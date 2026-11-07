// path: lib/api/store-callback-fields.ts
import { API_PAYMENTS_PATH } from "./payment-fields.ts";
import type { StoreConnectionPlatform } from "./store-connection-fields.ts";
import { API_PAYMENT_STATUS_ROUTE } from "./store-payment-status.ts";
import type { ApiStorePaymentStatusView, API_STORE_PAYMENT_STATUSES } from "./store-payment-status.ts";

/**
 * Section 20's second half for a connected store: the **callback** the platform makes to a WooCommerce shop.
 *
 * ## Why a callback at all, when STEP 205 already delivers webhooks
 *
 * Because the two are authenticated by different parties' secrets, and only one of them can work for a plugin.
 *
 *   - A **webhook** (STEP 205) is proven by an HMAC over the body, computed with the merchant's *credential signing
 *     secret*. That secret is shown once, on the platform, and section 20 forbids displaying it again. A store's plugin
 *     therefore cannot verify a webhook: it has nothing to verify it with.
 *   - A **callback** is proven by the **store's own token** - the one the shop minted on activation in STEP 208 and
 *     the platform sealed in `0035`'s `access_token_ciphertext`, which the migration describes in its own words as
 *     *"the access token the platform will call the store with"*. The shop has it; nobody else does.
 *
 * So a connection-backed store is called with its own token as a bearer credential, and the plugin compares it in
 * constant time before it reads a byte of the body. Nothing secret travels back: the token is the shop's, and it is
 * the same one it already holds.
 *
 * ## Where the platform calls, without storing an endpoint
 *
 * STEP 208 stored a bare domain, not a URL - `0035`'s choice, and the right one for a connection. Each platform's
 * callback lives at its own route **on the shop's own host**, so the address is derived from the stored domain and the
 * stored platform, never from anything a caller sent:
 *
 *   - WooCommerce owns a query route: `https://{domain}/?wc-api=kd_payments_callback`.
 *   - Shopify owns a **path prefix** that a merchant's shop proxies to the app: `https://{domain}/apps/kd-payments/...`
 *     (Shopify's App Proxy). STEP 211's app answers `/callbacks/payment` behind that prefix, so the platform calls the
 *     shop's own permanent host and Shopify forwards it, which also means a Shopify shop needs no second hostname
 *     column for the platform's app.
 *
 * The URL is therefore **derived** from values the platform validated on write, and never from anything a caller sent
 * in this request - which is why a caller cannot aim this POST at a host of their choosing.
 *
 * ## Why the body is not the truth
 *
 * The plugin is told what changed, and then it asks the platform - `GET /api/public/v1/payments/{id}` with its own
 * merchant key, server to server - before it touches an order. A callback is an *invitation to check*, not an
 * instruction: a token that leaks costs an attacker the ability to send notifications, not the ability to mark orders
 * paid. That is the same sentence section 18 writes for webhooks (`processed idempotently`, `accepted only after signature
 * verification`) applied to the one secret a store actually holds.
 */

/** The one verb a callback adds to a payment: the store's own "tell my shop now". */
export const API_STORE_CALLBACK_PATH = `${API_PAYMENTS_PATH}/{id}/callback`;

/** The route a call is counted and recorded under. The limiter keys on the template, never on the id. */
export const API_STORE_CALLBACK_ROUTE = `${API_PAYMENT_STATUS_ROUTE}/callback`;

/** The concrete path of one payment's callback, for a test and a document to build the same string. */
export function storeCallbackPathOf(paymentId: string): string {
  return `${API_PAYMENTS_PATH}/${encodeURIComponent(paymentId)}/callback`;
}

/** The object name in the envelope, so a shop can tell a callback from anything else the platform sends. */
export const STORE_CALLBACK_OBJECT = "payment_callback";

/** The prefix of a callback's id, and its shape: stable per `(company, payment, status)`. */
export const STORE_CALLBACK_ID_PREFIX = "cbt_";
export const STORE_CALLBACK_ID_PATTERN = /^cbt_[0-9a-f]{32}$/u;

/** Where a WooCommerce callback lives: WooCommerce's own query route, on the shop's own host. */
export const STORE_CALLBACK_WC_API_QUERY = "wc-api";
export const STORE_CALLBACK_WC_API_VALUE = "kd_payments_callback";

/**
 * Where a Shopify callback lives: the App Proxy prefix a merchant's shop forwards to the platform's app.
 *
 * The prefix is the app's own, so it is the same for every shop - which is exactly what makes it derivable from a
 * domain. The path behind it is the app's callback endpoint, pinned in one place here so the platform, the app and the
 * gate cannot disagree about where a callback lands.
 */
export const STORE_CALLBACK_SHOPIFY_PROXY_PREFIX = "/apps/kd-payments";
export const STORE_CALLBACK_SHOPIFY_PATH = `${STORE_CALLBACK_SHOPIFY_PROXY_PREFIX}/callbacks/payment`;

/**
 * The address the platform calls for one connection, derived from the platform and the domain `0035` holds.
 *
 * `https` only, no port beyond the default: the domain is a bare host by the time it reaches this function, and
 * STEP 205's own validator runs over the result before anything is sent. The platform decides the shape, because only
 * the platform knows which route its own store side answers - and a caller never supplies either value.
 */
export function storeCallbackUrlOf(platform: StoreConnectionPlatform, storeDomain: string): string {
  return platform === "shopify"
    ? `https://${storeDomain}${STORE_CALLBACK_SHOPIFY_PATH}`
    : `https://${storeDomain}/?${STORE_CALLBACK_WC_API_QUERY}=${STORE_CALLBACK_WC_API_VALUE}`;
}

/**
 * The headers of one callback.
 *
 * The bearer token is the shop's, the id and the type are repeated as headers so a plugin can dedupe and route before
 * it parses a body, and there is no signature: an HMAC here would be an HMAC the shop cannot verify.
 */
export const STORE_CALLBACK_AUTHORIZATION_HEADER = "authorization";
export const STORE_CALLBACK_BEARER_PREFIX = "Bearer ";
export const STORE_CALLBACK_ID_HEADER = "x-kd-callback-id";
export const STORE_CALLBACK_TYPE_HEADER = "x-kd-callback-type";
export const STORE_CALLBACK_USER_AGENT = "kd-solution-it-store-callbacks/1";
export const STORE_CALLBACK_CONTENT_TYPE = "application/json";

/** How long the platform waits for a shop to answer, and how large the body may grow. */
export const STORE_CALLBACK_TIMEOUT_MS = 10_000;
export const STORE_CALLBACK_MAXIMUM_BODY_BYTES = 16_384;

/** The event type of one payment state: `payment.<status>`, for every state, `pending` included. */
export type StoreCallbackType = `payment.${(typeof API_STORE_PAYMENT_STATUSES)[number]}`;

/**
 * The type of a callback for one state.
 *
 * Unlike STEP 205's event list, `pending` is allowed: a webhook repeats a `201` the store has just received, while a
 * callback is the store's own request for "tell my shop what this payment is", and a shop that asks during a pending
 * payment deserves the answer rather than a refusal.
 */
export function storeCallbackTypeOf(status: (typeof API_STORE_PAYMENT_STATUSES)[number]): StoreCallbackType {
  return `payment.${status}`;
}

/**
 * The reasons a callback is not delivered.
 *
 * Four of them are the **connection's** - there is none, none is active, the only one was revoked, or two active ones
 * make the shop unknowable - and they are the only ones a merchant can fix. `store_endpoint_invalid` is a domain that cannot be called (a private host, a host with a
 * port, anything the URL validator refuses). `connection_token_unavailable` is a box that will not open: a platform
 * fault, never a report about the shop. The store-side rules are STEP 205's own, imported rather than repeated.
 */
export const STORE_CALLBACK_RULES = Object.freeze({
  connectionMissing: "connection_missing",
  connectionNotActive: "connection_not_active",
  connectionRevoked: "connection_revoked",
  connectionAmbiguous: "connection_ambiguous",
  connectionTokenUnavailable: "connection_token_unavailable",
  storeEndpointInvalid: "store_endpoint_invalid",
  bodyTooLarge: "body_too_large",
} as const);

/** The three chain entries this surface writes. */
export const STORE_CALLBACK_AUDIT = Object.freeze({
  delivered: "api.store_callback_delivered",
  failed: "api.store_callback_failed",
  refused: "api.store_callback_refused",
} as const);

/** The entity a callback's chain entries name: the payment it is about. */
export const STORE_CALLBACK_ENTITY = "payment";

/** The platform's half of the envelope: what a shop is told, and nothing more. */
export interface StoreCallbackEnvelope {
  readonly id: string;
  readonly object: typeof STORE_CALLBACK_OBJECT;
  readonly type: StoreCallbackType;
  /** Unix seconds, as every event envelope on this platform carries it. */
  readonly created: number;
  /** STEP 204's answer, unchanged: no card field, no customer, no processor sentence. */
  readonly payment: ApiStorePaymentStatusView;
  /** Which shop was called, so a store that hosts two of them can tell. */
  readonly store: {
    readonly domain: string;
    readonly external_store_id: string | null;
  };
}

/** What a merchant is told when they ask the platform to call their shop. */
export interface StoreCallbackOutcome {
  readonly id: string;
  readonly object: typeof STORE_CALLBACK_OBJECT;
  readonly type: StoreCallbackType;
  readonly created: number;
  /** The shop's host only: the path a callback lives on is WooCommerce's business, not a dashboard's. */
  readonly endpoint_host: string;
  readonly delivered: boolean;
  /** STEP 205's own rule vocabulary for a store-side outcome, and null on a delivery. */
  readonly rule: string | null;
  /** The status the shop answered, or null when it did not answer at all. */
  readonly status_code: number | null;
}
