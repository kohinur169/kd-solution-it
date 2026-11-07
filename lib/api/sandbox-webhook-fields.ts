// path: lib/api/sandbox-webhook-fields.ts
import { deepFreeze } from "../utils/freeze.ts";
import { API_PAYMENTS_PATH } from "./payment-fields.ts";
import { API_PAYMENT_STATUS_COLUMNS } from "./store-payment-status.ts";
import { STORE_WEBHOOK_ENDPOINT_FIELD, STORE_WEBHOOK_TIMEOUT_MS } from "./store-webhook-fields.ts";

/**
 * Section 8's last line - *"Simulated webhooks let the merchant verify an integration."* - as a vocabulary.
 *
 * ## What a simulated webhook is, and what it is not
 *
 * It is **the platform's real webhook**, aimed where the merchant asks: the same envelope, the same four headers, the
 * same HMAC scheme, the same signing secret STEP 201 issued for the credential that made the call, and the same
 * transport STEP 205 delivers with. The store's verifier therefore exercises the bytes a production delivery will
 * carry - which is the whole point of a simulation that is worth anything.
 *
 * It is **not** a private event format. There is no `webhook.test` type and no synthetic payment body, because a
 * second body shape would let a store's handler pass a test that production fails. The event is the payment the
 * merchant already created in test mode, described by the type its state produces.
 *
 * ## Why the endpoint comes from the caller again
 *
 * STEP 205's carried gap, unchanged: no column in this tree says where a merchant wants webhooks delivered, and no
 * STEP in 200-211 owns adding one. So the endpoint travels in this request's body, is validated by the same function
 * that validates the delivery payload (`requireStoreWebhookEndpoint`), and - because the delivery re-validates it -
 * passes the same fence twice before a socket exists.
 *
 * ## Why the deadline is shorter than a delivery's
 *
 * A production delivery may hold a worker slot for ten seconds; a merchant's `POST` cannot hold a request that long.
 * The simulated call caps the transport at five seconds and answers with what happened by then, and a store that
 * needs longer than five seconds to answer a webhook is a store whose production deliveries will time out too.
 */

/** The action's path segment, under one payment's own path. */
export const API_SANDBOX_WEBHOOK_PATH_SEGMENT = "webhook-test";

/** The route a simulated delivery is counted and recorded under: a template, so one endpoint is one bucket. */
export const API_SANDBOX_WEBHOOK_ROUTE = `${API_PAYMENTS_PATH}/{id}/${API_SANDBOX_WEBHOOK_PATH_SEGMENT}`;

/** The concrete path of one payment's simulated delivery. */
export function sandboxWebhookPathOf(paymentId: string): string {
  return `${API_PAYMENTS_PATH}/${encodeURIComponent(paymentId)}/${API_SANDBOX_WEBHOOK_PATH_SEGMENT}`;
}

/**
 * The transport ceiling of a simulated delivery: half of STEP 205's.
 *
 * Five seconds is long enough for any endpoint that answers a webhook at all, and short enough that a merchant
 * pressing "send test webhook" gets an answer rather than a spinner.
 */
export const API_SANDBOX_WEBHOOK_TIMEOUT_MS = Math.floor(STORE_WEBHOOK_TIMEOUT_MS / 2);

/** The one field the request body carries, named exactly as STEP 205 names it in a delivery payload. */
export const API_SANDBOX_WEBHOOK_ENDPOINT_FIELD = STORE_WEBHOOK_ENDPOINT_FIELD;

/** The field a body refusal names when the problem is the body rather than the endpoint. */
export const API_SANDBOX_WEBHOOK_BODY_FIELD = "body";

/**
 * The largest body this endpoint reads.
 *
 * One URL, which `requireStoreWebhookEndpoint` already bounds at two thousand and forty-eight characters, plus the
 * JSON around it - so four kilobytes is the ceiling and a longer body is refused before a byte is parsed.
 */
export const API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES = 4_096;

/** The object name in the answer, so a client can tell a simulation's report from a payment. */
export const API_SANDBOX_WEBHOOK_OBJECT = "webhook_test";

/** The entity the chain names: the same payment a real delivery names, because it is the same event. */
export const API_SANDBOX_WEBHOOK_ENTITY = "payment";

/**
 * The columns read before the delivery: STEP 204's ten, which are exactly the ten an envelope carries.
 *
 * Re-read from `payment-fields.ts`'s own constant rather than written again here, so a simulated envelope and a
 * status read cannot describe one payment with two different field lists.
 */
export const API_SANDBOX_WEBHOOK_PAYMENT_COLUMNS = API_PAYMENT_STATUS_COLUMNS;

/**
 * The reasons a simulated delivery is refused **before** anything is sent.
 *
 * A refusal here is about the request, never about the store's endpoint: what the endpoint answered is the answer's
 * `rule` field, and it is a `200` with `delivered: false` - the platform did its job and the store's server said no,
 * which is a fact to report rather than an error to raise.
 */
export const API_SANDBOX_WEBHOOK_RULES = Object.freeze({
  endpointMissing: "endpoint_missing",
  bodyMalformed: "body_malformed",
  bodyTooLarge: "body_too_large",
  unknownField: "unknown_field",
  paymentNotDeliverable: "status_not_deliverable",
  liveCredential: "live_credential_not_simulable",
} as const);

/**
 * The rules that describe what the **store's endpoint** did, and are therefore reported rather than raised.
 *
 * The other rules of STEP 205 name a platform condition - a credential that will not open, an envelope past its
 * ceiling - and a simulation that hits one of those has nothing to tell the merchant about their server.
 */
export const API_SANDBOX_WEBHOOK_REPORTED_RULES = deepFreeze([
  "endpoint_timeout",
  "endpoint_unreachable",
  "endpoint_redirected",
  "endpoint_rejected",
  "endpoint_busy",
  "endpoint_error",
] as const);

/** The two chain entries a simulated delivery writes, beside the delivery's own STEP 205 entries. */
export const API_SANDBOX_WEBHOOK_AUDIT = Object.freeze({
  simulated: "api.sandbox_webhook_simulated",
  refused: "api.sandbox_webhook_refused",
} as const);

/**
 * What a merchant sends: where to deliver.
 *
 * One field, and it is the endpoint rather than an event type: the event is decided by the payment's own state, so a
 * caller cannot ask the platform to send a `payment.refunded` event for a payment that was never refunded.
 */
export interface ApiSandboxWebhookRequest {
  readonly endpointUrl: string;
}

/**
 * What a merchant receives: the verdict, and everything needed to match it against their own log.
 *
 * `rule` is STEP 205's vocabulary, unchanged, so a store reading this answer learns the same words its endpoint's
 * behaviour produces in production. `status_code` is the store's own answer, or null when there was none. The
 * endpoint is named by its **host** and never by its path, which a merchant may have made unguessable.
 */
export interface ApiSandboxWebhookView {
  readonly id: string;
  readonly object: typeof API_SANDBOX_WEBHOOK_OBJECT;
  /** The event type that was sent, `payment.<status>` for the payment's state. */
  readonly type: string;
  /** Whole seconds since the epoch: the instant the envelope says the event happened. */
  readonly created: number;
  readonly endpoint_host: string;
  readonly delivered: boolean;
  /** STEP 205's rule for what the endpoint did, or null when it was delivered. */
  readonly rule: string | null;
  /** The endpoint's own HTTP status, or null when it never answered. */
  readonly status_code: number | null;
}
