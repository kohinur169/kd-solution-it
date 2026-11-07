// path: plugins/shopify/kd-payments-app/src/payments.mjs
import { createHash } from "node:crypto";

/**
 * A Shopify order as a platform payment: the amount, the order, and the key that makes a retry the same payment.
 *
 * ## Why this module has no transport in it
 *
 * The platform's two payment calls are made by `platform.mjs`, which owns the base URL, the timeout and the refusal
 * shape. This module owns the **decisions**: what an amount is, what an order reference is, and what idempotency key
 * both of them produce. Keeping the two apart is what lets the gate prove the arithmetic without a socket and prove the
 * request without arithmetic.
 *
 * ## Money is read as a string, never as a float
 *
 * `19.99 * 100` is `1998.9999999999998` in a double, and rounding the product hides that for some values and not
 * others. So an
 * amount arrives as the two-place string a merchant types, the string is split, and the minor units are built from the
 * two halves: `19.99` is `19 * 100 + 99`, exactly. Three decimal places are refused rather than rounded, because a
 * merchant who types `19.999` has a different number in mind than the platform would charge.
 *
 * ## The idempotency key names the order, not the moment
 *
 * The platform's key window is a day and its row is keyed by the value, so a key derived from `(shop, order, amount)`
 * makes a retried checkout the same payment instead of a second charge. A clock in this key would make every retry a
 * new payment, which is the bug the key exists to prevent.
 *
 * ## What this app does not do
 *
 * It does not call Shopify's Admin API. Marking a Shopify order paid needs an offline access token, and this app
 * deliberately keeps the token only until the platform holds it. So the merchant is told what the platform answered and
 * which order it was for; the order itself is moved in Shopify's own admin. The handoff names that as a carried gap
 * rather than pretending a GraphQL call this repository cannot exercise.
 */

/** The platform's payment resource, spelled once. */
export const PAYMENT_PATH = "/api/public/v1/payments";

/** The one currency section 20's public API accepts, and the only one this app asks for. */
export const PAYMENT_CURRENCY = "USD";

/** The platform's own amount bounds, in minor units, mirrored here so a bad amount never leaves the app. */
export const PAYMENT_MINIMUM_AMOUNT_MINOR = 50;
export const PAYMENT_MAXIMUM_AMOUNT_MINOR = 10_000_000;

/** The largest key the platform accepts, and the smallest. A derived key is always the same length. */
export const PAYMENT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{6,126})[A-Za-z0-9]$/u;

/** The prefix of every key this app derives, so a platform operator can tell where a payment came from. */
export const PAYMENT_IDEMPOTENCY_KEY_PREFIX = "kd-shopify-";

/** How many payments one session keeps: one page, one merchant, and the top of the list is the interesting one. */
export const MAXIMUM_SESSION_PAYMENTS = 5;

/** An order reference Shopify itself uses: a numeric id. */
const ORDER_ID_PATTERN = /^[0-9]{1,20}$/u;

/** The global id form of the same order, which is what a Shopify API answers with. */
const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/([0-9]{1,20})$/u;

/** A two-place decimal a merchant typed: digits, and a point with one or two digits after it. */
const AMOUNT_PATTERN = /^([0-9]{1,8})(?:\.([0-9]{1,2}))?$/u;

/** Something a merchant can fix, named by a rule and never by the value that failed. */
export class PaymentError extends Error {
  constructor(rule) {
    super(rule);

    this.name = "PaymentError";
    this.rule = rule;
  }
}

export const PAYMENT_RULES = Object.freeze({
  amountMissing: "amount_missing",
  amountMalformed: "amount_malformed",
  amountTooSmall: "amount_too_small",
  amountTooLarge: "amount_too_large",
  orderMissing: "order_missing",
  orderMalformed: "order_malformed",
  answerMalformed: "answer_malformed",
  paymentMissing: "payment_missing",
});

/**
 * The amount in minor units, from the decimal string a merchant typed.
 *
 * `1` is a hundred and `1.5` is a hundred and fifty: a trailing half is a half, not a tenth, so the fraction is padded
 * on the right before it is read. The bounds are the platform's, so the app refuses where the platform would, with the
 * rule a merchant can act on instead of a `422` they cannot.
 */
export function parseAmountMinor(value) {
  if (typeof value !== "string") {
    throw new PaymentError(PAYMENT_RULES.amountMissing);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new PaymentError(PAYMENT_RULES.amountMissing);
  }

  const match = AMOUNT_PATTERN.exec(trimmed);

  if (match === null) {
    throw new PaymentError(PAYMENT_RULES.amountMalformed);
  }

  const whole = Number.parseInt(match[1] ?? "", 10);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const minor = whole * 100 + Number.parseInt(fraction.length === 0 ? "0" : fraction, 10);

  if (minor < PAYMENT_MINIMUM_AMOUNT_MINOR) {
    throw new PaymentError(PAYMENT_RULES.amountTooSmall);
  }

  if (minor > PAYMENT_MAXIMUM_AMOUNT_MINOR) {
    throw new PaymentError(PAYMENT_RULES.amountTooLarge);
  }

  return minor;
}

/**
 * The order a payment is for: the numeric id Shopify shows, or the global id an API answers with.
 *
 * Both forms are kept, because they are needed for different things and one is derivable from the other: the numeric id
 * is what a merchant types and what a screen shows, and the global id is what any Shopify API call would name. Nothing
 * else is accepted - not a name, not a hash, not an empty field.
 */
export function parseOrderReference(value) {
  if (typeof value !== "string") {
    throw new PaymentError(PAYMENT_RULES.orderMissing);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new PaymentError(PAYMENT_RULES.orderMissing);
  }

  const global = ORDER_GID_PATTERN.exec(trimmed);

  if (global !== null) {
    return { orderId: String(global[1]), orderGid: trimmed };
  }

  if (!ORDER_ID_PATTERN.test(trimmed)) {
    throw new PaymentError(PAYMENT_RULES.orderMalformed);
  }

  return { orderId: trimmed, orderGid: `gid://shopify/Order/${trimmed}` };
}

/**
 * The idempotency key for one order's payment: the shop, the order and the amount, and no clock.
 *
 * Thirty-two hexadecimal characters of a SHA-256, prefixed so the key says which store made it. The same order at a
 * different amount is a different payment, which is right: a merchant who corrects a total before charging is asking
 * for the corrected total, not for the first one replayed.
 */
export function paymentIdempotencyKeyOf({ shop, orderId, amountMinor }) {
  const digest = createHash("sha256")
    .update(`${shop}|${orderId}|${String(amountMinor)}|${PAYMENT_CURRENCY}`, "utf8")
    .digest("hex");

  return `${PAYMENT_IDEMPOTENCY_KEY_PREFIX}${digest.slice(0, 32)}`;
}

/** The status of one payment, read by the store that made it. */
export function paymentStatusPathOf(paymentId) {
  return `${PAYMENT_PATH}/${encodeURIComponent(paymentId)}`;
}

/** A payment id as this app will accept it from an answer: the platform's UUID shape, or a refusal. */
export function parsePaymentId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new PaymentError(PAYMENT_RULES.paymentMissing);
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new PaymentError(PAYMENT_RULES.answerMalformed);
  }

  return value;
}

/**
 * The five fields a screen shows, taken from a platform answer.
 *
 * Reduced rather than passed through: the platform's answer is a body this app did not write, and a page is a place a
 * body must not arrive whole. An answer that does not carry an id and a status is refused, because a screen that says
 * "created" about a payment with no id would be lying.
 */
export function paymentViewOf(answer) {
  if (typeof answer !== "object" || answer === null) {
    throw new PaymentError(PAYMENT_RULES.answerMalformed);
  }

  const id = parsePaymentId(answer.id);
  const status = typeof answer.status === "string" ? answer.status : "";
  const amountMinor = typeof answer.amount_minor === "number" ? answer.amount_minor : Number.NaN;

  if (status.length === 0 || !Number.isInteger(amountMinor)) {
    throw new PaymentError(PAYMENT_RULES.answerMalformed);
  }

  return {
    id,
    status,
    amountMinor,
    currency: typeof answer.currency === "string" ? answer.currency : PAYMENT_CURRENCY,
    mode: typeof answer.mode === "string" ? answer.mode : "",
    createdAt: typeof answer.created_at === "string" ? answer.created_at : "",
  };
}

/** One payment as a session keeps it: the order it was for, and the last answer the platform gave. */
export function sessionPaymentOf({ orderId, orderGid, amountMinor, view }) {
  return { orderId, orderGid, amountMinor, view };
}

/**
 * The payments list a session keeps, newest first and bounded.
 *
 * A replayed create is **not** a second payment: the same id replaces its earlier entry, so a merchant who presses the
 * button twice sees one payment rather than two identical rows - and a refresh then reads it once.
 */
export function withPayment(payments, payment) {
  const list = (Array.isArray(payments) ? payments : []).filter(
    (entry) => entry.view.id !== payment.view.id,
  );

  return [payment, ...list].slice(0, MAXIMUM_SESSION_PAYMENTS);
}
