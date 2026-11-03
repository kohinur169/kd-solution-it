// path: services/kyc/account-lifecycle.ts
import { z } from "zod";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { enqueueJob, type JobRegistry } from "../../lib/jobs/registry.ts";
import type { JobQueue } from "../../lib/jobs/queue.ts";
import type { EnqueueResult, JobDefinition } from "../../lib/jobs/types.ts";
import { enqueueCardTokenDeletion } from "../submerchant/card-tokens.ts";
import { KYC_DOCUMENTS_TABLE, KYC_SUBMISSIONS_TABLE } from "./kyc-capture.ts";
import { BUSINESS_PROFILE_TABLE } from "./business-profile.ts";
import { MCC_CODES_TABLE } from "./merchant-category.ts";
import { UNDERWRITING_RISK_TIERS_TABLE } from "./underwriting.ts";

/**
 * The merchant account lifecycle of FEATURE_LIST section 13: suspension, reactivation and account
 * closure, with the saved card token deletion and the chargeback period fund hold that come with a
 * closure.
 *
 * ## The record
 *
 * `0111`'s `merchant_account_events` is an append-only log; the current state of a merchant is the
 * latest of its five state bearing events (`suspended`, `reactivation_requested`, `reactivated`,
 * `closure_requested`, `closed` - the `card_tokens_deleted` event does not change the state). No
 * event is ever rewritten or removed, which is the 7 year retention of section 13 line 156: closed
 * and suspended account data stays readable.
 *
 * ## The flows
 *
 *   - `suspendMerchant` (office roles) records `suspended` with a reason from the closed list and
 *     the required reactivation documents, and sets every live owner user of the company to
 *     `suspended` - `0003`'s status column is what `lib/auth/session.ts` reads on every request, so
 *     the suspension is real from the next request on, not just a row.
 *   - `requestReactivation` (the merchant owner) records `reactivation_requested`, naming the
 *     submission the merchant answered the suspension with (the normal KYC submit flow of STEP 087
 *     is the upload path: documents, screening, submit).
 *   - `decideReactivation` (office roles) accepts the request only when the named submission is
 *     `approved` and none of its documents was rejected, sets the owners back to `active` and
 *     records `reactivated`.
 *   - `requestAccountClosure` (the merchant owner) records `closure_requested`.
 *   - `closeMerchantAccount` (office roles) closes the account: it records `closed` with the verified
 *     payout bank account, the `hold_release_at` (the merchant's own hold period from its
 *     underwriting risk tier, `0106`'s `hold_days`) and the `chargeback_hold_release_at` (the
 *     `chargeback.hold_days` platform setting seeded by `0111`, 180 days by default); it holds the
 *     chargeback liability part of the remaining balance as a `0043` `holds` row of reason
 *     `closure` until the chargeback period ends; it enqueues the `merchant_account.closure_payout`
 *     job, delayed to `hold_release_at`, which sends the rest to the bank (section 13 line 154); it
 *     moves every verified sub-merchant provision to `restricted` with both flags off and enqueues
 *     the saved card token deletion of `services/submerchant/card-tokens.ts` at once (line 155); and
 *     it sets the owners to `closed`. Every write is audited.
 *
 * ## The balance
 *
 * "Remaining money" is the credit balance of the merchant's `merchant_payable` ledger account of
 * `0040`: the sum of its `0041` entries, credit minus debit, reversals included as their mirror
 * entries. The chargeback liability funds are the reserve part of it - the merchant's risk tier's
 * `extra_reserve_percent` - and the rest is what the delayed payout job sends after the hold period.
 * The payout row itself is written by the job, because the money leaves only after the hold period;
 * the approval and processing of that row belong to the finance flow of the payment STEPs.
 */

/** The `0111` table: the append-only lifecycle event log. */
export const MERCHANT_ACCOUNT_EVENTS_TABLE = "merchant_account_events";

/** The audit entity of an event row. */
export const MERCHANT_ACCOUNT_EVENT_ENTITY = "merchant_account_event";

/** The five events that change the account state; the token deletion event does not. */
export const STATE_EVENTS = [
  "suspended",
  "reactivation_requested",
  "reactivated",
  "closure_requested",
  "closed",
] as const;

/** The full event vocabulary of `0111`. */
export const MERCHANT_ACCOUNT_EVENTS = [...STATE_EVENTS, "card_tokens_deleted"] as const;

/** The suspension reasons of `0111`. */
export const SUSPENSION_REASONS = ["risk", "chargeback_program", "billing", "manual"] as const;

/** The account states a merchant can be in, derived from the latest state bearing event. */
export const ACCOUNT_STATES = ["active", "suspended", "reactivation_requested", "closure_requested", "closed"] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** The office roles that may suspend, reactivate or close an account. */
export const ACCOUNT_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
  "finance_ops",
] as const satisfies readonly PlatformRole[]);

/** The audit action of an office read of the account queue. */
export const ACCOUNT_QUEUE_READ_AUDIT_ACTION = "merchant_account.read_by_office";

/** The audit action prefix of every lifecycle event: `merchant_account.<event>`. */
export function accountEventAuditAction(event: string): string {
  return `merchant_account.${event}`;
}

/** The `0003` table the suspension and closure write the status to. */
export const USERS_TABLE = "users";

/** The `0043` table the closure hold is placed on. */
export const HOLDS_TABLE = "holds";

/** The `0045` table the delayed payout job writes. */
export const PAYOUTS_TABLE = "payouts";

/** The `0046` table the closure payout destination comes from. */
export const PAYOUT_BANK_ACCOUNTS_TABLE = "payout_bank_accounts";

/** The `0040`/`0041` tables the remaining balance is read from. */
export const LEDGER_ACCOUNTS_TABLE = "ledger_accounts";
export const LEDGER_ENTRIES_TABLE = "ledger_entries";

/** The `0080` table the chargeback period is read from. */
export const PLATFORM_SETTINGS_TABLE = "platform_settings";

/** The platform setting that carries the chargeback period in days. */
export const CHARGEBACK_HOLD_DAYS_SETTING = "chargeback.hold_days";

/** The default chargeback period: the 180 day card network chargeback window. */
export const CHARGEBACK_HOLD_DAYS_DEFAULT = 180;

/** The bounds of the chargeback period setting. */
export const CHARGEBACK_HOLD_DAYS_MIN = 30;
export const CHARGEBACK_HOLD_DAYS_MAX = 365;

/** The ledger account code of the merchant's remaining money. */
export const MERCHANT_PAYABLE_ACCOUNT_CODE = "merchant_payable";

/** The `0054` table the closure restricts. */
export const SUBMERCHANT_PROVISIONS_TABLE = "submerchant_provisions";

/** The background job that sends the remaining money to the bank after the hold period. */
export const CLOSURE_PAYOUT_JOB = "merchant_account.closure_payout";

/** The audit action of the closure payout being requested. */
export const CLOSURE_PAYOUT_REQUESTED_AUDIT_ACTION = "merchant_account.closure_payout_requested";

/** The job's payload: the closure event and the payout it schedules. */
export const closurePayoutJobPayloadSchema = z.object({
  company_id: z.string().uuid(),
  closure_event_id: z.string().uuid(),
  payout_bank_account_id: z.string().uuid(),
  amount_minor: z.string().regex(/^\d{1,18}$/u),
});

export type ClosurePayoutJobPayload = z.infer<typeof closurePayoutJobPayloadSchema>;

/** One payout job per closure event. */
export function closurePayoutJobIdempotencyKey(closureEventId: string): string {
  return `${CLOSURE_PAYOUT_JOB}:${closureEventId}`;
}

const MS_PER_DAY = 86_400_000;

/** The payout floor of section 10, in minor units: 100 USD. */
const PAYOUT_FLOOR_MINOR = 10_000n;

export interface AccountLifecycleDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
  /** Present in routes and jobs; the gate drives the flows with or without it. */
  readonly jobs?: { readonly registry: JobRegistry; readonly queue: JobQueue };
}

const eventRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  event: z.string(),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  required_documents: z.array(z.string()).nullable(),
  actor_user_id: z.string().nullable(),
  kyc_submission_id: z.string().nullable(),
  payout_bank_account_id: z.string().nullable(),
  hold_release_at: z.string().nullable(),
  chargeback_hold_release_at: z.string().nullable(),
  created_at: z.string(),
});

export type AccountEventRow = z.infer<typeof eventRowSchema>;

export interface AccountStateSnapshot {
  readonly companyId: string;
  readonly state: AccountState;
  readonly reason: string | null;
  readonly requiredDocuments: readonly string[];
  readonly since: string | null;
  readonly kycSubmissionId: string | null;
  readonly closureNote: string | null;
  readonly holdReleaseAt: string | null;
  readonly chargebackHoldReleaseAt: string | null;
  /** True when the company has a submission in the review pipeline to answer a suspension with. */
  readonly reactivationReady: boolean;
}

export interface AccountQueueRow {
  readonly companyId: string;
  readonly state: AccountState;
  readonly reason: string | null;
  readonly requiredDocuments: readonly string[];
  readonly kycSubmissionId: string | null;
  readonly closureNote: string | null;
  readonly at: string;
}

export interface AccountQueue {
  readonly rows: readonly AccountQueueRow[];
}

export interface SuspendResult {
  readonly companyId: string;
  readonly state: AccountState;
  readonly eventId: string;
  readonly usersSuspended: number;
}

export interface ReactivationRequestResult {
  readonly companyId: string;
  readonly state: AccountState;
  readonly eventId: string;
  readonly kycSubmissionId: string;
}

export interface ReactivationDecisionResult {
  readonly companyId: string;
  readonly state: AccountState;
  readonly eventId: string;
  readonly usersReactivated: number;
}

export interface ClosureRequestResult {
  readonly companyId: string;
  readonly state: AccountState;
  readonly eventId: string;
}

export interface ClosureResult {
  readonly companyId: string;
  readonly state: AccountState;
  readonly eventId: string;
  readonly payoutBankAccountId: string;
  readonly holdReleaseAt: string;
  readonly chargebackHoldReleaseAt: string;
  readonly reserveHeldMinor: string;
  readonly payoutMinor: string;
  readonly payoutScheduled: boolean;
  readonly usersClosed: number;
  readonly provisionsRestricted: number;
  readonly tokenDeletionsQueued: number;
}

function nowOf(dependencies: AccountLifecycleDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function detailsOf(issues: readonly z.ZodIssue[]): readonly ErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path.join("."),
    rule: "invalid_format",
  }));
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** Read the latest events of one company, newest first (bounded; the log is append only). */
async function readEvents(companyId: string, rest: RestClient): Promise<readonly AccountEventRow[]> {
  return rest.select(
    MERCHANT_ACCOUNT_EVENTS_TABLE,
    `select=id,company_id,event,reason,detail,required_documents,actor_user_id,kyc_submission_id,payout_bank_account_id,hold_release_at,chargeback_hold_release_at,created_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.desc&limit=50`,
    eventRowSchema,
  );
}

/** The state a merchant is in: the latest state bearing event, or `active` with no events. */
function stateOf(events: readonly AccountEventRow[]): { state: AccountState; event: AccountEventRow | null } {
  const latest = events.find((row) => (STATE_EVENTS as readonly string[]).includes(row.event));

  if (latest === undefined) {
    return { state: "active", event: null };
  }

  if (latest.event === "reactivated") {
    return { state: "active", event: latest };
  }

  return { state: latest.event as AccountState, event: latest };
}

function snapshotOf(companyId: string, events: readonly AccountEventRow[], reactivationReady: boolean): AccountStateSnapshot {
  const { state, event } = stateOf(events);

  return {
    companyId,
    state,
    reason: event?.reason ?? null,
    requiredDocuments: event?.required_documents ?? [],
    since: event?.created_at ?? null,
    kycSubmissionId: event?.kyc_submission_id ?? null,
    closureNote: event?.detail ?? null,
    holdReleaseAt: event?.hold_release_at ?? null,
    chargebackHoldReleaseAt: event?.chargeback_hold_release_at ?? null,
    reactivationReady,
  };
}

/** True when the company has a submission in the review pipeline (submitted, in review, approved). */
async function readReactivationReady(companyId: string, rest: RestClient): Promise<boolean> {
  const submissions = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,status&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.desc&limit=10`,
    z.object({ id: z.string(), status: z.string() }),
  );

  return submissions.some((row) => row.status === "submitted" || row.status === "in_review" || row.status === "approved");
}

/**
 * The merchant's own account screen read: owner role, company from the session. The snapshot is
 * merchant safe: state, reason, the required documents, the closure schedule - never another
 * tenant's row, because every query is scoped by the session's company.
 */
export async function readMerchantAccountState(
  input: { readonly actor: RequestActor },
  dependencies: AccountLifecycleDependencies,
): Promise<AccountStateSnapshot> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);
  const events = await readEvents(companyId, dependencies.rest);
  const reactivationReady = await readReactivationReady(companyId, dependencies.rest);

  return snapshotOf(companyId, events, reactivationReady);
}

/**
 * The office queue: every account in an open state, newest event per company, oldest first. Manage
 * roles only; each read is audited `merchant_account.read_by_office`.
 */
export async function readAccountReviewQueue(
  input: { readonly actor: RequestActor },
  dependencies: AccountLifecycleDependencies,
): Promise<AccountQueue> {
  requireAnyRole(input.actor, ACCOUNT_MANAGE_ROLES);

  const events = await dependencies.rest.select(
    MERCHANT_ACCOUNT_EVENTS_TABLE,
    `select=id,company_id,event,reason,detail,required_documents,actor_user_id,kyc_submission_id,payout_bank_account_id,hold_release_at,chargeback_hold_release_at,created_at&deleted_at=is.null&order=created_at.desc&limit=200`,
    eventRowSchema,
  );

  const seen = new Set<string>();
  const rows: AccountQueueRow[] = [];

  for (const event of events) {
    if (!(STATE_EVENTS as readonly string[]).includes(event.event)) {
      continue;
    }

    if (seen.has(event.company_id)) {
      continue;
    }

    seen.add(event.company_id);

    const state = event.event === "reactivated" ? "active" : (event.event as AccountState);

    if (state === "active") {
      continue;
    }

    rows.push({
      companyId: event.company_id,
      state,
      reason: event.reason,
      requiredDocuments: event.required_documents ?? [],
      kycSubmissionId: event.kyc_submission_id,
      closureNote: event.detail,
      at: event.created_at,
    });
  }

  await appendTolerated(dependencies.audit, {
    action: ACCOUNT_QUEUE_READ_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: MERCHANT_ACCOUNT_EVENT_ENTITY,
    entityId: null,
    companyId: null,
    sessionId: null,
    payload: { open_accounts: rows.length },
  });

  return { rows };
}

/** Insert one event row and audit it. */
async function recordEvent(
  input: {
    readonly companyId: string;
    readonly event: string;
    readonly actorUserId: string | null;
    readonly reason?: string | null;
    readonly detail?: string | null;
    readonly requiredDocuments?: readonly string[] | null;
    readonly kycSubmissionId?: string | null;
    readonly payoutBankAccountId?: string | null;
    readonly holdReleaseAt?: string | null;
    readonly chargebackHoldReleaseAt?: string | null;
    readonly at: number;
  },
  dependencies: AccountLifecycleDependencies,
): Promise<string> {
  await dependencies.rest.insert(MERCHANT_ACCOUNT_EVENTS_TABLE, [
    {
      company_id: input.companyId,
      event: input.event,
      reason: input.reason ?? null,
      detail: input.detail ?? null,
      required_documents: input.requiredDocuments ?? null,
      actor_user_id: input.actorUserId,
      kyc_submission_id: input.kycSubmissionId ?? null,
      payout_bank_account_id: input.payoutBankAccountId ?? null,
      hold_release_at: input.holdReleaseAt ?? null,
      chargeback_hold_release_at: input.chargebackHoldReleaseAt ?? null,
      created_at: isoOf(input.at),
    },
  ]);

  const rows = await dependencies.rest.select(
    MERCHANT_ACCOUNT_EVENTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(input.companyId)}&event=eq.${input.event}&actor_user_id=${input.actorUserId === null ? "is.null" : `eq.${encodeURIComponent(input.actorUserId)}`}&created_at=eq.${encodeURIComponent(isoOf(input.at))}&deleted_at=is.null&order=created_at.desc&limit=1`,
    z.object({ id: z.string() }),
  );

  const written = rows[0];

  if (written === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  await appendTolerated(dependencies.audit, {
    action: accountEventAuditAction(input.event),
    actorUserId: input.actorUserId,
    entityType: MERCHANT_ACCOUNT_EVENT_ENTITY,
    entityId: written.id,
    companyId: input.companyId,
    sessionId: null,
    payload: {
      company_id: input.companyId,
      event: input.event,
      reason: input.reason ?? null,
      kyc_submission_id: input.kycSubmissionId ?? null,
      hold_release_at: input.holdReleaseAt ?? null,
      chargeback_hold_release_at: input.chargebackHoldReleaseAt ?? null,
    },
  });

  return written.id;
}

/**
 * Set the live owner users of one company to a status: one conditional update per user (by id,
 * current status and version), then a re-read counts who actually moved - a PostgREST update that
 * matches no row answers success with zero rows, so the count comes from the read, not the write.
 */
async function setUsersStatus(
  companyId: string,
  fromStatuses: readonly string[],
  toStatus: string,
  rest: RestClient,
): Promise<number> {
  const users = await rest.select(
    USERS_TABLE,
    `select=id,status,version&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=50`,
    z.object({ id: z.string(), status: z.string(), version: z.number().int() }),
  );

  const attempted: string[] = [];

  for (const user of users) {
    if (!fromStatuses.includes(user.status)) {
      continue;
    }

    attempted.push(user.id);

    await rest.update(
      USERS_TABLE,
      `id=eq.${encodeURIComponent(user.id)}&company_id=eq.${encodeURIComponent(companyId)}&status=eq.${user.status}&version=eq.${user.version}&deleted_at=is.null`,
      { status: toStatus, version: user.version + 1 },
    );
  }

  if (attempted.length === 0) {
    return 0;
  }

  const after = await rest.select(
    USERS_TABLE,
    `select=id,status&company_id=eq.${encodeURIComponent(companyId)}&status=eq.${toStatus}&deleted_at=is.null&limit=50`,
    z.object({ id: z.string(), status: z.string() }),
  );

  return after.filter((row) => attempted.includes(row.id)).length;
}

/** The body of a suspension: the merchant, the reason and the required reactivation documents. */
export const suspendAccountBodySchema = z.object({
  company_id: z.string().uuid(),
  reason: z.enum(SUSPENSION_REASONS),
  required_documents: z
    .array(z.string().trim().min(1).max(80))
    .max(10)
    .optional(),
});

/**
 * Suspend one merchant account. Manage roles only. Requires the account to be active; records the
 * `suspended` event with the reason and the required documents, sets the owners' `0003` status to
 * `suspended` (which is what locks their sessions on the next request), and audits.
 */
export async function suspendMerchant(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: AccountLifecycleDependencies,
): Promise<SuspendResult> {
  requireAnyRole(input.actor, ACCOUNT_MANAGE_ROLES);

  const parsed = suspendAccountBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const companyId = parsed.data.company_id;
  const rest = dependencies.rest;
  const events = await readEvents(companyId, rest);
  const { state } = stateOf(events);

  if (state !== "active") {
    throw new AppError("CONFLICT", {
      details: [{ field: "company_id", rule: state === "closed" ? "already_closed" : "not_active" }],
    });
  }

  const at = nowOf(dependencies);
  const eventId = await recordEvent(
    {
      companyId,
      event: "suspended",
      actorUserId: input.actor.userId,
      reason: parsed.data.reason,
      requiredDocuments: parsed.data.required_documents ?? [],
      at,
    },
    dependencies,
  );

  const usersSuspended = await setUsersStatus(companyId, ["active"], "suspended", rest);

  return { companyId, state: "suspended", eventId, usersSuspended };
}

/**
 * The merchant's request to come back: owner role, and the account must be suspended with no
 * request pending. The request names the submission the merchant answered with - the newest
 * submission in the review pipeline; without one the request is refused, because section 13's
 * "submits the required documents" is the precondition of the review.
 */
export async function requestReactivation(
  input: { readonly actor: RequestActor },
  dependencies: AccountLifecycleDependencies,
): Promise<ReactivationRequestResult> {
  requireAnyRole(input.actor, ["owner"]);
  const companyId = requireCompanyId(input.actor);
  const rest = dependencies.rest;
  const events = await readEvents(companyId, rest);
  const { state } = stateOf(events);

  if (state === "reactivation_requested") {
    throw new AppError("CONFLICT", { details: [{ field: "account", rule: "already_requested" }] });
  }

  if (state !== "suspended") {
    throw new AppError("CONFLICT", { details: [{ field: "account", rule: "not_suspended" }] });
  }

  const submissions = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,status&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.desc&limit=10`,
    z.object({ id: z.string(), status: z.string() }),
  );

  const answer = submissions.find(
    (row) => row.status === "submitted" || row.status === "in_review" || row.status === "approved",
  );

  if (answer === undefined) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "submission", rule: "missing" }] });
  }

  const eventId = await recordEvent(
    {
      companyId,
      event: "reactivation_requested",
      actorUserId: input.actor.userId,
      kycSubmissionId: answer.id,
      at: nowOf(dependencies),
    },
    dependencies,
  );

  return { companyId, state: "reactivation_requested", eventId, kycSubmissionId: answer.id };
}

/** The body of the reactivation decision: the merchant whose request is accepted. */
export const decideReactivationBodySchema = z.object({
  company_id: z.string().uuid(),
});

/**
 * Accept one reactivation request. Manage roles only. Requires the latest event to be
 * `reactivation_requested`, the named submission to be `approved` and none of its documents
 * rejected; then the owners go back to `active` and the `reactivated` event is recorded.
 */
export async function decideReactivation(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: AccountLifecycleDependencies,
): Promise<ReactivationDecisionResult> {
  requireAnyRole(input.actor, ACCOUNT_MANAGE_ROLES);

  const parsed = decideReactivationBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const companyId = parsed.data.company_id;
  const rest = dependencies.rest;
  const events = await readEvents(companyId, rest);
  const { state, event } = stateOf(events);

  if (state === "active") {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "already_active" }] });
  }

  if (state !== "reactivation_requested" || event === null || event.kyc_submission_id === null) {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "no_reactivation_requested" }] });
  }

  const submissions = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,company_id,status&id=eq.${encodeURIComponent(event.kyc_submission_id)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    z.object({ id: z.string(), company_id: z.string(), status: z.string() }),
  );

  const submission = submissions[0];

  if (submission === undefined || submission.status !== "approved") {
    throw new AppError("CONFLICT", { details: [{ field: "submission", rule: "not_approved" }] });
  }

  const rejected = await rest.select(
    KYC_DOCUMENTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(companyId)}&submission_id=eq.${encodeURIComponent(submission.id)}&status=eq.rejected&deleted_at=is.null&limit=1`,
    z.object({ id: z.string() }),
  );

  if (rejected.length > 0) {
    throw new AppError("CONFLICT", { details: [{ field: "submission", rule: "documents_rejected" }] });
  }

  const eventId = await recordEvent(
    {
      companyId,
      event: "reactivated",
      actorUserId: input.actor.userId,
      at: nowOf(dependencies),
    },
    dependencies,
  );

  const usersReactivated = await setUsersStatus(companyId, ["suspended"], "active", rest);

  return { companyId, state: "active", eventId, usersReactivated };
}

/** The body of the merchant's closure request: an optional note. */
export const closureRequestBodySchema = z.object({
  note: z.string().trim().min(1).max(280).optional(),
});

/**
 * The merchant's request to close the account. Owner role; the account must be active. Records
 * `closure_requested` with the note; the office closes it through `closeMerchantAccount`.
 */
export async function requestAccountClosure(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: AccountLifecycleDependencies,
): Promise<ClosureRequestResult> {
  requireAnyRole(input.actor, ["owner"]);

  const parsed = closureRequestBodySchema.safeParse(input.body ?? {});

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const companyId = requireCompanyId(input.actor);
  const events = await readEvents(companyId, dependencies.rest);
  const { state } = stateOf(events);

  if (state !== "active") {
    throw new AppError("CONFLICT", {
      details: [{ field: "account", rule: state === "closed" ? "already_closed" : "not_active" }],
    });
  }

  const eventId = await recordEvent(
    {
      companyId,
      event: "closure_requested",
      actorUserId: input.actor.userId,
      detail: parsed.data.note ?? null,
      at: nowOf(dependencies),
    },
    dependencies,
  );

  return { companyId, state: "closure_requested", eventId };
}

/** The body of the office's closure: the merchant and optionally the payout bank account. */
export const closeAccountBodySchema = z.object({
  company_id: z.string().uuid(),
  payout_bank_account_id: z.string().uuid().optional(),
});

const bankAccountRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  bank_name: z.string(),
  account_last_four: z.string(),
  country: z.string(),
  version: z.number().int(),
});

const profileRowSchema = z.object({
  mcc_code: z.string().nullable(),
});

const mccRowSchema = z.object({
  risk_tier: z.string(),
});

const tierRowSchema = z.object({
  tier: z.string(),
  extra_reserve_percent: z.coerce.number().int(),
  hold_days: z.coerce.number().int(),
});

const ledgerAccountRowSchema = z.object({
  id: z.string(),
});

const ledgerEntryRowSchema = z.object({
  entry_side: z.string(),
  amount_minor: z.coerce.number().int(),
});

const settingRowSchema = z.object({
  value: z.unknown(),
});

const provisionRowSchema = z.object({
  id: z.string(),
  version: z.number().int(),
});

/** The merchant's hold period in days and reserve percent from its underwriting risk tier. */
async function readHoldTerms(
  companyId: string,
  rest: RestClient,
): Promise<{ holdDays: number; reservePercent: number }> {
  const profiles = await rest.select(
    BUSINESS_PROFILE_TABLE,
    `select=mcc_code&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    profileRowSchema,
  );

  const mccCode = profiles[0]?.mcc_code ?? null;

  if (mccCode === null) {
    return { holdDays: 0, reservePercent: 0 };
  }

  const mccRows = await rest.select(
    MCC_CODES_TABLE,
    `select=risk_tier&code=eq.${encodeURIComponent(mccCode)}&deleted_at=is.null&limit=1`,
    mccRowSchema,
  );

  const tier = mccRows[0]?.risk_tier ?? "unassigned";

  if (tier === "unassigned") {
    return { holdDays: 0, reservePercent: 0 };
  }

  const tiers = await rest.select(
    UNDERWRITING_RISK_TIERS_TABLE,
    `select=tier,extra_reserve_percent,hold_days&tier=eq.${encodeURIComponent(tier)}&deleted_at=is.null&limit=1`,
    tierRowSchema,
  );

  const row = tiers[0];

  if (row === undefined) {
    return { holdDays: 0, reservePercent: 0 };
  }

  return { holdDays: row.hold_days, reservePercent: row.extra_reserve_percent };
}

/** The chargeback period in days from the `chargeback.hold_days` platform setting. */
async function readChargebackHoldDays(rest: RestClient): Promise<number> {
  const rows = await rest.select(
    PLATFORM_SETTINGS_TABLE,
    `select=value&setting_key=eq.${CHARGEBACK_HOLD_DAYS_SETTING}&company_id=is.null&deleted_at=is.null&limit=1`,
    settingRowSchema,
  );

  const raw = rows[0]?.value;
  const parsed = z.number().int().min(CHARGEBACK_HOLD_DAYS_MIN).max(CHARGEBACK_HOLD_DAYS_MAX).safeParse(raw);

  return parsed.success ? parsed.data : CHARGEBACK_HOLD_DAYS_DEFAULT;
}

/** The remaining money of the merchant: the credit balance of its `merchant_payable` account. */
async function readRemainingBalanceMinor(companyId: string, rest: RestClient): Promise<bigint> {
  const accounts = await rest.select(
    LEDGER_ACCOUNTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(companyId)}&account_code=eq.${MERCHANT_PAYABLE_ACCOUNT_CODE}&deleted_at=is.null&limit=1`,
    ledgerAccountRowSchema,
  );

  const account = accounts[0];

  if (account === undefined) {
    return 0n;
  }

  const entries = await rest.select(
    LEDGER_ENTRIES_TABLE,
    `select=entry_side,amount_minor&account_id=eq.${encodeURIComponent(account.id)}&deleted_at=is.null&limit=10000`,
    ledgerEntryRowSchema,
  );

  let balance = 0n;

  for (const entry of entries) {
    balance += entry.entry_side === "credit" ? BigInt(entry.amount_minor) : -BigInt(entry.amount_minor);
  }

  return balance > 0n ? balance : 0n;
}

/**
 * Close one merchant account. Manage roles only. Requires a closure request (or a suspension the
 * office decides to close). Records `closed` with the verified payout bank account, the hold
 * release instant and the chargeback hold release instant; places the chargeback liability reserve
 * of the remaining balance as a `0043` `holds` row of reason `closure` until the chargeback period
 * ends; enqueues the delayed `merchant_account.closure_payout` job that sends the rest to the bank
 * after the hold period; restricts every verified sub-merchant provision and enqueues its saved card
 * token deletion at once; sets the owners to `closed`. Every write is audited.
 */
export async function closeMerchantAccount(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: AccountLifecycleDependencies,
): Promise<ClosureResult> {
  requireAnyRole(input.actor, ACCOUNT_MANAGE_ROLES);

  const parsed = closeAccountBodySchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const companyId = parsed.data.company_id;
  const rest = dependencies.rest;
  const at = nowOf(dependencies);
  const events = await readEvents(companyId, rest);
  const { state } = stateOf(events);

  if (state === "closed") {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "already_closed" }] });
  }

  if (state !== "closure_requested" && state !== "suspended") {
    throw new AppError("CONFLICT", { details: [{ field: "company_id", rule: "no_closure_requested" }] });
  }

  // The payout destination: the named account, or the company's verified one.
  let bank: z.infer<typeof bankAccountRowSchema> | null = null;

  if (parsed.data.payout_bank_account_id !== undefined) {
    const named = await rest.select(
      PAYOUT_BANK_ACCOUNTS_TABLE,
      `select=id,company_id,status,bank_name,account_last_four,country,version&id=eq.${encodeURIComponent(parsed.data.payout_bank_account_id)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
      bankAccountRowSchema,
    );
    bank = named[0] ?? null;
  } else {
    const verified = await rest.select(
      PAYOUT_BANK_ACCOUNTS_TABLE,
      `select=id,company_id,status,bank_name,account_last_four,country,version&company_id=eq.${encodeURIComponent(companyId)}&status=eq.verified&deleted_at=is.null&order=created_at.desc&limit=1`,
      bankAccountRowSchema,
    );
    bank = verified[0] ?? null;
  }

  if (bank === null || bank.status !== "verified") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "payout_bank_account", rule: "not_verified" }] });
  }

  const { holdDays, reservePercent } = await readHoldTerms(companyId, rest);
  const chargebackHoldDays = await readChargebackHoldDays(rest);

  const holdReleaseAtMs = at + holdDays * MS_PER_DAY;
  const chargebackHoldReleaseAtMs = at + chargebackHoldDays * MS_PER_DAY;
  const holdReleaseAt = isoOf(holdReleaseAtMs);
  const chargebackHoldReleaseAt = isoOf(chargebackHoldReleaseAtMs);

  const balanceMinor = await readRemainingBalanceMinor(companyId, rest);
  const reserveMinor = (balanceMinor * BigInt(reservePercent)) / 100n;
  const payoutMinor = balanceMinor - reserveMinor;

  const eventId = await recordEvent(
    {
      companyId,
      event: "closed",
      actorUserId: input.actor.userId,
      payoutBankAccountId: bank.id,
      holdReleaseAt,
      chargebackHoldReleaseAt,
      at,
    },
    dependencies,
  );

  // The chargeback liability funds stay held until the chargeback period ends (section 13 line 154).
  if (reserveMinor > 0n) {
    await rest.insert(HOLDS_TABLE, [
      {
        company_id: companyId,
        payment_id: null,
        settlement_id: null,
        amount_minor: String(reserveMinor),
        currency: "USD",
        reason: "closure",
        status: "active",
        placed_at: isoOf(at),
        release_due_at: chargebackHoldReleaseAt,
      },
    ]);
  }

  // The rest goes to the bank after the hold period, through the delayed payout job.
  let payoutScheduled = false;

  if (payoutMinor > 0n && dependencies.jobs !== undefined) {
    await enqueueJob(
      dependencies.jobs,
      CLOSURE_PAYOUT_JOB,
      {
        company_id: companyId,
        closure_event_id: eventId,
        payout_bank_account_id: bank.id,
        amount_minor: String(payoutMinor),
      },
      {
        idempotencyKey: closurePayoutJobIdempotencyKey(eventId),
        delayMs: Math.max(0, holdReleaseAtMs - at),
        now: at,
      },
    );
    payoutScheduled = true;
  }

  const usersClosed = await setUsersStatus(companyId, ["active", "suspended"], "closed", rest);

  // Stop every verified sub-merchant and queue the saved card token deletion at once (line 155).
  const provisions = await rest.select(
    SUBMERCHANT_PROVISIONS_TABLE,
    `select=id,version&company_id=eq.${encodeURIComponent(companyId)}&status=eq.verified&deleted_at=is.null&limit=50`,
    provisionRowSchema,
  );

  const attemptedProvisions: string[] = [];
  let tokenDeletionsQueued = 0;

  for (const provision of provisions) {
    attemptedProvisions.push(provision.id);

    await rest.update(
      SUBMERCHANT_PROVISIONS_TABLE,
      `id=eq.${encodeURIComponent(provision.id)}&company_id=eq.${encodeURIComponent(companyId)}&status=eq.verified&version=eq.${provision.version}&deleted_at=is.null`,
      {
        status: "restricted",
        charges_enabled: false,
        payouts_enabled: false,
        restricted_at: isoOf(at),
        version: provision.version + 1,
      },
    );

    if (dependencies.jobs !== undefined) {
      const enqueued: EnqueueResult = await enqueueCardTokenDeletion(dependencies.jobs, {
        companyId,
        provisionId: provision.id,
        now: at,
      });

      if (!enqueued.deduplicated) {
        tokenDeletionsQueued += 1;
      }
    }
  }

  // The count comes from a re-read, not from the writes: an update that lost its race matched no
  // row and changed nothing.
  const restrictedNow = await rest.select(
    SUBMERCHANT_PROVISIONS_TABLE,
    `select=id,status&company_id=eq.${encodeURIComponent(companyId)}&status=eq.restricted&deleted_at=is.null&limit=50`,
    z.object({ id: z.string(), status: z.string() }),
  );
  const provisionsRestricted = restrictedNow.filter((row) => attemptedProvisions.includes(row.id)).length;

  await appendTolerated(dependencies.audit, {
    action: accountEventAuditAction("closed"),
    actorUserId: input.actor.userId,
    entityType: MERCHANT_ACCOUNT_EVENT_ENTITY,
    entityId: eventId,
    companyId,
    sessionId: null,
    payload: {
      company_id: companyId,
      payout_bank_account_id: bank.id,
      hold_release_at: holdReleaseAt,
      chargeback_hold_release_at: chargebackHoldReleaseAt,
      balance_minor: String(balanceMinor),
      reserve_held_minor: String(reserveMinor),
      payout_minor: String(payoutMinor),
      provisions_restricted: provisionsRestricted,
      token_deletions_queued: tokenDeletionsQueued,
    },
  });

  return {
    companyId,
    state: "closed",
    eventId,
    payoutBankAccountId: bank.id,
    holdReleaseAt,
    chargebackHoldReleaseAt,
    reserveHeldMinor: String(reserveMinor),
    payoutMinor: String(payoutMinor),
    payoutScheduled,
    usersClosed,
    provisionsRestricted,
    tokenDeletionsQueued,
  };
}

/**
 * The delayed payout job's handler body, exported for the gate: it writes the `0045` payout row of
 * the closure - the remaining money minus the chargeback reserve, to the verified bank account,
 * as a remainder payout when it is below the section 10 floor - and audits it. Idempotent per
 * closure event: a repeated run answers the row that already exists. The approval and processing of
 * the row belong to the finance flow of the payment STEPs.
 */
export async function runClosurePayout(
  payload: ClosurePayoutJobPayload,
  dependencies: AccountLifecycleDependencies,
): Promise<{ payoutId: string; alreadyRequested: boolean }> {
  const rest = dependencies.rest;
  const note = `closure payout of event ${payload.closure_event_id}`;

  const existing = await rest.select(
    PAYOUTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(payload.company_id)}&note=eq.${encodeURIComponent(note)}&deleted_at=is.null&limit=1`,
    z.object({ id: z.string() }),
  );

  const first = existing[0];

  if (first !== undefined) {
    return { payoutId: first.id, alreadyRequested: true };
  }

  const events = await rest.select(
    MERCHANT_ACCOUNT_EVENTS_TABLE,
    `select=id,company_id,event,actor_user_id,payout_bank_account_id&id=eq.${encodeURIComponent(payload.closure_event_id)}&company_id=eq.${encodeURIComponent(payload.company_id)}&event=eq.closed&deleted_at=is.null&limit=1`,
    z.object({
      id: z.string(),
      company_id: z.string(),
      event: z.string(),
      actor_user_id: z.string().nullable(),
      payout_bank_account_id: z.string().nullable(),
    }),
  );

  const closure = events[0];

  if (closure === undefined || closure.payout_bank_account_id !== payload.payout_bank_account_id) {
    throw new AppError("CONFLICT", { details: [{ field: "closure_event_id", rule: "not_closed" }] });
  }

  if (closure.actor_user_id === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  const banks = await rest.select(
    PAYOUT_BANK_ACCOUNTS_TABLE,
    `select=id,bank_name,account_last_four,country&id=eq.${encodeURIComponent(payload.payout_bank_account_id)}&company_id=eq.${encodeURIComponent(payload.company_id)}&deleted_at=is.null&limit=1`,
    z.object({ id: z.string(), bank_name: z.string(), account_last_four: z.string(), country: z.string() }),
  );

  const bank = banks[0];

  if (bank === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const amountMinor = BigInt(payload.amount_minor);

  if (amountMinor <= 0n) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount_minor", rule: "out_of_range" }] });
  }

  await rest.insert(PAYOUTS_TABLE, [
    {
      company_id: payload.company_id,
      settlement_id: null,
      amount_minor: payload.amount_minor,
      currency: "USD",
      platform_fee_minor: 0,
      status: "requested",
      requested_by: closure.actor_user_id,
      destination_bank_name: bank.bank_name,
      destination_last_four: bank.account_last_four,
      destination_country: bank.country,
      is_remainder: amountMinor < PAYOUT_FLOOR_MINOR,
      note,
    },
  ]);

  const rows = await rest.select(
    PAYOUTS_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(payload.company_id)}&note=eq.${encodeURIComponent(note)}&deleted_at=is.null&limit=1`,
    z.object({ id: z.string() }),
  );

  const written = rows[0];

  if (written === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  await appendTolerated(dependencies.audit, {
    action: CLOSURE_PAYOUT_REQUESTED_AUDIT_ACTION,
    actorUserId: null,
    entityType: "payout",
    entityId: written.id,
    companyId: payload.company_id,
    sessionId: null,
    payload: {
      company_id: payload.company_id,
      closure_event_id: payload.closure_event_id,
      amount_minor: payload.amount_minor,
    },
  });

  return { payoutId: written.id, alreadyRequested: false };
}

/** The job definition of the delayed closure payout, with injectable dependencies for the gate. */
export function createClosurePayoutJobHandler(
  dependenciesOf: () => AccountLifecycleDependencies,
): JobDefinition<ClosurePayoutJobPayload> {
  return {
    name: CLOSURE_PAYOUT_JOB,
    payloadSchema: closurePayoutJobPayloadSchema,
    handler: async (context) => {
      await runClosurePayout(context.payload, dependenciesOf());
    },
  };
}

/** Register the account lifecycle jobs once. */
export function registerAccountLifecycleJobs(registry: JobRegistry): void {
  if (!registry.has(CLOSURE_PAYOUT_JOB)) {
    registry.register(
      createClosurePayoutJobHandler(() => {
        const runtime = getAuthRuntime();

        return { rest: runtime.rest, audit: runtime.audit };
      }),
    );
  }
}
