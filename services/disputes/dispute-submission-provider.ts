// path: services/disputes/dispute-submission-provider.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import type { ProviderKey } from "../../lib/payments/registry.ts";

/**
 * The port a processor implements to accept a chargeback evidence pack, and the registry of the ones this build
 * has.
 *
 * ## The shape is `refund-provider.ts`'s, on purpose
 *
 * Every provider STEP in this repository ends at the same seam: a port the core defines, an adapter that
 * implements it, and a runtime that wires the one to the other. A refund's seam is `RefundProviderPort`; this is
 * the evidence pack's. It is a function and not a class, because a class would let an adapter keep state between
 * two calls, and it answers with a union instead of throwing, because a processor's refusal is data: an
 * unanswered call is not a defect in this platform.
 *
 * ## What the target carries, and what it deliberately does not
 *
 * It carries the facts a processor's dispute API asks for: its own case id, the pack's digest, the counts, the
 * four sections with their labels and the instant each record was captured, and each supplied document's name,
 * type, size and SHA-256. It does **not** carry a storage key and it does not carry file bytes. An adapter that
 * needs the files resolves them through the storage layer by document id, which is the seam the file STEPs
 * (100-105) already built for KYC; a port that handed out storage keys would make every adapter responsible for
 * the bucket, and a port that carried bytes would put a merchant's evidence in memory twice.
 *
 * ## The registry is empty, and that is a stated gap rather than an oversight
 *
 * `PROVIDER_KEYS` names five gateways and `payment_providers` seeds the same five, but **no provider's dispute
 * API is documented in this build**: `docs/final/PROVIDER_DOCS.md` records payment, payout, refund, sub-merchant,
 * webhook and account surfaces, and not one of them is a chargeback evidence endpoint. The master prompt's
 * provider rule is explicit - fetch and read the provider's own documentation in the same session, and code from
 * it, never from memory - so this STEP ships the port, the registry and the whole submission path, and leaves the
 * list empty rather than inventing five endpoints.
 *
 * That is not a dead feature. `recorded` is the channel that works today and the one most facilitators use: the
 * compliance desk sends the pack through the processor's own portal and records the case number here, with its
 * name on the row, the pack's digest, the audit entry and the status move. The provider channel is the same call
 * with `SUBMITTING_PROVIDER_KEYS` non-empty, and the refusal it produces until then is a rule a screen can print
 * (`dispute_submission_unsupported`), not a crash and not a silent no-op.
 */

/** The two modes `0029` and `0037` share: evidence answers the mode the disputed payment was taken in. */
export type DisputeSubmissionMode = "test" | "live";

/** One record of the pack, as the processor's case file reads it. */
export interface DisputeSubmissionItem {
  readonly section: string;
  readonly sourceKind: string;
  readonly label: string;
  readonly summary: string | null;
  readonly capturedAt: string;
}

/** One supplied document, by reference and digest: never its bytes, never its storage key. */
export interface DisputeSubmissionDocument {
  readonly id: string;
  readonly section: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly contentSha256: string;
}

/** What a processor is asked to accept. */
export interface DisputeSubmissionTarget {
  /** The `dispute_submissions` row this call belongs to, so an adapter can log against it. */
  readonly submissionId: string;
  readonly disputeId: string;
  readonly companyId: string;
  readonly providerKey: ProviderKey;
  /** The `payment_providers` row the disputed payment points at. */
  readonly providerId: string;
  readonly mode: DisputeSubmissionMode;
  /** The processor's own case id for the dispute, as the delivery that opened it reported. */
  readonly processorDisputeId: string | null;
  /** The disputed amount in the platform's minor unit (ten-thousandths), as decimal text. */
  readonly amountMinor: string;
  readonly currency: string;
  /** The SHA-256 of exactly what is being sent: the frozen pack's own digest. */
  readonly packDigest: string;
  readonly itemCount: number;
  readonly documentCount: number;
  readonly items: readonly DisputeSubmissionItem[];
  readonly documents: readonly DisputeSubmissionDocument[];
}

/**
 * What a processor answers.
 *
 * Four shapes, and none of them an exception: `sent` is an accepted submission with a reference, `declined` is a
 * processor that looked and said no, `unanswered` is a call that produced no answer at all (the evidence may or
 * may not have arrived, which is why it is not `declined`), and `not_sent` is this build refusing to make the
 * call for a reason it can name - an unsupported provider, a missing case id, a missing credential.
 */
export type DisputeSubmissionOutcome =
  | { readonly kind: "sent"; readonly processorReference: string }
  | { readonly kind: "declined"; readonly detail: string }
  | { readonly kind: "unanswered"; readonly detail: string }
  | { readonly kind: "not_sent"; readonly rule: string; readonly detail: string };

/** The port: one call, one answer, no exceptions. */
export type DisputeSubmissionPort = (target: DisputeSubmissionTarget) => Promise<DisputeSubmissionOutcome>;

/**
 * The providers this build can send evidence to through their own API.
 *
 * Empty by design, for the reason in this file's header: the port exists, the path through it exists, and the
 * documentation that would let an adapter be written correctly has not been read in a session yet. Adding the
 * next provider is one adapter file and one entry here; nothing else in this STEP changes.
 */
export const SUBMITTING_PROVIDER_KEYS: readonly ProviderKey[] = deepFreeze([]);

/** The ports, by provider. A provider that is absent is sent through `recorded` or not at all. */
export type DisputeSubmissionPorts = Readonly<Partial<Record<ProviderKey, DisputeSubmissionPort>>>;

/**
 * The port for one provider, or null when this build has none.
 *
 * Null is the answer that becomes `dispute_submission_unsupported`: a dispute of a payment taken through a
 * provider whose chargeback API this build has not documented is one the compliance desk sends through the
 * processor's portal and records, which is a real act with a real audit trail rather than a promised one.
 */
export function submissionPortFor(
  ports: DisputeSubmissionPorts,
  providerKey: ProviderKey,
): DisputeSubmissionPort | null {
  const port = ports[providerKey];

  return port === undefined ? null : port;
}
