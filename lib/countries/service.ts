// path: lib/countries/service.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { requireAnyRole } from "../auth/session.ts";
import { requireFreshReauthentication } from "../auth/step-up.ts";
import type { RequestActor } from "../auth/types.ts";
import {
  APPROVAL_QUEUE_LIMIT,
  canRequestApproval,
  requesterRolesOf,
  stageOf,
  type ApprovalStage,
  type ApprovalStatus,
} from "../approvals/registry.ts";
import { expireLapsedApprovals, requestApproval } from "../approvals/service.ts";
import {
  COUNTRY_DISABLED_AUDIT_ACTION,
  COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH,
  COUNTRY_DISABLE_REASON_MINIMUM_LENGTH,
  COUNTRY_ENABLE_ACTION,
  COUNTRY_ENABLED_AUDIT_ACTION,
  COUNTRY_SWITCH_LIMIT,
  COUNTRY_SWITCH_ROLES,
  countrySwitchStateOf,
  disableProblemOf,
  enableProblemOf,
  requestProblemOf,
  type CountrySwitchState,
} from "./registry.ts";

/**
 * Section 3's country switch: the list, the two turns, and the decision an opening spends.
 *
 * ## What the section asks for, and where each sentence is kept
 *
 *   - "Country enable and disable switch at platform level" - one row per ISO 3166-1 country with one
 *     boolean, seeded and frozen by `0076`; this file only ever writes `is_enabled` and the sentence
 *     beside it.
 *   - "controlled by super_admin and CEO" - `COUNTRY_SWITCH_ROLES` in every entry point, plus a fresh
 *     second factor on both turns (STEP 053).
 *   - "Sanctioned countries stay permanently disabled" - the state is read from two flags, the service
 *     refuses a sanctioned row before it writes, and `countries_sanctioned_disabled_check` refuses it
 *     again if this code ever forgets. The seed sets the flag and the guard trigger freezes it.
 *
 * ## Why opening spends a decision and closing does not
 *
 * Opening a market is the act the chain of section 2 exists for: `country_enable` is one of its four
 * actions, the CEO approves it, the super administrator confirms it, and this file spends that
 * approval (`approval_requests.consumed_at` of `0098`) in the same call that flips the switch. One
 * decision therefore opens one market exactly once, and a second opening needs a second decision.
 *
 * Closing is the opposite direction: a sanctions listing or a processor outage is a reason to stop
 * selling today, not after two signatures. It is still the two controllers' act, it still needs a
 * written reason of its own, and it is still audited - the reason lands in `disabled_reason` and the
 * action on the trail.
 *
 * ## Why the approval is spent before the switch is flipped
 *
 * The spend is the conditional write that can fail without a consequence: if somebody else already
 * spent the decision, nothing has been switched and the operator is told so. The flip then either
 * lands or does not, and a flip that loses a race releases the spend again rather than leaving a
 * market closed with a decision burned behind it. Both writes name the row they read, so a screen
 * that was open for an hour cannot overwrite a decision taken in between; `set_row_metadata` owns
 * `version`, so this module never writes the column itself.
 *
 * ## What is deliberately not here
 *
 * The pending-request list is read, not decided: a decision is STEP 072's route, and this screen links
 * to it rather than signing beside it. There is also no delete and no "add a country": `0076` refuses
 * both, and a new country is a new migration.
 */

/** The two tables this module needs, and no more. */
export type CountryStore = Omit<RestClient, "rpc">;

export interface CountryDependencies {
  readonly store: CountryStore;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** A decision still in the chain, as the list shows it beside its country. */
export interface CountryRequestView {
  readonly approvalId: string;
  readonly stage: ApprovalStage;
  readonly requestedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  /** True once the window has passed. The sweep of STEP 072 closes it; this list stops counting it. */
  readonly expired: boolean;
}

/** An approved decision nobody has spent yet: what an opening needs. */
export interface CountryOpeningView {
  readonly approvalId: string;
  readonly confirmedAtEpochMs: number;
}

/** One country, as the switch screen reads it. */
export interface CountrySwitchView {
  readonly id: string;
  readonly code: string;
  readonly alpha3: string;
  readonly name: string;
  readonly state: CountrySwitchState;
  /** Why the country is sanctioned, from `0076`'s seed. Null for every other country. */
  readonly sanctionNote: string | null;
  /** Why an operator closed it, in their own words. Null while it is open or was never closed. */
  readonly disabledReason: string | null;
  readonly version: number;
  /** The decision waiting for a signature, when one is. */
  readonly pending: CountryRequestView | null;
  /** The approved, unspent decision that would let this country open. */
  readonly opening: CountryOpeningView | null;
  /** True when this operator may open it now: it is off and an approved decision stands behind it. */
  readonly canEnable: boolean;
  /** True when this operator may close it now. */
  readonly canDisable: boolean;
  /** True when this operator may raise the opening decision. Only the super administrator may. */
  readonly canRequest: boolean;
}

/** Everything the switch screen renders: the rows, the counts, and what this account may raise. */
export interface CountrySwitchSnapshot {
  readonly countries: readonly CountrySwitchView[];
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly sanctionedCount: number;
  /** Decisions waiting for a signature, which is what the CEO's desk is for. */
  readonly awaitingDecisionCount: number;
  /** Countries an approved decision would open as soon as somebody spends it. */
  readonly readyToOpenCount: number;
  readonly readAtEpochMs: number;
  /** True when this account may raise an opening decision, so the screen can offer the form. */
  readonly canRaise: boolean;
}

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/u);

const instantSchema = z.string().min(1).max(40);

const countryRowSchema = z.object({
  id: z.string().min(1).max(64),
  code: z.string().length(2),
  alpha3: z.string().length(3),
  name: z.string().min(1).max(120),
  is_enabled: z.boolean(),
  is_sanctioned: z.boolean(),
  sanction_note: z.string().max(400).nullable(),
  disabled_reason: z.string().max(COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH).nullable(),
  version: z.number().int().positive(),
});

const openRequestRowSchema = z.object({
  id: z.string().min(1).max(64),
  subject_id: z.string().min(1).max(64),
  status: z.string().min(1).max(20),
  requested_at: instantSchema,
  expires_at: instantSchema,
  super_admin_confirmed_at: instantSchema.nullable(),
});

const versionRowSchema = z.object({ version: z.number().int().positive() });

const spentApprovalRowSchema = z.object({
  id: z.string().min(1).max(64),
  consumed_at: instantSchema.nullable(),
  consumed_by: z.string().min(1).max(64).nullable(),
});

const countryColumns =
  "select=id,code,alpha3,name,is_enabled,is_sanctioned,sanction_note,disabled_reason,version";

const countrySelect =
  `${countryColumns}&company_id=is.null&deleted_at=is.null&order=name.asc` +
  `&limit=${String(COUNTRY_SWITCH_LIMIT)}`;

const openRequestSelect =
  "select=id,subject_id,status,requested_at,expires_at,super_admin_confirmed_at" +
  "&action_type=eq.country_enable&deleted_at=is.null&consumed_at=is.null" +
  `&limit=${String(COUNTRY_SWITCH_LIMIT)}`;

function nowOf(dependencies: CountryDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function epochOf(value: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The role and the freshness both turns need.
 *
 * `403` without a rule is "this account does not control the switch"; `403` with `reauth_required` is
 * STEP 053's window. Both come from these two calls and from nowhere else, so a second entry point
 * cannot reach a weaker path than the screen.
 */
function requireCountryController(actor: RequestActor, instant: number): void {
  requireAnyRole(actor, COUNTRY_SWITCH_ROLES);
  requireFreshReauthentication(actor, instant);
}

/** The rows of the reference list, in the order the list renders them. */
async function readCountries(
  dependencies: CountryDependencies,
): Promise<readonly z.infer<typeof countryRowSchema>[]> {
  return dependencies.store.select("countries", countrySelect, countryRowSchema);
}

/** The open decisions of this switch: still in the chain, or approved and not yet spent. */
async function readOpenRequests(
  dependencies: CountryDependencies,
): Promise<readonly z.infer<typeof openRequestRowSchema>[]> {
  return dependencies.store.select("approval_requests", openRequestSelect, openRequestRowSchema);
}

/** One country by identifier, or `RESOURCE_NOT_FOUND`. */
async function readCountry(
  dependencies: CountryDependencies,
  countryId: string,
): Promise<z.infer<typeof countryRowSchema>> {
  const parsed = identifierSchema.safeParse(countryId);

  if (!parsed.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const rows = await dependencies.store.select(
    "countries",
    `${countryColumns}&id=eq.${encoded(parsed.data)}&company_id=is.null&deleted_at=is.null&limit=1`,
    countryRowSchema,
  );

  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return row;
}

interface RequestProgress {
  readonly pending: CountryRequestView | null;
  readonly opening: CountryOpeningView | null;
}

/**
 * Fold the open decisions into one per country.
 *
 * A country can hold at most one live request (the partial unique index of `0095` says so) and at
 * most one unspent approval per decision cycle; the first of each the reader meets wins, so a store
 * that answers in any order cannot change the picture.
 */
function progressOf(
  requests: readonly z.infer<typeof openRequestRowSchema>[],
  instant: number,
): ReadonlyMap<string, RequestProgress> {
  const pending = new Map<string, CountryRequestView>();
  const opening = new Map<string, CountryOpeningView>();

  for (const row of requests) {
    const status: ApprovalStatus | null =
      row.status === "pending_ceo" || row.status === "pending_super_admin" || row.status === "approved"
        ? row.status
        : null;

    if (status === null) {
      continue;
    }

    if (status === "approved") {
      const confirmedAt = row.super_admin_confirmed_at;

      if (confirmedAt !== null && !opening.has(row.subject_id)) {
        opening.set(row.subject_id, {
          approvalId: row.id,
          confirmedAtEpochMs: epochOf(confirmedAt),
        });
      }

      continue;
    }

    const stage = stageOf(status);

    if (stage === "closed" || pending.has(row.subject_id)) {
      continue;
    }

    const expiresAtEpochMs = epochOf(row.expires_at);

    pending.set(row.subject_id, {
      approvalId: row.id,
      stage,
      requestedAtEpochMs: epochOf(row.requested_at),
      expiresAtEpochMs,
      expired: expiresAtEpochMs <= instant,
    });
  }

  const merged = new Map<string, RequestProgress>();

  for (const [subjectId, view] of pending) {
    merged.set(subjectId, { pending: view, opening: opening.get(subjectId) ?? null });
  }

  for (const [subjectId, view] of opening) {
    if (!merged.has(subjectId)) {
      merged.set(subjectId, { pending: null, opening: view });
    }
  }

  return merged;
}

/** One row of the list, with the turns this account may take on it. */
function viewOf(
  row: z.infer<typeof countryRowSchema>,
  progress: RequestProgress,
  canRaise: boolean,
): CountrySwitchView {
  const state = countrySwitchStateOf({
    isEnabled: row.is_enabled,
    isSanctioned: row.is_sanctioned,
  });
  const liveRequest = progress.pending !== null && !progress.pending.expired;

  return {
    id: row.id,
    code: row.code,
    alpha3: row.alpha3,
    name: row.name,
    state,
    sanctionNote: row.sanction_note,
    disabledReason: state === "enabled" ? null : row.disabled_reason,
    version: row.version,
    pending: progress.pending,
    opening: progress.opening,
    canEnable:
      enableProblemOf({ state, hasApproval: progress.opening !== null }) === null,
    canDisable: disableProblemOf({ state }) === null,
    canRequest: canRaise && requestProblemOf({ state, hasLiveRequest: liveRequest }) === null,
  };
}

/** The whole screen: the rows, the counts and what this account may raise. */
async function snapshotOf(
  actor: RequestActor,
  dependencies: CountryDependencies,
): Promise<CountrySwitchSnapshot> {
  const instant = nowOf(dependencies);
  const canRaise = canRequestApproval(actor.roles, COUNTRY_ENABLE_ACTION);
  const [rows, requests] = await Promise.all([
    readCountries(dependencies),
    readOpenRequests(dependencies),
  ]);
  const progress = progressOf(requests, instant);
  const countries = rows.map((row) =>
    viewOf(row, progress.get(row.id) ?? { pending: null, opening: null }, canRaise),
  );

  return {
    countries,
    enabledCount: countries.filter((country) => country.state === "enabled").length,
    disabledCount: countries.filter((country) => country.state === "disabled").length,
    sanctionedCount: countries.filter((country) => country.state === "sanctioned").length,
    awaitingDecisionCount: countries.filter(
      (country) => country.pending !== null && !country.pending.expired,
    ).length,
    readyToOpenCount: countries.filter((country) => country.canEnable).length,
    readAtEpochMs: instant,
    canRaise,
  };
}

/**
 * A compare-and-set write, using the version the caller has already read.
 *
 * The filter means a row somebody else turned does not match, and the read-back distinguishes that
 * from a write that landed: `set_row_metadata` sets `version` to the old value plus one, so the row
 * this call wrote answers `expectedVersion + 1`. Anything else is `CONFLICT`, which the screen shows
 * as "this changed while you were looking at it", not as a failure to save.
 */
async function writeWithVersion(
  dependencies: CountryDependencies,
  countryId: string,
  expectedVersion: number,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencies.store.update(
    "countries",
    `id=eq.${encoded(countryId)}&version=eq.${String(expectedVersion)}`,
    values,
  );

  const rows = await dependencies.store.select(
    "countries",
    `select=version&id=eq.${encoded(countryId)}&limit=1`,
    versionRowSchema,
  );

  if (rows[0]?.version !== expectedVersion + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }
}

/**
 * Spend one approved decision, or refuse because somebody else already did.
 *
 * The filter is the authority check: a row whose `consumed_at` is no longer null does not match, so
 * two operators pressing "open" on one decision spend it once. The read-back says which of the two
 * happened, and the answer names `approvalId` rather than the country, because the country is fine
 * and the decision is what ran out.
 */
async function spendApproval(
  dependencies: CountryDependencies,
  approvalId: string,
  actorId: string,
  instant: number,
): Promise<string> {
  const spentAt = new Date(instant).toISOString();

  await dependencies.store.update(
    "approval_requests",
    `id=eq.${encoded(approvalId)}&status=eq.approved&consumed_at=is.null`,
    { consumed_at: spentAt, consumed_by: actorId },
  );

  const rows = await dependencies.store.select(
    "approval_requests",
    `select=id,consumed_at,consumed_by&id=eq.${encoded(approvalId)}&limit=1`,
    spentApprovalRowSchema,
  );

  if (rows[0]?.consumed_by !== actorId) {
    throw new AppError("CONFLICT", { details: [{ field: "approvalId", rule: "already_used" }] });
  }

  return spentAt;
}

/** Give a decision back when the switch it was spent on did not move, so nothing is burned. */
async function releaseApproval(
  dependencies: CountryDependencies,
  approvalId: string,
  actorId: string,
  spentAt: string,
): Promise<void> {
  await dependencies.store.update(
    "approval_requests",
    `id=eq.${encoded(approvalId)}&consumed_at=eq.${encoded(spentAt)}` +
      `&consumed_by=eq.${encoded(actorId)}`,
    { consumed_at: null, consumed_by: null },
  );
}

/**
 * The switch screen's read.
 *
 * Refused before the first query for any account that does not hold one of section 3's two roles, so
 * the list is never a way around the switch's own rule.
 */
export async function listCountrySwitches(
  input: { readonly actor: RequestActor },
  dependencies: CountryDependencies,
): Promise<CountrySwitchSnapshot> {
  requireAnyRole(input.actor, COUNTRY_SWITCH_ROLES);

  return snapshotOf(input.actor, dependencies);
}

/**
 * Open one country, spending the approved decision that authorises it.
 *
 * The order is the design: refuse a sanctioned or already open row, refuse a row no decision stands
 * behind, spend the decision, flip the switch, and give the decision back if the flip lost a race.
 * The audit entry names the decision that was spent, so the trail answers both "who opened this
 * market" and "on whose signature".
 */
export async function enableCountry(
  input: { readonly actor: RequestActor; readonly countryId: string },
  dependencies: CountryDependencies,
): Promise<CountrySwitchSnapshot> {
  const instant = nowOf(dependencies);

  requireCountryController(input.actor, instant);

  const row = await readCountry(dependencies, input.countryId);
  const state = countrySwitchStateOf({
    isEnabled: row.is_enabled,
    isSanctioned: row.is_sanctioned,
  });

  if (state === "sanctioned") {
    throw new AppError("CONFLICT", { details: [{ field: "countryId", rule: "sanctioned" }] });
  }

  if (state === "enabled") {
    throw new AppError("CONFLICT", { details: [{ field: "countryId", rule: "already_on" }] });
  }

  const progress = progressOf(await readOpenRequests(dependencies), instant).get(row.id) ?? {
    pending: null,
    opening: null,
  };
  const opening = progress.opening;

  if (opening === null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "countryId", rule: "approval_required" }],
    });
  }

  const spentAt = await spendApproval(dependencies, opening.approvalId, input.actor.userId, instant);

  try {
    await writeWithVersion(dependencies, row.id, row.version, {
      is_enabled: true,
      disabled_reason: null,
    });
  } catch (error) {
    await releaseApproval(dependencies, opening.approvalId, input.actor.userId, spentAt);

    throw error;
  }

  await dependencies.audit.append({
    action: COUNTRY_ENABLED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "country",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      code: row.code,
      name: row.name,
      approval_request_id: opening.approvalId,
      approval_confirmed_at: new Date(opening.confirmedAtEpochMs).toISOString(),
    },
  });

  return snapshotOf(input.actor, dependencies);
}

/**
 * Close one country, with the sentence that explains why.
 *
 * The reason is required by `countries_disabled_reason_check` for every closed market, so it is
 * trimmed and bounded here rather than met as a database error. A sanctioned country is refused
 * before the write: it is already closed and it already carries the sentence that matters.
 */
export async function disableCountry(
  input: { readonly actor: RequestActor; readonly countryId: string; readonly reason: string },
  dependencies: CountryDependencies,
): Promise<CountrySwitchSnapshot> {
  const instant = nowOf(dependencies);

  requireCountryController(input.actor, instant);

  const reason = input.reason.trim();

  if (
    reason.length < COUNTRY_DISABLE_REASON_MINIMUM_LENGTH ||
    reason.length > COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "reason", rule: "invalid_length" }],
    });
  }

  const row = await readCountry(dependencies, input.countryId);
  const state = countrySwitchStateOf({
    isEnabled: row.is_enabled,
    isSanctioned: row.is_sanctioned,
  });
  const problem = disableProblemOf({ state });

  if (problem !== null) {
    throw new AppError("CONFLICT", { details: [{ field: "countryId", rule: problem }] });
  }

  await writeWithVersion(dependencies, row.id, row.version, {
    is_enabled: false,
    disabled_reason: reason,
  });

  await dependencies.audit.append({
    action: COUNTRY_DISABLED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "country",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      code: row.code,
      name: row.name,
      reason_length: reason.length,
    },
  });

  return snapshotOf(input.actor, dependencies);
}

/**
 * Ask the chain for one country to be opened.
 *
 * The request is raised through STEP 070's `requestApproval`, so the requester matrix, the note's
 * bounds, the duplicate check and the audit entry are the ones the chain already owns - this function
 * adds only the two facts about the country that make the ask meaningful: it exists, it is off, and
 * it is not sanctioned.
 *
 * ## Why a lapsed request is swept here
 *
 * An undecided request stops being a request when its window passes, but only a sweep changes its
 * status, and the chain has no timer yet. The duplicate check reads the status, so a lapsed row still
 * holds its subject; when that is what refused the ask, one sweep of STEP 072's own function is run
 * and the ask is tried once more. That is the smallest place to put the wiring: the operator asked
 * for a decision, and the answer they get is either a new request or the reason they cannot have one.
 */
export async function requestCountryEnable(
  input: { readonly actor: RequestActor; readonly countryId: string; readonly note: string },
  dependencies: CountryDependencies,
): Promise<CountrySwitchSnapshot> {
  const instant = nowOf(dependencies);

  requireAnyRole(input.actor, requesterRolesOf(COUNTRY_ENABLE_ACTION));

  const row = await readCountry(dependencies, input.countryId);
  const state = countrySwitchStateOf({
    isEnabled: row.is_enabled,
    isSanctioned: row.is_sanctioned,
  });

  if (state === "sanctioned") {
    throw new AppError("CONFLICT", { details: [{ field: "countryId", rule: "sanctioned" }] });
  }

  if (state === "enabled") {
    throw new AppError("CONFLICT", { details: [{ field: "countryId", rule: "already_on" }] });
  }

  const raise = async (): Promise<void> => {
    await requestApproval(
      {
        actor: input.actor,
        actionType: COUNTRY_ENABLE_ACTION,
        subjectId: row.id,
        subjectLabel: `${row.name} (${row.code})`,
        amountMinor: null,
        currency: null,
        note: input.note,
      },
      { store: dependencies.store, audit: dependencies.audit, now: () => instant },
    );
  };

  try {
    await raise();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "CONFLICT") {
      throw error;
    }

    const sweep = await expireLapsedApprovals(
      { limit: APPROVAL_QUEUE_LIMIT },
      { store: dependencies.store, audit: dependencies.audit, now: () => instant },
    );

    if (sweep.expired === 0) {
      throw error;
    }

    await raise();
  }

  return snapshotOf(input.actor, dependencies);
}
