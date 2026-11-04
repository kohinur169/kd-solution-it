// path: services/products/catalogue.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText, TEXT_LIMITS } from "../../lib/security/text.ts";
import {
  CATALOGUE_CODE_COLUMN,
  CATALOGUE_CODE_PATTERN,
  CATALOGUE_CURRENCIES,
  CATALOGUE_DEFAULT_UNIT,
  CATALOGUE_FIELD_LIMITS,
  CATALOGUE_TABLES,
  CATALOGUE_UNITS,
  isCatalogueUnit,
  type CatalogueKind,
  type CatalogueUnit,
} from "./catalogue-fields.ts";
import { priceColumnSchema, priceFromMinor, priceProblemOf, priceToMinor } from "./price.ts";

/**
 * Section 15's product and service create and edit: one service over the two tables of `0020` and
 * `0021`.
 *
 * ## Why one module and not two
 *
 * A product and a service differ in exactly one column of identity - `sku` against `code` - and in
 * their default unit, and the two migrations say so themselves: same money rules, same unit list, same
 * soft delete, same indexes. Two files would therefore be two copies of one validation, one audit trail
 * and one uniqueness answer, and the second copy is where the drift starts. The catalogue is therefore
 * named by a `kind`, the table and the code column are looked up from it, and every public function
 * takes that kind - so `createCatalogueEntry` writes to `products` or to `services` and nothing else.
 *
 * ## The company and the role
 *
 * Both are read from the session and never from the body: `owner` is the only role that manages a
 * merchant catalogue (FEATURE_LIST section 25), and every query is scoped `company_id=eq.<company>` in
 * the statement itself, because the service role bypasses RLS. A product of another merchant is
 * therefore not found rather than refused - the same 404 an unknown id gets.
 *
 * ## The price
 *
 * The merchant types major units; `price.ts` converts to the `bigint` of minor units the columns store,
 * with decimal string arithmetic and no float. A price outside the pattern is `invalid_format` and one
 * past the ceiling is `too_large` - two different sentences, because one is a typo and the other is a
 * number the platform cannot print back.
 *
 * ## The code is unique per merchant, case insensitively
 *
 * `products_sku_key` and `services_code_key` are partial unique indexes on `lower(...)` among live
 * rows, so `ABC-1` and `abc-1` collide while a deleted row releases the code. A lost race answers
 * `CONFLICT` naming the code field instead of surfacing a database error, which is what lets the form
 * point at the box the merchant has to change.
 *
 * ## The edit does not depend on a version the merchant never saw
 *
 * The service re-reads the row and writes by id, company and live state, with the version the row
 * currently has, then re-reads and compares. `0019`-style last-write-wins is correct for a catalogue
 * entry: the form has one editor, there is no field a background job also writes, and refusing a save
 * because another tab bumped a counter would lose the merchant's typing for no benefit. The re-read is
 * what turns a row deleted between the read and the write into "not found" instead of a silent no-op.
 */

/** The audit action of a create, per kind. */
export const CATALOGUE_CREATED_AUDIT_ACTION: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "product.created",
  service: "service.created",
});

/** The audit action of an edit, per kind. */
export const CATALOGUE_UPDATED_AUDIT_ACTION: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "product.updated",
  service: "service.updated",
});

/** The audit entity of a row, per kind. */
export const CATALOGUE_AUDIT_ENTITY: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "product",
  service: "service",
});

/** Only the owner of a business manages its catalogue (section 25). */
export const CATALOGUE_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze([
  "owner",
] as const satisfies readonly PlatformRole[]);

/** The rule vocabulary this service answers with, for the form's sentences. */
export const CATALOGUE_RULES = [
  "required",
  "too_short",
  "too_long",
  "invalid_format",
  "too_large",
  "unknown_field",
  "already_used",
  "not_found",
  "already_changed",
] as const;

/** The values of one catalogue row, as the screen sees them. */
export interface CatalogueValues {
  readonly name: string;
  /** The `sku` of a product or the `code` of a service. */
  readonly code: string | null;
  readonly description: string | null;
  /** Major units, printed with four decimals: what the form shows and the merchant retypes. */
  readonly unitPrice: string;
  /** The same price in whole minor units, which is what the column stores. */
  readonly unitPriceMinor: bigint;
  readonly currency: string;
  readonly unit: CatalogueUnit;
}

/** One catalogue row as a screen sees it. */
export interface CatalogueSnapshot {
  readonly id: string;
  readonly kind: CatalogueKind;
  readonly companyId: string;
  readonly values: CatalogueValues;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export interface CatalogueDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * The row shape of `0020`/`0021`, validated on every read.
 *
 * `sku` and `code` are both optional here and the caller reads the one its kind uses, so one schema
 * covers both tables; the code column that does not belong to the kind is simply absent from the row
 * and stays null.
 */
export const catalogueRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  name: z.string().min(1).max(160),
  sku: z.string().max(48).nullable().optional(),
  code: z.string().max(48).nullable().optional(),
  description: z.string().max(2_000).nullable(),
  unit_price_minor: priceColumnSchema,
  currency: z.string().length(3),
  unit: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

type CatalogueRow = z.infer<typeof catalogueRowSchema>;

/** Empty text means "no value", and becomes null before any rule runs. */
const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? null : value;

/** An optional single line field: absent, null or empty all become null; otherwise trimmed and bounded. */
const optionalLine = (max: number) =>
  z
    .preprocess(emptyToNull, z.string().trim().max(max).nullish())
    .transform((value) => (value === null || value === undefined ? null : value));

/** The shape both tables share, without the money, which is parsed on its own. */
const catalogueBaseSchema = z
  .object({
    name: z.string().trim().min(1).max(CATALOGUE_FIELD_LIMITS.name.max),
    code: z
      .preprocess(emptyToNull, z.string().trim().max(CATALOGUE_FIELD_LIMITS.code.max).nullish())
      .transform((value) => (value === null || value === undefined ? null : value)),
    description: optionalLine(CATALOGUE_FIELD_LIMITS.description.max),
    unit_price: z.string().trim().min(1),
    unit: z.enum(CATALOGUE_UNITS),
    currency: z.enum(CATALOGUE_CURRENCIES),
  })
  .strict();

/** A stored minor unit value as the strings the form and the query use. */
function codeOf(kind: CatalogueKind, row: CatalogueRow): string | null {
  return (kind === "product" ? row.sku : row.code) ?? null;
}

function epochMs(instant: string): number {
  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/** The stored unit, narrowed to the closed list; the migration's check is what makes this total. */
function unitOf(kind: CatalogueKind, row: CatalogueRow): CatalogueUnit {
  return isCatalogueUnit(row.unit) ? row.unit : (CATALOGUE_DEFAULT_UNIT[kind] as CatalogueUnit);
}

function snapshotOf(kind: CatalogueKind, row: CatalogueRow): CatalogueSnapshot {
  return {
    id: row.id,
    kind,
    companyId: row.company_id,
    values: {
      name: row.name,
      code: codeOf(kind, row),
      description: row.description,
      unitPrice: priceFromMinor(row.unit_price_minor),
      unitPriceMinor: row.unit_price_minor,
      currency: row.currency,
      unit: unitOf(kind, row),
    },
    version: row.version,
    createdAtEpochMs: epochMs(row.created_at),
    updatedAtEpochMs: epochMs(row.updated_at),
  };
}

/**
 * Sanitise one raw value the way section 55 demands, then let the schema judge its shape.
 *
 * The sanitiser strips control characters and collapses whitespace but never truncates to the field
 * ceiling, so an over-ceiling value reaches the schema and answers `too_long` instead of being
 * silently shortened into something the merchant did not write.
 */
function sanitizeValue(field: string, raw: unknown): unknown {
  if (raw === null || raw === undefined || typeof raw !== "string") {
    return raw;
  }

  switch (field) {
    case "description":
      return sanitizeMultilineText(raw, TEXT_LIMITS.multiLine);
    case "unit_price":
      // A price is digits and one dot: collapsing whitespace is all the sanitising it can take, and
      // the pattern refuses anything else rather than having it removed.
      return sanitizeSingleLineText(raw, TEXT_LIMITS.singleLine);
    default:
      return sanitizeSingleLineText(raw, TEXT_LIMITS.multiLine);
  }
}

/** The keys a create body may carry, as the form spells them. */
function allowedKeys(kind: CatalogueKind): readonly string[] {
  return ["name", CATALOGUE_CODE_COLUMN[kind], "description", "unit_price", "currency", "unit"];
}

/** Sanitise a raw body into the shape the schema validates, field by field. */
function sanitizeBody(kind: CatalogueKind, body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: kind, rule: "invalid_format" }],
    });
  }

  const input = body as Record<string, unknown>;
  const allowed = allowedKeys(kind);
  const cleaned: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "unknown_field" }] });
    }
  }

  const codeColumn = CATALOGUE_CODE_COLUMN[kind];

  for (const key of allowed) {
    if (key in input) {
      // The form names the code the way the merchant fills it (`sku` or `code`); the schema names it
      // `code` for both, so the column is translated here and the raw key never reaches the parse.
      cleaned[key === codeColumn ? "code" : key] = sanitizeValue(key, input[key]);
    }
  }

  return cleaned;
}

/** Map one Zod issue to the `{field, rule}` detail the form renders. */
function detailOf(kind: CatalogueKind, issue: z.ZodIssue): ErrorDetail {
  const field = issue.path.length > 0 ? String(issue.path[0]) : kind;

  // The form knows the column by the name the merchant fills in.
  const named = field === "code" ? CATALOGUE_CODE_COLUMN[kind] : field;

  if (issue.code === "too_small") {
    return { field: named, rule: issue.minimum === 1 ? "required" : "too_short" };
  }

  if (issue.code === "too_big") {
    return { field: named, rule: "too_long" };
  }

  return { field: named, rule: "invalid_format" };
}

/** The parsed body, with the price converted to minor units. */
interface CatalogueInput {
  readonly name: string;
  readonly code: string | null;
  readonly description: string | null;
  readonly unitPriceMinor: bigint;
  readonly unit: CatalogueUnit;
  readonly currency: string;
}

/** The order fields are reported in, so a form marks the boxes top to bottom. */
function fieldOrderOf(kind: CatalogueKind): readonly string[] {
  return ["name", CATALOGUE_CODE_COLUMN[kind], "description", "unit_price", "unit", "currency"];
}

/**
 * Parse a body into the values the row is written with, naming every broken field at once.
 *
 * The shape, the code and the price are three different judgements, and stopping at the first of them
 * would make a merchant fix one box, submit, and be told about the next. So each is evaluated, the
 * first rule per field wins, and the answer is ordered the way the form reads - which is what the
 * screens rely on to mark several boxes in one go.
 */
function parseBody(kind: CatalogueKind, body: unknown): CatalogueInput {
  const cleaned = sanitizeBody(kind, body);
  const codeField = CATALOGUE_CODE_COLUMN[kind];
  const problems = new Map<string, string>();

  const parsed = catalogueBaseSchema.safeParse(cleaned);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const detail = detailOf(kind, issue);

      if (!problems.has(detail.field)) {
        problems.set(detail.field, detail.rule);
      }
    }
  }

  // The code's shape is the migration's own pattern, so a code the form accepts is one the index will
  // hold. `null` means the merchant named no code, which both tables allow.
  const rawCode = cleaned["code"];

  if (typeof rawCode === "string" && rawCode.length > 0 && !CATALOGUE_CODE_PATTERN.test(rawCode)) {
    if (!problems.has(codeField)) {
      problems.set(codeField, "invalid_format");
    }
  }

  const rawPrice = cleaned["unit_price"];

  if (typeof rawPrice === "string") {
    const priceProblem = priceProblemOf(rawPrice);

    if (priceProblem !== null && !problems.has("unit_price")) {
      problems.set("unit_price", priceProblem);
    }
  }

  if (problems.size > 0 || !parsed.success) {
    const details: ErrorDetail[] = [];

    for (const field of fieldOrderOf(kind)) {
      const rule = problems.get(field);

      if (rule !== undefined) {
        details.push({ field, rule });
      }
    }

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const value = parsed.data;
  const unitPriceMinor = priceToMinor(value.unit_price);

  if (unitPriceMinor === null) {
    // Unreachable: a price that passed `priceProblemOf` converts. Kept so the null is not a cast.
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "unit_price", rule: "invalid_format" }] });
  }

  return {
    name: value.name,
    code: value.code,
    description: value.description,
    unitPriceMinor,
    unit: value.unit,
    currency: value.currency,
  };
}

function requireCatalogueActor(actor: RequestActor): string {
  requireAnyRole(actor, CATALOGUE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** The PostgREST `select` of a whole row of either table. */
const ROW_COLUMNS =
  "select=id,company_id,name,sku,code,description,unit_price_minor,currency,unit,created_at,updated_at,deleted_at,version";

/** The error column of a lost unique race, as the migration named it. */
function conflictDetail(kind: CatalogueKind): ErrorDetail {
  return { field: CATALOGUE_CODE_COLUMN[kind], rule: "already_used" };
}

/**
 * Create one product or one service of the actor's own company.
 *
 * The kind decides the table, the code column and the audit action; everything else is shared. A code
 * already used by the same merchant answers `CONFLICT` naming the code field.
 */
export async function createCatalogueEntry(
  input: { readonly actor: RequestActor; readonly kind: CatalogueKind; readonly body: unknown },
  dependencies: CatalogueDependencies,
): Promise<CatalogueSnapshot> {
  const companyId = requireCatalogueActor(input.actor);
  const values = parseBody(input.kind, input.body);
  const table = CATALOGUE_TABLES[input.kind];
  const codeColumn = CATALOGUE_CODE_COLUMN[input.kind];

  const newRow: Record<string, unknown> = {
    company_id: companyId,
    name: values.name,
    [codeColumn]: values.code,
    description: values.description,
    unit_price_minor: values.unitPriceMinor,
    currency: values.currency,
    unit: values.unit,
  };

  let inserted: CatalogueRow;

  try {
    const [row] = await dependencies.rest.insertReturning(table, [newRow], catalogueRowSchema);

    if (row === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "catalogue", reason: "insert_returned_no_row" } });
    }

    inserted = row;
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError("CONFLICT", { details: [conflictDetail(input.kind)] });
    }

    throw error;
  }

  await appendTolerated(dependencies.audit, {
    action: CATALOGUE_CREATED_AUDIT_ACTION[input.kind],
    actorUserId: input.actor.userId,
    entityType: CATALOGUE_AUDIT_ENTITY[input.kind],
    entityId: inserted.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      // Names of the fields written, and the price as a number the trail can be read with - never the
      // description, which is free text a merchant may have pasted anything into.
      fields: ["name", codeColumn, "unit_price", "currency", "unit"],
      unit_price_minor: inserted.unit_price_minor.toString(),
    },
  });

  return snapshotOf(input.kind, inserted);
}

/** Read one live row of the kind, or `RESOURCE_NOT_FOUND` for a foreign, deleted or unknown id. */
export async function getCatalogueEntry(
  input: {
    readonly actor: RequestActor;
    readonly kind: CatalogueKind;
    readonly entryId: string;
  },
  dependencies: CatalogueDependencies,
): Promise<CatalogueSnapshot> {
  const companyId = requireCatalogueActor(input.actor);

  if (!z.string().uuid().safeParse(input.entryId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    CATALOGUE_TABLES[input.kind],
    `${ROW_COLUMNS}&id=eq.${input.entryId}&company_id=eq.${companyId}&deleted_at=is.null`,
    catalogueRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: input.kind, reason: "not_found" } });
  }

  return snapshotOf(input.kind, row);
}

/**
 * Edit one live row of the kind.
 *
 * The body names only the fields it changes; a missing key leaves the column alone. The row is
 * re-read afterwards, which is what turns a row removed between the two statements into "not found"
 * rather than a silent success, and the audit entry names the changed fields without their values.
 */
export async function updateCatalogueEntry(
  input: {
    readonly actor: RequestActor;
    readonly kind: CatalogueKind;
    readonly entryId: string;
    readonly body: unknown;
  },
  dependencies: CatalogueDependencies,
): Promise<CatalogueSnapshot> {
  const companyId = requireCatalogueActor(input.actor);
  const current = await getCatalogueEntry(
    { actor: input.actor, kind: input.kind, entryId: input.entryId },
    dependencies,
  );

  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: input.kind, rule: "invalid_format" }],
    });
  }

  const allowed = allowedKeys(input.kind);
  const raw = input.body as Record<string, unknown>;
  const changed: string[] = [];
  const values: Record<string, unknown> = {};
  const codeColumn = CATALOGUE_CODE_COLUMN[input.kind];

  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "unknown_field" }] });
    }
  }

  // A partial edit is validated by merging onto the stored values, so one broken field is reported
  // even when the body carries only that field.
  const merged: Record<string, unknown> = {
    name: current.values.name,
    [codeColumn]: current.values.code,
    description: current.values.description,
    unit_price: current.values.unitPrice,
    currency: current.values.currency,
    unit: current.values.unit,
  };

  for (const key of allowed) {
    if (key in raw) {
      merged[key] = sanitizeValue(key, raw[key]);
    }
  }

  const parsed = parseBody(input.kind, merged);

  if ("name" in raw) {
    values["name"] = parsed.name;
    changed.push("name");
  }

  if (codeColumn in raw) {
    values[codeColumn] = parsed.code;
    changed.push(codeColumn);
  }

  if ("description" in raw) {
    values["description"] = parsed.description;
    changed.push("description");
  }

  if ("unit_price" in raw) {
    values["unit_price_minor"] = parsed.unitPriceMinor;
    changed.push("unit_price");
  }

  if ("currency" in raw) {
    values["currency"] = parsed.currency;
    changed.push("currency");
  }

  if ("unit" in raw) {
    values["unit"] = parsed.unit;
    changed.push("unit");
  }

  if (changed.length > 0) {
    try {
      await dependencies.rest.update(
        CATALOGUE_TABLES[input.kind],
        `id=eq.${current.id}&company_id=eq.${companyId}&deleted_at=is.null`,
        values,
      );
    } catch (error) {
      if (isConflictError(error)) {
        throw new AppError("CONFLICT", { details: [conflictDetail(input.kind)] });
      }

      throw error;
    }
  }

  const updated = await getCatalogueEntry(
    { actor: input.actor, kind: input.kind, entryId: current.id },
    dependencies,
  );

  await appendTolerated(dependencies.audit, {
    action: CATALOGUE_UPDATED_AUDIT_ACTION[input.kind],
    actorUserId: input.actor.userId,
    entityType: CATALOGUE_AUDIT_ENTITY[input.kind],
    entityId: updated.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { fields: changed },
  });

  return updated;
}
