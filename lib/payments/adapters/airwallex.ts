// path: lib/payments/adapters/airwallex.ts

/**
 * The Airwallex documentation record: what the pages say, what this platform will do with it, and what is
 * still unproven. STEP 165 records; STEPs 166-169 seal the key, create the connected account, take payments
 * and pay out.
 *
 * ## The five facts that change how this adapter must be written
 *
 * 1. **Two hosts, and the sandbox one is not a "demo" host.** The API reference lists
 *    `https://api.sandbox.airwallex.com` (sandbox) and `https://api.airwallex.com` (production). A widely
 *    copied community specification names `api-demo.airwallex.com`; no page on the documentation host does,
 *    so that host is refused here by name.
 * 2. **Authentication is a short-lived token, not a key on every call.** `POST /api/v1/authentication/login`
 *    takes `x-client-id` and `x-api-key` **headers**, answers `201` with `token` and `expires_at`, and the
 *    token "is valid for 30 minutes and can be reused until it expires. Do not call the authentication
 *    endpoint before each request."
 * 3. **The API is date-versioned by header.** `x-api-version` selects a version; omitting it falls back to the
 *    account's stored default. The documentation recommends pinning, and a partner integration page repeats
 *    why: an account's default can differ per merchant.
 * 4. **Amounts are major units.** The Payments guide is explicit: "`amount`: The amount to charge specified in
 *    major units as defined by ISO 4217. For example, $9.99 is represented as `9.99`." This platform stores
 *    ten-thousandths, and Stripe-style cents would be off by a factor of a hundred here — the conversion in
 *    `airwallexAmountFromPlatformMinor` is therefore the one money-critical function in this file.
 * 5. **A payout's `PAID` is not final.** The transfer-status page says so twice: a transfer "may subsequently
 *    fail if it is rejected by the local clearing system or the recipient bank", moving from `PAID` to
 *    `FAILED`. A payout adapter that treats `PAID` as settled money would be wrong.
 *
 * ## The idempotency key is a body field, not a header
 *
 * Stripe's is an `Idempotency-Key` header; Airwallex's is the `request_id` field of the create body, described
 * as "Your unique idempotency key (v4 UUID) used to prevent duplicate transactions by ensuring that retried
 * API calls with the same ID are only processed once". The transfers changelog adds that a duplicate
 * `request_id` that is still being processed answers `409 Conflict`. Both are recorded here because STEP 168
 * must send the same field the page names, and a store-based guard alone would not satisfy the provider's own
 * contract.
 *
 * ## The sandbox gap that must not be papered over
 *
 * The sandbox page says the sandbox gives access to "all products in the Airwallex web app and API (except
 * Connected Account APIs)", and that testing those requires contacting Airwallex Sales, with Simulation APIs
 * named as the alternative and `x-on-behalf-of` as the way a platform calls on a connected account's behalf.
 * So STEP 169's connected-account cycle cannot be claimed as sandbox-verified without a Sales-granted sandbox
 * or a recorded simulation-API run — recorded in `AIRWALLEX_SANDBOX_LIMITS` and as an open question.
 */

import { createHash, createHmac } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { MONEY_SCALE } from "../money.ts";

/* -------------------------------------------------------------------------------------------------
 * Identity and hosts
 * ---------------------------------------------------------------------------------------------- */

/** The key this adapter registers under. */
export const AIRWALLEX_PROVIDER_KEY = "airwallex" as const;

/** The name a screen shows. */
export const AIRWALLEX_PROVIDER_NAME = "Airwallex";

/** The documented API hosts. */
export const AIRWALLEX_PRODUCTION_BASE = "https://api.airwallex.com";
export const AIRWALLEX_SANDBOX_BASE = "https://api.sandbox.airwallex.com";

/** The documented file host, which is not the API host. */
export const AIRWALLEX_PRODUCTION_FILES_BASE = "https://files.airwallex.com";
export const AIRWALLEX_SANDBOX_FILES_BASE = "https://files.sandbox.airwallex.com";

/** The prefix on every documented path. */
export const AIRWALLEX_API_PREFIX = "/api/v1";

/**
 * Hosts that look like documentation or an API but are not: a community specification names a "demo" API host
 * the pages never mention, and `docs.airwallex.com` is a host people type although every page lives on
 * `www.airwallex.com/docs`.
 */
export const AIRWALLEX_REFUSED_HOSTS: readonly string[] = deepFreeze(["api-demo.airwallex.com", "docs.airwallex.com"]);

/** The mode a base URL names, or null when it names no documented host. */
export function airwallexEnvironmentOfBase(base: string): "sandbox" | "live" | null {
  const normalized = base.trim().replace(/\/+$/u, "");
  if (normalized === AIRWALLEX_PRODUCTION_BASE) return "live";
  if (normalized === AIRWALLEX_SANDBOX_BASE) return "sandbox";
  return null;
}

/** True when a base URL is a documented API host. */
export function isAirwallexApiBase(base: string): boolean {
  return airwallexEnvironmentOfBase(base) !== null;
}

/**
 * The documented endpoints this platform will call, in the order STEPs 166-169 need them.
 *
 * Kept together so the paths are reviewable in one place and a path that is not here cannot be called: the
 * login endpoint, the connected-account create/update/submit/read endpoints, the PaymentIntent
 * create/retrieve/confirm endpoints, and the transfer create/read endpoints.
 */
export const AIRWALLEX_ENDPOINTS: Readonly<Record<string, string>> = deepFreeze({
  login: "/api/v1/authentication/login",
  balancesCurrent: "/api/v1/balances/current",
  accountsCreate: "/api/v1/accounts/create",
  accountsUpdate: "/api/v1/accounts/{id}/update",
  accountsSubmit: "/api/v1/accounts/{id}/submit",
  accountsRetrieve: "/api/v1/accounts/{id}",
  paymentIntentCreate: "/api/v1/pa/payment_intents/create",
  paymentIntentRetrieve: "/api/v1/pa/payment_intents/{id}",
  paymentIntentConfirm: "/api/v1/pa/payment_intents/{id}/confirm",
  paymentIntentCancel: "/api/v1/pa/payment_intents/{id}/cancel",
  transferCreate: "/api/v1/transfers/create",
  transferRetrieve: "/api/v1/transfers/{id}",
  beneficiaryCreate: "/api/v1/beneficiaries/create",
});

/* -------------------------------------------------------------------------------------------------
 * Documentation sources
 * ---------------------------------------------------------------------------------------------- */

/** The only host the documentation pages live on. */
export const AIRWALLEX_DOCUMENTATION_HOSTS: readonly string[] = deepFreeze(["www.airwallex.com"]);

/** The host the machine-readable version list lives on. */
export const AIRWALLEX_REFERENCE_HOSTS: readonly string[] = deepFreeze(["github.com"]);

/** One page read for this record. */
export interface AirwallexDocumentationSource {
  readonly topic: string;
  readonly url: string;
  readonly host: string;
  readonly status: "reviewed";
  readonly recorded: string;
}

const airwallexSource = (topic: string, url: string, recorded: string): AirwallexDocumentationSource => ({
  topic,
  url,
  host: new URL(url).hostname,
  status: "reviewed",
  recorded,
});

/** The pages read in the STEP 165 session, each with what it settled. */
export const AIRWALLEX_DOCUMENTATION_SOURCES: readonly AirwallexDocumentationSource[] = deepFreeze([
  airwallexSource(
    "API reference and the two API hosts",
    "https://www.airwallex.com/docs/api/introduction",
    "Sandbox is https://api.sandbox.airwallex.com and production https://api.airwallex.com; the API is REST.",
  ),
  airwallexSource(
    "API access token and how it is obtained",
    "https://www.airwallex.com/docs/api/authentication/api_access_token",
    "POST /api/v1/authentication/login with x-client-id and x-api-key headers answers 201 with token and expires_at; the token lives 30 minutes and is reused until it expires; 400/401 (credentials_invalid, credentials_expired)/403/429/500 are the documented errors.",
  ),
  airwallexSource(
    "Sandbox environment, and what it does not cover",
    "https://www.airwallex.com/docs/developer-tools/sandbox-environment",
    "The sandbox covers every product except Connected Account APIs; those need Airwallex Sales or the Simulation APIs; simulations may be run on behalf of a connected account with x-on-behalf-of; sandbox entity names must be New Business Sandbox or Sandbox Business; files are deleted after 90 days.",
  ),
  airwallexSource(
    "Webhook delivery, headers and signature scheme",
    "https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events",
    "x-timestamp is a Unix timestamp in milliseconds and x-signature is the hex HMAC-SHA256 of the timestamp concatenated with the raw body, keyed with the subscription's own secret; the endpoint must answer 200 or the delivery is retried; the event carries id, name, account_id, org_id, data.object, created_at and version.",
  ),
  airwallexSource(
    "Connected accounts overview",
    "https://www.airwallex.com/docs/connected-accounts/overview",
    "Onboarding verification, KYB, and RFI handling are the connected-account flows; the platform acts on an account's behalf after creation.",
  ),
  airwallexSource(
    "Native API onboarding and account lifecycle",
    "https://www.airwallex.com/docs/connected-accounts/onboarding/kyc-and-onboarding/native-api",
    "POST /api/v1/accounts/create takes account_details, customer_agreements (both flags true) and primary_contact, and answers an acct_ id with status CREATED; submit is POST /api/v1/accounts/{id}/submit and answers SUBMITTED; the status set is CREATED, SUBMITTED, ACTIVE, ACTION_REQUIRED, SUSPENDED; a 400 carries field_required or invalid_argument.",
  ),
  airwallexSource(
    "PaymentIntents guide: the create call and the client secret",
    "https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api",
    "amount is in major units (9.99 means $9.99), currency is the 3-letter ISO code, merchant_order_id and request_id are required and capped at 64 characters, request_id is the idempotency key, the client secret lives 60 minutes and cannot be refreshed, and it must never be logged.",
  ),
  airwallexSource(
    "Payment statuses, and the webhook each emits",
    "https://www.airwallex.com/docs/payments/reference/payment-statuses",
    "Six intent statuses: REQUIRES_PAYMENT_METHOD, REQUIRES_CUSTOMER_ACTION, REQUIRES_CAPTURE, PENDING, PENDING_REVIEW, SUCCEEDED, CANCELLED; a failed attempt reverts the intent to REQUIRES_PAYMENT_METHOD instead of a failure status; SUCCEEDED is the only status whose required action is to fulfil.",
  ),
  airwallexSource(
    "Transfer statuses and PAID's late failure",
    "https://www.airwallex.com/docs/payouts/transfers/create-a-transfer/transfer-statuses",
    "The transfer lifecycle includes IN_APPROVAL and its approval outcomes, SCHEDULED, OVERDUE, PROCESSING, SENT, PAID, FAILED and CANCELLED; PAID is not final and may later become FAILED if the clearing system or the recipient bank rejects it.",
  ),
  airwallexSource(
    "Sandbox test cards and the test cases that must pass",
    "https://www.airwallex.com/docs/payments/test-and-go-live/test-card-numbers",
    "4035501000000008 succeeds; 4012000300000013 fails 3DS; 5307837360544518 with 80.51 fails for insufficient funds; 5307837360544518 or 2223000010181375 with 80.05 fails as do-not-honor; 4012000300001003 with 80.59 fails as suspected fraud; evidence must record the intent id, the attempt id, screenshots and webhook delivery logs.",
  ),
  airwallexSource(
    "Versioning from the machine-readable specification",
    "https://github.com/airwallex/airwallex-openapi",
    "The API is date-versioned with the x-api-version header (for example 2026-08-21); omitting it falls back to the account default and pinning is strongly recommended.",
  ),
]);

/** True when a URL is on one of the two recorded hosts and nowhere else. */
export function isAirwallexDocumentationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (AIRWALLEX_REFUSED_HOSTS.includes(host)) return false;
  return AIRWALLEX_DOCUMENTATION_HOSTS.includes(host) || AIRWALLEX_REFERENCE_HOSTS.includes(host);
}

/* -------------------------------------------------------------------------------------------------
 * Recorded rules
 * ---------------------------------------------------------------------------------------------- */

/** One rule this platform applies because a page says so. */
export interface AirwallexRecordedRule {
  readonly id: string;
  readonly rule: string;
  readonly reason: string;
  readonly source: string;
}

/** The rules STEPs 166-169 must follow, each with the page that produced it. */
export const AIRWALLEX_RECORDED_RULES: readonly AirwallexRecordedRule[] = deepFreeze([
  {
    id: "token_reuse",
    rule: "Obtain one access token and reuse it until expiry; never log in before every call.",
    reason: "The token page: the token lives 30 minutes, can be reused, and the login endpoint must not be called before each request.",
    source: "https://www.airwallex.com/docs/api/authentication/api_access_token",
  },
  {
    id: "token_expiry",
    rule: "Treat a token as unusable shortly before its expires_at, not at it.",
    reason: "expires_at is authoritative and a call that races expiry costs a retry; this file keeps a 60-second skew.",
    source: "https://www.airwallex.com/docs/api/authentication/api_access_token",
  },
  {
    id: "credentials_in_headers",
    rule: "Send x-client-id and x-api-key only to the login endpoint, in headers, never in a URL or a body.",
    reason: "The key-best-practices page forbids query parameters and public places, and the login page specifies headers.",
    source: "https://www.airwallex.com/docs/api/authentication/api_access_token",
  },
  {
    id: "version_pinned",
    rule: "Send x-api-version on every call and store the pinned value with the configuration.",
    reason: "The specification: omitting the header falls back to the account's default, which can differ per merchant; pinning is strongly recommended.",
    source: "https://github.com/airwallex/airwallex-openapi",
  },
  {
    id: "amount_major_units",
    rule: "Send payment and transfer amounts in major units as an exact decimal, never in the platform's ten-thousandths and never in cents.",
    reason: "The Payments guide: amount is in major units as defined by ISO 4217, and 9.99 means $9.99.",
    source: "https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api",
  },
  {
    id: "request_id_is_the_key",
    rule: "Derive request_id per attempt, send it in the body, and treat a 409 or a duplicate-id error as 'the original request exists'.",
    reason: "The guide calls request_id the idempotency key that prevents duplicate transactions; the transfers changelog documents 409 while a duplicate is being processed.",
    source: "https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api",
  },
  {
    id: "client_secret_handling",
    rule: "Hand the client secret to the payment page once; never log it, store it in plain text or put it in a URL.",
    reason: "The guide: the client secret is the secure handshake with the frontend SDK, lives 60 minutes, cannot be refreshed, and must never be logged.",
    source: "https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api",
  },
  {
    id: "no_card_data",
    rule: "Never let this platform see a card number, expiry or CVV; the browser hands them to Airwallex's own component.",
    reason: "The platform is not the card-data processor in any page read, and section 6 of the feature list forbids it.",
    source: "https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api",
  },
  {
    id: "webhook_verify_first",
    rule: "Verify x-signature over x-timestamp plus the raw body before parsing anything.",
    reason: "The webhook page: use the original unmodified body, verify before parsing, and use the timestamp exactly as received.",
    source: "https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events",
  },
  {
    id: "webhook_secret_per_url",
    rule: "Store one signing secret per subscription URL and never reuse one across URLs.",
    reason: "The webhook page: each secret is unique to the URL it corresponds to.",
    source: "https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events",
  },
  {
    id: "webhook_answer_fast",
    rule: "Answer 200 immediately after verification and do the work asynchronously; never answer a non-200 for work this platform can retry itself.",
    reason: "The webhook page: any answer other than 200, including a timeout, is a failed delivery and is retried.",
    source: "https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events",
  },
  {
    id: "succeeded_is_money",
    rule: "Only SUCCEEDED means the order may be fulfilled, and a payout only becomes final after PAID has survived its late-failure window.",
    reason: "The status page ties fulfilment to SUCCEEDED; the transfer page states PAID may still become FAILED.",
    source: "https://www.airwallex.com/docs/payments/reference/payment-statuses",
  },
  {
    id: "no_failed_intent_status",
    rule: "Do not look for a failed PaymentIntent status; read the last payment attempt and the payment_intent.payment_failed event instead.",
    reason: "The status page: a failed attempt returns the intent to REQUIRES_PAYMENT_METHOD.",
    source: "https://www.airwallex.com/docs/payments/reference/payment-statuses",
  },
  {
    id: "agreements_required",
    rule: "A connected-account create body carries both agreement flags set to true, and the platform's UI must show the Airwallex terms.",
    reason: "The native-API page: both customer_agreements flags are required, and the platform must reference Airwallex terms in its UI.",
    source: "https://www.airwallex.com/docs/connected-accounts/onboarding/kyc-and-onboarding/native-api",
  },
  {
    id: "account_id_not_unique_across_providers",
    rule: "Never accept a bare acct_ id as proof of a provider; always pair the id with the provider key.",
    reason: "Airwallex's connected-account id and Stripe's account id share the acct_ prefix, so the prefix alone cannot say whose id it is.",
    source: "https://www.airwallex.com/docs/connected-accounts/onboarding/kyc-and-onboarding/native-api",
  },
  {
    id: "sandbox_gap",
    rule: "Never report a connected-account step as sandbox-verified without a Sales-granted sandbox or a Simulation API run.",
    reason: "The sandbox page: the sandbox covers all products except Connected Account APIs, which require contacting Sales or using the Simulation APIs.",
    source: "https://www.airwallex.com/docs/developer-tools/sandbox-environment",
  },
]);

/* -------------------------------------------------------------------------------------------------
 * Open questions
 * ---------------------------------------------------------------------------------------------- */

/** Something the pages read did not settle. */
export interface AirwallexOpenQuestion {
  readonly id: string;
  readonly question: string;
  readonly why: string;
}

/** What this STEP could not settle, recorded instead of guessed. */
export const AIRWALLEX_OPEN_QUESTIONS: readonly AirwallexOpenQuestion[] = deepFreeze([
  {
    id: "credentials_have_no_prefix",
    question: "What shape do a client id and an API key have?",
    why: "No page read documents a prefix or a checksum for either (unlike Stripe's sk_test_/sk_live_), so STEP 166 can validate length and characters but cannot infer the mode from the key. The mode comes from the base URL and must be stored beside the sealed credential.",
  },
  {
    id: "version_default",
    question: "Which API version should the platform pin?",
    why: "The reference FAQ states the latest version is 2026-05-29 while the published OpenAPI repository demonstrates 2026-08-21. This file records both and defaults to 2026-05-29; STEP 166's connection test must confirm which the account accepts before a pin is stored.",
  },
  {
    id: "business_legal_entity_enum",
    question: "Which legal_entity_type values does a business account use?",
    why: "The native-API page shows INDIVIDUAL explicitly and shows a business create body with no legal_entity_type at all, so the business enum was not observed. STEP 167 sends a business body without the field, exactly as the documented example does.",
  },
  {
    id: "transfer_request_id_length",
    question: "Is a transfer request_id capped at 50 characters or at 64?",
    why: "The PaymentIntent page caps request_id at 64; a community note claims transfers cap it at 10-50 and that duplicates within a window are rejected with request_id_duplicate. Only the 409 in the official changelog is recorded as fact, so the adapter derives keys well inside both bounds.",
  },
  {
    id: "webhook_tolerance",
    question: "What timestamp tolerance does Airwallex expect?",
    why: "The webhook page tells the receiver to decide for itself whether the difference is within tolerance and names no number. This file chooses 300 seconds, the same as the Stripe receiver, and records that the number is this platform's choice.",
  },
  {
    id: "connected_accounts_in_sandbox",
    question: "Can STEP 169 verify a connected account in a real sandbox?",
    why: "The sandbox page excludes Connected Account APIs and points to Sales or the Simulation APIs. Until one of those is granted, STEP 167 and 169 stay partial by definition, whatever the code does.",
  },
  {
    id: "account_event_names",
    question: "Which account-status webhook names does the platform subscribe to?",
    why: "The native-API page points at a separate account webhook page for them, and that page was not read in this session, so no account event name is recorded and the event record stays honest about it.",
  },
  {
    id: "fee_handling_for_platforms",
    question: "How does the platform take its fee on a connected account's payment?",
    why: "The pages read for STEP 165 describe payment intents and transfers separately; the platform-revenue mechanics (an application-fee equivalent) were not read. STEP 168 must read the payments-for-platforms pages before it decides how the platform's fee is collected.",
  },
]);

/* -------------------------------------------------------------------------------------------------
 * Credentials and configuration
 * ---------------------------------------------------------------------------------------------- */

/**
 * No prefix is documented for an Airwallex client id or API key, so those shapes are recorded as bounds
 * rather than as patterns that could pretend to know more than the pages do.
 */
export const AIRWALLEX_CLIENT_ID_MINIMUM_LENGTH = 8;
export const AIRWALLEX_CLIENT_ID_MAXIMUM_LENGTH = 128;
export const AIRWALLEX_API_KEY_MINIMUM_LENGTH = 16;
export const AIRWALLEX_API_KEY_MAXIMUM_LENGTH = 256;

/** What a client id may contain: printable ASCII with no whitespace and no URL punctuation. */
export const AIRWALLEX_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;

/** What an API key may contain; the documentation shows no separators, so none are assumed. */
export const AIRWALLEX_API_KEY_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;

/** The documented token lifetime, in seconds. */
export const AIRWALLEX_TOKEN_LIFETIME_SECONDS = 30 * 60;

/** How long before expiry a token stops being used. */
export const AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS = 60;

/** The documented header names. */
export const AIRWALLEX_CLIENT_ID_HEADER = "x-client-id";
export const AIRWALLEX_API_KEY_HEADER = "x-api-key";
export const AIRWALLEX_LOGIN_AS_HEADER = "x-login-as";
export const AIRWALLEX_ON_BEHALF_OF_HEADER = "x-on-behalf-of";
export const AIRWALLEX_API_VERSION_HEADER = "x-api-version";
export const AIRWALLEX_TIMESTAMP_HEADER = "x-timestamp";
export const AIRWALLEX_SIGNATURE_HEADER = "x-signature";
export const AIRWALLEX_TEST_SECRET_HEADER = "client-secret-key";

/** The documented date-based version shape. */
export const AIRWALLEX_API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** The versions observed in the pages read, oldest first. */
export const AIRWALLEX_OBSERVED_API_VERSIONS: readonly string[] = deepFreeze([
  "2024-02-22",
  "2024-09-27",
  "2025-06-30",
  "2026-05-29",
  "2026-08-21",
]);

/** The version this file defaults to, with the reason recorded as an open question. */
export const AIRWALLEX_DEFAULT_API_VERSION = "2026-05-29";

/** True when a string is a documented date version. */
export function isAirwallexApiVersion(value: string): boolean {
  return AIRWALLEX_API_VERSION_PATTERN.test(value.trim());
}

/** The reason a credential pair is unusable, or null when it is usable. */
export function validateAirwallexCredentials(input: {
  readonly clientId: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiVersion: string;
}): string | null {
  if (AIRWALLEX_CLIENT_ID_PATTERN.test(input.clientId.trim()) === false) {
    return "the client id must be 8 to 128 letters, digits, dashes or underscores";
  }
  if (AIRWALLEX_API_KEY_PATTERN.test(input.apiKey.trim()) === false) {
    return "the API key must be 16 to 256 letters, digits, dashes or underscores";
  }
  if (airwallexEnvironmentOfBase(input.baseUrl) === null) {
    return "the base URL must be one of the two documented API hosts";
  }
  if (isAirwallexApiVersion(input.apiVersion) === false) {
    return "the API version must be a date such as 2026-05-29";
  }
  return null;
}

/**
 * True when a string looks like one of this provider's credentials.
 *
 * A value shaped like a JWT (three dot-separated base64url segments) is the access token, not the key, and a
 * string carrying `x-api-key` or `Bearer ` is a copy-pasted header. Neither belongs in a stored field, and a
 * record that finds one has a defect worth refusing.
 */
export function carriesAirwallexKeyShapedText(value: string): boolean {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/u.test(trimmed)) return true;
  return /(x-api-key|x-client-id|client_secret|Bearer\s)/iu.test(trimmed);
}

/** Read a documented `expires_at` into epoch milliseconds, or null when it is unreadable. */
export function airwallexTokenExpiryMs(expiresAt: string): number | null {
  const trimmed = expiresAt.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)$/u.test(trimmed) === false) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when a token must not be used at `nowEpochMs`, including the skew. */
export function airwallexTokenNeedsRefresh(expiresAt: string, nowEpochMs: number): boolean {
  const expiresAtMs = airwallexTokenExpiryMs(expiresAt);
  if (expiresAtMs === null) return true;
  return nowEpochMs + AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS * 1_000 >= expiresAtMs;
}

/* -------------------------------------------------------------------------------------------------
 * Money: major units, converted once
 * ---------------------------------------------------------------------------------------------- */

/** The minor units of the currencies this adapter may charge in. */
export const AIRWALLEX_CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = deepFreeze({ usd: 2 });

/** The largest amount this adapter sends. */
export const AIRWALLEX_MAXIMUM_AMOUNT = 99_999_999;

/** The result of converting a platform amount into Airwallex's major-unit decimal. */
export type AirwallexAmount =
  | { readonly ok: true; readonly amount: number; readonly amountText: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Convert the platform's ten-thousandths to major units, exactly.
 *
 * `10_000n` is one unit, so `1_000_000n` is one hundred units and its text is `"100.00"` for USD. A platform
 * amount that is not a whole number of the currency's minor unit is refused rather than rounded, and the text
 * is built from integers so no floating-point rounding can reach a payment.
 */
export function airwallexAmountFromPlatformMinor(minor: bigint, currency: string): AirwallexAmount {
  const minorUnits = AIRWALLEX_CURRENCY_MINOR_UNITS[currency.trim().toLowerCase()];
  if (minorUnits === undefined) return { ok: false, reason: "the currency is not supported by this adapter" };
  if (minor <= 0n) return { ok: false, reason: "the amount must be greater than zero" };

  const unit = 10n ** BigInt(MONEY_SCALE);
  const whole = minor / unit;
  const remainder = minor % unit;
  const step = 10n ** BigInt(MONEY_SCALE - minorUnits);
  if (remainder % step !== 0n) {
    return { ok: false, reason: "the amount is not a whole number of the currency's minor unit" };
  }

  const fraction = remainder / step;
  const amountText = `${whole}.${fraction.toString().padStart(minorUnits, "0")}`;
  const amount = Number(amountText);
  if (Number.isFinite(amount) === false) return { ok: false, reason: "the amount is not representable" };
  if (amount > AIRWALLEX_MAXIMUM_AMOUNT) return { ok: false, reason: "the amount is too large" };
  return { ok: true, amount, amountText };
}

/** Read a documented major-unit amount back into the platform's minor units, or null. */
export function airwallexPlatformMinorFromAmount(amount: string | number, currency: string): bigint | null {
  const minorUnits = AIRWALLEX_CURRENCY_MINOR_UNITS[currency.trim().toLowerCase()];
  if (minorUnits === undefined) return null;
  const text = typeof amount === "number" ? (Number.isFinite(amount) ? amount.toFixed(minorUnits) : "") : amount.trim();
  const match = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${minorUnits}}))?$`, "u").exec(text);
  if (match === null) return null;
  const whole = BigInt(match[1] ?? "0");
  const fractionText = (match[2] ?? "").padEnd(minorUnits, "0");
  const fraction = BigInt(fractionText.length === 0 ? "0" : fractionText);
  return whole * 10n ** BigInt(MONEY_SCALE) + fraction * 10n ** BigInt(MONEY_SCALE - minorUnits);
}

/* -------------------------------------------------------------------------------------------------
 * Payment statuses
 * ---------------------------------------------------------------------------------------------- */

/** The six documented PaymentIntent statuses, in the page's order. */
export const AIRWALLEX_PAYMENT_INTENT_STATUSES: readonly string[] = deepFreeze([
  "REQUIRES_PAYMENT_METHOD",
  "REQUIRES_CUSTOMER_ACTION",
  "REQUIRES_CAPTURE",
  "PENDING",
  "PENDING_REVIEW",
  "SUCCEEDED",
  "CANCELLED",
]);

/** The documented PaymentAttempt statuses, which are a second, separate vocabulary. */
export const AIRWALLEX_PAYMENT_ATTEMPT_STATUSES: readonly string[] = deepFreeze([
  "CANCELLED",
  "FAILED",
  "SETTLED",
  "PAID",
]);

/** What a status means for this platform. */
export type AirwallexPaymentOutcome = "paid" | "pending" | "requires_customer_action" | "failed" | "unknown";

/**
 * Map a documented Intent status to what the platform may act on.
 *
 * Only `SUCCEEDED` is paid — the page's own required action for it is "Fulfill the order" and for every other
 * status it is something else. `PENDING` and `PENDING_REVIEW` are money in flight, `REQUIRES_CAPTURE` is
 * authorized but not captured, `REQUIRES_PAYMENT_METHOD` and `REQUIRES_CUSTOMER_ACTION` need the customer, and
 * `CANCELLED` is final and not paid. An unrecorded value is `unknown`, never a success.
 */
export function airwallexPaymentOutcomeOf(status: string): AirwallexPaymentOutcome {
  const normalized = status.trim().toUpperCase();
  if (normalized === "SUCCEEDED") return "paid";
  if (normalized === "PENDING" || normalized === "PENDING_REVIEW" || normalized === "REQUIRES_CAPTURE") return "pending";
  if (normalized === "REQUIRES_CUSTOMER_ACTION" || normalized === "REQUIRES_PAYMENT_METHOD") {
    return "requires_customer_action";
  }
  if (normalized === "CANCELLED") return "failed";
  return "unknown";
}

/** What an attempt status means, once a read has reported one. */
export function airwallexPaymentAttemptOutcomeOf(status: string): AirwallexPaymentOutcome {
  const normalized = status.trim().toUpperCase();
  if (normalized === "PAID" || normalized === "SETTLED") return "paid";
  if (normalized === "CANCELLED" || normalized === "FAILED") return "failed";
  return "unknown";
}

/** True when an Intent status is a platform-defined failure (which Airwallex does not use). */
export function airwallexIntentHasFailureStatus(status: string): boolean {
  return status.trim().toUpperCase() === "FAILED";
}

/* -------------------------------------------------------------------------------------------------
 * Transfer statuses and finality
 * ---------------------------------------------------------------------------------------------- */

/** The documented transfer statuses, including the approval ones, in the page's order. */
export const AIRWALLEX_TRANSFER_STATUSES: readonly string[] = deepFreeze([
  "IN_APPROVAL",
  "APPROVAL_RECALLED",
  "APPROVAL_REJECTED",
  "APPROVAL_BLOCKED",
  "SCHEDULED",
  "OVERDUE",
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "CANCELLED",
]);

/** The statuses a transfer may not leave. */
export const AIRWALLEX_TRANSFER_TERMINAL_STATUSES: readonly string[] = deepFreeze(["CANCELLED"]);

/** What a transfer status means for this platform's payout ledger. */
export type AirwallexTransferOutcome = "paid" | "in_flight" | "failed" | "cancelled" | "unknown";

/**
 * Map a transfer status.
 *
 * `PAID` is reported as `paid` **and** as `provisional`, because the page says a paid transfer may still fail;
 * the caller's ledger (STEP 141) is what decides when a provisional payment becomes final. Nothing else is
 * paid: `SENT` is on its way, the approval and scheduled and processing statuses are in flight, `OVERDUE` is a
 * funding problem rather than a failure, and `FAILED` is a failure that still becomes `CANCELLED`.
 */
export function airwallexTransferOutcomeOf(status: string): { readonly outcome: AirwallexTransferOutcome; readonly provisional: boolean } {
  const normalized = status.trim().toUpperCase();
  if (normalized === "PAID") return { outcome: "paid", provisional: true };
  if (normalized === "FAILED") return { outcome: "failed", provisional: false };
  if (normalized === "CANCELLED") return { outcome: "cancelled", provisional: false };
  if (
    normalized === "IN_APPROVAL" ||
    normalized === "APPROVAL_RECALLED" ||
    normalized === "APPROVAL_REJECTED" ||
    normalized === "APPROVAL_BLOCKED" ||
    normalized === "SCHEDULED" ||
    normalized === "OVERDUE" ||
    normalized === "PROCESSING" ||
    normalized === "SENT"
  ) {
    return { outcome: "in_flight", provisional: false };
  }
  return { outcome: "unknown", provisional: false };
}

/** True when a transfer that reads PAID may still fail, which is why a payout is not final on PAID alone. */
export function airwallexTransferCanStillFail(status: string): boolean {
  return airwallexTransferOutcomeOf(status).provisional;
}

/* -------------------------------------------------------------------------------------------------
 * Connected accounts
 * ---------------------------------------------------------------------------------------------- */

/** The documented connected-account id shape. */
export const AIRWALLEX_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{6,64}$/u;

/** The documented account statuses, from creation to suspension. */
export const AIRWALLEX_ACCOUNT_STATUSES: readonly string[] = deepFreeze([
  "CREATED",
  "SUBMITTED",
  "ACTIVE",
  "ACTION_REQUIRED",
  "SUSPENDED",
]);

/** The legal entity type the page showed explicitly. */
export const AIRWALLEX_OBSERVED_LEGAL_ENTITY_TYPES: readonly string[] = deepFreeze(["INDIVIDUAL"]);

/** Where an account stands for this platform. */
export type AirwallexOnboardingState = "ready" | "waiting" | "blocked";

/** Map a documented account status to the platform's onboarding state. */
export function airwallexOnboardingStateOf(status: string | null): { readonly state: AirwallexOnboardingState; readonly reason: string } {
  const normalized = (status ?? "").trim().toUpperCase();
  if (normalized === "ACTIVE") return { state: "ready", reason: "the account is active and ready to use" };
  if (normalized === "ACTION_REQUIRED") {
    return { state: "blocked", reason: "Airwallex raised a request for information and the account cannot act until it is answered" };
  }
  if (normalized === "SUSPENDED") {
    return { state: "blocked", reason: "onboarding verification was unsuccessful and no further action is possible" };
  }
  if (normalized === "SUBMITTED") return { state: "waiting", reason: "the account is submitted and pending review" };
  if (normalized === "CREATED") return { state: "waiting", reason: "the account exists but has not been submitted for verification" };
  return { state: "blocked", reason: "the account status is not one this adapter records" };
}

/** True when an id is a documented connected-account id. */
export function isAirwallexAccountId(value: string): boolean {
  return AIRWALLEX_ACCOUNT_ID_PATTERN.test(value.trim());
}

/**
 * True when a connected-account id could belong to another provider too.
 *
 * Airwallex and Stripe both use `acct_`, so this returns true for any `acct_` id and exists to stop code from
 * treating the prefix as proof of ownership. A store must key on `(provider_key, account_id)`.
 */
export function airwallexAccountIdCollidesWithStripe(value: string): boolean {
  return value.trim().startsWith("acct_");
}

/** One connected-account create request, in the two shapes the page showed. */
export type AirwallexAccountRequest =
  | {
      readonly kind: "individual";
      readonly email: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly countryCode: string;
      readonly agreedToDataUsage: boolean;
      readonly agreedToTermsAndConditions: boolean;
    }
  | {
      readonly kind: "business";
      readonly email: string;
      readonly businessName: string;
      readonly countryCode: string;
      readonly agreedToDataUsage: boolean;
      readonly agreedToTermsAndConditions: boolean;
    };

/** The country-code shape the documented address objects use. */
export const AIRWALLEX_COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;

/** The reason an account request is unusable, or null when it is usable. */
export function validateAirwallexAccountRequest(request: AirwallexAccountRequest): string | null {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(request.email.trim()) === false) return "a primary contact email is required";
  if (AIRWALLEX_COUNTRY_CODE_PATTERN.test(request.countryCode.trim()) === false) {
    return "the country code must be two upper-case letters";
  }
  if (request.agreedToDataUsage !== true || request.agreedToTermsAndConditions !== true) {
    return "both agreement flags must be true, because Airwallex requires the platform to accept them on the account's behalf";
  }
  if (request.kind === "individual") {
    if (request.firstName.trim().length === 0 || request.lastName.trim().length === 0) {
      return "an individual account names a first and a last name";
    }
    return null;
  }
  if (request.businessName.trim().length < 2) return "a business account names its business name";
  return null;
}

/**
 * Build the documented connected-account create body.
 *
 * The body is the page's own: `account_details`, `customer_agreements` with both flags, and `primary_contact`.
 * A business body carries no `legal_entity_type`, because the documented business example carries none and the
 * business enum was not observed (recorded as an open question); an individual body carries `INDIVIDUAL`,
 * which the page does show.
 */
export function buildAirwallexConnectedAccountBody(request: AirwallexAccountRequest): Record<string, unknown> {
  const common = {
    customer_agreements: {
      agreed_to_data_usage: request.agreedToDataUsage,
      agreed_to_terms_and_conditions: request.agreedToTermsAndConditions,
    },
    primary_contact: { email: request.email.trim() },
  };

  if (request.kind === "individual") {
    return {
      account_details: {
        legal_entity_type: "INDIVIDUAL",
        individual_details: { first_name: request.firstName.trim(), last_name: request.lastName.trim() },
      },
      ...common,
    };
  }

  return {
    account_details: {
      business_details: {
        business_name: request.businessName.trim(),
        registration_address: { country_code: request.countryCode.trim() },
      },
    },
    ...common,
  };
}

/* -------------------------------------------------------------------------------------------------
 * PaymentIntent body
 * ---------------------------------------------------------------------------------------------- */

/** The longest `merchant_order_id` and `request_id` the page allows. */
export const AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH = 64;

/** The shape this platform derives for a `request_id`. */
export const AIRWALLEX_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/u;

/** What a caller asks to charge. */
export interface AirwallexPaymentIntentRequest {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly merchantOrderId: string;
  readonly requestId: string;
  readonly returnUrl: string | null;
  readonly descriptor: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The reason a create request is unusable, or null when it is usable. */
export function validateAirwallexPaymentIntentRequest(request: AirwallexPaymentIntentRequest): string | null {
  const amount = airwallexAmountFromPlatformMinor(request.amountMinor, request.currency);
  if (amount.ok === false) return amount.reason;
  if (AIRWALLEX_REQUEST_ID_PATTERN.test(request.requestId) === false) {
    return "the request id must be 8 to 64 characters of letters, digits, dot, colon, dash or underscore";
  }
  if (request.requestId.length > AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH) return "the request id is longer than 64 characters";
  if (request.merchantOrderId.trim().length === 0) return "a merchant order id is required";
  if (request.merchantOrderId.length > AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH) return "the merchant order id is longer than 64 characters";
  if (request.returnUrl !== null) {
    if (/^https:\/\/[^\s]+$/u.test(request.returnUrl.trim()) === false) return "the return URL must be an absolute HTTPS URL";
  }
  if (request.descriptor !== null && request.descriptor.trim().length > 64) return "the descriptor is longer than 64 characters";
  const keys = Object.keys(request.metadata);
  if (keys.length > 20) return "a request carries too many metadata entries";
  for (const key of keys) {
    if (/^[A-Za-z0-9_]{1,40}$/u.test(key) === false) return "a metadata key must be 1 to 40 letters, digits or underscores";
    const value = request.metadata[key] ?? "";
    if (value.length > 500) return "a metadata value is too long";
    if (carriesAirwallexKeyShapedText(value)) return "a metadata value must not carry a credential or a client secret";
  }
  return null;
}

/**
 * Build the documented PaymentIntent create body.
 *
 * `amount` is a major-unit number, `currency` is the upper-case ISO code the examples show, and `request_id`
 * is the documented idempotency key. The body never carries a card field, a client secret or a bearer token:
 * the platform is not the card-data processor.
 */
export function buildAirwallexPaymentIntentBody(request: AirwallexPaymentIntentRequest): Record<string, unknown> {
  const amount = airwallexAmountFromPlatformMinor(request.amountMinor, request.currency);
  const body: Record<string, unknown> = {
    amount: amount.ok === true ? amount.amount : 0,
    currency: request.currency.trim().toUpperCase(),
    merchant_order_id: request.merchantOrderId.trim(),
    request_id: request.requestId,
  };
  if (request.returnUrl !== null) body["return_url"] = request.returnUrl.trim();
  if (request.descriptor !== null && request.descriptor.trim().length > 0) body["descriptor"] = request.descriptor.trim();
  if (Object.keys(request.metadata).length > 0) body["metadata"] = { ...request.metadata };
  return body;
}

/**
 * The request id this platform derives for one attempt: deterministic, 43 characters, inside both the 64 the
 * PaymentIntent page documents and the shorter bound a community note claims for transfers.
 */
export function airwallexRequestIdFor(companyId: string, reference: string): string {
  const digest = createHash("sha256").update(`${companyId}|${reference}`, "utf8").digest("hex");
  return `kd-${digest.slice(0, 40)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Webhook signatures
 * ---------------------------------------------------------------------------------------------- */

/** The signing scheme, as the page describes it. */
export const AIRWALLEX_WEBHOOK_SIGNATURE_SCHEME = "HMAC-SHA256 over x-timestamp + raw body, hex, per-URL secret";

/** The tolerance this platform chooses, because the page names none. */
export const AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The largest delivery this receiver reads. */
export const AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES = 1_048_576;

/** The documented event id shape. */
export const AIRWALLEX_EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_]{8,64}$/u;

/** What the signature check concluded. */
export type AirwallexSignatureVerdict =
  | { readonly ok: true; readonly timestampMs: number }
  | { readonly ok: false; readonly reason: string };

/** The documented signed value: the timestamp exactly as received, then the raw body. */
export function airwallexSignaturePayload(timestampHeader: string, rawBody: string): string {
  return `${timestampHeader}${rawBody}`;
}

/** Read a timestamp header into milliseconds, or null when it is not a Unix timestamp. */
export function airwallexTimestampMs(header: string): number | null {
  const trimmed = header.trim();
  if (/^\d{10}$|^\d{13}$/u.test(trimmed) === false) return null;
  const value = Number(trimmed);
  if (Number.isFinite(value) === false) return null;
  return trimmed.length === 10 ? value * 1_000 : value;
}

/**
 * Verify one delivery, exactly as the webhook page describes.
 *
 * The four documented steps: read `x-timestamp` and `x-signature`; concatenate the timestamp **as received**
 * with the raw body; HMAC-SHA256 it with the subscription's secret; compare in constant time. Then the page's
 * final instruction — decide whether the timestamp is within tolerance — which this receiver applies with
 * `AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS`. Every refusal carries a reason and never the secret, the signature or
 * the body.
 */
export function verifyAirwallexWebhookSignature(
  rawBody: string,
  headers: { readonly timestamp: string | null; readonly signature: string | null },
  options: {
    readonly secret: string;
    readonly nowEpochMs: number;
    readonly toleranceSeconds?: number;
    readonly maximumBodyBytes?: number;
  },
): AirwallexSignatureVerdict {
  const secret = options.secret.trim();
  if (secret.length < 8) return { ok: false, reason: "the webhook secret is missing or unusable" };
  if (rawBody.length === 0) return { ok: false, reason: "the delivery carries no body" };
  if (rawBody.length > (options.maximumBodyBytes ?? AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES)) {
    return { ok: false, reason: "the delivery is larger than this receiver accepts" };
  }
  if (headers.timestamp === null || headers.signature === null) {
    return { ok: false, reason: "the delivery carries no timestamp or no signature" };
  }

  const timestampMs = airwallexTimestampMs(headers.timestamp);
  if (timestampMs === null) return { ok: false, reason: "the timestamp header is not a Unix timestamp" };

  const signature = headers.signature.trim();
  if (/^[0-9a-f]{64}$/u.test(signature) === false) {
    return { ok: false, reason: "the signature is not a lower-case hex SHA-256 digest" };
  }

  const expected = createHmac("sha256", secret)
    .update(airwallexSignaturePayload(headers.timestamp, rawBody), "utf8")
    .digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(signature, "utf8");
  if (expectedBytes.length !== receivedBytes.length) return { ok: false, reason: "the signature does not match" };
  let matched = true;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    if (expectedBytes[index] !== receivedBytes[index]) matched = false;
  }
  if (matched === false) return { ok: false, reason: "the signature does not match" };

  const toleranceSeconds = options.toleranceSeconds ?? AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS;
  if (Number.isInteger(toleranceSeconds) === false || toleranceSeconds <= 0) {
    return { ok: false, reason: "the tolerance must be a positive number of seconds" };
  }
  if (Math.abs(options.nowEpochMs - timestampMs) > toleranceSeconds * 1_000) {
    return { ok: false, reason: "the delivery is outside the timestamp tolerance" };
  }

  return { ok: true, timestampMs };
}

/* -------------------------------------------------------------------------------------------------
 * Webhook events
 * ---------------------------------------------------------------------------------------------- */

/** The delivery-headers the page names, plus the test-event secret header. */
export const AIRWALLEX_EVENT_FIELDS: readonly string[] = deepFreeze([
  "id",
  "name",
  "account_id",
  "org_id",
  "data",
  "created_at",
  "version",
]);

/** The documented event names this platform subscribes to, grouped by resource. */
export const AIRWALLEX_EVENT_NAMES: Readonly<Record<string, readonly string[]>> = deepFreeze({
  paymentIntent: [
    "payment_intent.created",
    "payment_intent.requires_payment_method",
    "payment_intent.requires_customer_action",
    "payment_intent.requires_capture",
    "payment_intent.pending",
    "payment_intent.pending_review",
    "payment_intent.succeeded",
    "payment_intent.cancelled",
    "payment_intent.payment_failed",
    "payment_intent.updated",
  ],
  paymentAttempt: ["payment_attempt.authorized", "payment_attempt.authentication_failed", "payment_attempt.authorization_failed"],
  transfer: [
    "payout.transfer.in_approval",
    "payout.transfer.approval_recalled",
    "payout.transfer.approval_rejected",
    "payout.transfer.approval_blocked",
    "payout.transfer.scheduled",
    "payout.transfer.overdue",
    "payout.transfer.processing",
    "payout.transfer.sent",
    "payout.transfer.paid",
    "payout.transfer.failed",
    "payout.transfer.cancelled",
  ],
});

/** One parsed event envelope, as far as this record reads it. */
export interface AirwallexEventEnvelope {
  readonly eventId: string;
  readonly name: string;
  readonly accountId: string | null;
  readonly orgId: string | null;
  readonly objectId: string | null;
  readonly objectStatus: string | null;
  readonly version: string | null;
  readonly createdAt: string | null;
}

/** True when a name is one this record subscribes to. */
export function isAirwallexEventName(name: string): boolean {
  const normalized = name.trim();
  return Object.values(AIRWALLEX_EVENT_NAMES).some((names) => names.includes(normalized));
}

/**
 * Read an event envelope.
 *
 * The page's fields are `id`, `name`, `account_id`, `org_id`, `data`, `created_at` and `version`, with the
 * resource under `data.object`. An envelope without an `evt_` id or without a name cannot be deduplicated or
 * routed, so it is refused rather than guessed at.
 */
export function parseAirwallexEvent(rawBody: string): AirwallexEventEnvelope | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const envelope = payload as Record<string, unknown>;

  const eventId = envelope["id"];
  const name = envelope["name"];
  if (typeof eventId !== "string" || AIRWALLEX_EVENT_ID_PATTERN.test(eventId) === false) return null;
  if (typeof name !== "string" || /^[a-z0-9_.]{3,64}$/u.test(name) === false) return null;

  const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
  const data = typeof envelope["data"] === "object" && envelope["data"] !== null ? (envelope["data"] as Record<string, unknown>) : null;
  const object = data !== null && typeof data["object"] === "object" && data["object"] !== null ? (data["object"] as Record<string, unknown>) : null;

  return {
    eventId,
    name,
    accountId: text(envelope["account_id"]),
    orgId: text(envelope["org_id"]),
    objectId: object === null ? null : text(object["id"]),
    objectStatus: object === null ? null : text(object["status"]),
    version: text(envelope["version"]),
    createdAt: text(envelope["created_at"]),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The sandbox cycle and its limits
 * ---------------------------------------------------------------------------------------------- */

/** The record's sandbox status vocabulary. */
export type AirwallexSandboxStatus = "verified" | "partial" | "not_run";

/** This provider's session status, now. */
export const AIRWALLEX_SESSION_STATUS: AirwallexSandboxStatus = "partial";

/** One step of the sandbox cycle STEP 169 must walk. */
export interface AirwallexSandboxStep {
  readonly id: string;
  readonly title: string;
  readonly behaviour: string;
  readonly evidence: string;
}

/** The five steps of the documented sandbox cycle, in order. */
export const AIRWALLEX_SANDBOX_CYCLE: readonly AirwallexSandboxStep[] = deepFreeze([
  {
    id: "token",
    title: "Obtain and reuse an access token",
    behaviour: "POST /api/v1/authentication/login with the sandbox x-client-id and x-api-key answers 201 with a token and expires_at; the token is reused until it is within 60 seconds of expiry.",
    evidence: "The answer's expires_at and one authenticated read (GET /api/v1/balances/current) with the same token.",
  },
  {
    id: "account",
    title: "Create one connected account after approval",
    behaviour: "POST /api/v1/accounts/create answers an acct_ id with status CREATED; submit answers SUBMITTED; a second call with the same request answers the same account and never a second one.",
    evidence: "The acct_ id, its status before and after submit, and the second call's answer.",
  },
  {
    id: "payment",
    title: "Take a payment with the documented test card",
    behaviour: "A PaymentIntent created with amount 9.99 USD and 4035501000000008 reaches SUCCEEDED and emits payment_intent.succeeded; a 3DS or decline card emits the documented failure event instead of succeeding.",
    evidence: "payment_intent id, payment_attempt id, the status, the webhook delivery log, and one screenshot of the 3DS or decline path.",
  },
  {
    id: "transfer",
    title: "Pay out to a beneficiary and wait out PAID",
    behaviour: "POST /api/v1/transfers/create with a request_id answers a transfer that reaches PAID, and the receiver keeps listening for payout.transfer.failed after it.",
    evidence: "The transfer id, its status sequence, and a recorded statement that PAID is provisional.",
  },
  {
    id: "webhook",
    title: "Verify and deduplicate a delivery",
    behaviour: "A delivery signed with the subscription's secret verifies against x-timestamp plus the raw body; a tampered body is refused; a repeated event id applies once.",
    evidence: "One accepted delivery, one refused one, and the event record's delivery count.",
  },
]);

/** What the sandbox cannot do for this provider, recorded so no STEP overstates it. */
export const AIRWALLEX_SANDBOX_LIMITS: readonly string[] = deepFreeze([
  "The sandbox covers every product except the Connected Account APIs, so account creation, submission and RFI handling cannot be exercised in a self-service sandbox.",
  "Connected Account testing needs Airwallex Sales to grant it, or the Simulation APIs, which are not the same evidence as a real sandbox run.",
  "A platform may call on a connected account's behalf with the x-on-behalf-of header, which is what STEPs 167-169 will use once an account exists.",
  "New sandbox accounts must be created with the entity name New Business Sandbox or Sandbox Business or they stay In review and never activate.",
  "Files uploaded in the sandbox are deleted after 90 days, so evidence kept there is temporary.",
  "The test cards and the required test cases are documented, and evidence must include the intent id, the attempt id, screenshots and the webhook delivery log.",
]);

/* -------------------------------------------------------------------------------------------------
 * Session review: what may be claimed
 * ---------------------------------------------------------------------------------------------- */

/** One recorded check of the STEP 165 session. */
export interface AirwallexSessionCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly evidence: string;
}

/** What was reviewed, and how it was proven. */
export const AIRWALLEX_SESSION_CHECKS: readonly AirwallexSessionCheck[] = deepFreeze([
  {
    id: "sources",
    description: "Every documentation source is on a recorded host and none is a refused host",
    passed: true,
    evidence: "AIRWALLEX_DOCUMENTATION_SOURCES is checked against isAirwallexDocumentationUrl, including the api-demo lookalike.",
  },
  {
    id: "hosts",
    description: "The two documented API hosts are the only bases, and a community 'demo' host is refused",
    passed: true,
    evidence: "airwallexEnvironmentOfBase answers sandbox/live for the documented hosts and null for api-demo.airwallex.com.",
  },
  {
    id: "credentials",
    description: "Credential shape is validated by bounds because no prefix is documented",
    passed: true,
    evidence: "validateAirwallexCredentials checks both values and the base URL, and carriesAirwallexKeyShapedText refuses a token or a header pasted into a field.",
  },
  {
    id: "amounts",
    description: "The major-unit conversion is exact in both directions and refuses a rounded value",
    passed: true,
    evidence: "airwallexAmountFromPlatformMinor and airwallexPlatformMinorFromAmount are checked against hand-computed values.",
  },
  {
    id: "statuses",
    description: "Every documented status maps to a platform outcome, and only SUCCEEDED is paid",
    passed: true,
    evidence: "The Intent, attempt and transfer vocabularies are checked value by value.",
  },
  {
    id: "finality",
    description: "A PAID transfer is recorded as provisional",
    passed: true,
    evidence: "airwallexTransferOutcomeOf reports PAID as paid with provisional true, and airwallexTransferCanStillFail agrees.",
  },
  {
    id: "signature",
    description: "The documented webhook signature scheme is implemented and its refusals are named",
    passed: true,
    evidence: "verifyAirwallexWebhookSignature signs t+body with HMAC-SHA256 and refuses a tampered body, a wrong secret, a stale timestamp and a malformed header.",
  },
  {
    id: "sandbox",
    description: "The sandbox gap is recorded rather than papered over",
    passed: true,
    evidence: "AIRWALLEX_SANDBOX_LIMITS names the missing Connected Account APIs, and AIRWALLEX_SESSION_STATUS is partial.",
  },
]);

/** The five step ids the sandbox cycle defines. */
export const AIRWALLEX_REQUIRED_STEP_IDS: readonly string[] = deepFreeze(
  AIRWALLEX_SANDBOX_CYCLE.map((step) => step.id),
);

/** One recorded sandbox result for one step. */
export interface AirwallexStepResult {
  readonly stepId: string;
  readonly status: AirwallexSandboxStatus;
  readonly notes: string;
  readonly evidence: string | null;
}

/** The verification record for one provider configuration. */
export interface AirwallexVerificationRecord {
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly environment: "sandbox" | "live";
  readonly apiVersion: string;
  readonly steps: readonly AirwallexStepResult[];
  readonly status: AirwallexSandboxStatus;
  readonly reviewedAtEpochMs: number;
}

/** What the platform may claim about this provider, from what it recorded. */
export function calculateAirwallexStatus(
  steps: readonly AirwallexStepResult[],
): { readonly status: AirwallexSandboxStatus; readonly verifiedSteps: number; readonly missingSteps: readonly string[] } {
  const byId = new Map(steps.map((step) => [step.stepId, step.status]));
  const missingSteps = AIRWALLEX_REQUIRED_STEP_IDS.filter((id) => {
    const status = byId.get(id);
    return status === undefined || status === "not_run";
  });
  const verifiedSteps = AIRWALLEX_REQUIRED_STEP_IDS.filter((id) => byId.get(id) === "verified").length;

  if (missingSteps.length === AIRWALLEX_REQUIRED_STEP_IDS.length) {
    return { status: "not_run", verifiedSteps, missingSteps };
  }
  if (missingSteps.length > 0) return { status: "partial", verifiedSteps, missingSteps };
  return { status: "verified", verifiedSteps, missingSteps };
}

/** The store the caller supplies for verification records. */
export interface AirwallexVerificationStore {
  save(record: AirwallexVerificationRecord): void;
  find(): AirwallexVerificationRecord | null;
}

/** The in-memory store, which is all this STEP needs. */
export class InMemoryAirwallexVerificationStore implements AirwallexVerificationStore {
  private record: AirwallexVerificationRecord | null = null;
  save(record: AirwallexVerificationRecord): void {
    this.record = record;
  }
  find(): AirwallexVerificationRecord | null {
    return this.record;
  }
}

/** One audit entry this file hands to the caller's audit writer. */
export interface AirwallexAuditEntry {
  readonly action: "airwallex.verification_recorded";
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly environment: "sandbox" | "live";
  readonly status: AirwallexSandboxStatus;
  readonly reviewedAtEpochMs: number;
}

/**
 * Record one session's verification, with its audit entry.
 *
 * The status is derived, never asserted: `verified` needs every documented step verified, and one recorded
 * step is not the same as five. Storing a record that claims more than its steps prove is refused.
 */
export function recordAirwallexVerification(
  input: {
    readonly environment: "sandbox" | "live";
    readonly apiVersion: string;
    readonly steps: readonly AirwallexStepResult[];
    readonly reviewedAtEpochMs: number;
  },
  options: { readonly store: AirwallexVerificationStore; readonly recordAudit?: (entry: AirwallexAuditEntry) => void },
): { readonly status: "recorded"; readonly record: AirwallexVerificationRecord } | { readonly status: "failed"; readonly reason: string } {
  if (isAirwallexApiVersion(input.apiVersion) === false) {
    return { status: "failed", reason: "the API version must be a date such as 2026-05-29" };
  }
  const unknown = input.steps.find((step) => AIRWALLEX_REQUIRED_STEP_IDS.includes(step.stepId) === false);
  if (unknown !== undefined) return { status: "failed", reason: `the step ${unknown.stepId} is not part of the sandbox cycle` };
  if (input.steps.some((step) => step.status === "verified" && step.evidence === null)) {
    return { status: "failed", reason: "a verified step must carry its evidence" };
  }

  const calculated = calculateAirwallexStatus(input.steps);
  const record: AirwallexVerificationRecord = {
    providerKey: AIRWALLEX_PROVIDER_KEY,
    environment: input.environment,
    apiVersion: input.apiVersion,
    steps: [...input.steps],
    status: calculated.status,
    reviewedAtEpochMs: input.reviewedAtEpochMs,
  };
  options.store.save(record);
  options.recordAudit?.({
    action: "airwallex.verification_recorded",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    environment: input.environment,
    status: record.status,
    reviewedAtEpochMs: input.reviewedAtEpochMs,
  });
  return { status: "recorded", record };
}

/** The capability matrix this provider's record supports. */
export const AIRWALLEX_CAPABILITY_MATRIX: Readonly<Record<string, boolean>> = deepFreeze({
  connectedAccounts: true,
  payments: true,
  payouts: true,
  refunds: true,
  webhooks: true,
  hostedComponents: true,
  sandboxForConnectedAccounts: false,
});

/** Text a record or a screen may show, with control characters removed and the length bounded. */
export function sanitizeAirwallexText(value: string, maximumLength = 200): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}
