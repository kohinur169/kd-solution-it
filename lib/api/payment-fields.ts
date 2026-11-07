// path: lib/api/payment-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { PUBLIC_API_BASE } from "./public-fields.ts";

/**
 * Section 20's store payment vocabulary: the endpoint, the idempotency header, the ceilings, the rules a
 * refusal names and the shape the answer has.
 *
 * Section 20's first line decides this STEP's whole scope: *"A public API exists for online store payments
 * only."* So this is not a general purpose payments API - it is the one call an online store makes at its
 * checkout to hand the platform an amount, and it is deliberately narrow: no invoice, no client, no card, no
 * customer, nothing a store cannot prove it owns.
 *
 * ## Why the numbers are here and not in the route
 *
 * A ceiling that lives in a route is a ceiling the next route forgets. The amount bounds, the method list, the
 * key length and the body size are read by the service, by the route and by the gate from this file, so the
 * three cannot disagree about what a store may ask for.
 *
 * ## What a refusal may say
 *
 * Every rule below is a machine word a client can branch on. None of them quotes the value that failed - not
 * the amount, not the currency, not the key - because a public endpoint's refusal is read by whoever found the
 * URL, and the platform's error contract says a detail carries a field and a rule and never an input.
 *
 * ## Why this module is framework free
 *
 * The gate imports it under plain Node and the service beside it runs the same numbers in production, so it
 * imports the freeze helper and the public API's base path and nothing else.
 */

/** Where a store creates a payment. One path segment under this version's root. */
export const API_PAYMENTS_PATH = `${PUBLIC_API_BASE}/payments`;

/**
 * The header a store sends its idempotency key in.
 *
 * A header rather than a body field because the key describes the *request* rather than the payment: a client
 * library sets it once for the call, and a retried call carries the same value without anybody remembering to
 * copy it into the payload.
 */
export const API_IDEMPOTENCY_HEADER = "idempotency-key";

/**
 * The key's shape: 8 to 128 characters, letters, digits, dot, underscore, colon and hyphen, starting and
 * ending with a letter or a digit.
 *
 * The lower bound is not decoration. Two stores that both send `1` would collide on one row, and the collision
 * would be reported to the second store as "this key was already used" - a refusal it cannot diagnose. Eight
 * characters is the shortest a generated key is in practice.
 */
export const API_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{6,126})[A-Za-z0-9]$/u;

export const API_IDEMPOTENCY_KEY_MINIMUM_LENGTH = 8;
export const API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH = 128;

/**
 * How long the platform keeps a key's answer.
 *
 * A day: long past the window in which a store retries a checkout call, and short enough that the cleanup job
 * of section 27 has something to delete. A key older than the window is a new key, which is why `expires_at`
 * is written when the row is created rather than extended.
 */
export const API_IDEMPOTENCY_TTL_SECONDS = 86_400;

/**
 * The largest body this endpoint reads.
 *
 * Three fields, so a kilobyte is generous and two is a ceiling a proxy will not silently raise. The route
 * refuses a longer `Content-Length` before it reads a byte and refuses a longer body before it parses one.
 */
export const API_PAYMENT_BODY_MAXIMUM_BYTES = 2_048;

/** The only currency the platform trades in (MASTER_PROMPT rule 2). */
export const API_PAYMENT_CURRENCY = "USD";

/** The three methods the schema's `payments_method_check` accepts, in its order. */
export const API_PAYMENT_METHODS = deepFreeze(["card", "bank_transfer", "e_wallet"] as const);

export type ApiPaymentMethod = (typeof API_PAYMENT_METHODS)[number];

/** What a store gets when it does not name a method: the one every gateway accepts. */
export const API_PAYMENT_DEFAULT_METHOD: ApiPaymentMethod = "card";

/** The capability a store payment needs. `lib/payments/registry.ts` names acceptance as a provider's ability. */
export const API_PAYMENT_CAPABILITY = "acceptance";

/**
 * The amount bounds, in minor units of USD.
 *
 * At least fifty cents: a processor charges a fixed fee per authorization, so a smaller payment costs more
 * than it collects. At most a hundred thousand dollars: past that a store checkout is not a checkout any more,
 * and a payment of that size belongs on an invoice with its own terms and its own record. Both numbers are
 * decided here and nowhere else, so the route and the service cannot disagree about them.
 */
export const API_PAYMENT_MINIMUM_AMOUNT_MINOR = 50;
export const API_PAYMENT_MAXIMUM_AMOUNT_MINOR = 10_000_000;

/** What a created store payment is: a row waiting for its customer, not a captured charge. */
export const API_PAYMENT_STATUS = "pending";

/** The object name in the answer, so a client can tell one resource from another. */
export const API_PAYMENT_OBJECT = "payment";

/** The entity a payment's chain entry names. */
export const API_PAYMENT_ENTITY = "payment";

/** The scope an idempotency key is written under, from `0033`'s own list. */
export const API_PAYMENT_SCOPE = "payment";

/** The answer header that says this body is the first answer replayed, not a second payment. */
export const API_REPLAY_HEADER = "idempotency-replayed";

/** The field a body refusal names when the problem is the body rather than one of its fields. */
export const API_PAYMENT_FIELD = "payment";

/** The field an idempotency refusal names. */
export const API_IDEMPOTENCY_FIELD = "idempotency_key";

/**
 * The reasons a store payment is refused.
 *
 * Grouped by what the client must do about them: fix the body (`amount`, `currency`, `method`, `unknown`), fix
 * the request (`body`, `size`, `key`), or use another key (`conflict`, `in_flight`, `failed`). The last one,
 * `route_unavailable`, is the platform's answer rather than the client's mistake: the merchant has no active
 * rule that accepts this payment, so the store must be told plainly instead of being sent to a gateway.
 */
export const API_PAYMENT_RULES = Object.freeze({
  idempotencyKeyMissing: "idempotency_key_missing",
  idempotencyKeyMalformed: "idempotency_key_malformed",
  idempotencyConflict: "idempotency_conflict",
  idempotencyInFlight: "idempotency_in_flight",
  idempotencyFailed: "idempotency_failed",
  amountTooSmall: "amount_too_small",
  amountTooLarge: "amount_too_large",
  amountNotWhole: "amount_not_whole",
  amountMissing: "amount_missing",
  currencyUnsupported: "currency_unsupported",
  methodUnsupported: "method_unsupported",
  bodyMalformed: "body_malformed",
  bodyTooLarge: "body_too_large",
  unknownField: "unknown_field",
  routeUnavailable: "route_unavailable",
} as const);

/** The tables this STEP writes and reads, named once so a query string cannot drift from the migration. */
export const API_PAYMENT_TABLES = Object.freeze({
  idempotencyKeys: "idempotency_keys",
  payments: "payments",
  routingRules: "routing_rules",
  paymentProviders: "payment_providers",
} as const);

/** The audit action a created payment writes, beside the call entry STEP 202 already writes. */
export const API_PAYMENT_AUDIT = Object.freeze({ created: "api.payment_created" } as const);

/** What a store sends: an amount in minor units, the currency it trades in, and how it wants to be paid. */
export interface ApiStorePaymentRequest {
  readonly amountMinor: number;
  readonly currency: typeof API_PAYMENT_CURRENCY;
  readonly method: ApiPaymentMethod;
}

/**
 * What a store receives.
 *
 * The payment's own identity and what it is: no key, no credential, no provider secret and no customer. The
 * amount is minor units because that is what the request sent and what the row holds; a store that shows it
 * divides by a hundred itself, in its own currency format, rather than trusting a string the platform formatted.
 */
export interface ApiStorePaymentView {
  readonly id: string;
  readonly object: typeof API_PAYMENT_OBJECT;
  readonly status: typeof API_PAYMENT_STATUS;
  readonly amount_minor: number;
  readonly currency: typeof API_PAYMENT_CURRENCY;
  readonly mode: "test" | "live";
  readonly payment_method: ApiPaymentMethod;
  readonly created_at: string;
}
