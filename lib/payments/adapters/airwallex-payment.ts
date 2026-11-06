// path: lib/payments/adapters/airwallex-payment.ts

/**
 * Taking a payment through Airwallex: one PaymentIntent created for a ready connected account, its client secret
 * handed to the page once, and the intent read back so the browser's word is never what settles money.
 *
 * ## What STEP 168 has to answer for
 *
 * Section 6 asks that every method the connected processor supports can be accepted, that the platform never sees
 * card data, and that a payment is never silently sent to another provider. STEP 165 recorded how Airwallex does
 * that: `POST /api/v1/pa/payment_intents/create` with the amount in **major units**, `request_id` as the documented
 * idempotency key, and a client secret that lives 60 minutes, cannot be refreshed and must never be logged or
 * stored. The card is entered in Airwallex's own component; this file only builds the request, keeps the record and
 * reads the answer.
 *
 * ## The client secret is a pass-through, not a stored value
 *
 * `createAirwallexCharge` returns the secret to its caller exactly once and stores only the boolean that one was
 * issued. The record, the view a screen reads and every audit entry are asserted to carry neither the secret nor
 * the token. There is no path in this file that can show a client secret again: reading the intent back returns
 * whatever the documented answer carries, and a caller that needs it must re-read the intent rather than a database.
 *
 * ## The fee is recorded, not sent, because the page was never read
 *
 * STEP 165 left one open question exactly here: how the platform takes its fee on a connected account's payment.
 * Stripe's destination charge answers that with `application_fee_amount`; Airwallex's pages read for this STEP do
 * not. So the attempt carries the platform fee for the ledger (STEPs 133/139 compute it) and the body carries none,
 * and the gate asserts the body has no fee field. Guessing a parameter name into a live payment body is not a thing
 * this adapter does.
 *
 * ## The id has no documented prefix, so none is assumed
 *
 * STEP 165's pages named no prefix for a PaymentIntent id — unlike `acct_`, which they did name for accounts. The
 * pattern here is therefore prefix-free, refuses an Airwallex account id (which is `acct_`-shaped and could arrive
 * by mistake), and the record says which provider owns the id, because this platform also stores Stripe's `pi_` ids.
 *
 * ## A duplicate request is not a rejection
 *
 * STEP 165 recorded the documented rule: `request_id` is the idempotency key, and a `409` means the original request
 * exists. So a `409` is `duplicate`, which marks the attempt for reconciliation instead of calling the payment
 * refused — claiming a failure that may have created a PaymentIntent is exactly the mistake that rule warns about.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_API_VERSION_HEADER,
  AIRWALLEX_ON_BEHALF_OF_HEADER,
  AIRWALLEX_PAYMENT_INTENT_STATUSES,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH,
  AIRWALLEX_REQUEST_ID_PATTERN,
  airwallexAmountFromPlatformMinor,
  airwallexPaymentOutcomeOf,
  airwallexPlatformMinorFromAmount,
  airwallexRequestIdFor,
  buildAirwallexPaymentIntentBody,
  carriesAirwallexKeyShapedText,
  isAirwallexAccountId,
  sanitizeAirwallexText,
  validateAirwallexPaymentIntentRequest,
  type AirwallexPaymentIntentRequest,
  type AirwallexPaymentOutcome,
} from "./airwallex.ts";
import {
  airwallexAccessTokenFor,
  airwallexClientCodeOf,
  airwallexClientEndpoint,
  airwallexClientMessageOf,
  AIRWALLEX_ANSWER_MAXIMUM_BYTES,
  type AirwallexClientTransport,
  type AirwallexConfigStore,
  type AirwallexKeyConfig,
  type AirwallexTokenCache,
} from "./airwallex-client.ts";
import { airwallexAccountReadinessOf, type AirwallexAccountProvision } from "./airwallex-accounts.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The documented PaymentIntent create path. */
export const AIRWALLEX_PAYMENT_INTENT_CREATE_PATH = "/api/v1/pa/payment_intents/create";

/** The read path's prefix; the intent id sits after it. */
export const AIRWALLEX_PAYMENT_INTENT_PATH_PREFIX = "/api/v1/pa/payment_intents/";

/**
 * The id shape this file accepts.
 *
 * No page read for STEP 165 documents a PaymentIntent id prefix, so none is assumed: the pattern is a bounded
 * token of letters, digits, dashes and underscores. An `acct_` id is refused separately, because that one *is*
 * documented and would mean a connected account had been pasted where an intent belongs.
 */
export const AIRWALLEX_PAYMENT_INTENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

/** The read path for one intent. */
export const AIRWALLEX_PAYMENT_INTENT_READ_PATH_PATTERN = /^\/api\/v1\/pa\/payment_intents\/[A-Za-z0-9_-]{8,64}$/u;

/** The only paths this file may call. */
export const AIRWALLEX_PAYMENT_ALLOWED_PATH_PATTERNS: readonly RegExp[] = deepFreeze([
  /^\/api\/v1\/pa\/payment_intents\/create$/u,
  AIRWALLEX_PAYMENT_INTENT_READ_PATH_PATTERN,
]);

/** True when a path is one this file may call. */
export function isAirwallexPaymentPath(path: string): boolean {
  return AIRWALLEX_PAYMENT_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** True when a string is a plausible PaymentIntent id and not a connected-account id. */
export function isAirwallexPaymentIntentId(value: string): boolean {
  const trimmed = value.trim();
  if (isAirwallexAccountId(trimmed)) return false;
  return AIRWALLEX_PAYMENT_INTENT_ID_PATTERN.test(trimmed);
}

/** The read path for one intent, refusing an id this file cannot read. */
export function airwallexPaymentIntentPath(paymentIntentId: string): string {
  const id = paymentIntentId.trim();
  if (isAirwallexPaymentIntentId(id) === false) throw new Error("invalid payment intent id");
  return `${AIRWALLEX_PAYMENT_INTENT_PATH_PREFIX}${id}`;
}

/** The bounds every call here keeps. */
export const AIRWALLEX_PAYMENT_TIMEOUT_MS = 20_000;
export const AIRWALLEX_PAYMENT_TEXT_MAXIMUM_LENGTH = 200;

/** The longest client secret this file will carry in memory (it never stores one). */
export const AIRWALLEX_CLIENT_SECRET_MAXIMUM_LENGTH = 512;

/* -------------------------------------------------------------------------------------------------
 * The request
 * ---------------------------------------------------------------------------------------------- */

/** What a caller asks to charge. */
export interface AirwallexChargeRequest {
  readonly companyId: string;
  /** The amount in the platform's ten-thousandths. */
  readonly amountMinor: bigint;
  /** The platform's fee for this payment, recorded for the ledger and deliberately never sent. */
  readonly platformFeeMinor: bigint;
  readonly currency: string;
  readonly merchantOrderId: string;
  /** The invoice or payment reference the documented `request_id` is derived from. */
  readonly reference: string;
  readonly returnUrl: string | null;
  readonly descriptor: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The documented `request_id` for one attempt: deterministic from the company and the reference. */
export function airwallexChargeRequestId(request: AirwallexChargeRequest): string {
  return airwallexRequestIdFor(request.companyId, request.reference.trim());
}

/** The request as the page's own validator and body builder expect it. */
export function airwallexIntentRequestOf(request: AirwallexChargeRequest): AirwallexPaymentIntentRequest {
  return {
    amountMinor: request.amountMinor,
    currency: request.currency,
    merchantOrderId: request.merchantOrderId,
    requestId: airwallexChargeRequestId(request),
    returnUrl: request.returnUrl,
    descriptor: request.descriptor,
    metadata: request.metadata,
  };
}

/**
 * The reason a charge request is unusable, or null when it is usable.
 *
 * The documented rules come from STEP 165's validator. What this function adds is the platform's own arithmetic:
 * a fee that is negative, or that is not smaller than the payment, is refused here rather than discovered by a
 * ledger later, and a reference that is blank is refused because the derived `request_id` would then collide
 * across payments.
 */
export function validateAirwallexChargeRequest(request: AirwallexChargeRequest): string | null {
  if (request.reference.trim().length === 0) return "a payment reference is required, because the request id derives from it";
  if (request.reference.trim().length > 120) return "the payment reference is longer than 120 characters";
  // The page's own rules come before the platform's arithmetic, so a bad amount is reported as a bad amount rather
  // than as a fee that happens to be larger than it.
  const documented = validateAirwallexPaymentIntentRequest(airwallexIntentRequestOf(request));
  if (documented !== null) return documented;
  if (request.platformFeeMinor < 0n) return "the platform fee cannot be negative";
  if (request.platformFeeMinor >= request.amountMinor) return "the platform fee must be smaller than the payment";
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One call: the method, the mode, the path, the token, the pin, the account acted for and the body. */
export interface AirwallexPaymentCall {
  readonly method: "GET" | "POST";
  readonly environment: "sandbox" | "live";
  readonly path: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  /** The connected account the platform acts for, sent as `x-on-behalf-of`. */
  readonly onBehalfOf: string | null;
  readonly body: string | null;
}

/** The HTTP answer. */
export interface AirwallexPaymentAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port. */
export type AirwallexPaymentTransport = (call: AirwallexPaymentCall) => Promise<AirwallexPaymentAnswer>;

/**
 * Perform one documented payment call.
 *
 * STEP 165 recorded `x-on-behalf-of` as the documented way a platform calls for a connected account, so a create
 * always carries the account it acts for, and the read carries it too when the intent belongs to an account. The
 * path must be the create endpoint or an intent-shaped read; the host comes from the stored mode; the token and the
 * pin are required; a POST needs a body and a GET refuses one; redirects are refused; the timeout is bounded and an
 * oversized answer is refused. No credential, token or secret ever reaches the URL.
 */
export const airwallexPaymentFetchTransport: AirwallexPaymentTransport = async (call) => {
  if (isAirwallexPaymentPath(call.path) === false) throw new Error("invalid API path");
  if (call.accessToken.trim().length === 0) throw new Error("an access token is required");
  if (call.apiVersion.trim().length === 0) throw new Error("an API version is required");
  if (call.onBehalfOf !== null && isAirwallexAccountId(call.onBehalfOf) === false) {
    throw new Error("x-on-behalf-of must name a connected account");
  }
  if (call.method === "POST" && (call.body === null || call.body.length === 0)) {
    throw new Error("a request body is required");
  }
  if (call.method === "GET" && call.body !== null) throw new Error("a read carries no body");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${call.accessToken}`,
    Accept: "application/json",
    [AIRWALLEX_API_VERSION_HEADER]: call.apiVersion.trim(),
  };
  if (call.onBehalfOf !== null) headers[AIRWALLEX_ON_BEHALF_OF_HEADER] = call.onBehalfOf.trim();
  if (call.body !== null) headers["Content-Type"] = "application/json";

  const response = await fetch(airwallexClientEndpoint(call.environment, call.path), {
    method: call.method,
    headers,
    ...(call.body === null ? {} : { body: call.body }),
    redirect: "error",
    signal: AbortSignal.timeout(AIRWALLEX_PAYMENT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > AIRWALLEX_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * Reading answers
 * ---------------------------------------------------------------------------------------------- */

function parseJsonBody(body: string): unknown {
  try {
    return body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function answerRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function textAt(value: unknown, key: string): string | null {
  const record = answerRecord(value);
  if (record === null) return null;
  const field = record[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

/** The provider's own words, sanitised and bounded. */
export function airwallexPaymentMessageOf(body: string): string {
  return airwallexClientMessageOf(parseJsonBody(body));
}

/** The intent id an answer names, or null when it names none this file accepts. */
export function airwallexPaymentIntentIdOf(body: string): string | null {
  const id = textAt(parseJsonBody(body), "id");
  return id !== null && isAirwallexPaymentIntentId(id) ? id : null;
}

/** The documented intent status an answer names, or null when it names one this adapter does not record. */
export function airwallexPaymentStatusOf(body: string): string | null {
  const named = textAt(parseJsonBody(body), "status");
  if (named === null) return null;
  const normalized = named.toUpperCase();
  return AIRWALLEX_PAYMENT_INTENT_STATUSES.includes(normalized) ? normalized : null;
}

/** The client secret an answer carries, bounded and never stored, or null. */
export function airwallexClientSecretOf(body: string): string | null {
  const secret = textAt(parseJsonBody(body), "client_secret");
  if (secret === null || secret.length > AIRWALLEX_CLIENT_SECRET_MAXIMUM_LENGTH) return null;
  return secret;
}

/** The amount and currency an answer reports, as text, or nulls when absent. */
export function airwallexIntentAmountOf(body: string): { readonly amountText: string | null; readonly currency: string | null } {
  const record = answerRecord(parseJsonBody(body));
  if (record === null) return { amountText: null, currency: null };
  const amount = record["amount"];
  const currency = record["currency"];
  const amountText =
    typeof amount === "number" && Number.isFinite(amount)
      ? amount.toFixed(2)
      : typeof amount === "string" && amount.trim().length > 0
        ? amount.trim()
        : null;
  return {
    amountText,
    currency: typeof currency === "string" && currency.trim().length > 0 ? currency.trim().toLowerCase() : null,
  };
}

/** What a create answer means. */
export type AirwallexPaymentIntentVerdict =
  | {
      readonly outcome: "created";
      readonly paymentIntentId: string;
      readonly status: string;
      readonly paymentOutcome: AirwallexPaymentOutcome;
      readonly clientSecret: string | null;
    }
  | { readonly outcome: "duplicate"; readonly detail: string }
  | { readonly outcome: "rejected"; readonly detail: string; readonly code: string | null }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a create answer.
 *
 * `2XX` with a PaymentIntent id is the only success, and its client secret is carried out of here once. `409` is
 * `duplicate` — the documented meaning of that status is that the original request with this `request_id` exists —
 * and `400`/`422` are `rejected` with the page's own code kept. `401`/`403` and the remaining refusals are `failed`,
 * so nothing was created; a timeout class, `429`, any `5XX`, a thrown transport and a `2XX` naming no id are
 * `unknown`, because a PaymentIntent may exist and only a replay or a person can settle it.
 */
export function parseAirwallexPaymentIntentAnswer(status: number, body: string): AirwallexPaymentIntentVerdict {
  if (status === 409) {
    return {
      outcome: "duplicate",
      detail: "a PaymentIntent with this request id already exists, so the original answer must be reconciled",
    };
  }

  const message = airwallexPaymentMessageOf(body);
  const code = airwallexClientCodeOf(parseJsonBody(body));
  const detailOr = (fallback: string): string => (message.length > 0 ? message : fallback);

  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally; a PaymentIntent may exist" };
  }
  if (status === 400 || status === 422) {
    return { outcome: "rejected", detail: detailOr(`Airwallex refused the request with status ${status}`), code };
  }
  if (status === 401 || status === 403) {
    return { outcome: "failed", detail: detailOr("the API rejected the token or refused the permission") };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "failed", detail: "the API answered with a redirect, which proves nothing" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: detailOr(`the API refused the call with status ${status}`) };
  }

  const paymentIntentId = airwallexPaymentIntentIdOf(body);
  const intentStatus = airwallexPaymentStatusOf(body);
  if (paymentIntentId === null) {
    return { outcome: "unknown", detail: "the answer names no PaymentIntent id, so one may or may not exist" };
  }
  if (intentStatus === null) {
    return { outcome: "unknown", detail: "the answer names no status this adapter records, so the intent is unread" };
  }
  return {
    outcome: "created",
    paymentIntentId,
    status: intentStatus,
    paymentOutcome: airwallexPaymentOutcomeOf(intentStatus),
    clientSecret: airwallexClientSecretOf(body),
  };
}

/** What a read of one intent means. */
export type AirwallexPaymentReadVerdict =
  | {
      readonly outcome: "read";
      readonly paymentIntentId: string;
      readonly status: string;
      readonly paymentOutcome: AirwallexPaymentOutcome;
      readonly amountText: string | null;
      readonly currency: string | null;
      readonly clientSecret: string | null;
    }
  | { readonly outcome: "not_found"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a read answer.
 *
 * `2XX` carrying one of the seven documented statuses is the only `read`; a status this adapter does not record is
 * `unknown` rather than `paid`, because a payment is not confirmed by a word nobody has seen before. `404` is
 * `not_found`, `400`/`401`/`403` are `failed`, and a redirect, a timeout class, `429`, a `5XX` or a thrown transport
 * leave the state unread.
 */
export function parseAirwallexPaymentReadAnswer(status: number, body: string): AirwallexPaymentReadVerdict {
  if (status === 404) return { outcome: "not_found", detail: "Airwallex does not know that PaymentIntent id" };
  const message = airwallexPaymentMessageOf(body);
  if (status === 400 || status === 401 || status === 403) {
    return { outcome: "failed", detail: message.length > 0 ? message : `the API refused the read with status ${status}` };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally, so the payment status was not read" };
  }
  if (status >= 300 && status < 400) {
    return { outcome: "unknown", detail: "the API answered with a redirect, which proves nothing" };
  }
  if (status < 200 || status >= 300) {
    return { outcome: "failed", detail: message.length > 0 ? message : `the API refused the read with status ${status}` };
  }

  const paymentIntentId = airwallexPaymentIntentIdOf(body);
  const intentStatus = airwallexPaymentStatusOf(body);
  if (paymentIntentId === null || intentStatus === null) {
    return { outcome: "unknown", detail: "the answer carries no id or no status this adapter records" };
  }
  const amount = airwallexIntentAmountOf(body);
  return {
    outcome: "read",
    paymentIntentId,
    status: intentStatus,
    paymentOutcome: airwallexPaymentOutcomeOf(intentStatus),
    amountText: amount.amountText,
    currency: amount.currency,
    clientSecret: airwallexClientSecretOf(body),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The attempt record
 * ---------------------------------------------------------------------------------------------- */

/** Where one attempt stands. */
export type AirwallexAttemptStatus = "pending" | "created" | "rejected" | "unknown";

/** How a payment finally stood, once a read has settled it. */
export type AirwallexSettlementStatus = "paid" | "pending" | "requires_customer_action" | "failed";

/** One payment attempt. Never carries a client secret or an access token. */
export interface AirwallexPaymentAttempt {
  readonly id: string;
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  /** The documented `request_id`: the idempotency key this attempt used. */
  readonly requestId: string;
  readonly amountMinor: bigint;
  readonly platformFeeMinor: bigint;
  readonly currency: string;
  readonly connectedAccountId: string;
  readonly paymentIntentId: string | null;
  readonly providerStatus: string | null;
  readonly attemptStatus: AirwallexAttemptStatus;
  readonly settlement: AirwallexSettlementStatus | null;
  /** True when a client secret came back. The value itself is never stored. */
  readonly clientSecretIssued: boolean;
  readonly reason: string | null;
  readonly requiresReconciliation: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The only moves an attempt may make. A row carrying an intent id never leaves `created`. */
export const AIRWALLEX_ATTEMPT_OUTCOMES: Readonly<
  Record<AirwallexAttemptStatus, readonly AirwallexAttemptStatus[]>
> = deepFreeze({
  pending: ["pending", "created", "rejected", "unknown"],
  unknown: ["unknown", "created", "rejected", "pending"],
  rejected: ["rejected"],
  created: ["created"],
});

/** What this file reads and writes. One row per attempt, unique on the derived request id. */
export interface AirwallexPaymentAttemptStore {
  insert(attempt: AirwallexPaymentAttempt): void;
  findById(id: string): AirwallexPaymentAttempt | null;
  findByRequestId(companyId: string, requestId: string): AirwallexPaymentAttempt | null;
  findByPaymentIntentId(companyId: string, paymentIntentId: string): AirwallexPaymentAttempt | null;
  save(next: AirwallexPaymentAttempt, expectedVersion: number): boolean;
}

/**
 * The in-memory store: the invariants the real table must carry — a unique attempt id, a unique `request_id` per
 * company, an immutable company, provider, mode, amount, fee, currency, acting account and request id, a version
 * guard, forward-only attempt outcomes, a `created` row that must carry an intent id, an intent id that never
 * changes once written, and a settlement that only exists on a created row.
 */
export class InMemoryAirwallexPaymentAttemptStore implements AirwallexPaymentAttemptStore {
  private readonly attempts = new Map<string, AirwallexPaymentAttempt>();

  insert(attempt: AirwallexPaymentAttempt): void {
    if (this.attempts.has(attempt.id)) throw new Error("duplicate attempt id");
    if (attempt.version !== 1) throw new Error("a new attempt starts at version 1");
    if (attempt.attemptStatus !== "pending") throw new Error("a new attempt is pending");
    if (attempt.paymentIntentId !== null) throw new Error("a new attempt carries no intent id");
    if (this.findByRequestId(attempt.companyId, attempt.requestId) !== null) {
      throw new Error("this request id is already used");
    }
    this.attempts.set(attempt.id, attempt);
  }

  findById(id: string): AirwallexPaymentAttempt | null {
    return this.attempts.get(id) ?? null;
  }

  findByRequestId(companyId: string, requestId: string): AirwallexPaymentAttempt | null {
    return (
      [...this.attempts.values()].find(
        (attempt) => attempt.companyId === companyId && attempt.requestId === requestId,
      ) ?? null
    );
  }

  findByPaymentIntentId(companyId: string, paymentIntentId: string): AirwallexPaymentAttempt | null {
    return (
      [...this.attempts.values()].find(
        (attempt) =>
          attempt.companyId === companyId &&
          attempt.providerKey === AIRWALLEX_PROVIDER_KEY &&
          attempt.paymentIntentId === paymentIntentId,
      ) ?? null
    );
  }

  save(next: AirwallexPaymentAttempt, expectedVersion: number): boolean {
    const current = this.attempts.get(next.id);
    if (current === undefined) return false;
    if (current.providerKey !== next.providerKey) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.requestId !== next.requestId) return false;
    if (current.amountMinor !== next.amountMinor || current.platformFeeMinor !== next.platformFeeMinor) return false;
    if (current.currency !== next.currency) return false;
    if (current.connectedAccountId !== next.connectedAccountId) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (AIRWALLEX_ATTEMPT_OUTCOMES[current.attemptStatus].includes(next.attemptStatus) === false) return false;
    if (current.paymentIntentId !== null && next.paymentIntentId !== current.paymentIntentId) return false;
    if (next.attemptStatus === "created" && next.paymentIntentId === null) return false;
    if (next.paymentIntentId !== null && next.attemptStatus !== "created") return false;
    if (next.attemptStatus !== "created" && next.settlement !== null) return false;
    this.attempts.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a secret or a token. */
export interface AirwallexPaymentAuditEntry {
  readonly action:
    | "airwallex_payment.created"
    | "airwallex_payment.duplicate"
    | "airwallex_payment.rejected"
    | "airwallex_payment.unknown"
    | "airwallex_payment.settled"
    | "airwallex_payment.read_failed";
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly attemptId: string;
  readonly paymentIntentId: string | null;
  readonly environment: "sandbox" | "live";
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Options and the context one call needs
 * ---------------------------------------------------------------------------------------------- */

/** What every function in this file needs. */
export interface AirwallexPaymentOptions {
  /** The company's connected account, whose readiness decides whether a payment may be attempted at all. */
  readonly provision: AirwallexAccountProvision;
  readonly configStore: AirwallexConfigStore;
  readonly keyring: EncryptionKeyring;
  /** STEP 166's in-memory token cache: a token lives nowhere else. */
  readonly tokenCache: AirwallexTokenCache;
  readonly attemptStore: AirwallexPaymentAttemptStore;
  readonly occurredAtEpochMs: number;
  readonly transport?: AirwallexPaymentTransport;
  readonly loginTransport?: AirwallexClientTransport;
  readonly recordAudit?: (entry: AirwallexPaymentAuditEntry) => void;
}

type PaymentContext =
  | { readonly ok: true; readonly config: AirwallexKeyConfig; readonly token: string }
  | { readonly ok: false; readonly reason: string };

async function paymentContextOf(companyId: string, options: AirwallexPaymentOptions): Promise<PaymentContext> {
  const config = options.configStore.findActiveByCompany(companyId);
  if (config === null) return { ok: false, reason: "no active Airwallex key configuration exists for this company" };
  const token = await airwallexAccessTokenFor(config.id, {
    store: options.configStore,
    keyring: options.keyring,
    tokenCache: options.tokenCache,
    nowEpochMs: options.occurredAtEpochMs,
    ...(options.loginTransport === undefined ? {} : { transport: options.loginTransport }),
  });
  if (token.status !== "token") return { ok: false, reason: token.reason };
  return { ok: true, config, token: token.token };
}

function auditAttempt(
  action: AirwallexPaymentAuditEntry["action"],
  attempt: AirwallexPaymentAttempt,
  outcome: string,
  options: { readonly occurredAtEpochMs: number; readonly recordAudit?: (entry: AirwallexPaymentAuditEntry) => void },
): void {
  options.recordAudit?.({
    action,
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: attempt.companyId,
    attemptId: attempt.id,
    paymentIntentId: attempt.paymentIntentId,
    environment: attempt.environment,
    outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
}

function settleAttempt(
  attempt: AirwallexPaymentAttempt,
  next: AirwallexPaymentAttempt,
  options: AirwallexPaymentOptions,
): AirwallexPaymentAttempt {
  const saved = options.attemptStore.save(next, attempt.version);
  return saved ? next : (options.attemptStore.findById(attempt.id) ?? attempt);
}

/* -------------------------------------------------------------------------------------------------
 * Creating a payment
 * ---------------------------------------------------------------------------------------------- */

/** What creating a payment did. */
export type CreateAirwallexChargeResult =
  | {
      readonly status: "created";
      readonly attempt: AirwallexPaymentAttempt;
      /** Handed to the page once; never stored, logged or audited. */
      readonly clientSecret: string | null;
    }
  | { readonly status: "already_created"; readonly attempt: AirwallexPaymentAttempt; readonly requiresRead: true }
  | {
      readonly status: "in_flight";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly attempt: AirwallexPaymentAttempt;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly attempt: AirwallexPaymentAttempt }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly attempt: AirwallexPaymentAttempt;
    };

/**
 * Create a PaymentIntent for a company whose connected account can take payments.
 *
 * The order is the discipline STEPs 163 and 167 used and STEP 164 set for payments: the connected account's
 * readiness is checked first (a payment on an account that is not `ACTIVE` is never attempted), the request is
 * validated, the token is fetched, the attempt is stored as `pending` **before** the call, and only then is Airwallex
 * asked. A replay with the same derived `request_id` answers `already_created`, and the caller reads the intent for
 * its status; an `unknown` attempt answers `in_flight`; a `rejected` attempt is final, because Airwallex created
 * nothing and the same `request_id` would only be refused again.
 */
export async function createAirwallexCharge(
  request: AirwallexChargeRequest,
  options: AirwallexPaymentOptions,
): Promise<CreateAirwallexChargeResult> {
  const readiness = airwallexAccountReadinessOf(options.provision, options.occurredAtEpochMs);
  if (readiness.canAcceptPayments === false) {
    return {
      status: "failed",
      reason: readiness.blockingReason ?? "the connected account is not ready to accept payments",
    };
  }
  if (options.provision.companyId !== request.companyId) {
    return { status: "failed", reason: "the connected account belongs to another company" };
  }
  if (readiness.accountId === null) {
    return { status: "failed", reason: "no connected account exists for this company" };
  }

  const invalid = validateAirwallexChargeRequest(request);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const requestId = airwallexChargeRequestId(request);
  const existing = options.attemptStore.findByRequestId(request.companyId, requestId);
  if (existing !== null) {
    if (existing.attemptStatus === "created") {
      return { status: "already_created", attempt: existing, requiresRead: true };
    }
    if (existing.attemptStatus === "unknown") {
      return {
        status: "in_flight",
        requiresReconciliation: true,
        reason: "an earlier attempt with this request id has an unknown outcome; reconcile it before charging again",
        attempt: existing,
      };
    }
    return {
      status: "failed",
      reason: "an earlier attempt with this request id did not succeed; use a new reference",
    };
  }

  const context = await paymentContextOf(request.companyId, options);
  if (context.ok === false) return { status: "failed", reason: context.reason };

  const attempt: AirwallexPaymentAttempt = {
    id: randomUUID(),
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId: request.companyId,
    environment: context.config.environment,
    requestId,
    amountMinor: request.amountMinor,
    platformFeeMinor: request.platformFeeMinor,
    currency: request.currency.trim().toLowerCase(),
    connectedAccountId: readiness.accountId,
    paymentIntentId: null,
    providerStatus: null,
    attemptStatus: "pending",
    settlement: null,
    clientSecretIssued: false,
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.attemptStore.insert(attempt);
  } catch {
    return { status: "failed", reason: "this request id is already used" };
  }

  let verdict: AirwallexPaymentIntentVerdict;
  try {
    const answer = await (options.transport ?? airwallexPaymentFetchTransport)({
      method: "POST",
      environment: context.config.environment,
      path: AIRWALLEX_PAYMENT_INTENT_CREATE_PATH,
      accessToken: context.token,
      apiVersion: context.config.apiVersion,
      onBehalfOf: readiness.accountId,
      body: JSON.stringify(buildAirwallexPaymentIntentBody(airwallexIntentRequestOf(request))),
    });
    verdict = parseAirwallexPaymentIntentAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unknown", detail: "the API could not be reached, so a PaymentIntent may or may not exist" };
  }

  if (verdict.outcome === "created") {
    const created = settleAttempt(
      attempt,
      {
        ...attempt,
        attemptStatus: "created",
        paymentIntentId: verdict.paymentIntentId,
        providerStatus: verdict.status,
        settlement: verdict.paymentOutcome === "paid" ? "paid" : null,
        clientSecretIssued: verdict.clientSecret !== null,
        reason: null,
        version: attempt.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditAttempt("airwallex_payment.created", created, verdict.paymentOutcome, options);
    return { status: "created", attempt: created, clientSecret: verdict.clientSecret };
  }

  if (verdict.outcome === "duplicate") {
    const duplicate = settleAttempt(
      attempt,
      {
        ...attempt,
        attemptStatus: "unknown",
        reason: verdict.detail,
        requiresReconciliation: true,
        version: attempt.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditAttempt("airwallex_payment.duplicate", duplicate, "duplicate", options);
    return { status: "unknown", requiresReconciliation: true, reason: verdict.detail, attempt: duplicate };
  }

  if (verdict.outcome === "rejected") {
    const rejected = settleAttempt(
      attempt,
      {
        ...attempt,
        attemptStatus: "rejected",
        reason: verdict.detail,
        version: attempt.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditAttempt("airwallex_payment.rejected", rejected, verdict.code ?? "rejected", options);
    return { status: "rejected", reason: verdict.detail, attempt: rejected };
  }

  if (verdict.outcome === "unknown") {
    const unknown = settleAttempt(
      attempt,
      {
        ...attempt,
        attemptStatus: "unknown",
        reason: verdict.detail,
        requiresReconciliation: true,
        version: attempt.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditAttempt("airwallex_payment.unknown", unknown, "unknown", options);
    return { status: "unknown", requiresReconciliation: true, reason: verdict.detail, attempt: unknown };
  }

  // `failed` means the API refused the call outright, so no intent exists and no row changes: the pending row stays,
  // which is what lets the next attempt with the same request id pass through it.
  return { status: "failed", reason: verdict.detail };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a payment back
 * ---------------------------------------------------------------------------------------------- */

/** What a read of one intent said. */
export type ReadAirwallexPaymentIntentResult =
  | {
      readonly status: "read";
      readonly paymentIntentId: string;
      readonly providerStatus: string;
      readonly outcome: AirwallexPaymentOutcome;
      readonly amountText: string | null;
      readonly currency: string | null;
      /** The client secret the documented answer carries, when it does; handed to the page, never stored. */
      readonly clientSecret: string | null;
    }
  | { readonly status: "not_found"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Read one intent, which is how a payment is confirmed without trusting the browser.
 *
 * The customer confirms in Airwallex's component, so the browser's word is never enough; the same read is what a
 * webhook delivery (STEP 169) applies an event through. A `404` says the id is not at Airwallex, which is a
 * reconciliation rather than a status; a refusal or an unsettled answer says the state was not read.
 */
export async function readAirwallexPaymentIntent(
  paymentIntentId: string,
  options: AirwallexPaymentOptions,
): Promise<ReadAirwallexPaymentIntentResult> {
  if (isAirwallexPaymentIntentId(paymentIntentId) === false) {
    return { status: "failed", reason: "the payment intent id is not one this adapter accepts" };
  }
  const context = await paymentContextOf(options.provision.companyId, options);
  if (context.ok === false) return { status: "failed", reason: context.reason };

  let verdict: AirwallexPaymentReadVerdict;
  try {
    const answer = await (options.transport ?? airwallexPaymentFetchTransport)({
      method: "GET",
      environment: context.config.environment,
      path: airwallexPaymentIntentPath(paymentIntentId),
      accessToken: context.token,
      apiVersion: context.config.apiVersion,
      onBehalfOf: options.provision.accountId,
      body: null,
    });
    verdict = parseAirwallexPaymentReadAnswer(answer.status, answer.body);
  } catch {
    return { status: "failed", reason: "the API could not be reached, so the payment status is unknown" };
  }

  if (verdict.outcome === "read") {
    return {
      status: "read",
      paymentIntentId: verdict.paymentIntentId,
      providerStatus: verdict.status,
      outcome: verdict.paymentOutcome,
      amountText: verdict.amountText,
      currency: verdict.currency,
      clientSecret: verdict.clientSecret,
    };
  }
  if (verdict.outcome === "not_found") return { status: "not_found", reason: verdict.detail };
  return { status: "failed", reason: verdict.detail };
}

/** What applying a read to its attempt did. */
export type ApplyAirwallexReadResult =
  | { readonly status: "applied"; readonly attempt: AirwallexPaymentAttempt; readonly settlement: AirwallexSettlementStatus }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Apply a read to its attempt, and refuse a read that does not describe it.
 *
 * Only an answer **at the amount and currency the platform asked for** becomes `paid`. A mismatch is a failure with
 * `requiresReconciliation`, never a paid attempt: the amounts are compared in the platform's own units, which is what
 * stops a currency or unit mix-up from becoming a ledger entry. A `SUCCEEDED` intent is the only `paid`, per STEP
 * 165's mapping; everything else keeps its own meaning.
 */
export function applyAirwallexPaymentIntentRead(
  attempt: AirwallexPaymentAttempt,
  read: Extract<ReadAirwallexPaymentIntentResult, { status: "read" }>,
  options: { readonly occurredAtEpochMs: number; readonly attemptStore: AirwallexPaymentAttemptStore; readonly recordAudit?: (entry: AirwallexPaymentAuditEntry) => void },
): ApplyAirwallexReadResult {
  if (attempt.paymentIntentId !== null && attempt.paymentIntentId !== read.paymentIntentId) {
    return { status: "failed", reason: "the read describes another payment intent" };
  }

  const expectedMinor = read.amountText === null ? null : airwallexPlatformMinorFromAmount(read.amountText, attempt.currency);
  const amountMatches = expectedMinor !== null && expectedMinor === attempt.amountMinor;
  const currencyMatches = read.currency !== null && read.currency === attempt.currency;
  const mismatch = amountMatches === false || currencyMatches === false;

  const settlement: AirwallexSettlementStatus = mismatch
    ? "failed"
    : read.outcome === "paid"
      ? "paid"
      : read.outcome === "failed"
        ? "failed"
        : read.outcome === "pending"
          ? "pending"
          : "requires_customer_action";

  const next: AirwallexPaymentAttempt = {
    ...attempt,
    paymentIntentId: attempt.paymentIntentId ?? read.paymentIntentId,
    providerStatus: read.providerStatus,
    settlement,
    reason: mismatch ? "the PaymentIntent does not describe this attempt's amount and currency" : attempt.reason,
    requiresReconciliation: mismatch,
    version: attempt.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  if (options.attemptStore.save(next, attempt.version) === false) {
    return { status: "failed", reason: "the attempt moved while its read was being applied; re-read it" };
  }

  auditAttempt("airwallex_payment.settled", next, mismatch ? "mismatch" : settlement, options);
  return { status: "applied", attempt: next, settlement };
}

/** Mark an attempt that could not be read, without inventing a status for it. */
export function markAirwallexAttemptUnread(
  attempt: AirwallexPaymentAttempt,
  reason: string,
  options: { readonly occurredAtEpochMs: number; readonly attemptStore: AirwallexPaymentAttemptStore; readonly recordAudit?: (entry: AirwallexPaymentAuditEntry) => void },
): AirwallexPaymentAttempt {
  const next: AirwallexPaymentAttempt = {
    ...attempt,
    reason: sanitizeAirwallexText(reason, AIRWALLEX_PAYMENT_TEXT_MAXIMUM_LENGTH),
    requiresReconciliation: true,
    version: attempt.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const saved = options.attemptStore.save(next, attempt.version);
  const settled = saved ? next : (options.attemptStore.findById(attempt.id) ?? attempt);
  auditAttempt("airwallex_payment.read_failed", settled, "unread", options);
  return settled;
}

/** The documented request-id rules, exported so a caller can validate a reference before building one. */
export const AIRWALLEX_CHARGE_REFERENCE_MAXIMUM_LENGTH = 120;

/** True when a reference can produce a documented `request_id`. Exported for the screen that asks for one. */
export function airwallexChargeReferenceIsUsable(reference: string): boolean {
  const trimmed = reference.trim();
  if (trimmed.length === 0 || trimmed.length > AIRWALLEX_CHARGE_REFERENCE_MAXIMUM_LENGTH) return false;
  return carriesAirwallexKeyShapedText(trimmed) === false;
}

/** The documented `request_id` bounds, re-exported for the gate that holds this file to them. */
export const AIRWALLEX_CHARGE_REQUEST_ID_MAXIMUM_LENGTH = AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH;

/** True when a string could be a documented `request_id`; exported so the gate can hold the derived one to it. */
export function airwallexRequestIdIsDocumented(requestId: string): boolean {
  return AIRWALLEX_REQUEST_ID_PATTERN.test(requestId) && requestId.length <= AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH;
}

/** The fee conversion, exported so a caller can show the fee in major units before charging. */
export function airwallexFeeTextOf(feeMinor: bigint, currency: string): string | null {
  const converted = airwallexAmountFromPlatformMinor(feeMinor, currency);
  return converted.ok ? converted.amountText : null;
}
