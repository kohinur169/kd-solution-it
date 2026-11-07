// path: lib/api/store-webhook-fields.ts
import { deepFreeze } from "../utils/freeze.ts";
import { API_PAYMENT_ENTITY } from "./payment-fields.ts";
import { API_STORE_PAYMENT_STATUSES, type ApiStorePaymentStatus } from "./store-payment-status.ts";

/**
 * Section 20's outbound half: the webhook the platform sends a store when a payment moves.
 *
 * ## Why this exists
 *
 * STEP 204 gave a store a `GET` to poll. Polling is the fallback, not the contract: a checkout that ships when a
 * payment is captured should be *told*, once, with a body it can verify. FEATURE_LIST section 27 lists webhook
 * processing among the background jobs, and section 28 says a request handler validates, writes minimal rows and
 * enqueues - so the delivery is a job with retries, not a `fetch` inside somebody's request.
 *
 * ## The two facts `0034` already decided
 *
 * The credential table's own comment states the design: *"The webhook signing secret must be used later to sign an
 * outbound delivery, so it is stored as AES-256-GCM ciphertext beside its own last four characters."* This STEP is
 * that "later". The secret is opened inside the job, at the moment of signing, and never travels in a payload, a
 * log line or a chain entry.
 *
 * ## The one fact no migration in this tree holds
 *
 * Where a store wants its webhooks delivered. There is no endpoint column, no store webhook table and no STEP in
 * 200-211 that owns adding one, and this STEP's block grants no migration exception - so the endpoint is supplied
 * by the calling code, validated, and carried in the job's payload, which is what makes a retry after a restart
 * still know where to go. STEP 205's handoff names that gap rather than inventing a table it does not own.
 *
 * ## The signature scheme, stated rather than implied
 *
 * A store must be able to prove two things about a delivery: that the platform sent it, and that it is the same
 * body the platform signed. Both come from one header:
 *
 * ```
 * x-kd-signature: t=1793620800,v1=<lower case hex HMAC-SHA256 of "1793620800.<body>">
 * ```
 *
 * The key is the credential's signing secret. `t` is the attempt's instant in whole seconds and is checked by the
 * store against its own tolerance window; the HMAC covers the timestamp and the exact bytes sent, so a re-sent body
 * with a fresh timestamp is not valid and a replayed timestamp with a different body is not either. The version
 * prefix is there so a later scheme can be added beside `v1` rather than replacing it silently.
 *
 * The body is byte-identical on every attempt - only `t` moves - so a store that dedupes on `x-kd-event-id` and
 * verifies the signature sees one event however many times the platform tried.
 */

/** The job name, in the queue's own lower case dotted shape. */
export const STORE_WEBHOOK_JOB_NAME = "store.webhook.deliver";

/** The object name inside the envelope, so a store can tell one resource from another. */
export const STORE_WEBHOOK_OBJECT = "event";

/** The chain entity these deliveries are recorded against: the payment they describe. */
export const STORE_WEBHOOK_ENTITY = API_PAYMENT_ENTITY;

/** The header a store dedupes on. Stable across every retry of one event. */
export const STORE_WEBHOOK_EVENT_ID_HEADER = "x-kd-event-id";

/** The header a store routes on without parsing the body. */
export const STORE_WEBHOOK_EVENT_TYPE_HEADER = "x-kd-event-type";

/** The header that proves the delivery came from the platform. */
export const STORE_WEBHOOK_SIGNATURE_HEADER = "x-kd-signature";

/** The header that says which attempt this is, counted from one. A store's own debugging aid, not a decision. */
export const STORE_WEBHOOK_ATTEMPT_HEADER = "x-kd-delivery-attempt";

/** The version prefix inside the signature header. */
export const STORE_WEBHOOK_SIGNATURE_VERSION = "v1";

/** How the platform identifies itself to the store's endpoint. */
export const STORE_WEBHOOK_USER_AGENT = "kd-solution-it-webhooks/1";

/** The content type of every delivery. A webhook is JSON and nothing else. */
export const STORE_WEBHOOK_CONTENT_TYPE = "application/json";

/** The longest endpoint this platform will call. `sanitizeHttpUrl`'s own default, named here as the ceiling. */
export const STORE_WEBHOOK_ENDPOINT_MAXIMUM_LENGTH = 2_048;

/** The field an endpoint refusal names, for the caller that supplies one. */
export const STORE_WEBHOOK_ENDPOINT_FIELD = "endpoint_url";

/** How long one attempt may hold its connection. Well inside the job's own timeout. */
export const STORE_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * How many attempts one delivery gets.
 *
 * Five, the queue's own default ceiling, with the platform's exponential backoff between them - so a store that
 * is down for a couple of minutes still receives the event, and one that is gone for a day does not accumulate an
 * attempt per hour for ever.
 */
export const STORE_WEBHOOK_MAXIMUM_ATTEMPTS = 5;

/** The largest body this platform will send. A payment view is a few hundred bytes; this is generous and bounded. */
export const STORE_WEBHOOK_MAXIMUM_BODY_BYTES = 16_384;

/** The tight shape of an event id: `evt_` and thirty two lower case hex characters. */
export const STORE_WEBHOOK_EVENT_ID_PATTERN = /^evt_[0-9a-f]{32}$/u;

/**
 * The events a store can receive, one per payment state that changes what it must do.
 *
 * `pending` is deliberately absent: it is the state STEP 203's `201` already told the store about, and a webhook
 * that repeats an answer the store just received is noise that trains an integration to ignore webhooks.
 */
export const STORE_WEBHOOK_EVENT_TYPES = deepFreeze(
  API_STORE_PAYMENT_STATUSES.filter((status) => status !== "pending").map(
    (status) => `payment.${status}` as const,
  ),
);

export type StoreWebhookEventType = (typeof STORE_WEBHOOK_EVENT_TYPES)[number];

/** The status a delivered event reports, which is the event name after its prefix. */
export function storeWebhookEventOf(status: ApiStorePaymentStatus): StoreWebhookEventType | null {
  const eventType = `payment.${status}` as StoreWebhookEventType;

  return (STORE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType) ? eventType : null;
}

/**
 * The reasons a delivery does not reach a store.
 *
 * Split the way the queue needs them: `endpoint_unreachable`, `endpoint_timeout`, `endpoint_busy` and
 * `endpoint_error` are worth another attempt, `endpoint_redirected`, `endpoint_rejected`, `endpoint_invalid`,
 * `credential_unavailable`, `credential_revoked`, `credential_mode_mismatch` and `body_too_large` are not. A
 * redirect is in the permanent list on purpose: an endpoint that answers "try over there" is an endpoint that has
 * moved, and following it would let a merchant's URL aim the platform's own request at a host nobody approved.
 */
export const STORE_WEBHOOK_RULES = Object.freeze({
  endpointUnreachable: "endpoint_unreachable",
  endpointTimeout: "endpoint_timeout",
  endpointRedirected: "endpoint_redirected",
  endpointRejected: "endpoint_rejected",
  endpointBusy: "endpoint_busy",
  endpointError: "endpoint_error",
  endpointInvalid: "endpoint_invalid",
  credentialUnavailable: "credential_unavailable",
  credentialRevoked: "credential_revoked",
  credentialModeMismatch: "credential_mode_mismatch",
  bodyTooLarge: "body_too_large",
  statusNotDeliverable: "status_not_deliverable",
} as const);

export type StoreWebhookRule = (typeof STORE_WEBHOOK_RULES)[keyof typeof STORE_WEBHOOK_RULES];

/** The reasons another attempt cannot help. Everything else is transient. */
export const STORE_WEBHOOK_FINAL_RULES: readonly StoreWebhookRule[] = deepFreeze([
  STORE_WEBHOOK_RULES.endpointRedirected,
  STORE_WEBHOOK_RULES.endpointRejected,
  STORE_WEBHOOK_RULES.endpointInvalid,
  STORE_WEBHOOK_RULES.credentialUnavailable,
  STORE_WEBHOOK_RULES.credentialRevoked,
  STORE_WEBHOOK_RULES.credentialModeMismatch,
  STORE_WEBHOOK_RULES.bodyTooLarge,
  STORE_WEBHOOK_RULES.statusNotDeliverable,
]);

/** Whether a failure is one a later attempt could turn into a delivery. */
export function isFinalWebhookRule(rule: StoreWebhookRule): boolean {
  return STORE_WEBHOOK_FINAL_RULES.includes(rule);
}

/**
 * The reason a store's answer is a failure, for a status that is not a success.
 *
 * `408` and `425` mean "ask again", `429` is the store's own rate limit and its `Retry-After` is not needed because
 * the platform's backoff is the same shape. `5xx` is a store that is broken right now. A `4xx` is a store that
 * refuses this delivery and will refuse it again, so it is final. A `2xx` never reaches this function - the caller
 * decides success first - and one that does is reported as an endpoint error rather than as a delivery.
 */
export function storeWebhookRuleForStatus(status: number): StoreWebhookRule {
  if (status >= 200 && status < 300) {
    return STORE_WEBHOOK_RULES.endpointError;
  }

  if (status >= 300 && status < 400) {
    return STORE_WEBHOOK_RULES.endpointRedirected;
  }

  if (status === 408 || status === 425 || status === 429) {
    return STORE_WEBHOOK_RULES.endpointBusy;
  }

  if (status >= 400 && status < 500) {
    return STORE_WEBHOOK_RULES.endpointRejected;
  }

  return STORE_WEBHOOK_RULES.endpointError;
}

/** The chain entries a delivery writes: one when it is scheduled, one per attempt outcome. */
export const STORE_WEBHOOK_AUDIT = Object.freeze({
  scheduled: "api.webhook_scheduled",
  delivered: "api.webhook_delivered",
  failed: "api.webhook_failed",
} as const);

/** The envelope a store receives. Field order is the order the platform writes, and the signature covers the bytes. */
export interface StoreWebhookEnvelope {
  readonly id: string;
  readonly object: typeof STORE_WEBHOOK_OBJECT;
  readonly type: StoreWebhookEventType;
  /** Whole seconds since the epoch, fixed when the platform decided to deliver rather than when it tried. */
  readonly created: number;
  readonly data: {
    readonly payment: StoreWebhookPayment;
  };
}

/**
 * The payment inside an envelope.
 *
 * The same ten fields STEP 204's `GET` answers, so the two channels cannot describe one payment differently - and
 * the same deliberate omissions: no card, no customer, no fee, no processor identifier and no company id.
 */
export interface StoreWebhookPayment {
  readonly id: string;
  readonly object: "payment";
  readonly status: ApiStorePaymentStatus;
  readonly amount_minor: number;
  readonly refunded_minor: number;
  readonly currency: string;
  readonly mode: "test" | "live";
  readonly payment_method: "card" | "bank_transfer" | "e_wallet";
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * What the job carries between attempts.
 *
 * The endpoint and the payment travel here rather than being read again on every attempt, so a retry after a
 * restart delivers the event as it was decided - a captured payment is not re-read later and delivered as a
 * refunded one. The signing secret is *not* here: the payload names the credential, and the secret is opened only
 * at the moment of signing.
 */
export interface StoreWebhookJobPayload {
  readonly companyId: string;
  readonly credentialId: string;
  readonly mode: "test" | "live";
  readonly endpointUrl: string;
  readonly eventId: string;
  readonly eventType: StoreWebhookEventType;
  readonly created: number;
  readonly payment: StoreWebhookPayment;
}

/** One attempt's outcome, before it becomes a chain entry. */
export interface StoreWebhookAttemptOutcome {
  readonly delivered: boolean;
  readonly rule: StoreWebhookRule | null;
  readonly statusCode: number | null;
  readonly attempt: number;
  readonly willRetry: boolean;
}
