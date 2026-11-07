// path: plugins/shopify/kd-payments-app/src/callback.mjs
import { sameSignature, signMessage } from "./shopify.mjs";

/**
 * The platform's callback, landing on a Shopify shop and reaching this app through Shopify's App Proxy.
 *
 * ## What proves the caller here, and why it is not the store token
 *
 * STEP 209's WooCommerce plugin is reached **directly**: the platform posts to `https://{domain}/?wc-api=...`, and the
 * only thing that can prove the caller is the store token the shop minted. A Shopify app is reached **through
 * Shopify**: the platform posts to `https://{shop}/apps/kd-payments/callbacks/payment`, and Shopify forwards it to this
 * app with a query it signed with the app's own shared secret. So the proof here is Shopify's signature - a value this
 * app can verify, minted from a secret the platform never sees - and the store token the platform seals for a Shopify
 * connection is not needed at this boundary at all.
 *
 * That difference is the whole reason this module exists beside STEP 209's endpoint rather than reusing its rules.
 *
 * ## The three checks, in order
 *
 *   1. **Shopify signed this proxy request** - `shop`, `path_prefix`, `timestamp` and `signature`, compared in constant
 *      time, with the timestamp bounded so an old signature is a replay and not a callback. Nothing is read from the
 *      body before this passes: an unauthenticated caller does not get to choose how much of a body this process parses.
 *   2. **The body is the platform's envelope** - six keys, compared whole; the object, the id, the type and the payment
 *      inside it all shaped as the platform writes them; and the shop the body names is the shop Shopify forwarded it
 *      for, so a callback for one shop cannot be replayed at another.
 *   3. **This callback is new** - the id is stable per `(company, payment, status)` on the platform, so a redelivery is
 *      recognised and changes nothing.
 *
 * ## What the app does with the outcome, and what it refuses to do
 *
 * It **records** it: one bounded list, per shop, shown to the merchant the next time they are in the app. It does not
 * mark the Shopify order paid, because that needs an offline Admin API token and this app's whole design is that it
 * holds no Shopify token after the platform has one. A verified, deduplicated record a merchant can read is the honest
 * half; the other half is a token-storage decision this STEP does not make.
 */

/** The path the platform calls on the shop's own host, behind the app's proxy prefix. */
export const CALLBACK_PATH = "/callbacks/payment";

/** The largest body this endpoint reads. The envelope is a small object; a megabyte is an attack, not a callback. */
export const CALLBACK_BODY_MAXIMUM_BYTES = 16_384;

/** How old a proxy signature may be. A callback is delivered once, promptly; five minutes is generous. */
export const CALLBACK_SIGNATURE_MAXIMUM_AGE_SECONDS = 300;

/** How far in the future a proxy timestamp may sit before this app treats it as a clock it does not trust. */
export const CALLBACK_SIGNATURE_FUTURE_TOLERANCE_SECONDS = 60;

/** The object name of the platform's callback envelope. */
export const CALLBACK_OBJECT = "payment_callback";

/** The id the platform gives a callback: stable per `(company, payment, status)`. */
export const CALLBACK_ID_PATTERN = /^cbt_[0-9a-f]{32}$/u;

/** The six keys of the envelope, sorted, compared whole rather than by membership. */
export const CALLBACK_ENVELOPE_KEYS = Object.freeze(["created", "id", "object", "payment", "store", "type"]);

/** The payment states the platform publishes, in its own order. */
export const CALLBACK_PAYMENT_STATUSES = Object.freeze([
  "pending",
  "authorized",
  "captured",
  "settled",
  "failed",
  "voided",
  "partially_refunded",
  "refunded",
  "under_review",
]);

const CALLBACK_TYPE_PATTERN = new RegExp(`^payment\\.(${CALLBACK_PAYMENT_STATUSES.join("|")})$`, "u");
const PAYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** How many outcomes one process keeps, and how many one shop is shown. */
export const MAXIMUM_OUTCOMES = 200;

export const CALLBACK_RULES = Object.freeze({
  methodNotAllowed: "method_not_allowed",
  signatureMissing: "proxy_signature_missing",
  signatureInvalid: "proxy_signature_invalid",
  timestampMissing: "proxy_timestamp_missing",
  timestampStale: "proxy_timestamp_stale",
  timestampFuture: "proxy_timestamp_future",
  bodyTooLarge: "body_too_large",
  bodyMalformed: "body_malformed",
  envelopeMalformed: "envelope_malformed",
  shopMismatch: "shop_mismatch",
});

/** The answers this endpoint gives. `applied` is always false: nothing in this app moves an order. */
export function callbackAnswerOf({ handled, duplicate = false, rule = null }) {
  return {
    object: CALLBACK_OBJECT,
    handled,
    duplicate,
    applied: false,
    rule,
  };
}

/**
 * A bounded, per-shop record of the callbacks this process has seen.
 *
 * Bounded twice: by count, because an app that never forgot would be an app with a memory leak a stranger can drive,
 * and by nothing else - the dedupe is what makes a redelivery cheap, and a record is what a merchant reads.
 */
export function createOutcomeStore({ maximum = MAXIMUM_OUTCOMES, now = () => Date.now() } = {}) {
  const outcomes = [];

  return {
    /** Record one outcome, or report the id as a duplicate. The list is newest first. */
    record(outcome) {
      const seen = outcomes.find((entry) => entry.id === outcome.id && entry.store === outcome.store);

      if (seen !== undefined) {
        return { recorded: false, duplicate: true };
      }

      outcomes.unshift({ ...outcome, receivedAt: new Date(now()).toISOString() });

      while (outcomes.length > maximum) {
        outcomes.pop();
      }

      return { recorded: true, duplicate: false };
    },

    /** The newest outcomes for one shop: a copy, so a page cannot append to the record it renders. */
    forStore(store, limit = 5) {
      return outcomes.filter((entry) => entry.store === store).slice(0, limit);
    },

    size() {
      return outcomes.length;
    },
  };
}

/** The body of a request, bounded twice: by its declared length and by what actually arrives. */
async function readBody(request) {
  const declared = request.headers["content-length"];

  if (typeof declared === "string" && Number.parseInt(declared, 10) > CALLBACK_BODY_MAXIMUM_BYTES) {
    return { tooLarge: true };
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > CALLBACK_BODY_MAXIMUM_BYTES) {
      return { tooLarge: true };
    }

    chunks.push(chunk);
  }

  return { text: Buffer.concat(chunks).toString("utf8") };
}

/** A refusal with the status this endpoint answers and the rule a caller can branch on. */
function refusal(status, rule) {
  return { status, body: callbackAnswerOf({ handled: false, rule }) };
}

/**
 * The envelope's own shape, checked field by field instead of trusted.
 *
 * The six keys are compared **whole**, sorted, because a check that every expected key is present still accepts a body
 * carrying a seventh; and every field inside is shaped, because "the object is an object" is not a check.
 */
export function readEnvelope(document) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (Object.keys(document).sort().join(",") !== CALLBACK_ENVELOPE_KEYS.join(",")) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (document.object !== CALLBACK_OBJECT || typeof document.id !== "string") {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (!CALLBACK_ID_PATTERN.test(document.id) || !Number.isInteger(document.created)) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  const type = CALLBACK_TYPE_PATTERN.exec(typeof document.type === "string" ? document.type : "");

  if (type === null) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  const payment = document.payment;
  const store = document.store;

  if (typeof payment !== "object" || payment === null || typeof store !== "object" || store === null) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (typeof payment.id !== "string" || !PAYMENT_ID_PATTERN.test(payment.id)) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (!Number.isInteger(payment.amount_minor) || payment.amount_minor < 0) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (payment.status !== String(type[1])) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  if (typeof store.domain !== "string" || store.domain.length === 0) {
    return { failure: CALLBACK_RULES.envelopeMalformed };
  }

  return {
    envelope: {
      id: document.id,
      type: document.type,
      status: String(type[1]),
      paymentId: payment.id,
      amountMinor: payment.amount_minor,
      store: store.domain,
    },
  };
}

/**
 * The endpoint itself: verify, bound, parse, verify again, dedupe, record.
 *
 * `signature` is the proxy query Shopify signed, `secret` is the app's own shared secret, and both are arguments so the
 * gate can drive the endpoint with a request it built itself and a secret it chose.
 */
export async function handleCallback({ request, secret, outcomes, now = () => Date.now() }) {
  const method = (request.method ?? "GET").toUpperCase();

  if (method !== "POST") {
    return refusal(405, CALLBACK_RULES.methodNotAllowed);
  }

  const url = new URL(request.url ?? "/", "https://app.invalid");
  const query = url.searchParams;
  const presented = query.get("signature");
  const shop = query.get("shop");

  if (presented === null || presented.length === 0 || shop === null || shop.length === 0) {
    return refusal(401, CALLBACK_RULES.signatureMissing);
  }

  const timestamp = query.get("timestamp");

  if (timestamp === null || !/^[0-9]{1,12}$/u.test(timestamp)) {
    return refusal(401, CALLBACK_RULES.timestampMissing);
  }

  if (!sameSignature(presented.toLowerCase(), proxySignatureOf(query, secret))) {
    return refusal(401, CALLBACK_RULES.signatureInvalid);
  }

  const seconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(now() / 1_000);

  if (nowSeconds - seconds > CALLBACK_SIGNATURE_MAXIMUM_AGE_SECONDS) {
    return refusal(401, CALLBACK_RULES.timestampStale);
  }

  if (seconds - nowSeconds > CALLBACK_SIGNATURE_FUTURE_TOLERANCE_SECONDS) {
    return refusal(401, CALLBACK_RULES.timestampFuture);
  }

  const body = await readBody(request);

  if (body.tooLarge === true) {
    return refusal(413, CALLBACK_RULES.bodyTooLarge);
  }

  let document;

  try {
    document = JSON.parse(body.text ?? "");
  } catch {
    return refusal(400, CALLBACK_RULES.bodyMalformed);
  }

  const read = readEnvelope(document);

  if (read.failure !== undefined) {
    return refusal(400, read.failure);
  }

  const envelope = read.envelope;

  if (envelope === undefined) {
    return refusal(400, CALLBACK_RULES.envelopeMalformed);
  }

  // The shop Shopify forwarded this for, and the shop the platform's body names, must be the same shop.
  if (envelope.store !== shop) {
    return refusal(400, CALLBACK_RULES.shopMismatch);
  }

  const outcome = outcomes.record({
    id: envelope.id,
    type: envelope.type,
    status: envelope.status,
    paymentId: envelope.paymentId,
    amountMinor: envelope.amountMinor,
    store: envelope.store,
  });

  return {
    status: 200,
    body: callbackAnswerOf({ handled: true, duplicate: outcome.duplicate }),
  };
}

/**
 * The message Shopify signs for a proxied request: the query's parameters, sorted by name, joined with `&`.
 *
 * This is the app-proxy signature and **not** the install HMAC: the install message escapes `%`, `&` and `=` because
 * those characters are what separates one parameter from another there, while a proxy signature is computed over the
 * query's own `key=value` pairs. Keeping the two functions apart is what stops one being verified with the other's rules
 * - the mistake that would accept a signature Shopify never made.
 */
export function proxySignatureOf(query, secret) {
  const entries = [...query.entries()].filter(([key]) => key !== "signature");

  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const message = entries.map(([key, value]) => `${key}=${value}`).join("&");

  return signMessage(message, secret);
}
