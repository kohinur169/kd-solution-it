// path: services/disputes/chargeback-rate.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "../../lib/auth/session.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import {
  CHARGEBACK_ACTIONS_TABLE,
  CHARGEBACK_ACTION_ENTITY,
  CHARGEBACK_AUDIT,
  CHARGEBACK_COUNT_MAXIMUM_PAGES,
  CHARGEBACK_COUNT_PAGE_SIZE,
  CHARGEBACK_DETAIL_MAXIMUM_LENGTH,
  CHARGEBACK_FIELD,
  CHARGEBACK_HISTORY_LIMIT,
  CHARGEBACK_NOTE_MAXIMUM_LENGTH,
  CHARGEBACK_POLICY_ROLES,
  CHARGEBACK_READ_ROLES,
  CHARGEBACK_RULES,
  CHARGEBACK_SUSPEND_ROLES,
  CHARGEBACK_TEMPLATE_KEY,
  CHARGEBACK_WATCHLIST_LIMIT,
  chargebackRank,
  isChargebackKind,
  isClearableKind,
  type ChargebackKind,
  type ChargebackMode,
  type ChargebackPolicyValues,
} from "./chargeback-fields.ts";
import {
  ratePercentText,
  readChargebackPolicy,
  readChargebackPolicyFor,
  type ChargebackPolicyDependencies,
  type ChargebackPolicyView,
} from "./chargeback-policy.ts";

/**
 * Section 18's chargeback programme: the measurement, the three steps, and the two the platform takes alone.
 *
 * ## What a measurement is
 *
 * A rate is one division with two halves, so this service counts both: the transactions a merchant captured
 * inside the rolling window, and the chargebacks opened against that merchant inside the same window. Both
 * counts are read from the rows the platform already keeps - `0037`'s payments by `captured_at`, `0039`'s
 * disputes by `opened_at` - and the rate is `chargebacks / transactions` in basis points, rounded once, stored as
 * an integer, and re-derived by `0128`'s own check. Section 18's minimum is asked *before* the percentage,
 * because a merchant with three transactions and one chargeback has a rate of 3333 basis points and no programme
 * anybody should act on.
 *
 * ## The ladder, and who climbs which rung
 *
 * The decided step is the highest bar the numbers clear: `warning` at the lowest, then `reserve`, then
 * `suspension`. A warning and an extra reserve are the platform acting on its own clock - the sweep in
 * `chargeback-rate-job.ts` takes them - and a suspension is a named super administrator's decision, because
 * `0111` refuses a suspension with no actor and because stopping a merchant's business should have a signature on
 * it. The action row records which of the two it was in `mode`, and the actor in `actor_user_id`, so the
 * difference survives into the audit.
 *
 * ## What a step actually does
 *
 * A warning queues one notice through `0061` and nothing else: the merchant is told, and the watchlist keeps
 * looking. An extra reserve starts a `0044` reserve at the policy's percent, pausing the merchant's existing
 * reserve first so that `reserves_active_key` - one active reserve per merchant - still holds: the merchant's
 * terms changed, and the old agreement stays readable as history. A suspension writes an `0111` event with
 * reason `chargeback_program`, which is the state the account lifecycle already knows how to derive and how to
 * return from. Each of them then writes the action row that names the effect it produced, and `0128`'s trigger
 * refuses a row whose effect is missing or belongs to another merchant.
 *
 * ## What it will not do
 *
 * It will not act on a truncated read. Counting needs `count=exact`, which the platform's PostgREST client does
 * not send, so both sides are counted by paging rows on `id`; a window larger than the page ceiling is reported
 * as measured-but-truncated and no step is taken on it, because a capped denominator is a rate that reads lower
 * than the truth and a programme that under-acts is worse than one that says it could not see.
 */

/** The dependencies: the policy's, because a measurement is only meaningful against a policy. */
export type ChargebackRateDependencies = ChargebackPolicyDependencies;

/** One merchant's numbers inside one window. */
export interface ChargebackMeasurement {
  readonly companyId: string;
  readonly windowDays: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly paymentsCount: number;
  readonly chargebacksCount: number;
  readonly rateBps: number;
  readonly truncated: boolean;
}

/** One step, as a screen prints it. */
export interface ChargebackStepView {
  readonly id: string;
  readonly companyId: string;
  readonly kind: ChargebackKind;
  readonly mode: ChargebackMode;
  readonly appliedAt: string;
  readonly detail: string;
  readonly paymentsCount: number;
  readonly chargebacksCount: number;
  readonly rateBps: number;
  readonly rateText: string;
  readonly windowDays: number;
  readonly reservePercentText: string | null;
  readonly actorUserId: string | null;
  readonly clearedAt: string | null;
  readonly clearNote: string | null;
}

/** One row of the watchlist. */
export interface ChargebackWatchRow {
  readonly companyId: string;
  readonly companyName: string;
  readonly paymentsCount: number;
  readonly chargebacksCount: number;
  readonly rateBps: number;
  readonly rateText: string;
  readonly truncated: boolean;
  /** The step the numbers earn today, or null when they earn none. */
  readonly dueKind: ChargebackKind | null;
  /** The step already standing, un-cleared, or null. */
  readonly liveKind: ChargebackKind | null;
  /** The step a person cleared before, so the row can say "cleared" rather than "warned". */
  readonly clearedKind: ChargebackKind | null;
  /** The rule that stops this row being actioned now, or null when it may be. */
  readonly blockedRule: string | null;
}

/** The whole screen. */
export interface ChargebackScreenView {
  readonly policy: ChargebackPolicyView;
  readonly rows: readonly ChargebackWatchRow[];
  readonly history: readonly ChargebackStepView[];
  readonly readAt: string;
  readonly canApply: boolean;
  readonly canSuspend: boolean;
  readonly totalCompanies: number;
}

/** What one sweep did. */
export interface ChargebackSweepResult {
  readonly measured: number;
  readonly warned: number;
  readonly reserved: number;
  /** The merchants whose numbers earn a suspension, which the sweep may recommend and never take. */
  readonly suspensionsDue: number;
  readonly skipped: number;
  readonly truncated: number;
}

/* -------------------------------------------------------------------------------------------------
 * Shapes on the wire
 * ---------------------------------------------------------------------------------------------- */

const actionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  kind: z.string(),
  mode: z.string(),
  window_days: z.number().int(),
  payments_count: z.number().int(),
  chargebacks_count: z.number().int(),
  rate_bps: z.number().int(),
  reserve_percent_bps: z.number().int().nullable(),
  detail: z.string(),
  actor_user_id: z.string().nullable(),
  applied_at: z.string(),
  cleared_at: z.string().nullable(),
  clear_note: z.string().nullable(),
  version: z.number().int(),
});

const companyRowSchema = z.object({ id: z.string(), name: z.string() });

const countRowSchema = z.object({ id: z.string(), company_id: z.string() });

/** One id, and the merchant it belongs to: the two columns a count reads. */
type CountRow = z.infer<typeof countRowSchema>;

/** One id, for a count that needs nothing else. */
type IdRow = z.infer<typeof idRowSchema>;

const reserveRowSchema = z.object({ id: z.string(), percent_bps: z.number().int(), version: z.number().int() });

const idRowSchema = z.object({ id: z.string() });

const ownerRowSchema = z.object({ user_id: z.string() });

const addressRowSchema = z.object({ email: z.string() });

const methodRowSchema = z.object({ method: z.string() });

const ACTION_COLUMNS =
  "select=id,company_id,kind,mode,window_days,payments_count,chargebacks_count,rate_bps,reserve_percent_bps" +
  ",detail,actor_user_id,applied_at,cleared_at,clear_note,version";

const DISPUTE_TEMPLATE_REFERENCE_KIND = "dispute";
const EMAIL_MAX_ATTEMPTS = 5;

function refused(code: "CONFLICT" | "VALIDATION_FAILED", rule: string): AppError {
  return new AppError(code, { details: [{ field: CHARGEBACK_FIELD, rule }] });
}

function nowOf(dependencies: ChargebackRateDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** The rolling window the policy names, as two instants: `from` inclusive, `to` exclusive. */
export function windowOf(
  policy: ChargebackPolicyValues,
  nowMs: number,
): { readonly from: string; readonly to: string } {
  const day = 24 * 60 * 60 * 1000;

  return { from: instantOf(nowMs - policy.windowDays * day), to: instantOf(nowMs) };
}

/** The rate those two counts give, in basis points, rounded once. Zero transactions is a rate of zero. */
export function rateBpsOf(paymentsCount: number, chargebacksCount: number): number {
  if (paymentsCount <= 0) {
    return 0;
  }

  return Math.round((chargebacksCount * 10_000) / paymentsCount);
}

/**
 * Count the rows one filter selects, by paging on `id`.
 *
 * The platform's PostgREST client reads rows and never a `Content-Range`, so a count is a walk: five hundred ids
 * at a time, cursor on the last one, forty pages at most. A walk that runs out of pages is `truncated`, and the
 * caller refuses to act on it - the alternative is a denominator that stops at twenty thousand and a rate that
 * reads as if the merchant were better than it is.
 */
export async function countRows(
  rest: RestClient,
  table: string,
  filter: string,
  options: { readonly pageSize?: number; readonly maximumPages?: number } = {},
): Promise<{ readonly count: number; readonly truncated: boolean; readonly rows: readonly string[] }> {
  const pageSize = options.pageSize ?? CHARGEBACK_COUNT_PAGE_SIZE;
  const maximumPages = options.maximumPages ?? CHARGEBACK_COUNT_MAXIMUM_PAGES;
  const ids: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maximumPages; page += 1) {
    const query: string =
      `select=id&${filter}&order=id.asc&limit=${String(pageSize)}` +
      (cursor === null ? "" : `&id=gt.${encodeURIComponent(cursor)}`);
    const rows: readonly IdRow[] = await rest.select(table, query, idRowSchema);

    for (const row of rows) {
      ids.push(row.id);
    }

    if (rows.length < pageSize) {
      return { count: ids.length, truncated: false, rows: ids };
    }

    cursor = rows[rows.length - 1]?.id ?? null;

    if (cursor === null) {
      break;
    }
  }

  return { count: ids.length, truncated: true, rows: ids };
}

/** The two counts of every merchant inside one window, in two walks rather than two per merchant. */
export async function readWindowCounts(
  rest: RestClient,
  window: { readonly from: string; readonly to: string },
): Promise<{
  readonly payments: ReadonlyMap<string, number>;
  readonly chargebacks: ReadonlyMap<string, number>;
  readonly truncated: boolean;
}> {
  const paymentsByCompany = new Map<string, number>();
  const chargebacksByCompany = new Map<string, number>();
  let truncated = false;
  for (const table of ["payments", "disputes"] as const) {
    const stamp = table === "payments" ? "captured_at" : "opened_at";
    const filter =
      `deleted_at=is.null&${stamp}=gte.${encodeURIComponent(window.from)}` +
      `&${stamp}=lt.${encodeURIComponent(window.to)}`;
    const rows: readonly CountRow[] = await (async (): Promise<readonly CountRow[]> => {
      const collected: CountRow[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < CHARGEBACK_COUNT_MAXIMUM_PAGES; page += 1) {
        const query: string =
          `select=id,company_id&${filter}&order=id.asc&limit=${String(CHARGEBACK_COUNT_PAGE_SIZE)}` +
          (cursor === null ? "" : `&id=gt.${encodeURIComponent(cursor)}`);
        const batch: readonly CountRow[] = await rest.select(table, query, countRowSchema);

        collected.push(...batch);

        if (batch.length < CHARGEBACK_COUNT_PAGE_SIZE) {
          return collected;
        }

        cursor = batch[batch.length - 1]?.id ?? null;

        if (cursor === null) {
          return collected;
        }
      }

      truncated = true;

      return collected;
    })();

    for (const row of rows) {
      const target = table === "payments" ? paymentsByCompany : chargebacksByCompany;
      target.set(row.company_id, (target.get(row.company_id) ?? 0) + 1);
    }
  }

  return { payments: paymentsByCompany, chargebacks: chargebacksByCompany, truncated };
}

/** One merchant's measurement, from the two walks. */
export function measurementOf(
  input: {
    readonly companyId: string;
    readonly window: { readonly from: string; readonly to: string };
    readonly paymentsCount: number;
    readonly chargebacksCount: number;
    readonly windowDays: number;
    readonly truncated: boolean;
  },
): ChargebackMeasurement {
  return {
    companyId: input.companyId,
    windowDays: input.windowDays,
    windowFrom: input.window.from,
    windowTo: input.window.to,
    paymentsCount: input.paymentsCount,
    chargebacksCount: input.chargebacksCount,
    rateBps: rateBpsOf(input.paymentsCount, input.chargebacksCount),
    truncated: input.truncated,
  };
}

/**
 * The step a measurement earns, or null.
 *
 * The order is section 18's own: the minimum count first, then the highest bar the rate clears. The rule the
 * caller reads is the reason no step follows, so a screen can print "under the bar" and "too few transactions"
 * as two different sentences - they are two different answers for a merchant.
 */
export function decideChargebackStep(
  measurement: ChargebackMeasurement,
  policy: ChargebackPolicyValues,
): { readonly kind: ChargebackKind | null; readonly rule: string | null } {
  if (measurement.truncated) {
    return { kind: null, rule: CHARGEBACK_RULES.measurementTruncated };
  }

  if (measurement.paymentsCount < policy.minimumTransactions) {
    return { kind: null, rule: CHARGEBACK_RULES.minimumNotReached };
  }

  if (measurement.rateBps >= policy.suspensionRateBps) {
    return { kind: "suspension", rule: null };
  }

  if (measurement.rateBps >= policy.reserveRateBps) {
    return { kind: "reserve", rule: null };
  }

  if (measurement.rateBps >= policy.warningRateBps) {
    return { kind: "warning", rule: null };
  }

  return { kind: null, rule: CHARGEBACK_RULES.belowThreshold };
}

/** The sentence a step carries: what was measured, against which bar, on which day. */
export function detailOf(
  measurement: ChargebackMeasurement,
  kind: ChargebackKind,
  policy: ChargebackPolicyValues,
): string {
  const bar =
    kind === "warning" ? policy.warningRateBps : kind === "reserve" ? policy.reserveRateBps : policy.suspensionRateBps;
  const sentence =
    `${ratePercentText(measurement.rateBps)} percent over ${String(measurement.windowDays)} days: ` +
    `${String(measurement.chargebacksCount)} chargebacks in ${String(measurement.paymentsCount)} transactions, ` +
    `against the ${ratePercentText(bar)} percent ${kind} bar.`;

  return sentence.slice(0, CHARGEBACK_DETAIL_MAXIMUM_LENGTH);
}

/** One row as a screen prints it. */
function stepViewOf(row: z.infer<typeof actionRowSchema>): ChargebackStepView {
  if (!isChargebackKind(row.kind)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return {
    id: row.id,
    companyId: row.company_id,
    kind: row.kind,
    mode: row.mode === "manual" ? "manual" : "automatic",
    appliedAt: row.applied_at,
    detail: row.detail,
    paymentsCount: row.payments_count,
    chargebacksCount: row.chargebacks_count,
    rateBps: row.rate_bps,
    rateText: ratePercentText(row.rate_bps),
    windowDays: row.window_days,
    reservePercentText: row.reserve_percent_bps === null ? null : ratePercentText(row.reserve_percent_bps),
    actorUserId: row.actor_user_id,
    clearedAt: row.cleared_at,
    clearNote: row.clear_note,
  };
}

async function readSteps(
  dependencies: ChargebackRateDependencies,
  filter: string,
  limit: number,
): Promise<readonly ChargebackStepView[]> {
  const rows = await dependencies.rest.select(
    CHARGEBACK_ACTIONS_TABLE,
    `${ACTION_COLUMNS}&${filter}&deleted_at=is.null&order=applied_at.desc&limit=${String(limit)}`,
    actionRowSchema,
  );

  return rows.map(stepViewOf);
}

/* -------------------------------------------------------------------------------------------------
 * The screen
 * ---------------------------------------------------------------------------------------------- */

/** Ask for the role and the second factor every reading and writing act of this STEP asks for. */
function requireWatchRole(actor: RequestActor, roles: readonly PlatformRole[] = CHARGEBACK_READ_ROLES): void {
  requireAnyRole(actor, roles);

  if (!hasSatisfiedTwoFactor(actor)) {
    throw new AppError("PERMISSION_DENIED");
  }
}

/**
 * The watchlist: every merchant's rate, the step it earns, and the step already standing.
 *
 * One walk per side of the division for the whole platform rather than two per merchant, then the merchants
 * themselves - so the screen costs the same whether it prints ten rows or a hundred. A merchant with no
 * transactions and no chargebacks is in the list at zero: the absence of a rate is a fact a compliance officer
 * asks about, not a reason to hide the row.
 */
export async function readChargebackScreen(
  actor: RequestActor,
  dependencies: ChargebackRateDependencies,
): Promise<ChargebackScreenView> {
  requireWatchRole(actor);

  const policy = await readChargebackPolicyFor(actor, dependencies);
  const nowMs = nowOf(dependencies);
  const window = windowOf(policy.values, nowMs);
  const [companies, counts, live, recent] = await Promise.all([
    dependencies.rest.select(
      "companies",
      `select=id,name&deleted_at=is.null&order=name.asc&limit=${String(CHARGEBACK_WATCHLIST_LIMIT)}`,
      companyRowSchema,
    ),
    readWindowCounts(dependencies.rest, window),
    readSteps(dependencies, "cleared_at=is.null", CHARGEBACK_WATCHLIST_LIMIT * 3),
    readSteps(dependencies, "applied_at=not.is.null", CHARGEBACK_HISTORY_LIMIT),
  ]);
  const liveByCompany = new Map<string, ChargebackStepView>();

  for (const step of live) {
    const current = liveByCompany.get(step.companyId);

    if (current === undefined || chargebackRank(step.kind) > chargebackRank(current.kind)) {
      liveByCompany.set(step.companyId, step);
    }
  }

  const cleared = await readSteps(dependencies, "cleared_at=not.is.null", CHARGEBACK_WATCHLIST_LIMIT);
  const clearedByCompany = new Map<string, ChargebackKind>();
  const expiredButLive = new Set(live.map((step) => `${step.companyId}:${step.kind}`));

  for (const step of cleared) {
    if (expiredButLive.has(`${step.companyId}:${step.kind}`)) {
      continue;
    }

    const current = clearedByCompany.get(step.companyId);

    if (current === undefined || chargebackRank(step.kind) > chargebackRank(current)) {
      clearedByCompany.set(step.companyId, step.kind);
    }
  }

  const rows = companies.map((company): ChargebackWatchRow => {
    const measurement = measurementOf({
      companyId: company.id,
      window,
      paymentsCount: counts.payments.get(company.id) ?? 0,
      chargebacksCount: counts.chargebacks.get(company.id) ?? 0,
      windowDays: policy.values.windowDays,
      truncated: counts.truncated,
    });
    const decision = decideChargebackStep(measurement, policy.values);
    const standing = liveByCompany.get(company.id) ?? null;
    const blockedRule =
      standing === null
        ? decision.rule
        : standing.kind === "suspension"
          ? CHARGEBACK_RULES.suspended
          : decision.kind === null
            ? decision.rule
            : chargebackRank(decision.kind) <= chargebackRank(standing.kind)
              ? CHARGEBACK_RULES.stepTaken
              : null;

    return {
      companyId: company.id,
      companyName: company.name,
      paymentsCount: measurement.paymentsCount,
      chargebacksCount: measurement.chargebacksCount,
      rateBps: measurement.rateBps,
      rateText: ratePercentText(measurement.rateBps),
      truncated: measurement.truncated,
      dueKind: decision.kind,
      liveKind: standing?.kind ?? null,
      clearedKind: clearedByCompany.get(company.id) ?? null,
      blockedRule,
    };
  });

  const canApply = hasSatisfiedTwoFactor(actor) && actor.roles.some((role) => CHARGEBACK_APPLY_ROLES.includes(role));

  return {
    policy,
    rows,
    history: recent,
    readAt: instantOf(nowMs),
    canApply,
    canSuspend: hasSatisfiedTwoFactor(actor) && actor.roles.some((role) => CHARGEBACK_SUSPEND_ROLES.includes(role)),
    totalCompanies: rows.length,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The effects of a step
 * ---------------------------------------------------------------------------------------------- */

/** Queue the notice a warning owes the merchant, or answer null when there is nobody to send it to. */
async function queueNotice(
  dependencies: ChargebackRateDependencies,
  companyId: string,
  queuedAt: string,
): Promise<string | null> {
  const methods = await dependencies.rest
    .select("email_settings", "select=method&status=eq.active&deleted_at=is.null&limit=1", methodRowSchema)
    .catch(() => []);
  const method = methods[0]?.method ?? null;

  if (method === null) {
    return null;
  }

  const owners = await dependencies.rest
    .select(
      "role_assignments",
      `select=user_id&company_id=eq.${encodeURIComponent(companyId)}&role=eq.owner` +
        "&revoked_at=is.null&deleted_at=is.null&order=granted_at.asc&limit=1",
      ownerRowSchema,
    )
    .catch(() => []);
  const ownerUserId = owners[0]?.user_id;

  if (ownerUserId === undefined) {
    return null;
  }

  const addresses = await dependencies.rest
    .select("users", `select=email&id=eq.${encodeURIComponent(ownerUserId)}&deleted_at=is.null&limit=1`, addressRowSchema)
    .catch(() => []);
  const email = addresses[0]?.email;

  if (email === undefined) {
    return null;
  }

  try {
    const rows = await dependencies.rest.insertReturning(
      "email_send_logs",
      [
        {
          company_id: companyId,
          template_key: CHARGEBACK_TEMPLATE_KEY,
          recipient_email: email,
          recipient_user_id: ownerUserId,
          subject: getMessage("email.chargebackWarning.subject"),
          provider: method,
          max_attempts: EMAIL_MAX_ATTEMPTS,
          reference_kind: DISPUTE_TEMPLATE_REFERENCE_KIND,
          reference_id: null,
          queued_at: queuedAt,
        },
      ],
      idRowSchema,
    );

    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the extra reserve: pause what the merchant already has, then open one at the policy's percent.
 *
 * `reserves_active_key` allows one active reserve per merchant, and `reserves_guard_state` freezes the percent
 * of one that already exists, so "an extra reserve" cannot be a number moved on an old row. It is a new
 * agreement: the old one is paused with a note saying why, and the new one starts at the extra percent. A
 * merchant with no reserve yet gets one, which is the same act read from the simpler side.
 */
async function startExtraReserve(
  dependencies: ChargebackRateDependencies,
  input: {
    readonly companyId: string;
    readonly percentBps: number;
    readonly days: number;
    readonly startedAt: string;
    readonly note: string;
  },
): Promise<string> {
  const active = await dependencies.rest.select(
    "reserves",
    `select=id,percent_bps,version&company_id=eq.${encodeURIComponent(input.companyId)}` +
      "&status=eq.active&deleted_at=is.null&limit=1",
    reserveRowSchema,
  );
  const existing = active[0] ?? null;

  if (existing !== null) {
    if (existing.percent_bps >= input.percentBps) {
      // A merchant already withholding at least this share does not need a second agreement at a lower one:
      // the step is recorded against the reserve that is standing, and the row is the honest record of it.
      return existing.id;
    }

    await dependencies.rest.update(
      "reserves",
      `id=eq.${encodeURIComponent(existing.id)}&version=eq.${String(existing.version)}&status=eq.active`,
      { status: "paused", note: input.note.slice(0, 280) },
    );
  }

  const startedMs = Date.parse(input.startedAt);
  const rows = await dependencies.rest.insertReturning(
    "reserves",
    [
      {
        company_id: input.companyId,
        percent_bps: input.percentBps,
        release_days: input.days,
        currency: "USD",
        status: "active",
        started_at: input.startedAt,
        next_release_on: instantOf(startedMs + input.days * 24 * 60 * 60 * 1000),
        note: input.note.slice(0, 280),
      },
    ],
    idRowSchema,
  );
  const reserveId = rows[0]?.id;

  if (reserveId === undefined) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "reserve_not_written" } });
  }

  return reserveId;
}

/** Write the suspension the account lifecycle already knows how to derive, and how to return from. */
async function writeSuspensionEvent(
  dependencies: ChargebackRateDependencies,
  input: {
    readonly companyId: string;
    readonly actorUserId: string;
    readonly detail: string;
    readonly sustainedAt: string;
  },
): Promise<string> {
  const rows = await dependencies.rest.insertReturning(
    "merchant_account_events",
    [
      {
        company_id: input.companyId,
        event: "suspended",
        reason: "chargeback_program",
        detail: input.detail.slice(0, 280),
        required_documents: [],
        actor_user_id: input.actorUserId,
        chargeback_hold_release_at: null,
        created_at: input.sustainedAt,
        updated_at: input.sustainedAt,
      },
    ],
    idRowSchema,
  );
  const eventId = rows[0]?.id;

  if (eventId === undefined) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "suspension_not_written" } });
  }

  return eventId;
}

/* -------------------------------------------------------------------------------------------------
 * Taking a step
 * ---------------------------------------------------------------------------------------------- */

/**
 * The body of a step: the merchant, and the officer's own sentence for the one step a person takes.
 *
 * `companyId` is in the body rather than in the path because there is no per-merchant URL here: the act is the
 * platform's programme, and the merchant is which row of it. `.strict()`, so a caller cannot smuggle a `kind` in
 * and ask for a suspension the numbers do not earn.
 */
const applyBodySchema = z.object({ companyId: z.string().uuid(), reason: z.string().optional() }).strict();

export interface ChargebackApplyBody {
  readonly companyId: string;
  readonly reason: string | null;
}

/** Parse the apply body: a merchant, and a sentence for a suspension and nothing that is not one. */
export function parseApplyBody(body: unknown): ChargebackApplyBody {
  const parsed = applyBodySchema.safeParse(body);

  if (!parsed.success) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  const reason = parsed.data.reason?.trim() ?? null;

  if (reason !== null && (reason.length < 1 || reason.length > CHARGEBACK_NOTE_MAXIMUM_LENGTH)) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  return { companyId: parsed.data.companyId, reason };
}

/** The body of a clearing: the merchant, the step's word, and the sentence that says why it came off. */
const clearBodySchema = z
  .object({ companyId: z.string().uuid(), kind: z.string(), note: z.string() })
  .strict();

export interface ChargebackClearBody {
  readonly companyId: string;
  readonly kind: ChargebackKind;
  readonly note: string;
}

/** Parse the clear body: one step, trimmed and bounded, and never a suspension. */
export function parseClearBody(body: unknown): ChargebackClearBody {
  const parsed = clearBodySchema.safeParse(body);

  if (!parsed.success || !isChargebackKind(parsed.data.kind)) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  const note = parsed.data.note.trim();

  if (note.length < 1 || note.length > CHARGEBACK_NOTE_MAXIMUM_LENGTH) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  return { companyId: parsed.data.companyId, kind: parsed.data.kind, note };
}

/** The body of a sweep: one merchant, or every merchant. */
const sweepBodySchema = z.object({ company_id: z.string().uuid().optional() }).strict();

export interface ChargebackSweepBody {
  readonly companyId: string | null;
}

/** Parse the sweep body. */
export function parseSweepBody(body: unknown): ChargebackSweepBody {
  const parsed = sweepBodySchema.safeParse(body);

  if (!parsed.success) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  return { companyId: parsed.data.company_id ?? null };
}

/** One merchant's row, measured fresh: the single-merchant read the apply path needs. */
async function measureOne(
  dependencies: ChargebackRateDependencies,
  companyId: string,
  policy: ChargebackPolicyValues,
): Promise<{ readonly measurement: ChargebackMeasurement; readonly companyName: string }> {
  const companies = await dependencies.rest.select(
    "companies",
    `select=id,name&id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    companyRowSchema,
  );
  const company = companies[0];

  if (company === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { details: [{ field: CHARGEBACK_FIELD, rule: CHARGEBACK_RULES.companyMissing }] });
  }

  const nowMs = nowOf(dependencies);
  const window = windowOf(policy, nowMs);
  const payments = await countRows(
    dependencies.rest,
    "payments",
    `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null` +
      `&captured_at=gte.${encodeURIComponent(window.from)}&captured_at=lt.${encodeURIComponent(window.to)}`,
  );
  const chargebacks = await countRows(
    dependencies.rest,
    "disputes",
    `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null` +
      `&opened_at=gte.${encodeURIComponent(window.from)}&opened_at=lt.${encodeURIComponent(window.to)}`,
  );

  return {
    companyName: company.name,
    measurement: measurementOf({
      companyId,
      window,
      paymentsCount: payments.count,
      chargebacksCount: chargebacks.count,
      windowDays: policy.windowDays,
      truncated: payments.truncated || chargebacks.truncated,
    }),
  };
}

/** The roles that may take the automatic steps by pressing "run now": the desks that watch the rate. */
const CHARGEBACK_APPLY_ROLES: readonly PlatformRole[] = CHARGEBACK_READ_ROLES.filter((role) => role !== "ceo");

/** The live steps of one merchant, highest first. */
async function liveStepsOf(
  dependencies: ChargebackRateDependencies,
  companyId: string,
): Promise<readonly ChargebackStepView[]> {
  const steps = await readSteps(
    dependencies,
    `company_id=eq.${encodeURIComponent(companyId)}`,
    CHARGEBACK_HISTORY_LIMIT,
  );

  return steps.filter((step) => step.clearedAt === null);
}

/** Append one chain entry, tolerating a chain that is not configured. */
async function note(
  dependencies: ChargebackRateDependencies,
  action: string,
  input: {
    readonly actorUserId: string | null;
    readonly companyId: string | null;
    readonly sessionId: string | null;
    readonly entityId: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const entry: AuditEntry = {
    action,
    actorUserId: input.actorUserId,
    entityType: action === CHARGEBACK_AUDIT.policySaved ? "platform_settings" : CHARGEBACK_ACTION_ENTITY,
    entityId: input.entityId,
    payload: input.payload,
    companyId: input.companyId,
    sessionId: input.sessionId,
    ipAddress: null,
    userAgent: null,
  };

  await appendTolerated(dependencies.audit, entry);
}

/** The chain is evidence, not a lock: a failed append is logged by the caller's route and never unwinds a step. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // The manual steps carry their actor in the row itself, and the automatic ones are the platform's; a chain
    // outage must not leave a merchant reserved in the ledger and un-reserved in the watchlist.
  }
}

/**
 * Take the step one merchant's numbers earn.
 *
 * The refusal order is deliberate: an existing suspension first, because nothing above it exists; then the
 * decision, because a merchant under the bar has nothing to take; then a duplicate of the step already standing.
 * The effect is written before the action row, so a row always names something that exists, and `0128` refuses
 * the row if it does not.
 */
export async function applyChargebackStep(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: ChargebackRateDependencies,
): Promise<ChargebackStepView> {
  requireWatchRole(input.actor, CHARGEBACK_APPLY_ROLES);
  const body = parseApplyBody(input.body);
  const companyId = body.companyId;
  const policy = await readChargebackPolicyFor(input.actor, dependencies);
  const { measurement, companyName } = await measureOne(dependencies, companyId, policy.values);
  const standing = await liveStepsOf(dependencies, companyId);
  const suspended = standing.find((step) => step.kind === "suspension") ?? null;

  if (suspended !== null) {
    throw refused("CONFLICT", CHARGEBACK_RULES.suspended);
  }

  const decision = decideChargebackStep(measurement, policy.values);

  if (decision.kind === null) {
    throw refused("CONFLICT", decision.rule ?? CHARGEBACK_RULES.belowThreshold);
  }

  if (standing.some((step) => step.kind === decision.kind)) {
    throw refused("CONFLICT", CHARGEBACK_RULES.stepTaken);
  }

  const appliedAt = instantOf(nowOf(dependencies));
  const detail = detailOf(measurement, decision.kind, policy.values);

  if (decision.kind === "suspension") {
    requireAnyRole(input.actor, CHARGEBACK_SUSPEND_ROLES);

    if (!hasSatisfiedTwoFactor(input.actor)) {
      throw new AppError("PERMISSION_DENIED");
    }

    if (body.reason === null) {
      throw refused("VALIDATION_FAILED", CHARGEBACK_RULES.suspensionReasonRequired);
    }
  }

  const emailSendId =
    decision.kind === "warning" ? await queueNotice(dependencies, companyId, appliedAt) : null;
  const reserveId =
    decision.kind === "reserve"
      ? await startExtraReserve(dependencies, {
          companyId: companyId,
          percentBps: policy.values.reservePercentBps,
          days: policy.values.reserveDays,
          startedAt: appliedAt,
          note: `${companyName}: ${detail}`,
        })
      : null;
  const accountEventId =
    decision.kind === "suspension"
      ? await writeSuspensionEvent(dependencies, {
          companyId: companyId,
          actorUserId: input.actor.userId,
          detail: body.reason ?? detail,
          sustainedAt: appliedAt,
        })
      : null;
  const rows = await dependencies.rest.insertReturning(
    CHARGEBACK_ACTIONS_TABLE,
    [
      {
        company_id: companyId,
        kind: decision.kind,
        mode: decision.kind === "suspension" ? "manual" : "automatic",
        window_days: measurement.windowDays,
        payments_count: measurement.paymentsCount,
        chargebacks_count: measurement.chargebacksCount,
        rate_bps: measurement.rateBps,
        minimum_transactions: policy.values.minimumTransactions,
        warning_rate_bps: policy.values.warningRateBps,
        reserve_rate_bps: policy.values.reserveRateBps,
        suspension_rate_bps: policy.values.suspensionRateBps,
        reserve_percent_bps: decision.kind === "reserve" ? policy.values.reservePercentBps : null,
        detail,
        actor_user_id: decision.kind === "suspension" ? input.actor.userId : null,
        reserve_id: reserveId,
        account_event_id: accountEventId,
        email_send_id: emailSendId,
        applied_at: appliedAt,
      },
    ],
    actionRowSchema,
  );
  const written = rows[0];

  if (written === undefined) {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "action_not_written" } });
  }

  await note(dependencies, CHARGEBACK_AUDIT.actionApplied, {
    actorUserId: decision.kind === "suspension" ? input.actor.userId : null,
    companyId: companyId,
    sessionId: input.actor.sessionId,
    entityId: written.id,
    payload: {
      kind: decision.kind,
      mode: written.mode,
      policy_digest: policy.digest,
      window_days: measurement.windowDays,
      payments_count: measurement.paymentsCount,
      chargebacks_count: measurement.chargebacksCount,
      rate_bps: measurement.rateBps,
      reserve_percent_bps: written.reserve_percent_bps,
      reserve_id: reserveId,
      account_event_id: accountEventId,
      email_send_id: emailSendId,
    },
  });

  return stepViewOf(written);
}

/**
 * Clear a warning or an extra reserve after the rate came back down.
 *
 * A suspension is not clearable here for the reason `0128` states: returning a suspended merchant to trading is
 * `0111`'s reactivation, which asks for documents and records who let them back - a different act with a
 * different evidence trail, and this service does not pretend to be it.
 */
export async function clearChargebackAction(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: ChargebackRateDependencies,
): Promise<ChargebackStepView> {
  requireWatchRole(input.actor, CHARGEBACK_POLICY_ROLES);
  const body = parseClearBody(input.body);
  const companyId = body.companyId;
  const kind = body.kind;

  if (!isClearableKind(kind)) {
    throw refused("CONFLICT", CHARGEBACK_RULES.notClearable);
  }

  const rows = await dependencies.rest.select(
    CHARGEBACK_ACTIONS_TABLE,
    `${ACTION_COLUMNS}&company_id=eq.${encodeURIComponent(companyId)}&kind=eq.${kind}` +
      "&deleted_at=is.null&order=applied_at.desc&limit=1",
    actionRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: CHARGEBACK_FIELD, rule: CHARGEBACK_RULES.companyMissing }],
    });
  }

  if (row.cleared_at !== null) {
    throw refused("CONFLICT", CHARGEBACK_RULES.alreadyCleared);
  }

  const clearedAt = instantOf(nowOf(dependencies));

  await dependencies.rest.update(
    CHARGEBACK_ACTIONS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${String(row.version)}&cleared_at=is.null`,
    { cleared_at: clearedAt, cleared_by_user_id: input.actor.userId, clear_note: body.note },
  );

  const after = await dependencies.rest.select(
    CHARGEBACK_ACTIONS_TABLE,
    `${ACTION_COLUMNS}&id=eq.${encodeURIComponent(row.id)}&limit=1`,
    actionRowSchema,
  );
  const cleared = after[0];

  if (cleared === undefined || cleared.cleared_at === null) {
    throw new AppError("CONFLICT", { details: [{ field: CHARGEBACK_FIELD, rule: "stale" }] });
  }

  await note(dependencies, CHARGEBACK_AUDIT.actionCleared, {
    actorUserId: input.actor.userId,
    companyId,
    sessionId: input.actor.sessionId,
    entityId: cleared.id,
    payload: { kind, cleared_at: clearedAt, note_length: body.note.length },
  });

  return stepViewOf(cleared);
}

/**
 * The sweep: measure every merchant and take the steps the platform takes alone.
 *
 * A suspension is counted and never taken - the sweep reports how many merchants' numbers earn one, and the
 * watchlist is where a super administrator reads them and signs. That is also why the sweep's result names
 * `suspensionsDue`: a report a person acts on is not the same object as a decision, and mixing them is how an
 * automated system suspends somebody nobody looked at.
 */
export async function runChargebackSweep(
  input: { readonly companyId: string | null },
  dependencies: ChargebackRateDependencies,
): Promise<ChargebackSweepResult> {
  const policy = await readChargebackPolicy(dependencies);
  const nowMs = nowOf(dependencies);
  const window = windowOf(policy.values, nowMs);
  const companies =
    input.companyId === null
      ? await dependencies.rest.select(
          "companies",
          `select=id,name&deleted_at=is.null&order=name.asc&limit=${String(CHARGEBACK_WATCHLIST_LIMIT)}`,
          companyRowSchema,
        )
      : (
          await dependencies.rest.select(
            "companies",
            `select=id,name&id=eq.${encodeURIComponent(input.companyId)}&deleted_at=is.null&limit=1`,
            companyRowSchema,
          )
        );
  const counts = await readWindowCounts(dependencies.rest, window);
  const live = await readSteps(dependencies, "cleared_at=is.null", CHARGEBACK_WATCHLIST_LIMIT * 3);
  const liveByCompany = new Map<string, ChargebackStepView>();

  for (const step of live) {
    const current = liveByCompany.get(step.companyId);

    if (current === undefined || chargebackRank(step.kind) > chargebackRank(current.kind)) {
      liveByCompany.set(step.companyId, step);
    }
  }

  let warned = 0;
  let reserved = 0;
  let suspensionsDue = 0;
  let skipped = 0;

  for (const company of companies) {
    const measurement = measurementOf({
      companyId: company.id,
      window,
      paymentsCount: counts.payments.get(company.id) ?? 0,
      chargebacksCount: counts.chargebacks.get(company.id) ?? 0,
      windowDays: policy.values.windowDays,
      truncated: counts.truncated,
    });
    const decision = decideChargebackStep(measurement, policy.values);
    const standing = liveByCompany.get(company.id) ?? null;

    if (decision.kind === null) {
      skipped += 1;
      continue;
    }

    if (decision.kind === "suspension") {
      suspensionsDue += 1;
      skipped += 1;
      continue;
    }

    if (standing !== null && chargebackRank(standing.kind) >= chargebackRank(decision.kind)) {
      skipped += 1;
      continue;
    }

    const appliedAt = instantOf(nowMs);
    const detail = detailOf(measurement, decision.kind, policy.values);

    try {
      const emailSendId = decision.kind === "warning" ? await queueNotice(dependencies, company.id, appliedAt) : null;
      const reserveId =
        decision.kind === "reserve"
          ? await startExtraReserve(dependencies, {
              companyId: company.id,
              percentBps: policy.values.reservePercentBps,
              days: policy.values.reserveDays,
              startedAt: appliedAt,
              note: `${company.name}: ${detail}`,
            })
          : null;
      const rows = await dependencies.rest.insertReturning(
        CHARGEBACK_ACTIONS_TABLE,
        [
          {
            company_id: company.id,
            kind: decision.kind,
            mode: "automatic",
            window_days: measurement.windowDays,
            payments_count: measurement.paymentsCount,
            chargebacks_count: measurement.chargebacksCount,
            rate_bps: measurement.rateBps,
            minimum_transactions: policy.values.minimumTransactions,
            warning_rate_bps: policy.values.warningRateBps,
            reserve_rate_bps: policy.values.reserveRateBps,
            suspension_rate_bps: policy.values.suspensionRateBps,
            reserve_percent_bps: decision.kind === "reserve" ? policy.values.reservePercentBps : null,
            detail,
            actor_user_id: null,
            reserve_id: reserveId,
            account_event_id: null,
            email_send_id: emailSendId,
            applied_at: appliedAt,
          },
        ],
        actionRowSchema,
      );
      const written = rows[0];

      if (written === undefined) {
        skipped += 1;
        continue;
      }

      if (decision.kind === "warning") {
        warned += 1;
      } else {
        reserved += 1;
      }

      await note(dependencies, CHARGEBACK_AUDIT.actionApplied, {
        actorUserId: null,
        companyId: company.id,
        sessionId: null,
        entityId: written.id,
        payload: {
          kind: decision.kind,
          mode: "automatic",
          policy_digest: policy.digest,
          rate_bps: measurement.rateBps,
          payments_count: measurement.paymentsCount,
          chargebacks_count: measurement.chargebacksCount,
          reserve_percent_bps: written.reserve_percent_bps,
          reserve_id: reserveId,
          email_send_id: emailSendId,
        },
      });
    } catch {
      // One merchant's failure never stops the sweep: a refused row is a row the next tick re-measures, and the
      // companies after this one are entitled to theirs today.
      skipped += 1;
    }
  }

  const result: ChargebackSweepResult = {
    measured: companies.length,
    warned,
    reserved,
    suspensionsDue,
    skipped,
    truncated: counts.truncated ? companies.length : 0,
  };

  await note(dependencies, CHARGEBACK_AUDIT.sweepRun, {
    actorUserId: null,
    companyId: null,
    sessionId: null,
    entityId: input.companyId,
    payload: {
      policy_digest: policy.digest,
      measured: result.measured,
      warned: result.warned,
      reserved: result.reserved,
      suspensions_due: result.suspensionsDue,
      skipped: result.skipped,
      truncated: counts.truncated,
    },
  });

  return result;
}
