// path: lib/kyc/adapters/deliveries.ts

/**
 * The deliveries the three supplementary identity vendors send, verified before anything in them is believed, deduplicated
 * so a retry changes nothing, and applied only through STEP 170's forward-only recorder - never onto a processor KYB status.
 *
 * ## Documentation read in this session (2026-11-07)
 *
 * Every fact below comes from a vendor's own page, read before this file was written.
 *
 * | Topic | URL | What it established |
 * |---|---|---|
 * | Sumsub webhooks | https://docs.sumsub.com/docs/webhooks.md | Deliveries go to an HTTPS endpoint, Slack, Telegram or email; every notification is logged and retried. |
 * | Sumsub sender verification | https://docs.sumsub.com/docs/webhook-manager.md | Each webhook carries a **secret key** used for a digest; the digest is `HMAC(secret, raw body)` as **lower-case hex**, sent in `x-payload-digest`, with the algorithm named in `x-payload-digest-alg`: `HMAC_SHA256_HEX` (the dashboard default), `HMAC_SHA512_HEX`, or `HMAC_SHA1_HEX` which is **legacy and deprecated**. The body must be hashed as received, "without any alteration or conversion to JSON". The endpoint must accept within 1 second and answer within 10, and only HTTPS is used. Retries: five resends (six attempts) at 1 minute, 5 minutes, 1 hour, 5 hours, 18 hours; **`401`, `403` and `404` are permanent** and are not retried, while every other non-2xx and every timeout is retried. A test webhook carries `"testMode": true`, which is **never** sent in production. |
 * | Sumsub payload | https://docs.sumsub.com/docs/receive-and-interpret-results-via-api.md | `applicantReviewed` carries `applicantId`, `inspectionId`, `applicantType`, `correlationId`, `externalUserId`, `levelName`, `type`, `sandboxMode`, `reviewResult.reviewAnswer` (`GREEN`/`RED`), `reviewStatus`, `createdAtMs`, `createdAt` and `clientId`. The documentation also states the result is to be read from the applicant, and that `reviewRejectType` separates `FINAL` from `RETRY`. |
 * | Sumsub event types | https://docs.sumsub.com/docs/user-verification-webhooks.md | The webhook catalogue names `applicantCreated`, `applicantPending`, `applicantReviewed`, `applicantPrechecked` (deprecated), `applicantReset`, `applicantLevelChanged`, `applicantWorkflowCompleted`, `applicantWorkflowFailed`, `videoIdentStatusChanged` and more. Only `applicantReviewed` announces a decision; the rest announce a state this platform does not need to act on. |
 * | Didit webhooks | https://docs.didit.me/integration/webhooks.md | Read the raw body **before** parsing. Headers: `X-Signature-V2` (recommended, over a canonical JSON that the page does not specify), `X-Signature` (**HMAC-SHA256 over the exact raw bytes**), `X-Signature-Simple` (deprecated, over `timestamp:session_id:status:webhook_type`, which authenticates the envelope only and never the decision), `X-Timestamp` (Unix seconds), and a `-Previous` variant of each for 24 hours after a secret rotation. The timestamp must be within **300 seconds**. Compare in constant time and accept a match on either the current or the previous header. Retries: on `5xx`, `404`, timeout or connection failure, twice (about 1 minute, then about 4 minutes), re-signed with the current secret and a fresh timestamp. The envelope carries `event_id`, `session_id`, `status`, `webhook_type`, `created_at`, `timestamp`, `application_id`, `environment`, `sandbox_scenario`, `workflow_id`, `workflow_version`, `vendor_data` and `decision`; duplicates are to be keyed on `event_id`, and delivery order is not guaranteed. |
 * | Jumio callbacks | https://documentation.jumio.ai/docs/developer-resources/callback | The callback is an HTTP **POST** of JSON with `callbackSentAt`, `userReference`, `workflowExecution{id, href, definitionKey, status}` and `account{id, href}`. `workflowExecution.status` is one of `INITIATED`, `PROCESSED`, `ACQUISITION_STARTED`, `ACQUIRED`, `SESSION_EXPIRED`, `TOKEN_EXPIRED`. **No signature and no shared secret are documented**; what is documented is a per-region **IP allowlist** and callback hostnames, and the instruction to save the callback, answer **200 OK**, and then retrieve the authoritative transaction through the Retrieval API. |
 *
 * ## What this file does with those facts
 *
 * 1. **Nothing is believed before it is verified.** `verifySupplementaryIdvDelivery` runs on the raw bytes as received
 *    and returns `verified`, `unsigned` or `refused` with a reason. Sumsub is checked with the documented digest and
 *    algorithm header; Didit with `X-Signature` over the exact bytes, its 300-second window and its `-Previous` header
 *    during a rotation; Jumio has no signature to check, so it is `unsigned` unless the caller supplies a peer address
 *    inside the documented allowlist.
 * 2. **An unverified delivery decides nothing.** Even a verified delivery does not set a result here: it names a session,
 *    and the answer is read from the vendor through the vendor adapter's own `readSession`, then recorded by STEP 170's
 *    `recordSupplementaryIdvAnswer`. That is what all three vendors document as the authoritative path, and it means a
 *    forged or stale body can at worst ask for a read of a session it cannot create.
 * 3. **A duplicate changes nothing.** The deduplication key is the vendor's own event id when it documents one (Didit's
 *    `event_id`) and the SHA-256 of the raw body otherwise, because Sumsub and Jumio document no delivery id. The claim is
 *    taken after verification and released again if the read or the record fails, so a retry is never lost to a claim
 *    that never produced a state.
 * 4. **A test delivery is never a result.** Sumsub marks a test webhook with `"testMode": true` and states that the field
 *    is never sent in production, so a body carrying it is acknowledged and dropped.
 * 5. **A mode mismatch is refused.** Sumsub sends `sandboxMode` and Didit sends `environment`; a delivery that disagrees
 *    with the environment its configuration was sealed under is refused rather than recorded.
 * 6. **No payload is stored.** The raw body carries names, dates of birth and document numbers. This file computes a hash
 *    for deduplication, keeps the vendor's own status words only in the audit trail, and stores no body, no name and no
 *    document.
 * 7. **The answer is the vendor's, not this platform's.** The receiver answers `200` when the delivery is handled or is a
 *    duplicate, `400` when it cannot be parsed, `401` when it cannot be verified, `404` when it names a session this
 *    company does not hold, and `500` when the state could not be recorded - mapped per vendor where the vendor documents
 *    different retry classes.
 *
 * ## What this STEP deliberately does not do
 *
 * It adds no route, no job and no table: the receiver is a function a route handler calls with the bytes it received, and
 * the stores are the in-memory implementations of STEP 170 plus the delivery store declared here. The screen that turns a
 * vendor on, the manual fallback and the processor-KYB gate are STEP 175's.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  openSupplementaryIdvConfig,
  recordSupplementaryIdvAnswer,
  type OpenedSupplementaryIdvConfig,
  type SupplementaryIdvConfigStore,
  type SupplementaryIdvEnvironment,
  type SupplementaryIdvSession,
  type SupplementaryIdvSessionStore,
  type SupplementaryIdvVendorAnswer,
  type SupplementaryIdvVendorKey,
} from "./supplementary-idv.ts";
import { isSumsubApplicantId } from "./sumsub.ts";

/* -------------------------------------------------------------------------------------------------
 * The vocabulary of an answer
 * ---------------------------------------------------------------------------------------------- */

/** What a delivery turned out to be. */
export const SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES = deepFreeze([
  "accepted",
  "duplicate",
  "ignored",
  "test",
  "unverified",
  "malformed",
  "unknown_session",
  "refused",
  "failed",
] as const);

/** One delivery outcome. */
export type SupplementaryIdvDeliveryOutcome = (typeof SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES)[number];

/** True when a string is one of this file's outcomes. */
export function isSupplementaryIdvDeliveryOutcome(value: string): value is SupplementaryIdvDeliveryOutcome {
  return (SUPPLEMENTARY_IDV_DELIVERY_OUTCOMES as readonly string[]).includes(value);
}

/** The outcomes that end a delivery without a state change but with an acknowledgement. */
export const SUPPLEMENTARY_IDV_ACKNOWLEDGED_OUTCOMES = deepFreeze(["accepted", "duplicate", "ignored", "test"] as const);

/**
 * The answer each vendor is given, per outcome.
 *
 * Sumsub documents `401`, `403` and `404` as permanent and everything else as retried, so the division is the vendor's
 * own. Didit retries `5xx`, `404`, timeouts and connection failures, so a plain `400` or `401` already stops it. Jumio
 * documents only that the callback should be answered `200`, so the same classes are used to tell it what to do.
 */
export const SUPPLEMENTARY_IDV_DELIVERY_ANSWERS: Readonly<
  Record<SupplementaryIdvVendorKey, Readonly<Record<SupplementaryIdvDeliveryOutcome, number>>>
> = deepFreeze({
  sumsub: {
    accepted: 200,
    duplicate: 200,
    ignored: 200,
    test: 200,
    unverified: 401,
    malformed: 400,
    unknown_session: 404,
    refused: 500,
    failed: 500,
  },
  didit: {
    accepted: 200,
    duplicate: 200,
    ignored: 200,
    test: 200,
    unverified: 401,
    malformed: 400,
    unknown_session: 404,
    refused: 500,
    failed: 500,
  },
  jumio: {
    accepted: 200,
    duplicate: 200,
    ignored: 200,
    test: 200,
    unverified: 401,
    malformed: 400,
    unknown_session: 404,
    refused: 500,
    failed: 500,
  },
});

/** The HTTP status a vendor is answered with for one outcome. */
export function supplementaryIdvDeliveryAnswerOf(vendorKey: SupplementaryIdvVendorKey, outcome: SupplementaryIdvDeliveryOutcome): number {
  return SUPPLEMENTARY_IDV_DELIVERY_ANSWERS[vendorKey][outcome];
}

/* -------------------------------------------------------------------------------------------------
 * The documented header names
 * ---------------------------------------------------------------------------------------------- */

/** Sumsub's digest header and its algorithm header, spelled as the documentation spells them. */
export const SUMSUB_DIGEST_HEADER = "x-payload-digest";
export const SUMSUB_DIGEST_ALGORITHM_HEADER = "x-payload-digest-alg";

/** Didit's signature headers and clock header. */
export const DIDIT_SIGNATURE_HEADER = "X-Signature";
export const DIDIT_SIGNATURE_PREVIOUS_HEADER = "X-Signature-Previous";
export const DIDIT_SIGNATURE_V2_HEADER = "X-Signature-V2";
export const DIDIT_SIGNATURE_SIMPLE_HEADER = "X-Signature-Simple";
export const DIDIT_TIMESTAMP_HEADER = "X-Timestamp";

/** Didit's documented clock window, in seconds. */
export const DIDIT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Didit's documented static delivery address and user agent, for an operator who can allowlist them. */
export const DIDIT_DELIVERY_ADDRESS = "18.203.201.92";
export const DIDIT_DELIVERY_USER_AGENT = "DiditWebhook/2.0 +https://didit.me";

/** Jumio's documented callback addresses, by data-centre region. */
export const JUMIO_CALLBACK_ADDRESSES: Readonly<Record<string, { readonly hostname: string; readonly addresses: readonly string[] }>> =
  deepFreeze({
    us: {
      hostname: "callback.amer-1.jumio.ai",
      addresses: ["34.202.241.227", "34.226.103.119", "34.226.254.127", "52.8.136.236", "54.177.61.57", "54.183.15.212"],
    },
    eu: {
      hostname: "callback.emea-1.jumio.ai",
      addresses: ["34.253.41.236", "35.157.27.193", "52.48.0.25", "52.57.194.92", "52.58.113.86", "52.209.180.134"],
    },
    sgp: {
      hostname: "callback.apac-1.jumio.ai",
      addresses: ["3.0.109.121", "52.76.184.73", "52.77.102.92", "13.238.100.17", "13.238.203.238", "52.64.132.26"],
    },
  });

/** Every documented Jumio callback address, flattened. */
export const JUMIO_CALLBACK_IPS: readonly string[] = deepFreeze(
  Object.values(JUMIO_CALLBACK_ADDRESSES).flatMap((region) => region.addresses),
);

/** True when an address is one Jumio documents for its callbacks. */
export function isJumioCallbackAddress(address: string): boolean {
  return JUMIO_CALLBACK_IPS.includes(address.trim());
}

/* -------------------------------------------------------------------------------------------------
 * The vendor vocabularies a delivery may use
 * ---------------------------------------------------------------------------------------------- */

/**
 * The Sumsub delivery types this file reads.
 *
 * Only `applicantReviewed` announces a decision, and the other two are named in the documentation's own catalogue, so a
 * type outside these three is acknowledged and ignored rather than guessed at.
 */
export const SUMSUB_DELIVERY_TYPES = deepFreeze(["applicantCreated", "applicantPending", "applicantReviewed"] as const);

/** The one Sumsub delivery type that carries a decision. */
export const SUMSUB_DECISION_DELIVERY_TYPE = "applicantReviewed";

/** True when a Sumsub delivery type is one this file reads. */
export function isSumsubDeliveryType(value: string): boolean {
  return (SUMSUB_DELIVERY_TYPES as readonly string[]).includes(value);
}

/** The Didit statuses, exact and case-sensitive, as the envelope documents them. */
export const DIDIT_DELIVERY_STATUSES = deepFreeze([
  "Approved",
  "Declined",
  "In Review",
  "In Progress",
  "Not Started",
  "Abandoned",
  "Expired",
  "Kyc Expired",
  "Resubmitted",
  "Awaiting User",
] as const);

/** The Didit statuses after which a read is worth making. */
export const DIDIT_READ_STATUSES = deepFreeze(["Approved", "Declined", "In Review", "Abandoned", "Expired", "Kyc Expired"] as const);

/** True when a Didit status is one the envelope documents. */
export function isDiditDeliveryStatus(value: string): boolean {
  return (DIDIT_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/** True when a Didit status asks for a read. */
export function isDiditReadStatus(value: string): boolean {
  return (DIDIT_READ_STATUSES as readonly string[]).includes(value);
}

/** The one Didit event family this file reads: a session's status. */
export const DIDIT_STATUS_EVENT_TYPE = "status.updated";

/** The Jumio workflow statuses, exact and case-sensitive. */
export const JUMIO_DELIVERY_STATUSES = deepFreeze([
  "INITIATED",
  "PROCESSED",
  "ACQUISITION_STARTED",
  "ACQUIRED",
  "SESSION_EXPIRED",
  "TOKEN_EXPIRED",
] as const);

/** The Jumio statuses after which a read is worth making. */
export const JUMIO_READ_STATUSES = deepFreeze(["PROCESSED", "ACQUIRED", "SESSION_EXPIRED", "TOKEN_EXPIRED"] as const);

/** True when a Jumio status is one the documentation names. */
export function isJumioDeliveryStatus(value: string): boolean {
  return (JUMIO_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/** True when a Jumio status asks for a read. */
export function isJumioReadStatus(value: string): boolean {
  return (JUMIO_READ_STATUSES as readonly string[]).includes(value);
}

/** The UUID shape the three vendors' session identifiers take. */
export const DELIVERY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** True when a value is a UUID, case-insensitively. */
export function isDeliveryUuid(value: string): boolean {
  return DELIVERY_UUID_PATTERN.test(value.trim().toLowerCase());
}

/* -------------------------------------------------------------------------------------------------
 * Headers, read the one way
 * ---------------------------------------------------------------------------------------------- */

/** The headers a receiver hands over: names as they arrived, values already flattened. */
export type SupplementaryIdvHeaders = Readonly<Record<string, string>>;

/**
 * Read one header, case-insensitively.
 *
 * HTTP header names are case-insensitive, and Sumsub documents its own in lower case while Didit documents its in mixed
 * case, so a receiver must not depend on which spelling the transport preserved.
 */
export function deliveryHeaderOf(headers: SupplementaryIdvHeaders, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === wanted) {
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Signature primitives
 * ---------------------------------------------------------------------------------------------- */

/** The largest body this receiver reads. */
export const SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES = 262_144;

/** The hash used for deduplicating a body that carries no delivery id. */
export function deliveryBodyHashOf(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** An HMAC in lower-case hex, over the raw body. */
export function deliveryHmacHexOf(algorithm: "sha256" | "sha512", secret: string, rawBody: string): string {
  return createHmac(algorithm, secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking where they differ.
 *
 * The length is compared first, because `timingSafeEqual` throws on unequal buffers, and a differing length is itself a
 * mismatch rather than an error.
 */
export function deliveryDigestsMatch(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected.trim().toLowerCase(), "utf8");
  const right = Buffer.from(candidate.trim().toLowerCase(), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------------------------------
 * Verification
 * ---------------------------------------------------------------------------------------------- */

/** The Sumsub digest algorithms that are accepted, and the crypto name of each. */
export const SUMSUB_DIGEST_ALGORITHMS: Readonly<Record<string, "sha256" | "sha512">> = deepFreeze({
  HMAC_SHA256_HEX: "sha256",
  HMAC_SHA512_HEX: "sha512",
});

/** The Sumsub digest algorithm the documentation calls legacy and deprecated. */
export const SUMSUB_DEPRECATED_DIGEST_ALGORITHM = "HMAC_SHA1_HEX";

/** Why a delivery could not be verified. */
export const SUPPLEMENTARY_IDV_VERIFICATION_REASONS = deepFreeze([
  "digest_missing",
  "digest_algorithm_missing",
  "digest_algorithm_deprecated",
  "digest_algorithm_unknown",
  "digest_mismatch",
  "signature_missing",
  "signature_mismatch",
  "signature_only_canonical_json",
  "signature_only_envelope",
  "timestamp_missing",
  "timestamp_stale",
  "timestamp_malformed",
  "secret_missing",
  "peer_address_missing",
  "peer_address_refused",
  "body_empty",
  "body_too_large",
] as const);

/** One verification refusal reason. */
export type SupplementaryIdvVerificationReason = (typeof SUPPLEMENTARY_IDV_VERIFICATION_REASONS)[number];

/**
 * What verifying a delivery concluded.
 *
 * `verified` means a documented signature over the exact bytes matched. `unsigned` means the vendor documents no
 * signature and the caller could not supply a trusted peer address, or the vendor documents no signature at all (Jumio):
 * the delivery is a hint, never a decision. `refused` means the delivery claimed a signature and it did not hold.
 */
export type SupplementaryIdvVerification =
  | { readonly verdict: "verified"; readonly vendorKey: SupplementaryIdvVendorKey; readonly method: string }
  | { readonly verdict: "unsigned"; readonly vendorKey: SupplementaryIdvVendorKey; readonly reason: SupplementaryIdvVerificationReason }
  | { readonly verdict: "refused"; readonly vendorKey: SupplementaryIdvVendorKey; readonly reason: SupplementaryIdvVerificationReason };

/** The secrets one verification needs. */
export interface SupplementaryIdvDeliverySecrets {
  readonly webhookSecret: string | null;
}

/** Verify a Sumsub delivery with the documented digest and algorithm header. */
export function verifySumsubDelivery(
  headers: SupplementaryIdvHeaders,
  rawBody: string,
  secrets: SupplementaryIdvDeliverySecrets,
): SupplementaryIdvVerification {
  const digest = deliveryHeaderOf(headers, SUMSUB_DIGEST_HEADER);
  if (digest === null) return { verdict: "refused", vendorKey: "sumsub", reason: "digest_missing" };
  const algorithmName = deliveryHeaderOf(headers, SUMSUB_DIGEST_ALGORITHM_HEADER);
  if (algorithmName === null) return { verdict: "refused", vendorKey: "sumsub", reason: "digest_algorithm_missing" };
  if (algorithmName === SUMSUB_DEPRECATED_DIGEST_ALGORITHM) {
    return { verdict: "refused", vendorKey: "sumsub", reason: "digest_algorithm_deprecated" };
  }
  const algorithm = SUMSUB_DIGEST_ALGORITHMS[algorithmName];
  if (algorithm === undefined) return { verdict: "refused", vendorKey: "sumsub", reason: "digest_algorithm_unknown" };
  const secret = secrets.webhookSecret;
  if (secret === null || secret.trim().length === 0) return { verdict: "refused", vendorKey: "sumsub", reason: "secret_missing" };
  if (rawBody.length === 0) return { verdict: "refused", vendorKey: "sumsub", reason: "body_empty" };
  // The digest is over the bytes as received: no trimming, no re-serialization, no normalization of any kind.
  const expected = deliveryHmacHexOf(algorithm, secret, rawBody);
  if (deliveryDigestsMatch(expected, digest) === false) return { verdict: "refused", vendorKey: "sumsub", reason: "digest_mismatch" };
  return { verdict: "verified", vendorKey: "sumsub", method: algorithmName };
}

/**
 * Verify a Didit delivery with `X-Signature` over the exact bytes, its clock window, and its previous header.
 *
 * `X-Signature-V2` is documented over a canonical JSON whose form the page read here does not specify, so a delivery that
 * carries only `V2` is refused rather than half-checked. `X-Signature-Simple` authenticates the envelope alone by the
 * documentation's own words, so it is never enough on its own either.
 */
export function verifyDiditDelivery(
  headers: SupplementaryIdvHeaders,
  rawBody: string,
  secrets: SupplementaryIdvDeliverySecrets,
  nowEpochMs: number,
): SupplementaryIdvVerification {
  const secret = secrets.webhookSecret;
  if (secret === null || secret.trim().length === 0) return { verdict: "refused", vendorKey: "didit", reason: "secret_missing" };
  if (rawBody.length === 0) return { verdict: "refused", vendorKey: "didit", reason: "body_empty" };

  const timestamp = deliveryHeaderOf(headers, DIDIT_TIMESTAMP_HEADER);
  if (timestamp === null) return { verdict: "refused", vendorKey: "didit", reason: "timestamp_missing" };
  if (/^\d{1,12}$/u.test(timestamp) === false) return { verdict: "refused", vendorKey: "didit", reason: "timestamp_malformed" };
  const sentAtSeconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(nowEpochMs / 1_000);
  if (Math.abs(nowSeconds - sentAtSeconds) > DIDIT_SIGNATURE_TOLERANCE_SECONDS) {
    return { verdict: "refused", vendorKey: "didit", reason: "timestamp_stale" };
  }

  const signature = deliveryHeaderOf(headers, DIDIT_SIGNATURE_HEADER);
  const previous = deliveryHeaderOf(headers, DIDIT_SIGNATURE_PREVIOUS_HEADER);
  if (signature === null && previous === null) {
    const canonical = deliveryHeaderOf(headers, DIDIT_SIGNATURE_V2_HEADER);
    if (canonical !== null) return { verdict: "refused", vendorKey: "didit", reason: "signature_only_canonical_json" };
    const simple = deliveryHeaderOf(headers, DIDIT_SIGNATURE_SIMPLE_HEADER);
    if (simple !== null) return { verdict: "refused", vendorKey: "didit", reason: "signature_only_envelope" };
    return { verdict: "refused", vendorKey: "didit", reason: "signature_missing" };
  }

  const expected = deliveryHmacHexOf("sha256", secret, rawBody);
  if (signature !== null && deliveryDigestsMatch(expected, signature)) {
    return { verdict: "verified", vendorKey: "didit", method: "X-Signature" };
  }
  if (previous !== null && deliveryDigestsMatch(expected, previous)) {
    // The same body signed by the replaced secret during the documented 24-hour rotation window.
    return { verdict: "verified", vendorKey: "didit", method: "X-Signature-Previous" };
  }
  return { verdict: "refused", vendorKey: "didit", reason: "signature_mismatch" };
}

/**
 * Read a Jumio callback's authenticity.
 *
 * Jumio documents no signature and no shared secret; what it documents is a per-region IP allowlist and callback hostname.
 * An address the transport is sure of, inside that list, is therefore `verified` by allowlist. Without such an address the
 * delivery is `unsigned`: it can still name a transaction to read, and it can never set a result.
 */
export function verifyJumioDelivery(peerAddress: string | null): SupplementaryIdvVerification {
  if (peerAddress === null || peerAddress.trim().length === 0) {
    return { verdict: "unsigned", vendorKey: "jumio", reason: "peer_address_missing" };
  }
  if (isJumioCallbackAddress(peerAddress) === false) {
    return { verdict: "refused", vendorKey: "jumio", reason: "peer_address_refused" };
  }
  return { verdict: "verified", vendorKey: "jumio", method: "IP allowlist" };
}

/** Verify one delivery with the vendor's own documented method. */
export function verifySupplementaryIdvDelivery(
  vendorKey: SupplementaryIdvVendorKey,
  headers: SupplementaryIdvHeaders,
  rawBody: string,
  secrets: SupplementaryIdvDeliverySecrets,
  options: { readonly nowEpochMs: number; readonly peerAddress: string | null },
): SupplementaryIdvVerification {
  if (rawBody.length > SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES) {
    return { verdict: "refused", vendorKey, reason: "body_too_large" };
  }
  if (vendorKey === "sumsub") return verifySumsubDelivery(headers, rawBody, secrets);
  if (vendorKey === "didit") return verifyDiditDelivery(headers, rawBody, secrets, options.nowEpochMs);
  return verifyJumioDelivery(options.peerAddress);
}

/* -------------------------------------------------------------------------------------------------
 * Reading a delivery
 * ---------------------------------------------------------------------------------------------- */

/**
 * What a delivery says, in the vocabulary this platform uses for deliveries.
 *
 * It deliberately carries no `result`: a delivery does not decide anything here. It names a session and, at most, a
 * vendor status word this platform keeps in its audit trail.
 */
export interface SupplementaryIdvDelivery {
  readonly vendorKey: SupplementaryIdvVendorKey;
  /** The deduplication key: the vendor's event id when it documents one, otherwise the hash of the raw body. */
  readonly deliveryKey: string;
  readonly deliveryType: string;
  /** The vendor's own status word, kept for the office and never turned into a result here. */
  readonly status: string | null;
  /** The vendor's own identifier for the session, which is what STEP 170 stores as the reference. */
  readonly reference: string | null;
  /** This platform's session id, when the vendor echoes it back. */
  readonly sessionId: string | null;
  readonly environment: SupplementaryIdvEnvironment | null;
  readonly testMode: boolean;
  readonly occurredAtEpochMs: number | null;
  /** True when a read is worth making: the delivery announces something a read can confirm. */
  readonly wantsRead: boolean;
  /** The hash of the bytes that arrived, which is all this platform keeps of them. */
  readonly bodyHash: string;
}

function deliveryJsonOf(rawBody: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed) === false
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function exactTextOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function epochMsOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Sumsub sends `createdAtMs` as a formatted date string rather than a number; Didit sends seconds.
    return value < 1_000_000_000_000 ? Math.trunc(value) * 1_000 : Math.trunc(value);
  }
  return null;
}

function environmentOf(value: unknown): SupplementaryIdvEnvironment | null {
  return value === "live" ? "live" : value === "sandbox" ? "sandbox" : null;
}

/** Read a Sumsub delivery body. */
function sumsubDeliveryOf(rawBody: string): SupplementaryIdvDelivery | null {
  const body = deliveryJsonOf(rawBody);
  if (body === null) return null;
  const type = exactTextOf(body["type"]);
  // A body without a type is not a Sumsub delivery at all. A type outside the catalogue is a delivery this platform does
  // not read: it is acknowledged and ignored rather than answered as malformed, so a new event does not become a retry storm.
  if (type === null) return null;
  const applicantId = textOf(body["applicantId"]);
  const externalUserId = textOf(body["externalUserId"]);
  return {
    vendorKey: "sumsub",
    deliveryKey: deliveryBodyHashOf(rawBody),
    deliveryType: type,
    status: textOf(body["reviewStatus"]),
    reference: applicantId !== null && isSumsubApplicantId(applicantId) ? applicantId : null,
    sessionId: externalUserId,
    environment: body["sandboxMode"] === true ? "sandbox" : body["sandboxMode"] === false ? "live" : null,
    testMode: body["testMode"] === true,
    occurredAtEpochMs: epochMsOf(body["createdAt"]),
    wantsRead: type === SUMSUB_DECISION_DELIVERY_TYPE,
    bodyHash: deliveryBodyHashOf(rawBody),
  };
}

/** Read a Didit delivery body. */
function diditDeliveryOf(rawBody: string): SupplementaryIdvDelivery | null {
  const body = deliveryJsonOf(rawBody);
  if (body === null) return null;
  const type = exactTextOf(body["webhook_type"]);
  if (type === null) return null;
  const status = exactTextOf(body["status"]);
  const sessionId = textOf(body["session_id"]);
  const eventId = textOf(body["event_id"]);
  return {
    vendorKey: "didit",
    // The documentation names `event_id` as the deduplication key and the console's own delivery log does the same.
    deliveryKey: eventId !== null && eventId.length <= 200 ? `event:${eventId}` : deliveryBodyHashOf(rawBody),
    deliveryType: type,
    status: status !== null && isDiditDeliveryStatus(status) ? status : null,
    reference: sessionId !== null && isDeliveryUuid(sessionId) ? sessionId : null,
    sessionId: textOf(body["vendor_data"]),
    environment: environmentOf(body["environment"]),
    testMode: false,
    occurredAtEpochMs: epochMsOf(body["timestamp"]),
    wantsRead: type === DIDIT_STATUS_EVENT_TYPE && status !== null && isDiditReadStatus(status),
    bodyHash: deliveryBodyHashOf(rawBody),
  };
}

/** Read a Jumio callback body. */
function jumioDeliveryOf(rawBody: string): SupplementaryIdvDelivery | null {
  const body = deliveryJsonOf(rawBody);
  if (body === null) return null;
  const execution = typeof body["workflowExecution"] === "object" && body["workflowExecution"] !== null
    ? (body["workflowExecution"] as Readonly<Record<string, unknown>>)
    : null;
  if (execution === null) return null;
  const status = exactTextOf(execution["status"]);
  // A callback without a status is not a Jumio callback. A status outside the six documented ones is acknowledged and
  // left alone: the enum is Jumio's, and this platform does not invent a meaning for a word it has not read.
  if (status === null) return null;
  const executionId = textOf(execution["id"]);
  return {
    vendorKey: "jumio",
    // Jumio documents no delivery id, so the body hash is the identity of one delivery.
    deliveryKey: deliveryBodyHashOf(rawBody),
    deliveryType: "callback",
    status,
    reference: executionId !== null && isDeliveryUuid(executionId) ? executionId : null,
    sessionId: null,
    environment: null,
    testMode: false,
    occurredAtEpochMs: null,
    wantsRead: isJumioReadStatus(status),
    bodyHash: deliveryBodyHashOf(rawBody),
  };
}

/** Read one delivery body with the vendor's own parser. */
export function parseSupplementaryIdvDelivery(vendorKey: SupplementaryIdvVendorKey, rawBody: string): SupplementaryIdvDelivery | null {
  if (vendorKey === "sumsub") return sumsubDeliveryOf(rawBody);
  if (vendorKey === "didit") return diditDeliveryOf(rawBody);
  return jumioDeliveryOf(rawBody);
}

/* -------------------------------------------------------------------------------------------------
 * The delivery store, and why a claim is released
 * ---------------------------------------------------------------------------------------------- */

/** What the store remembers about one delivery, which is never the body. */
export interface SupplementaryIdvDeliveryRecord {
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly companyId: string;
  readonly deliveryKey: string;
  readonly outcome: SupplementaryIdvDeliveryOutcome;
  readonly httpStatus: number;
  readonly occurredAtEpochMs: number;
}

/** The delivery store: one row per delivered body, unique on vendor and key per company. */
export interface SupplementaryIdvDeliveryStore {
  /** Take the claim for one delivery. True when it is new, false when it was already claimed. */
  claim(entry: {
    readonly vendorKey: SupplementaryIdvVendorKey;
    readonly companyId: string;
    readonly deliveryKey: string;
    readonly occurredAtEpochMs: number;
  }): boolean;
  /** Settle a claim with its outcome. */
  settle(record: SupplementaryIdvDeliveryRecord): void;
  /** Give a claim back, because nothing was recorded and a retry must be able to proceed. */
  release(vendorKey: SupplementaryIdvVendorKey, companyId: string, deliveryKey: string): void;
  find(vendorKey: SupplementaryIdvVendorKey, companyId: string, deliveryKey: string): SupplementaryIdvDeliveryRecord | null;
}

/** The in-memory delivery store, with the uniqueness the real table must carry. */
export class InMemorySupplementaryIdvDeliveryStore implements SupplementaryIdvDeliveryStore {
  private readonly claims = new Map<string, { readonly occurredAtEpochMs: number; record: SupplementaryIdvDeliveryRecord | null }>();

  private keyOf(vendorKey: SupplementaryIdvVendorKey, companyId: string, deliveryKey: string): string {
    return `${vendorKey}\u0000${companyId}\u0000${deliveryKey}`;
  }

  claim(entry: {
    readonly vendorKey: SupplementaryIdvVendorKey;
    readonly companyId: string;
    readonly deliveryKey: string;
    readonly occurredAtEpochMs: number;
  }): boolean {
    const key = this.keyOf(entry.vendorKey, entry.companyId, entry.deliveryKey);
    if (this.claims.has(key)) return false;
    this.claims.set(key, { occurredAtEpochMs: entry.occurredAtEpochMs, record: null });
    return true;
  }

  settle(record: SupplementaryIdvDeliveryRecord): void {
    const key = this.keyOf(record.vendorKey, record.companyId, record.deliveryKey);
    if (this.claims.has(key) === false) throw new Error("a delivery must be claimed before it is settled");
    this.claims.set(key, { occurredAtEpochMs: record.occurredAtEpochMs, record });
  }

  release(vendorKey: SupplementaryIdvVendorKey, companyId: string, deliveryKey: string): void {
    const key = this.keyOf(vendorKey, companyId, deliveryKey);
    const current = this.claims.get(key);
    if (current !== undefined && current.record === null) this.claims.delete(key);
  }

  find(vendorKey: SupplementaryIdvVendorKey, companyId: string, deliveryKey: string): SupplementaryIdvDeliveryRecord | null {
    return this.claims.get(this.keyOf(vendorKey, companyId, deliveryKey))?.record ?? null;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The audit trail
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry for a delivery. Office-only, and free of the payload. */
export interface SupplementaryIdvDeliveryAuditEntry {
  readonly action: "supplementary_idv.delivery_accepted" | "supplementary_idv.delivery_refused" | "supplementary_idv.delivery_ignored";
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly companyId: string;
  readonly deliveryKey: string;
  readonly deliveryType: string;
  readonly outcome: SupplementaryIdvDeliveryOutcome;
  readonly httpStatus: number;
  /** The vendor's own status word, when the delivery named one this platform reads. */
  readonly vendorStatus: string | null;
  readonly sessionId: string | null;
  /** The hash of the body, which is all this platform keeps of it. */
  readonly bodyHash: string;
  readonly officeOnly: true;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Receiving
 * ---------------------------------------------------------------------------------------------- */

/** What a receiver hands to this module: the bytes, the headers, and who they came from. */
export interface SupplementaryIdvDeliveryInput {
  readonly vendorKey: SupplementaryIdvVendorKey;
  /** The configuration the endpoint belongs to, chosen by the route, never by the body. */
  readonly configId: string;
  readonly companyId: string;
  readonly headers: SupplementaryIdvHeaders;
  readonly rawBody: string;
  readonly receivedAtEpochMs: number;
  /** The peer address the transport is sure of, or null when it cannot be trusted. */
  readonly peerAddress: string | null;
}

/** What receiving one delivery needs. */
export interface SupplementaryIdvDeliveryOptions {
  readonly configStore: SupplementaryIdvConfigStore;
  readonly sessionStore: SupplementaryIdvSessionStore;
  readonly deliveryStore: SupplementaryIdvDeliveryStore;
  readonly keyring: EncryptionKeyring;
  /**
   * Read the authoritative answer from the vendor.
   *
   * The receiver never calls a vendor itself: the vendor adapter's own `readSession` is handed in, so a delivery can
   * only ever cause the same read a poll would, and the recorded result is the vendor's answer rather than the body's.
   */
  readonly readSession: (
    session: SupplementaryIdvSession,
    opened: OpenedSupplementaryIdvConfig,
  ) => Promise<SupplementaryIdvVendorAnswer>;
  readonly recordAudit?: (entry: SupplementaryIdvDeliveryAuditEntry) => void;
  readonly recordSessionAudit?: (entry: { readonly action: string; readonly vendorKey: SupplementaryIdvVendorKey; readonly companyId: string; readonly sessionId: string; readonly officeOnly: true; readonly occurredAtEpochMs: number }) => void;
}

/** What receiving one delivery concluded. */
export interface SupplementaryIdvDeliveryOutcomeReport {
  readonly outcome: SupplementaryIdvDeliveryOutcome;
  readonly httpStatus: number;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly deliveryKey: string | null;
  readonly deliveryType: string | null;
  readonly verification: SupplementaryIdvVerification | null;
  readonly reason: string | null;
  readonly sessionId: string | null;
  /** True only when an answer was recorded against the session. */
  readonly recorded: boolean;
  readonly changed: boolean;
}

function auditActionOf(outcome: SupplementaryIdvDeliveryOutcome): SupplementaryIdvDeliveryAuditEntry["action"] {
  if (outcome === "accepted" || outcome === "duplicate") return "supplementary_idv.delivery_accepted";
  if (outcome === "ignored" || outcome === "test") return "supplementary_idv.delivery_ignored";
  return "supplementary_idv.delivery_refused";
}

/**
 * Receive one delivery.
 *
 * The order is deliberate and is what makes a forged body harmless: the configuration is resolved from the route rather
 * than from the body, the bytes are verified before they are parsed, a test marker is honoured before anything else, the
 * delivery is deduplicated after it is verified, the session is resolved from a vendor identifier the receiver checked,
 * the answer is read from the vendor, and only then is STEP 170's forward-only recorder called. A failed read releases
 * the claim, so the vendor's retry is heard.
 */
export async function receiveSupplementaryIdvDelivery(
  input: SupplementaryIdvDeliveryInput,
  options: SupplementaryIdvDeliveryOptions,
): Promise<SupplementaryIdvDeliveryOutcomeReport> {
  const vendorKey = input.vendorKey;
  const answerFor = (outcome: SupplementaryIdvDeliveryOutcome): number => supplementaryIdvDeliveryAnswerOf(vendorKey, outcome);

  const finished = (
    outcome: SupplementaryIdvDeliveryOutcome,
    extra: {
      readonly reason?: string;
      readonly delivery?: SupplementaryIdvDelivery;
      readonly verification?: SupplementaryIdvVerification;
      readonly recorded?: boolean;
      readonly changed?: boolean;
      readonly sessionId?: string;
    } = {},
  ): SupplementaryIdvDeliveryOutcomeReport => {
    const delivery = extra.delivery ?? null;
    const verification = extra.verification ?? null;
    const sessionId = extra.sessionId ?? delivery?.sessionId ?? null;
    const httpStatus = answerFor(outcome);
    options.recordAudit?.({
      action: auditActionOf(outcome),
      vendorKey,
      companyId: input.companyId,
      deliveryKey: delivery?.deliveryKey ?? deliveryBodyHashOf(input.rawBody),
      deliveryType: delivery?.deliveryType ?? "unread",
      outcome,
      httpStatus,
      vendorStatus: delivery?.status ?? null,
      sessionId,
      bodyHash: delivery?.bodyHash ?? deliveryBodyHashOf(input.rawBody),
      officeOnly: true,
      occurredAtEpochMs: input.receivedAtEpochMs,
    });
    return {
      outcome,
      httpStatus,
      vendorKey,
      deliveryKey: delivery?.deliveryKey ?? null,
      deliveryType: delivery?.deliveryType ?? null,
      verification,
      reason: extra.reason ?? null,
      sessionId,
      recorded: extra.recorded ?? false,
      changed: extra.changed ?? false,
    };
  };

  if (input.rawBody.length > SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES) {
    return finished("malformed", { reason: "the body is larger than this receiver reads" });
  }

  // The configuration comes from the route. A body cannot choose which company's secret verifies it.
  const config = options.configStore.findById(input.configId);
  if (config === null || config.vendorKey !== vendorKey || config.companyId !== input.companyId) {
    return finished("refused", { reason: "the endpoint and the delivery disagree about the vendor or the company" });
  }
  if (config.status !== "active") {
    return finished("refused", { reason: "the configuration is not active" });
  }

  const opened = openSupplementaryIdvConfig(config, options.keyring);
  if (opened.status === "failed") {
    return finished("refused", { reason: opened.reason });
  }

  const verification = verifySupplementaryIdvDelivery(vendorKey, input.headers, input.rawBody, { webhookSecret: opened.config.webhookSecret }, {
    nowEpochMs: input.receivedAtEpochMs,
    peerAddress: input.peerAddress,
  });
  if (verification.verdict === "refused") {
    return finished("unverified", { reason: verification.reason, verification });
  }

  const delivery = parseSupplementaryIdvDelivery(vendorKey, input.rawBody);
  if (delivery === null) {
    return finished("malformed", { reason: "the body is not a delivery this vendor documents", verification });
  }

  if (delivery.testMode) {
    // Sumsub documents `testMode` for a webhook sent from the dashboard and states it is never sent in production.
    return finished("test", { delivery, verification, reason: "a test delivery is never a result" });
  }

  if (delivery.environment !== null && delivery.environment !== config.environment) {
    return finished("refused", { delivery, verification, reason: "the delivery names the other environment" });
  }

  if (delivery.wantsRead === false) {
    return finished("ignored", { delivery, verification, reason: "the delivery announces no decision to read" });
  }

  const claimed = options.deliveryStore.claim({
    vendorKey,
    companyId: input.companyId,
    deliveryKey: delivery.deliveryKey,
    occurredAtEpochMs: input.receivedAtEpochMs,
  });
  if (claimed === false) {
    return finished("duplicate", { delivery, verification, reason: "this delivery was already handled" });
  }

  const releaseAnd = (outcome: SupplementaryIdvDeliveryOutcome, reason: string): SupplementaryIdvDeliveryOutcomeReport => {
    options.deliveryStore.release(vendorKey, input.companyId, delivery.deliveryKey);
    return finished(outcome, { delivery, verification, reason });
  };

  // The session is found by this platform's own id when the vendor echoes it, and otherwise by the vendor's id.
  const byId = delivery.sessionId !== null ? options.sessionStore.findById(delivery.sessionId) : null;
  const resolved =
    byId !== null && byId.vendorKey === vendorKey && byId.companyId === input.companyId
      ? byId
      : delivery.reference !== null
        ? options.sessionStore.findByReference(input.companyId, vendorKey, delivery.reference)
        : null;

  if (resolved === null) {
    return releaseAnd("unknown_session", "no session of this company holds the vendor reference the delivery names");
  }
  if (delivery.reference !== null && resolved.reference !== null && resolved.reference !== delivery.reference) {
    return releaseAnd("unknown_session", "the session holds another vendor reference");
  }
  const reference = resolved.reference;
  if (reference === null) {
    return releaseAnd("failed", "the session holds no vendor reference to read");
  }

  let answer: SupplementaryIdvVendorAnswer;
  try {
    answer = await options.readSession(resolved, opened.config);
  } catch {
    return releaseAnd("failed", "the vendor could not be read, so nothing was recorded");
  }

  if (answer.reference.trim() !== reference) {
    return releaseAnd("failed", "the vendor answered about another session");
  }

  const recorded = recordSupplementaryIdvAnswer(resolved.id, answer, {
    sessionStore: options.sessionStore,
    occurredAtEpochMs: input.receivedAtEpochMs,
  });
  if (recorded.status === "failed") {
    return releaseAnd("failed", recorded.reason);
  }
  if (recorded.status === "refused") {
    // A refusal is STEP 170's forward-only rule: the row already says something newer. The delivery is settled, because a
    // retry would be refused the same way.
    options.deliveryStore.settle({
      vendorKey,
      companyId: input.companyId,
      deliveryKey: delivery.deliveryKey,
      outcome: "ignored",
      httpStatus: answerFor("ignored"),
      occurredAtEpochMs: input.receivedAtEpochMs,
    });
    options.recordSessionAudit?.({
      action: "supplementary_idv.delivery_outranked",
      vendorKey,
      companyId: input.companyId,
      sessionId: resolved.id,
      officeOnly: true,
      occurredAtEpochMs: input.receivedAtEpochMs,
    });
    return finished("ignored", { delivery, verification, reason: recorded.reason, sessionId: resolved.id });
  }

  options.deliveryStore.settle({
    vendorKey,
    companyId: input.companyId,
    deliveryKey: delivery.deliveryKey,
    outcome: "accepted",
    httpStatus: answerFor("accepted"),
    occurredAtEpochMs: input.receivedAtEpochMs,
  });
  options.recordSessionAudit?.({
    action: recorded.changed ? "supplementary_idv.delivery_recorded" : "supplementary_idv.delivery_unchanged",
    vendorKey,
    companyId: input.companyId,
    sessionId: resolved.id,
    officeOnly: true,
    occurredAtEpochMs: input.receivedAtEpochMs,
  });
  return finished("accepted", {
    delivery,
    verification,
    recorded: true,
    changed: recorded.changed,
    sessionId: resolved.id,
  });
}

/* -------------------------------------------------------------------------------------------------
 * What the office sees
 * ---------------------------------------------------------------------------------------------- */

/** A delivery as the office sees it: who sent what, and what it did. */
export interface SupplementaryIdvDeliverySummary {
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly deliveryKey: string;
  readonly deliveryType: string;
  readonly vendorStatus: string | null;
  readonly verification: string;
  readonly outcome: SupplementaryIdvDeliveryOutcome;
  readonly httpStatus: number;
  readonly sessionId: string | null;
  /** Always false: no delivery changes a charge flag, a payout flag or a processor status. */
  readonly changesProcessorKyb: false;
}

/** Summarise one received delivery for the office. */
export function supplementaryIdvDeliverySummaryOf(report: SupplementaryIdvDeliveryOutcomeReport): SupplementaryIdvDeliverySummary {
  return {
    vendorKey: report.vendorKey,
    deliveryKey: report.deliveryKey ?? "",
    deliveryType: report.deliveryType ?? "unread",
    vendorStatus: null,
    verification: report.verification?.verdict ?? "none",
    outcome: report.outcome,
    httpStatus: report.httpStatus,
    sessionId: report.sessionId,
    changesProcessorKyb: false,
  };
}

/** The largest body this receiver reads, exported once for a route's own body limit. */
export const SUPPLEMENTARY_IDV_DELIVERY_BODY_LIMIT_BYTES = SUPPLEMENTARY_IDV_MAXIMUM_DELIVERY_BYTES;
