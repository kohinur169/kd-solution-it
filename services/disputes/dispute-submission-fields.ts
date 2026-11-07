// path: services/disputes/dispute-submission-fields.ts
import type { PlatformRole } from "../../lib/auth/types.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The vocabulary of STEP 198: the compliance desk's decision on a frozen pack, and the two ways that pack
 * reaches the processor.
 *
 * ## Why this is its own module
 *
 * Two runtimes need these words. The office review screen is a client component and may only import a module
 * that imports nothing but frozen arrays and types; the service imports the REST client and the audit trail and
 * must never reach a browser bundle. Everything a reviewer's screen has to know - the two decisions, the two
 * channels, the limits, the word a refusal names - lives here, and both sides read the same list.
 *
 * ## Why the decisions are two and not three
 *
 * "Approved" means the desk may send this pack. "Declined" means it may not, and the note says why. There is no
 * "needs changes" state, because `0126` made a frozen pack immovable: the merchant cannot amend evidence that
 * has already been frozen, so a third decision would promise an edit the database refuses. A desk that wants a
 * different pack talks to the merchant and the dispute is answered with what it has - or the pack is declined,
 * the dispute stays open, and the processor's own deadline decides what happens next. Saying that here is
 * cheaper than a screen full of buttons that fail.
 *
 * ## Why the two channels exist
 *
 * Section 19 says the desk "sends it to the processor". Most payment facilitators do that through the
 * processor's own portal, because chargeback evidence is a case file, not a payment: `recorded` is that act,
 * with the processor's reference typed in and the officer's name on it. `provider` is the platform calling the
 * processor's API, and this build has no such adapter - `dispute-submission-provider.ts` states that gap, and
 * the refusal is a rule rather than a crash. Both channels write the same row and move the same status, so the
 * screen, the audit chain and STEP 199's monitoring do not care which one was used.
 */

/** The decision column of `dispute_reviews`. */
export const DISPUTE_REVIEW_DECISIONS = deepFreeze(["approved", "declined"] as const);

export type DisputeReviewDecision = (typeof DISPUTE_REVIEW_DECISIONS)[number];

/** The channel column of `dispute_submissions`: the platform called the processor, or a person did. */
export const DISPUTE_SUBMISSION_CHANNELS = deepFreeze(["provider", "recorded"] as const);

export type DisputeSubmissionChannel = (typeof DISPUTE_SUBMISSION_CHANNELS)[number];

/** The three states of one attempt: the claim, the answer, and the answer that was a failure. */
export const DISPUTE_SUBMISSION_STATUSES = deepFreeze(["sending", "sent", "failed"] as const);

export type DisputeSubmissionStatus = (typeof DISPUTE_SUBMISSION_STATUSES)[number];

/**
 * Who reviews and who sends.
 *
 * Section 19 names `compliance_kyc` and section 2's role matrix gives `super_admin` everything, so the list is
 * those two and nobody else - not the finance desk that owns the chargeback fee, not the merchant whose
 * evidence it is. The two acts share one list because they are one desk's work: a reviewer who may approve a
 * pack but not send it would be a role that exists only to be overruled.
 */
export const DISPUTE_REVIEW_ROLES: readonly PlatformRole[] = deepFreeze(["compliance_kyc", "super_admin"]);

/** The longest reason a reviewer may give, and the shortest: a decision without a reason is not a review. */
export const DISPUTE_REVIEW_NOTE_MINIMUM_LENGTH = 1;
export const DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH = 500;

/** The processor's own case number, as a person types it off the processor's portal. */
export const DISPUTE_SUBMISSION_REFERENCE_MINIMUM_LENGTH = 1;
export const DISPUTE_SUBMISSION_REFERENCE_MAXIMUM_LENGTH = 120;

/** How many packs the review queue lists, and how many decisions one pack's screen prints. */
export const DISPUTE_REVIEW_QUEUE_LIMIT = 100;
export const DISPUTE_REVIEW_HISTORY_LIMIT = 10;

/** The largest body either route reads: two small fields and a uuid. */
export const DISPUTE_SUBMISSION_MAXIMUM_BODY_BYTES = 2048;

/** The field both routes name in a refusal, so one panel has one place to print it. */
export const DISPUTE_SUBMISSION_FIELD = "submission";

/** The template `0061` carries for a dispute update, and the reference kind the queue row names. */
export const DISPUTE_SUBMISSION_TEMPLATE_KEY = "dispute_update";
export const DISPUTE_SUBMISSION_REFERENCE_KIND = "dispute";

/** How many times the email queue tries a dispute update before it gives up, the same number the warnings use. */
export const DISPUTE_SUBMISSION_MAX_ATTEMPTS = 5;

/** The words a refusal names. Each one is a sentence the merchant or the officer reads. */
export const DISPUTE_SUBMISSION_RULES = deepFreeze({
  /** The dispute is not on this desk's desk, or does not exist. */
  disputeNotFound: "dispute_not_found",
  /** No frozen pack exists, so there is nothing to review and nothing to send. */
  packMissing: "dispute_pack_missing",
  /** The latest decision on this pack is not an approval. */
  reviewRequired: "dispute_review_required",
  /** The dispute is decided; `0039` refuses to reopen it and this desk does not review history. */
  disputeResolved: "dispute_resolved",
  /** The pack has already been sent, or is being sent right now. */
  submissionExists: "dispute_submission_exists",
  /** This build has no documented dispute API for the payment's provider, so the provider channel cannot run. */
  submissionUnsupported: "dispute_submission_unsupported",
  /** The processor answered but did not accept the evidence. */
  submissionDeclined: "dispute_submission_declined",
  /** The processor did not answer, so the evidence may or may not have arrived. */
  submissionUnanswered: "dispute_submission_unanswered",
  /** The payment behind the dispute names no provider, so no channel can be chosen. */
  providerMissing: "dispute_provider_missing",
  /** The row moved between the read and the write. */
  disputeMoved: "dispute_moved",
  /** The processor accepted the evidence and the dispute already says so. */
  alreadySubmitted: "dispute_already_submitted",
} as const);

export type DisputeSubmissionRule = (typeof DISPUTE_SUBMISSION_RULES)[keyof typeof DISPUTE_SUBMISSION_RULES];

/** True when the value is one of the two decisions. */
export function isDisputeReviewDecision(value: unknown): value is DisputeReviewDecision {
  return typeof value === "string" && (DISPUTE_REVIEW_DECISIONS as readonly string[]).includes(value);
}

/** True when the value is one of the two channels. */
export function isDisputeSubmissionChannel(value: unknown): value is DisputeSubmissionChannel {
  return typeof value === "string" && (DISPUTE_SUBMISSION_CHANNELS as readonly string[]).includes(value);
}

/** True when the value is one of the three attempt states. */
export function isDisputeSubmissionStatus(value: unknown): value is DisputeSubmissionStatus {
  return typeof value === "string" && (DISPUTE_SUBMISSION_STATUSES as readonly string[]).includes(value);
}
