// path: services/invoices/invoice-numbering.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";

/**
 * The numbering service: one counter per merchant, and the number it prints.
 *
 * ## What a number is
 *
 * `PREFIX-SEQUENCE`, padded: `INV-00001`. The prefix is the merchant's, the sequence is theirs alone, and
 * the padding is how many digits it prints with. `0022` owns the *constraint* - between three and forty
 * characters of `[A-Z0-9._/-]`, starting alphanumeric, unique per merchant over the live rows - and this
 * module owns the *policy* that produces one that satisfies it.
 *
 * ## Where the counter lives, and why not here
 *
 * In `invoice_number_counters`, taken by `take_invoice_number`. A counter read and written from this module
 * would be a read-modify-write across two round trips, and that shape loses numbers under exactly the load
 * numbering exists to survive: two issues read nine, both write ten. The function is one statement with an
 * `on conflict do update`, so Postgres serialises the two callers on the row and the second increments what
 * the first wrote.
 *
 * ## Why the settings are validated twice
 *
 * The columns check the prefix, the padding and the reset rule, and this module's parser checks the same
 * things again before the write. That is not redundancy for its own sake: a column violation surfaces as a
 * failed REST update with no field to mark, while the merchant needs to be told which box is wrong.
 *
 * ## What is never done
 *
 * A number is never edited on an issued invoice, never reused, and never re-derived from the invoice's
 * position in a list. `0022` says a deleted invoice frees nothing and history keeps its number; this module
 * honours that by refusing a `next_number` below the highest number the merchant has already printed.
 */

/** The merchant's numbering series, as the settings screen edits it. */
export interface InvoiceNumberSettings {
  readonly prefix: string;
  readonly nextNumber: string;
  readonly padding: number;
  readonly yearly: boolean;
  /** The month the series returns to `nextNumber`, when `yearly` is true. */
  readonly resetMonth: number | null;
  /** What the next number will actually look like, so the screen can show it before anyone saves. */
  readonly previewNumber: string;
  /** The highest number the merchant has already printed, read from the issued invoices. */
  readonly lastUsedNumber: string;
  readonly updatedAtEpochMs: number;
}

/** What a taken number is, plus where the series now stands. */
export interface TakenInvoiceNumber {
  readonly number: string;
  readonly sequenceNumber: string;
  readonly periodKey: number;
}

export interface InvoiceNumberingDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** Section 20's tenancy: the merchant owns the series, and only an `owner` may change it. */
const NUMBERING_ROLES = Object.freeze(["owner"] as const);

export const INVOICE_NUMBER_SETTINGS_UPDATED_AUDIT_ACTION = "invoice.numbering_updated";

export const INVOICE_NUMBER_AUDIT_ENTITY = "invoice_number_settings";

/** The defaults a merchant who has never opened the screen gets. */
export const INVOICE_NUMBER_DEFAULTS = Object.freeze({
  prefix: "INV",
  nextNumber: "1",
  padding: 5,
  yearly: false,
});

/** `00114` would print 11 characters; `0022` allows forty in total, so eleven digits is the ceiling. */
export const INVOICE_NUMBER_PADDING_LIMITS = Object.freeze({ min: 1, max: 11 });

/** The prefix cannot fill the whole number: the sequence and the separator need room. */
export const INVOICE_NUMBER_PREFIX_LIMITS = Object.freeze({ min: 1, max: 12 });

/**
 * The prefix `0022`'s number check will accept as a head.
 *
 * No separator at the end, because the number's own separator follows it and `INV--00001` is not a number a
 * merchant meant. Upper case only, because the check is upper case only.
 */
export const INVOICE_NUMBER_PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,11}$/u;

/**
 * A next number: digits, at most a `bigint`'s worth, and not zero.
 *
 * Leading zeros are tolerated because a merchant types `0007` meaning seven, and reading that as a refusal
 * would be pedantry about a value that has exactly one sensible meaning. Zero itself is refused: a number
 * prints from one, and `invoice_number_settings_next_check` says so too.
 */
export const INVOICE_NUMBER_SEQUENCE_PATTERN = /^\d{1,18}$/u;

function requireNumberingActor(actor: RequestActor): string {
  requireAnyRole(actor, NUMBERING_ROLES);

  return requireCompanyId(actor);
}

function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    return audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
    return Promise.resolve();
  }
}

/** The row shape of `0114`, validated on every read. */
export const invoiceNumberSettingsRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  prefix: z.string(),
  next_number: z.union([z.string(), z.number()]).transform((value) => BigInt(String(value))),
  padding: z.number().int(),
  yearly: z.boolean(),
  reset_month: z.number().int().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const SETTINGS_COLUMNS =
  "select=id,company_id,prefix,next_number,padding,yearly,reset_month,created_at,updated_at";

/**
 * Print a number from its parts.
 *
 * The padding is a floor, not a cap: a merchant who pads to five and reaches their hundred-thousandth invoice
 * prints six digits rather than truncating, because a truncated number is a duplicate and an over-long one is
 * only unusual. `0022`'s forty character ceiling is reached long after that, and the take function checks it.
 */
export function printInvoiceNumber(input: {
  readonly prefix: string;
  readonly sequenceNumber: bigint;
  readonly padding: number;
}): string {
  return `${input.prefix}-${input.sequenceNumber.toString().padStart(input.padding, "0")}`;
}

/**
 * A typed prefix, or null when `0022` would refuse the number it produces.
 *
 * Trailing separators are trimmed rather than refused: a merchant who types `INV-` means `INV`, and the
 * separator is added by `printInvoiceNumber` anyway. What is refused is anything that would not start the
 * number with an alphanumeric.
 */
export function normaliseInvoiceNumberPrefix(input: string): string | null {
  const text = input.trim().toUpperCase().replace(/[._/-]+$/u, "");

  if (!INVOICE_NUMBER_PREFIX_PATTERN.test(text)) {
    return null;
  }

  return text;
}

/** A typed next number as a bigint, or null when it is not a positive whole number. */
export function parseNextNumber(input: string): bigint | null {
  const text = input.trim();

  if (!INVOICE_NUMBER_SEQUENCE_PATTERN.test(text)) {
    return null;
  }

  const value = BigInt(text);

  return value >= 1n ? value : null;
}

/**
 * The last number a merchant's printed invoices reached.
 *
 * Read from the invoices rather than from the counter, because the counter is editable and resettable while
 * the printed numbers are a fact. The database does the extraction in `invoice_number_last_used`; this is the
 * type-strict way to read it, and it refuses an answer it cannot parse rather than treating it as zero - a
 * zero would silently permit reissuing every number the merchant has.
 */
async function readLastUsedNumber(rest: RestClient, companyId: string): Promise<bigint> {
  const body = await rest.rpc("invoice_number_last_used", { p_company_id: companyId });
  const parsed = z
    .union([z.string(), z.number(), z.null()])
    .nullable()
    .safeParse(body);

  if (!parsed.success) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "invoice_number", reason: "unreadable_last_used" } });
  }

  const value = parsed.data;

  if (value === null || value === undefined) {
    return 0n;
  }

  const text = typeof value === "number" ? String(value) : value.trim();

  if (!/^\d{1,18}$/u.test(text)) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "invoice_number", reason: "unreadable_last_used" } });
  }

  return BigInt(text);
}

/** The merchant's series, defaulted when they have never saved one. */
export async function getInvoiceNumberSettings(
  input: { readonly actor: RequestActor },
  dependencies: InvoiceNumberingDependencies,
): Promise<InvoiceNumberSettings> {
  const companyId = requireNumberingActor(input.actor);

  const rows = await dependencies.rest.select(
    "invoice_number_settings",
    `${SETTINGS_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceNumberSettingsRowSchema,
  );
  const row = rows[0];
  const lastUsed = await readLastUsedNumber(dependencies.rest, companyId);

  if (row === undefined) {
    return {
      ...INVOICE_NUMBER_DEFAULTS,
      resetMonth: null,
      previewNumber: printInvoiceNumber({
        prefix: INVOICE_NUMBER_DEFAULTS.prefix,
        sequenceNumber: BigInt(INVOICE_NUMBER_DEFAULTS.nextNumber),
        padding: INVOICE_NUMBER_DEFAULTS.padding,
      }),
      lastUsedNumber: lastUsed.toString(),
      updatedAtEpochMs: 0,
    };
  }

  return {
    prefix: row.prefix,
    nextNumber: row.next_number.toString(),
    padding: row.padding,
    yearly: row.yearly,
    resetMonth: row.reset_month,
    previewNumber: printInvoiceNumber({
      prefix: row.prefix,
      sequenceNumber: row.next_number,
      padding: row.padding,
    }),
    lastUsedNumber: lastUsed.toString(),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

/** A validated settings body, ready to write. */
export interface ParsedNumberSettings {
  readonly prefix: string;
  readonly nextNumber: bigint;
  readonly padding: number;
  readonly yearly: boolean;
  readonly resetMonth: number | null;
}

/**
 * Validate a settings body.
 *
 * Every problem is collected rather than thrown at the first, because a merchant fixing a prefix and a
 * padding should be told about both. The one rule that is not a field error is the floor: a `next_number`
 * below the highest printed number is refused with the number it would collide with, since the merchant needs
 * to know what value is safe rather than only that theirs was not.
 */
export async function parseInvoiceNumberSettings(
  body: unknown,
  input: { readonly companyId: string; readonly rest: RestClient },
): Promise<ParsedNumberSettings> {
  const problems: ErrorDetail[] = [];
  const raw = (body ?? {}) as {
    readonly prefix?: unknown;
    readonly next_number?: unknown;
    readonly padding?: unknown;
    readonly yearly?: unknown;
    readonly reset_month?: unknown;
  };

  const prefixText = typeof raw.prefix === "string" ? raw.prefix : "";
  const prefix = prefixText.length === 0 ? null : normaliseInvoiceNumberPrefix(prefixText);

  if (prefixText.length === 0) {
    problems.push({ field: "prefix", rule: "required" });
  } else if (prefix === null) {
    problems.push({ field: "prefix", rule: "invalid_format" });
  }

  const nextText = typeof raw.next_number === "string" ? raw.next_number : "";
  const nextNumber = nextText.length === 0 ? null : parseNextNumber(nextText);

  if (nextText.length === 0) {
    problems.push({ field: "next_number", rule: "required" });
  } else if (nextNumber === null) {
    problems.push({ field: "next_number", rule: "invalid_format" });
  }

  const padding = typeof raw.padding === "number" ? raw.padding : Number.NaN;

  if (!Number.isInteger(padding)) {
    problems.push({ field: "padding", rule: "invalid_format" });
  } else if (padding < INVOICE_NUMBER_PADDING_LIMITS.min) {
    problems.push({ field: "padding", rule: "too_small" });
  } else if (padding > INVOICE_NUMBER_PADDING_LIMITS.max) {
    problems.push({ field: "padding", rule: "too_large" });
  }

  const yearly = raw.yearly === true;
  const resetMonthRaw = raw.reset_month;

  if (!yearly && resetMonthRaw !== undefined && resetMonthRaw !== null) {
    problems.push({ field: "reset_month", rule: "invalid_format" });
  }

  let resetMonth: number | null = null;

  if (yearly) {
    if (typeof resetMonthRaw !== "number" || !Number.isInteger(resetMonthRaw) || resetMonthRaw < 1 || resetMonthRaw > 12) {
      problems.push({ field: "reset_month", rule: resetMonthRaw === undefined || resetMonthRaw === null ? "required" : "invalid_format" });
    } else {
      resetMonth = resetMonthRaw;
    }
  }

  if (problems.length > 0 || prefix === null || nextNumber === null || !Number.isInteger(padding)) {
    throw new AppError("VALIDATION_FAILED", { details: problems });
  }

  // The printed number has to satisfy `0022`, and the only way to know is to print one.
  const preview = printInvoiceNumber({ prefix, sequenceNumber: nextNumber, padding });

  if (preview.length < 3 || preview.length > 40) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "prefix", rule: "too_long" }] });
  }

  // The floor. A number already printed cannot be issued again, so a `next_number` at or below the highest
  // one the merchant has used is refused rather than silently skipped past - the merchant needs to know the
  // value that is safe, and a silent correction would hide that they had tried to go backwards.
  const lastUsed = await readLastUsedNumber(input.rest, input.companyId);

  if (nextNumber <= lastUsed) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "next_number", rule: "too_small" }],
      cause: { rule: "invoice_number", reason: "already_used", last_used: lastUsed.toString() },
    });
  }

  return { prefix, nextNumber, padding, yearly, resetMonth };
}

/**
 * Save the merchant's series.
 *
 * An update when a row exists and an insert when it does not, because the settings row is created on the first
 * save rather than at sign-up: a merchant who never invoices has no numbering series, and a row created in
 * advance would have to hold a guess at their prefix.
 */
export async function updateInvoiceNumberSettings(
  input: {
    readonly actor: RequestActor;
    readonly settings: ParsedNumberSettings;
  },
  dependencies: InvoiceNumberingDependencies,
): Promise<InvoiceNumberSettings> {
  const companyId = requireNumberingActor(input.actor);

  const rows = await dependencies.rest.select(
    "invoice_number_settings",
    `${SETTINGS_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceNumberSettingsRowSchema,
  );

  const values: Readonly<Record<string, unknown>> = {
    prefix: input.settings.prefix,
    next_number: input.settings.nextNumber,
    padding: input.settings.padding,
    yearly: input.settings.yearly,
    reset_month: input.settings.resetMonth,
  };

  if (rows[0] === undefined) {
    await dependencies.rest.insert("invoice_number_settings", [{ company_id: companyId, ...values }]);
  } else {
    // Scoped to the company as well as the id: a REST update that matched nothing still reports success, so
    // the scope is what makes a write to another merchant's row impossible rather than merely unlikely.
    await dependencies.rest.update(
      "invoice_number_settings",
      `id=eq.${rows[0].id}&company_id=eq.${companyId}&deleted_at=is.null`,
      values,
    );
  }

  const saved = await getInvoiceNumberSettings({ actor: input.actor }, dependencies);

  await appendTolerated(dependencies.audit, {
    action: INVOICE_NUMBER_SETTINGS_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_NUMBER_AUDIT_ENTITY,
    entityId: rows[0]?.id ?? null,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      prefix: input.settings.prefix,
      next_number: input.settings.nextNumber.toString(),
      padding: input.settings.padding,
      yearly: input.settings.yearly,
      reset_month: input.settings.resetMonth,
    },
  });

  return saved;
}

/**
 * Take the next number of a merchant's series.
 *
 * Called by the issue path, which every status transition that needs a number goes through (STEP 116). The
 * work itself is the database's `take_invoice_number`; this wrapper is the typing, the role check and the
 * translation of a refusal into a sentence.
 *
 * A refusal from the function is a `check_violation` - the number it produced is already printed, or cannot be
 * printed at all - and it arrives here as a `CONFLICT` naming the numbering rather than a 500, because the
 * cause is a merchant's settings and the fix is on the settings screen.
 */
export async function takeInvoiceNumber(
  input: { readonly actor: RequestActor; readonly companyId?: string },
  dependencies: InvoiceNumberingDependencies,
): Promise<TakenInvoiceNumber> {
  const companyId = input.companyId ?? requireNumberingActor(input.actor);

  if (input.companyId !== undefined) {
    // A caller that names the company (the issue path, which has already resolved it) still has to be the
    // same company: numbering never crosses a tenant boundary, not even for an office role.
    requireCompanyId(input.actor);

    if (requireCompanyId(input.actor) !== input.companyId) {
      throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice_number", reason: "wrong_company" } });
    }
  }

  const now = dependencies.now ?? ((): number => Date.now());
  let body: unknown;

  try {
    body = await dependencies.rest.rpc("take_invoice_number", {
      p_company_id: companyId,
      p_at: new Date(now()).toISOString(),
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError("CONFLICT", {
        details: [{ field: "number", rule: "already_used" }],
        cause: { rule: "invoice_number", reason: error.code.toLowerCase() },
      });
    }

    throw error;
  }

  const parsed = z
    .array(
      z.object({
        number: z.string().min(3).max(40),
        sequence_number: z.union([z.string(), z.number()]).transform((value) => BigInt(String(value))),
        period_key: z.number().int(),
      }),
    )
    .length(1)
    .safeParse(body);
  const answer = parsed.success ? parsed.data[0] : undefined;

  if (answer === undefined) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "invoice_number", reason: "unreadable_take" } });
  }

  return {
    number: answer.number,
    sequenceNumber: answer.sequence_number.toString(),
    periodKey: answer.period_key,
  };
}
