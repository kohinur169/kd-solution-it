// path: lib/approvals/registry.ts
import type { PlatformRole } from "../auth/types.ts";
import type { MessagePath } from "../i18n/messages.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The approval chain of section 2, as data: the four actions, who may raise each of them, who signs
 * at which stage, and the limits the columns impose.
 *
 * ## Why the four actions are a closed list
 *
 * Section 2 says the chain exists because some actions are too large for one person, and names two of
 * them - a large payout release and a platform fee change. Section 36 adds the country switch, and
 * reserve release arrives with the reserve rules. The four are therefore a vocabulary rather than an
 * open string: `approval_requests_action_check` closes it in the database, this file closes it in
 * code, and the gate compares the two. A fifth action is a migration and an entry here, which is the
 * point - it is the moment somebody decides a new class of decision needs a second signature.
 *
 * ## Who may raise what, and why the CEO may raise nothing
 *
 * The chain is "requester, then CEO, then super_admin", so the CEO is a signer and not a requester:
 * a CEO who could raise a request and then approve it would be the four-eyes rule signing its own
 * form. The matrix below is the requester side only. It is narrower than the role charters on
 * purpose: finance operations handle payouts and reserves, and the platform's own fee and the country
 * switch belong to the super administrator until STEP 071 delegates them.
 *
 * ## The two stages
 *
 * `ceo` decides first; `super_admin` signs last. Both may *see* the whole queue - the CEO needs to
 * know what is waiting for the second signature and the super administrator needs to know what is on
 * its way - but only the stage's own role may act on it, which is enforced in the service and will be
 * enforced again by STEP 072's decision endpoint.
 */

/** The four actions that need the section 2 chain. */
export type ApprovalActionType =
  | "payout_release"
  | "reserve_release"
  | "platform_fee_change"
  | "country_enable";

export const APPROVAL_ACTION_TYPES: readonly ApprovalActionType[] = deepFreeze([
  "payout_release",
  "reserve_release",
  "platform_fee_change",
  "country_enable",
]);

const actionTypeSet: ReadonlySet<string> = new Set<string>(APPROVAL_ACTION_TYPES);

/** True when a value is one of the four actions. */
export function isApprovalActionType(value: unknown): value is ApprovalActionType {
  return typeof value === "string" && actionTypeSet.has(value);
}

/** The table a subject lives in. Fixed per action, as `approval_requests_subject_check` requires. */
export type ApprovalSubjectType = "payout" | "reserve" | "plan" | "country";

const subjectTypeByAction: Readonly<Record<ApprovalActionType, ApprovalSubjectType>> = deepFreeze({
  payout_release: "payout",
  reserve_release: "reserve",
  platform_fee_change: "plan",
  country_enable: "country",
});

/** The subject type of an action, which is the only subject type it may name. */
export function subjectTypeOf(action: ApprovalActionType): ApprovalSubjectType {
  return subjectTypeByAction[action];
}

/**
 * Who may raise each action.
 *
 * Finance operations own the payout and reserve work of their charter; the platform's own fee and
 * the country switch are the super administrator's. The CEO is deliberately absent: the chain's
 * first name is the requester and its second is the approver, and no account is both.
 */
const requesterRolesByAction: Readonly<Record<ApprovalActionType, readonly PlatformRole[]>> =
  deepFreeze({
    payout_release: ["finance_ops", "super_admin"],
    reserve_release: ["finance_ops", "super_admin"],
    platform_fee_change: ["super_admin"],
    country_enable: ["super_admin"],
  });

/** The roles that may raise one action. */
export function requesterRolesOf(action: ApprovalActionType): readonly PlatformRole[] {
  return requesterRolesByAction[action];
}

/** True when an account holding these roles may raise this action. */
export function canRequestApproval(
  roles: readonly PlatformRole[],
  action: ApprovalActionType,
): boolean {
  const allowed = requesterRolesByAction[action];

  return roles.some((role) => allowed.includes(role));
}

/** The actions an account holding these roles may raise, in the vocabulary's order. */
export function requestableActionsOf(
  roles: readonly PlatformRole[],
): readonly ApprovalActionType[] {
  return APPROVAL_ACTION_TYPES.filter((action) => canRequestApproval(roles, action));
}

const actionLabelKeys: Readonly<Record<ApprovalActionType, MessagePath>> = deepFreeze({
  payout_release: "officeApprovals.actionPayoutRelease",
  reserve_release: "officeApprovals.actionReserveRelease",
  platform_fee_change: "officeApprovals.actionPlatformFeeChange",
  country_enable: "officeApprovals.actionCountryEnable",
});

/** The catalog key of an action's name, so the queue and the form read the same words. */
export function approvalActionLabelKey(action: ApprovalActionType): MessagePath {
  return actionLabelKeys[action];
}

/** The roles that may open the queue. Both stages see it; only their own stage may be acted on. */
export const APPROVAL_QUEUE_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The role that decides at the first stage. Used by the queue to mark what is the reader's. */
export const APPROVAL_CEO_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
] as const satisfies readonly PlatformRole[]);

/** The role that signs last, which is what makes a request approved. */
export const APPROVAL_FINAL_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The six statuses `approval_requests_status_check` allows. */
export type ApprovalStatus =
  | "pending_ceo"
  | "pending_super_admin"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = deepFreeze([
  "pending_ceo",
  "pending_super_admin",
  "approved",
  "rejected",
  "cancelled",
  "expired",
]);

const statusSet: ReadonlySet<string> = new Set<string>(APPROVAL_STATUSES);

/** True when a value is one of the six statuses. */
export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && statusSet.has(value);
}

/** The statuses that are still waiting on somebody, which is what the queue reads. */
export const PENDING_APPROVAL_STATUSES: readonly ApprovalStatus[] = deepFreeze([
  "pending_ceo",
  "pending_super_admin",
]);

/**
 * The two desks a request passes through, named as a type.
 *
 * The screen and the console take this type rather than spelling the two names, because a page that
 * writes an office role's name is a page that can drift from the role list the services enforce.
 */
export type ApprovalStage = "ceo" | "super_admin";

const stageLabelKeys: Readonly<Record<ApprovalStage, MessagePath>> = deepFreeze({
  ceo: "officeApprovals.stageCeo",
  super_admin: "officeApprovals.stageFinal",
});

/** The catalog key of the sentence that says whose desk a row is on. */
export function stageLabelKey(stage: ApprovalStage): MessagePath {
  return stageLabelKeys[stage];
}

/** The stage a status belongs to, so the screen can say whose desk a row is on. */
export function stageOf(status: ApprovalStatus): ApprovalStage | "closed" {
  if (status === "pending_ceo") {
    return "ceo";
  }

  if (status === "pending_super_admin") {
    return "super_admin";
  }

  return "closed";
}

/**
 * The two decisions a signer can take at the desk in front of them.
 *
 * One verb pair for both stages on purpose: the CEO's `approve` moves a request to the last signature
 * and the super administrator's `approve` is that signature, so the difference between the two
 * decisions is the stage the row is on, not a separate vocabulary for each desk.
 */
export type ApprovalDecision = "approve" | "reject";

export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = deepFreeze([
  "approve",
  "reject",
] as const satisfies readonly ApprovalDecision[]);

const decisionSet: ReadonlySet<string> = new Set<string>(APPROVAL_DECISIONS);

/** True when a value is one of the two decisions. */
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return typeof value === "string" && decisionSet.has(value);
}

/** The statuses a row no longer waiting on anybody may hold, which is what the history reads. */
export const CLOSED_APPROVAL_STATUSES: readonly ApprovalStatus[] = deepFreeze([
  "approved",
  "rejected",
  "cancelled",
  "expired",
] as const satisfies readonly ApprovalStatus[]);

/** How many closed requests the home shows. Enough to see the outcome of a decision, not a ledger. */
export const APPROVAL_HISTORY_LIMIT = 10;

/** The roles that may sign at one stage: the CEO at the first desk, the super administrator last. */
export function decisionRolesOf(stage: ApprovalStage): readonly PlatformRole[] {
  return stage === "ceo" ? APPROVAL_CEO_ROLES : APPROVAL_FINAL_ROLES;
}

/**
 * Why this account may not sign one row, or null when it may.
 *
 * Three rules, in the order a person meets them:
 *
 *   - **the desk.** A request waiting for the CEO is signed by the CEO and one waiting for the final
 *     signature by the super administrator. An account holding both roles signs one row once, at the
 *     desk the row is actually on.
 *   - **the requester never signs the first signature.** A chain whose first two names are the same
 *     person is one person deciding, however many columns the row has.
 *   - **the last signature is not the first signer's.** The chain wants two people at the two desks,
 *     so an account that approved as the CEO cannot also confirm, even when it holds both roles.
 *
 * A requester may take the *last* signature, and that is deliberate: the CEO's independent approval
 * already stands between the request and the release. The property the chain protects is that no
 * single person completes a large action alone, not that the accounts are four.
 */
export function signatureProblemOf(input: {
  readonly roles: readonly PlatformRole[];
  readonly stage: ApprovalStage;
  readonly actorId: string;
  readonly requesterId: string;
  readonly ceoDeciderId: string | null;
}): "role" | "requester_signature" | "signer_signature" | null {
  const allowed = decisionRolesOf(input.stage);

  if (!input.roles.some((role) => allowed.includes(role))) {
    return "role";
  }

  if (input.stage === "ceo" && input.actorId === input.requesterId) {
    return "requester_signature";
  }

  if (input.stage === "super_admin" && input.actorId === input.ceoDeciderId) {
    return "signer_signature";
  }

  return null;
}

/**
 * The audit name of one decision.
 *
 * Four names rather than one `approval.decided` with a payload, because the viewer of STEP 076 filters
 * by action and "who signed as the CEO" and "who signed last" are different questions with different
 * answers. All four satisfy the platform's dotted, lower case action rule.
 */
export function decisionAuditAction(
  stage: ApprovalStage,
  decision: ApprovalDecision,
): string {
  if (stage === "ceo") {
    return decision === "approve" ? "approval.ceo_approved" : "approval.ceo_rejected";
  }

  return decision === "approve" ? "approval.confirmed" : "approval.final_rejected";
}

/** The status one decision leaves a row in, at the desk it was taken. */
export function statusAfterDecision(
  stage: ApprovalStage,
  decision: ApprovalDecision,
): ApprovalStatus {
  if (decision === "reject") {
    return "rejected";
  }

  return stage === "ceo" ? "pending_super_admin" : "approved";
}

/** What the CEO reads in a queue row. `approval_requests_label_check` allows 1 to 160. */
export const APPROVAL_LABEL_MAXIMUM_LENGTH = 160;

/** The shortest note worth queueing. `approval_requests_note_check` allows 10 to 1000 characters. */
export const APPROVAL_NOTE_MINIMUM_LENGTH = 10;

/** The longest note the column holds. */
export const APPROVAL_NOTE_MAXIMUM_LENGTH = 1_000;

/** An ISO 4217 code, as `approval_requests_amount_check` requires. */
export const APPROVAL_CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/**
 * How long a request waits before it is expired, in milliseconds.
 *
 * Three days, because that is the same window section 5 gives finance operations to resolve a
 * reconciliation mismatch: a decision that matters enough to need two signatures matters enough to
 * be taken promptly, and a queue nobody empties should say so in the record rather than grow quietly.
 */
export const APPROVAL_EXPIRY_MS = 3 * 24 * 60 * 60 * 1_000;

/** How many rows one queue read returns. A longer queue is a staffing problem, not a paging one. */
export const APPROVAL_QUEUE_LIMIT = 100;

/** The largest amount a request may name, in minor units. Beyond this is a data entry mistake. */
export const APPROVAL_AMOUNT_MAXIMUM_MINOR = 1_000_000_000_000;

/**
 * What is wrong with an amount, or null when nothing is.
 *
 * Money is a pair in the column (`approval_requests_amount_check`): an amount and the currency it is
 * in, or neither. A request that moves money must name a positive whole number of minor units, which
 * is the platform's rule 5 for money everywhere.
 */
export function amountProblemOf(input: {
  readonly amountMinor: number | null;
  readonly currency: string | null;
}): string | null {
  if (input.amountMinor === null && input.currency === null) {
    return null;
  }

  if (input.amountMinor === null || input.currency === null) {
    return "amount_currency_pair";
  }

  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    return "amount_invalid";
  }

  if (input.amountMinor > APPROVAL_AMOUNT_MAXIMUM_MINOR) {
    return "amount_too_large";
  }

  if (!APPROVAL_CURRENCY_PATTERN.test(input.currency)) {
    return "currency_invalid";
  }

  return null;
}
