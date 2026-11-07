// path: services/disputes/dispute-fields.ts
import type { PlatformRole } from "../../lib/auth/types.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The vocabulary of section 19's dispute: the six states `0039_disputes.sql` allows, the order they move
 * in, the roles that may read them, the numbers the schema enforces, the words a refusal names, the events a
 * provider may use to move a row, - STEP 195 - the response the merchant writes and the window it has to write
 * it in, and - STEP 196 - the two warnings section 19 sends them along the way.
 *
 * ## Why this is a separate module from the service
 *
 * Two runtimes need the same words. The merchant screen and the office queue are client and server React
 * components, so they may import a module that imports nothing but a frozen array and a type; the service
 * imports the REST client and the audit trail and must never reach a browser bundle. Everything a screen
 * has to know - the statuses, their labels, the limits, the rule a refusal names - lives here.
 *
 * ## Why the lifecycle is `0039`'s and not this module's
 *
 * `0039` already carries the whole state machine: six statuses, `disputes_guard_deadline` refusing to
 * reopen a resolved row, `disputes_resolved_check` tying `resolved_at` to exactly the three terminal
 * statuses, `disputes_due_check` bounding the deadline by the window. This module therefore *reads* that
 * machine rather than inventing a second one, and the gate compares the two lists word for word.
 */

/** The column the audit chain names a dispute under. */
export const DISPUTE_AUDIT_ENTITY = "dispute";

/** The six statuses `disputes_status_check` allows, in the order a row moves through them. */
export const DISPUTE_STATUSES = deepFreeze([
  "open",
  "under_review",
  "evidence_submitted",
  "won",
  "lost",
  "closed",
] as const);

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** The three statuses that are still somebody's desk: the merchant's, then the compliance desk's. */
export const DISPUTE_OPEN_STATUSES = deepFreeze(["open", "under_review", "evidence_submitted"] as const);

/** The three statuses that are history, and the ones `disputes_resolved_check` requires an instant on. */
export const DISPUTE_RESOLVED_STATUSES = deepFreeze(["won", "lost", "closed"] as const);

/**
 * How far through the machine each status is.
 *
 * This is the whole of the "status tracking" in the STEP's title: a provider delivery may only move a row
 * *forward* in this order, so a late `under_review` that arrives after the processor already closed a
 * dispute cannot reopen the question, and a retried `opened` cannot undo a response. The three terminal
 * statuses share a rank because none of them may follow another - `0039`'s trigger refuses that at the
 * database, and `disputeStatusRank` refuses it before the write.
 */
export const DISPUTE_STATUS_RANK: Readonly<Record<DisputeStatus, number>> = deepFreeze({
  open: 0,
  under_review: 1,
  evidence_submitted: 2,
  won: 3,
  lost: 3,
  closed: 3,
});

/**
 * The four statuses a *provider* delivery may write.
 *
 * `evidence_submitted` is deliberately absent. Section 19 gives that state to the compliance desk, which
 * sends the evidence pack to the processor (STEP 198), and `disputes_evidence_check` requires
 * `evidence_ready` on the row before `submitted_at` exists. A webhook that reported "the processor is
 * looking at it" cannot therefore skip the platform's own submission, and this list is where that is said.
 */
export const DISPUTE_PROVIDER_STATUSES = deepFreeze(["open", "under_review", "won", "lost", "closed"] as const);

/**
 * Who may read a merchant's disputes, and who may read the platform's queue.
 *
 * The merchant's own screen is the `owner` - the same role that asks for a refund - because a dispute is
 * the merchant's money and the merchant writes its side of the answer (STEP 195). The office list is the
 * compliance desk's, because section 19 says `compliance_kyc` reviews the evidence pack and sends it, and
 * the finance desk's, because the chargeback fee is section 18's money rule. `ceo` and `super_admin` read
 * everything by the role matrix of section 2. No role here may *decide* a dispute: the processor does.
 */
export const DISPUTE_REQUEST_ROLES: readonly PlatformRole[] = deepFreeze(["owner"] as const);
export const DISPUTE_OFFICE_ROLES: readonly PlatformRole[] = deepFreeze([
  "ceo",
  "compliance_kyc",
  "finance_ops",
  "super_admin",
] as const);

/** How many of a merchant's disputes one screen lists. */
export const DISPUTE_LIST_LIMIT = 50;

/** How many rows the office deadline queue lists. */
export const DISPUTE_QUEUE_LIMIT = 100;

/**
 * The window section 19 gives a merchant, in hours, and the one `super_admin` may extend it to.
 *
 * `disputes_window_check` allows exactly these two numbers, so a caller cannot invent a third: the
 * default is the 24 hours section 19 states, and 48 is the extension the same sentence allows. The STEP
 * that lets a super administrator choose between them is a later one; this STEP always opens at 24 and
 * says so, rather than reading a value no screen writes yet.
 */
export const DISPUTE_DEFAULT_WINDOW_HOURS = 24;
export const DISPUTE_WINDOW_HOURS = deepFreeze([24, 48] as const);

/**
 * How close to its deadline a window has to be before a screen says so.
 *
 * One number for every screen: the list's badge (STEP 194), the countdown on the response form and the
 * office queue's ordering all read it here, so "due soon" can never mean four hours on one screen and six on
 * another. It is a display rule, never an enforcement rule - only the closed window refuses a save.
 */
export const DISPUTE_DUE_SOON_HOURS = 4;

/** `disputes_reason_check`: 1 to 64 characters, trimmed. */
export const DISPUTE_REASON_MAXIMUM_LENGTH = 64;

/** `disputes_outcome_check`: 1 to 500 characters, trimmed. */
export const DISPUTE_OUTCOME_NOTE_MAXIMUM_LENGTH = 500;

/** `disputes_response_check`: 1 to 20000 characters, the merchant's own words. */
export const DISPUTE_RESPONSE_MINIMUM_LENGTH = 1;
export const DISPUTE_RESPONSE_MAXIMUM_LENGTH = 20_000;

/**
 * The largest body the response route reads.
 *
 * Twenty thousand characters of prose can arrive escaped - a newline is `\n`, a quote is `\"`, an emoji is
 * six bytes - so the ceiling is the text's own bound with room for the escaping, not the bound itself.
 */
export const DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES = 32_768;

/**
 * The extension section 19 allows, and the one role that may make it.
 *
 * "super_admin can set the deadline to 48 hours when needed" - one direction only, because a deadline that
 * could shrink would be a deadline that could take back time a merchant was already using. The service
 * therefore refuses a body naming 24 on a dispute that is already at 48.
 */
export const DISPUTE_EXTENDED_WINDOW_HOURS = 48;
export const DISPUTE_DEADLINE_ROLES: readonly PlatformRole[] = deepFreeze(["super_admin"] as const);

/**
 * Section 19's two warnings, in the order a window meets them.
 *
 * `start` is the opening itself: the merchant is told the window has begun and when it closes. `midpoint` is
 * half way to the deadline - twelve hours into a twenty-four hour window, twenty-four into a forty-eight hour
 * one - which is the last moment a warning can still change the answer. Both are emails queued through
 * `0061`, and `0125` records which of the two each send row was.
 */
export const DISPUTE_WARNING_STAGES = deepFreeze(["start", "midpoint"] as const);

export type DisputeWarningStage = (typeof DISPUTE_WARNING_STAGES)[number];

/** The section 23 template key a deadline warning uses. `0061` accepts it; the stage lives in `0125`. */
export const DISPUTE_WARNING_TEMPLATE_KEY = "dispute_update";

/** What the email is about, in the vocabulary of `email_send_logs.reference_kind`. */
export const DISPUTE_WARNING_REFERENCE_KIND = "dispute";

/** How many times the email system may try a warning: the same ceiling the other platform alerts use. */
export const DISPUTE_WARNING_MAX_ATTEMPTS = 3;

/**
 * How many of a merchant's open disputes one sweep considers.
 *
 * A tick that found more than this is not a busy platform, it is a broken one, and a bounded read that says
 * how much it left for the next tick is better than a sweep that grows until it times out.
 */
export const DISPUTE_WARNING_BATCH_LIMIT = 200;

/**
 * The reason recorded on a send row whose warning another sweep won.
 *
 * A duplicate is dropped rather than deleted: `0061` refuses a delete, and a dropped row with a reason tells
 * the whole story of a race that produced one email instead of two.
 */
export const DISPUTE_WARNING_DUPLICATE_REASON = "A deadline warning for this stage was already queued.";

/** The roles that may send a merchant's due warnings by hand, when the deployment's clock has not. */
export const DISPUTE_WARNING_ROLES: readonly PlatformRole[] = deepFreeze(["ceo", "compliance_kyc", "super_admin"] as const);

/** The largest provider body a dispute webhook reads. Stripe's own ceiling for an event is far smaller. */
export const DISPUTE_WEBHOOK_MAXIMUM_BODY_BYTES = 1_048_576;

/** The longest external event id `webhook_events_external_id_check` keeps. */
export const DISPUTE_EVENT_ID_MAXIMUM_LENGTH = 200;

/**
 * The two amount scales, side by side.
 *
 * The platform counts minor units at four decimals (`services/products/price.ts`: `PRICE_SCALE` is 4), and
 * every processor this platform speaks to counts hundredths - cents. A dispute of `20.00 USD` therefore
 * arrives as `2000` and is stored as `200000`. Getting this wrong by a factor of a hundred is a silent
 * money bug, so the conversion lives in one exported function with the two constants named.
 */
export const PROVIDER_AMOUNT_HUNDREDTHS = 100n;

/** The platform amount, in minor units, of a provider amount in hundredths. */
export function disputeMinorFromProviderHundredths(value: number): bigint {
  return BigInt(Math.trunc(value)) * PROVIDER_AMOUNT_HUNDREDTHS;
}

/** The rules this module refuses with: the `rule` of an `AppError` detail, or the `reason` of a refusal. */
export const DISPUTE_RULES = deepFreeze({
  /** No such dispute, or a dispute of another merchant. */
  disputeNotFound: "dispute_not_found",
  /** The processor names a payment this platform has no row for. */
  paymentNotFound: "dispute_payment_not_found",
  /** The dispute's currency is not the payment's currency. */
  currencyMismatch: "dispute_currency_mismatch",
  /** The disputed amount is zero, negative or not a whole number of minor units. */
  amountInvalid: "dispute_amount_invalid",
  /** The reason code is empty, too long, or not trimmed. */
  reasonInvalid: "dispute_reason_invalid",
  /** The event does not name a status this platform can write. */
  statusMissing: "dispute_status_missing",
  /** The event asks for a status a provider may not write, such as `evidence_submitted`. */
  statusNotFromProvider: "dispute_status_not_from_provider",
  /** The event asks for a status at or behind the one the row already has - a retried or late delivery. */
  statusStale: "dispute_status_stale",
  /** The row is decided, and `0039`'s trigger refuses to reopen it. */
  resolved: "dispute_resolved",
  /** The row moved between the read and the write. */
  disputeMoved: "dispute_moved",
  /** The delivery has no provider that this platform receives dispute events from. */
  providerUnsupported: "webhook_provider_unsupported",
  /** No `payment_providers` row carries the key the delivery names. */
  providerUnknown: "webhook_provider_unknown",
  /** No signing secret is configured for the provider, so nothing can be verified. */
  secretMissing: "webhook_secret_missing",
  /** The signature header is absent, malformed, stale or does not match the body. */
  signatureInvalid: "webhook_signature_invalid",
  /** The body is not JSON, or not the envelope the provider documents. */
  bodyInvalid: "webhook_body_invalid",
  /** The body is larger than `DISPUTE_WEBHOOK_MAXIMUM_BODY_BYTES`. */
  bodyTooLarge: "webhook_body_too_large",
  /** The event carries no usable event id, so it could be applied twice. */
  eventIdInvalid: "webhook_event_id_invalid",
  /** The event says neither `live` nor `test` where the platform needs one. */
  modeInvalid: "webhook_mode_invalid",
  /** The response is empty, too long, not trimmed, or carries a control character the column should not hold. */
  responseInvalid: "dispute_response_invalid",
  /** The merchant is writing after the window section 19 gave them has closed. */
  deadlinePassed: "dispute_deadline_passed",
  /** The pack was already sent to the processor, so the words are fixed. */
  submitted: "dispute_submitted",
  /** The window is not one of the two the schema allows, or the extension goes the wrong way. */
  windowInvalid: "dispute_window_invalid",
  /** The dispute is decided or already sent, so its deadline is history. */
  deadlineNotExtendable: "dispute_deadline_not_extendable",
} as const);

/**
 * The audit actions of this STEP.
 *
 * One per act. `opened` and `moved` are what a delivery does to a dispute, `ignored` is a delivery that
 * was verified and correctly did nothing - a duplicate, a stale status, a resolved row - and `refused` is
 * a delivery that never reached its effect. The four are separate words because an investigator asks four
 * different questions: what appeared, what changed, what was correctly dropped, and what was turned away.
 */
export const DISPUTE_AUDIT = deepFreeze({
  opened: "dispute.opened",
  moved: "dispute.status_changed",
  ignored: "dispute.webhook_ignored",
  refused: "dispute.webhook_rejected",
  listed: "dispute.listed",
  responseSaved: "dispute.response_saved",
  deadlineExtended: "dispute.deadline_extended",
  warningSent: "dispute.warning_sent",
} as const);

/** True when a value is one of `0039`'s six statuses. */
export function isDisputeStatus(value: unknown): value is DisputeStatus {
  return typeof value === "string" && (DISPUTE_STATUSES as readonly string[]).includes(value);
}

/** True when the status is one of the three that are history. */
export function isResolvedDisputeStatus(status: string): boolean {
  return (DISPUTE_RESOLVED_STATUSES as readonly string[]).includes(status);
}

/** True when the status is one a provider delivery may write. */
export function isProviderWritableDisputeStatus(status: string): boolean {
  return (DISPUTE_PROVIDER_STATUSES as readonly string[]).includes(status);
}

/** How far through the machine a status is, or -1 for a word this platform does not know. */
export function disputeStatusRank(status: string): number {
  return isDisputeStatus(status) ? (DISPUTE_STATUS_RANK[status] ?? -1) : -1;
}

/**
 * Whether a provider delivery may move a row from one status to another.
 *
 * Forward only, and never between two terminal statuses: `won` -> `lost` is not a correction, it is a
 * second decision on money that has already been decided, and `0039`'s trigger refuses it.
 */
export function disputeStatusMayMove(from: string, to: DisputeStatus): boolean {
  if (!isProviderWritableDisputeStatus(to)) {
    return false;
  }

  if (isResolvedDisputeStatus(from)) {
    return false;
  }

  return disputeStatusRank(to) > disputeStatusRank(from);
}

/** The deadline of a dispute opened at one instant, for one window: `opened_at + window hours`. */
export function disputeDueAt(openedAtEpochMs: number, windowHours: number): number {
  return openedAtEpochMs + windowHours * 3_600_000;
}

/**
 * Whether an extension may be made, and to what.
 *
 * Only the wider window is available, only from the narrower one: 24 to 48 is section 19's sentence, 48 to
 * 24 is taking back time, and 24 to 24 is a save that changes nothing.
 */
export function disputeExtensionTarget(currentWindowHours: number, requestedWindowHours: number): number | null {
  if (!(DISPUTE_WINDOW_HOURS as readonly number[]).includes(requestedWindowHours)) {
    return null;
  }

  if (requestedWindowHours === DISPUTE_EXTENDED_WINDOW_HOURS && currentWindowHours === DISPUTE_DEFAULT_WINDOW_HOURS) {
    return DISPUTE_EXTENDED_WINDOW_HOURS;
  }

  return null;
}

/**
 * The window of a dispute as a screen prints it, in hours, from the two instants on the row.
 *
 * Read from `response_window_hours` rather than from a subtraction, because the row is the fact and a
 * subtraction of two instants would quietly disagree with it after a hand-written correction.
 */
export function disputeWindowLabel(windowHours: number): string {
  return `${String(windowHours)}h`;
}
