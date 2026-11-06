// path: lib/payments/adapters/rainforest.ts

/**
 * The Rainforest adapter: documentation verification and sandbox notes recording for the Rainforest
 * provider, the third of the five provider adapters (STEPs 147-169).
 *
 * ## What section 6 asks of this provider
 *
 * The feature list says "Rainforest (rainforestpay.com): payment acceptance and sub-merchant
 * creation." Rainforest is a payments-as-a-service platform: the platform embeds it, the platform's
 * merchants are Rainforest's merchants, and Rainforest performs the KYC/KYB checks and answers
 * approved, declined or manual review. The provider matrix in `lib/gateways/registry.ts` records
 * exactly that (`acceptance: true, payouts: false, submerchant: true`).
 *
 * ## What this file is
 *
 * Before any code is written against a provider's API, `docs/final/MASTER_PROMPT.md` requires its
 * current official documentation to be read in the same session, the URLs recorded, and what was
 * and was not verified written down plainly. This file is that record for Rainforest, as
 * `lib/payments/adapters/nmi.ts` is it for NMI and `lib/payments/adapters/payoneer.ts` is it for
 * Payoneer:
 *
 * - **The documentation sources** read for this STEP, with the topic each one established. All of
 *   them are on `docs.rainforestpay.com`, Rainforest's own documentation host.
 * - **The recorded rules** those pages state: the environment split and the key prefixes, the API
 *   version header, the permission model, the two-call payin flow, the direct-to-API approval
 *   requirement, the payin, merchant and merchant application status vocabularies, the onboarding
 *   sequence, the webhook envelope, the signing key, the source addresses and the retry schedule.
 * - **The documented vocabularies**, encoded as frozen lists plus small mapping functions, so STEPs
 *   159 and 160 map against the documentation instead of inventing status strings. Every mapping
 *   returns `null` for a value the pages do not publish: an unknown status is answered as unknown,
 *   never as success, pending or failure.
 * - **The sandbox cycle** an acceptance and sub-merchant provider must complete before the adapter
 *   can be called verified, and the notes from this session, which say plainly that none of those
 *   five steps was executed because no Rainforest sandbox account or API key exists in this
 *   environment.
 * - **The verification record**: the checks, the notes, the calculated status and the store.
 *
 * ## The status rule, and why it is strict
 *
 * A record is `verified` only when at least one documentation check was verified, every documented
 * check passed, at least one sandbox note exists, every sandbox note passed, and the five steps of
 * the sandbox cycle are all present and passed. Anything less that still verified or passed
 * something is `partial`; a record that verified nothing and passed nothing is `not_verified`.
 * The point of the rule is that a documentation review alone can never read as a live verification:
 * this session's record is `partial`, and the gate proves it can never be anything else until
 * somebody with credentials runs the cycle.
 *
 * ## The security rules this record carries forward
 *
 * Rainforest signs every webhook delivery with an endpoint signing key, and the pages read point to
 * a "Verify webhooks" recipe for the scheme. That recipe is not readable in this environment, so
 * the scheme is recorded as an **open question** and STEP 160 must not trust a signature until it
 * is read: the recorded rule is that a delivery is applied only after verification, never before.
 * The same pages state that sending raw card or bank account data through the API requires explicit
 * Rainforest approval and that components exist so the platform's servers never touch that data;
 * this platform therefore never handles a raw card number, and no route may carry one.
 *
 * ## What this file is not
 *
 * It is not the Rainforest client, the key store, the payment adapter or the webhook receiver —
 * STEPs 158-160 build those, and they may only run after this record exists. It is not the
 * `lib/gateways/registry.ts` provider row (it already exists) and it is not a route, a job, a
 * migration or a table: the record here is the caller's to store, and the store shipped is a
 * reference implementation.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";

/* -------------------------------------------------------------------------------------------------
 * Environment, endpoints and documented limits
 * ---------------------------------------------------------------------------------------------- */

/** The provider key `lib/gateways/registry.ts` and `0029` use for this provider. */
export const RAINFOREST_PROVIDER_KEY = "rainforest";

/** The display name section 6 gives the provider. */
export const RAINFOREST_PROVIDER_NAME = "Rainforest";

/** The documented sandbox API base. */
export const RAINFOREST_SANDBOX_API_BASE = "https://api.sandbox.rainforestpay.com";

/** The documented production API base; moving environment is a base URL and key change only. */
export const RAINFOREST_PRODUCTION_API_BASE = "https://api.rainforestpay.com";

/** The documented path prefix every API call carries. */
export const RAINFOREST_API_PATH_PREFIX = "/v1";

/** The API version the pages read document as the current one. */
export const RAINFOREST_API_VERSION = "2024-10-16";

/** The documented request header that selects the API version. */
export const RAINFOREST_API_VERSION_HEADER = "Rainforest-Api-Version";

/** The documented sandbox API key prefix. */
export const RAINFOREST_SANDBOX_KEY_PREFIX = "sbx_apikey_";

/** The documented production API key prefix. */
export const RAINFOREST_PRODUCTION_KEY_PREFIX = "apikey_";

/** The documented sandbox id prefix: sandbox ids are distinguishable from production ones. */
export const RAINFOREST_SANDBOX_ID_PREFIX = "sbx_";

/** The documented webhook field names every delivery carries. */
export const RAINFOREST_WEBHOOK_ENVELOPE_FIELDS: readonly string[] = deepFreeze(["data", "event_type"]);

/** The documented acknowledgement window for a webhook delivery. */
export const RAINFOREST_WEBHOOK_ACK_TIMEOUT_SECONDS = 15;

/** The documented retry schedule, each entry the delay before the next attempt, in seconds. */
export const RAINFOREST_WEBHOOK_RETRY_DELAYS_SECONDS: readonly number[] = deepFreeze([
  0, 5, 300, 1_800, 7_200, 18_000, 36_000, 36_000,
]);

/** The documented retry window: the delays above add up to roughly 28 hours. */
export const RAINFOREST_WEBHOOK_RETRY_WINDOW_SECONDS = RAINFOREST_WEBHOOK_RETRY_DELAYS_SECONDS.reduce(
  (total, delay) => total + delay,
  0,
);

/** The documented number of consecutive failing days after which an endpoint is disabled. */
export const RAINFOREST_WEBHOOK_DISABLE_AFTER_FAILING_DAYS = 5;

/** The documented addresses every webhook is sent from. */
export const RAINFOREST_WEBHOOK_SOURCE_IPS: readonly string[] = deepFreeze([
  "44.228.126.217",
  "50.112.21.217",
  "52.24.126.164",
  "54.148.139.208",
]);

/** The longest provider text this file keeps. */
export const RAINFOREST_TEXT_MAXIMUM_LENGTH = 500;

/** The two environments Rainforest documents. */
export type RainforestEnvironment = "sandbox" | "production";

/** The documented API base of an environment. */
export function rainforestApiBaseFor(environment: RainforestEnvironment): string {
  return environment === "sandbox" ? RAINFOREST_SANDBOX_API_BASE : RAINFOREST_PRODUCTION_API_BASE;
}

/**
 * The absolute URL of a documented API path, or null when the path is not an API path.
 *
 * Only a path under the documented `/v1` prefix is accepted, and only characters that appear in
 * Rainforest's published paths (including the `{parameter}` braces) are allowed, so a caller cannot
 * turn a base URL into a request against somewhere else.
 */
export function rainforestApiUrlFor(environment: RainforestEnvironment, path: string): string | null {
  if (/^\/v1\/[A-Za-z0-9_{}/-]{1,200}$/u.test(path) === false) return null;
  return `${rainforestApiBaseFor(environment)}${path}`;
}

/** The documented API key prefix of an environment. */
export function rainforestApiKeyPrefixFor(environment: RainforestEnvironment): string {
  return environment === "sandbox" ? RAINFOREST_SANDBOX_KEY_PREFIX : RAINFOREST_PRODUCTION_KEY_PREFIX;
}

/**
 * The environment an API key belongs to, read from its documented prefix, or null when the value
 * carries neither prefix.
 *
 * The key itself is never returned, copied or stored: only the environment the prefix names.
 */
export function rainforestEnvironmentOfApiKey(apiKey: string): RainforestEnvironment | null {
  if (apiKey.startsWith(RAINFOREST_SANDBOX_KEY_PREFIX)) return "sandbox";
  if (apiKey.startsWith(RAINFOREST_PRODUCTION_KEY_PREFIX)) return "production";
  return null;
}

/** True when a value carries the documented shape of an API key, so it can be refused as text. */
export function isRainforestApiKeyShaped(value: string): boolean {
  return rainforestEnvironmentOfApiKey(value) !== null && value.length >= 20;
}

/** True when an id names the documented sandbox environment. */
export function isRainforestSandboxId(value: string): boolean {
  return value.startsWith(RAINFOREST_SANDBOX_ID_PREFIX) && value.length > RAINFOREST_SANDBOX_ID_PREFIX.length;
}

/* -------------------------------------------------------------------------------------------------
 * Documentation sources
 * ---------------------------------------------------------------------------------------------- */

/** One page read for this STEP: what it is, where it is, and what it established. */
export interface RainforestDocumentationSource {
  readonly topic: string;
  readonly url: string;
  readonly establishes: string;
}

/**
 * The pages read in the STEP 157 session, all on `docs.rainforestpay.com`.
 *
 * The list is the allowlist the validator enforces, so a later review cannot mark an unrelated page
 * as a Rainforest verification.
 */
export const RAINFOREST_DOCUMENTATION_SOURCES: readonly RainforestDocumentationSource[] = deepFreeze([
  {
    topic: "Rainforest overview",
    url: "https://docs.rainforestpay.com/docs/overview.md",
    establishes:
      "The platform, merchant and user model; that Rainforest performs KYC/KYB and answers approved, declined or manual review; and the payment vocabulary (payins, refunds, deposits).",
  },
  {
    topic: "API keys",
    url: "https://docs.rainforestpay.com/docs/api-keys.md",
    establishes:
      "That an API key is a long-lived server credential that must never reach the browser, and the permission model: resource:action permissions, Rainforest groups and constrained statements.",
  },
  {
    topic: "Authentication",
    url: "https://docs.rainforestpay.com/reference/authentication.md",
    establishes:
      "Bearer authentication, the apikey_ production and sbx_apikey_ sandbox key prefixes, and the documented sandbox call URL https://api.sandbox.rainforestpay.com/v1/.",
  },
  {
    topic: "Moving to production",
    url: "https://docs.rainforestpay.com/docs/moving-to-production.md",
    establishes:
      "The sandbox and production API base URLs, that sandbox and production data and ids are separate, that sandbox ids are prefixed sbx_, and that each environment needs its own API key.",
  },
  {
    topic: "API version upgrades",
    url: "https://docs.rainforestpay.com/docs/api-version-upgrades.md",
    establishes:
      "The Rainforest-Api-Version header, the current version 2024-10-16, the older versions, that webhook payloads follow the platform's minimum version, and that a request below it fails with 400.",
  },
  {
    topic: "Process payins via API",
    url: "https://docs.rainforestpay.com/docs/process-payins-via-api.md",
    establishes:
      "The two-call payin flow (payin config, then payin), POST /v1/payins in both environments, method_type CARD and ACH, the card and ACH field requirements, and that the direct API integration requires Rainforest approval.",
  },
  {
    topic: "Onboarding merchants via API",
    url: "https://docs.rainforestpay.com/docs/onboarding-merchants-via-api.md",
    establishes:
      "The API onboarding sequence (deposit method config, deposit method, merchant with deposit_routes, application update, submit), the required fields per merchant type, and validation_errors.",
  },
  {
    topic: "Understanding payins",
    url: "https://docs.rainforestpay.com/docs/understanding-payins.md",
    establishes:
      "The payin status table, card authorization in real time, ACH settlement without a real-time authorisation, T+1 and T+4 deposit timing, and that SUCCEEDED means the funds are available to deposit.",
  },
  {
    topic: "Payin webhooks",
    url: "https://docs.rainforestpay.com/docs/payin-webhooks.md",
    establishes:
      "The payin event names payin.{status}, the {data, event_type} payload, and the payin fields including idempotency_key, amount in minor units and the USD-only currency_code.",
  },
  {
    topic: "Merchant webhooks",
    url: "https://docs.rainforestpay.com/docs/merchant-webhooks.md",
    establishes:
      "The merchant event names merchant.{status}, the merchant status vocabulary, and that merchant.active is the notification that a merchant is ready to process payments.",
  },
  {
    topic: "Merchant application webhooks",
    url: "https://docs.rainforestpay.com/docs/merchant-application-webhooks.md",
    establishes:
      "The merchant_application.{status} event names and the application status vocabulary, including completed and declined as the two terminal underwriting answers.",
  },
  {
    topic: "Webhooks",
    url: "https://docs.rainforestpay.com/docs/webhooks-and-notifications.md",
    establishes:
      "Per-endpoint signing keys, the four source IPv4 addresses, the retry schedule with 2XX acknowledgements inside 15 seconds, message.attempt.exhausted, and the portal replay of events.",
  },
  {
    topic: "On-premises webhook integration",
    url: "https://docs.rainforestpay.com/docs/on-premises-webhook-integration.md",
    establishes:
      "That webhooks are at-least-once, that the resource id and event_type are the idempotency key, and that the signature must be validated at the final destination and the signing key kept secret.",
  },
  {
    topic: "Test accounts and cards",
    url: "https://docs.rainforestpay.com/docs/test-accounts-and-cards.md",
    establishes:
      "The sandbox test cards and ACH accounts: an approved card leaves the payin PROCESSING, an unlisted card fails with FAILED, and any valid sandbox routing and account number is approved.",
  },
  {
    topic: "Going live",
    url: "https://docs.rainforestpay.com/docs/going-live.md",
    establishes:
      "The three launch phases and that production access, a production merchant, a default billing profile and a residuals account are Rainforest-side prerequisites, not documentation reading.",
  },
]);

/** The host a Rainforest documentation check may name. */
export const RAINFOREST_DOCUMENTATION_HOSTS: readonly string[] = deepFreeze(["docs.rainforestpay.com"]);

/* -------------------------------------------------------------------------------------------------
 * The recorded rules
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the pages above state, recorded so that STEPs 158-160 code against the rules rather than
 * against a memory of the pages. Every rule here is a sentence those pages contain in substance;
 * nothing is inferred from another provider's documentation.
 */
export const RAINFOREST_RECORDED_RULES: readonly string[] = deepFreeze([
  "Rainforest is a payments-as-a-service platform: the platform embeds it, the platform's merchants are the Rainforest merchants, users pay those merchants, and Rainforest performs KYC/KYB and answers approved, declined or manual review.",
  "The API is bearer authenticated: the key is sent as Authorization: Bearer <api_key>, production keys are prefixed apikey_, sandbox keys are prefixed sbx_apikey_, and a key must never be sent to the browser or embedded in front-end code.",
  "The API bases are https://api.sandbox.rainforestpay.com and https://api.rainforestpay.com under the /v1 path prefix; sandbox and production hold separate data, separate keys and separate ids, and sandbox ids carry the sbx_ prefix.",
  "Every request may select the API version with the Rainforest-Api-Version header; the current version on the pages read is 2024-10-16, the older versions are 2023-12-01 and 2023-01-01, and a request for a version below the platform's minimum fails with 400.",
  "API key permissions are statements of resource:action permissions (create, update, read, delete) or a Rainforest group such as group#all or group#payment_component, optionally constrained by resource fields such as merchant_id, and multiple statements are OR'd together.",
  "A payin is created in two calls: POST /v1/payin_configs carries the merchant, the idempotency key, the amount and the currency, and POST /v1/payins processes the payin against that config with method_type CARD or ACH.",
  "Both the payin config and the payin require the merchant to be ACTIVE; amount is in minor units, and currency_code is documented as USD only.",
  "Sending raw card or bank account data through the API is a direct-to-API integration that requires Rainforest approval, and an ACH account_number is sent encrypted with RSA-OAEP-SHA256; the components exist so sensitive data never reaches the platform's servers, so this platform never accepts, logs or stores a raw card number.",
  "A card payin is authorised in real time and then sits in PROCESSING until it becomes SUCCEEDED, which the pages define as the funds becoming available to deposit: T+1 is the standard card timing and T+4 the standard ACH timing.",
  "An ACH payin has no real-time authorisation and can be returned after processing, so a processing ACH payin is not settled money and an ACH return creates a separate returning payment.",
  "Payin statuses are CREATED, PRESENTING, AUTHORIZED, PROCESSING, SUCCEEDED, FAILED, RETURNED, CANCELED and IN_REVIEW, and the payin event names are the same words in lower case as payin.{status}, for example payin.processing, payin.succeeded, payin.returned and payin.in_review.",
  "Merchant statuses are PENDING, ONBOARDING, ACTIVE, SUSPENDED, DEACTIVATED and CANCELED; merchant events are named merchant.{status}, and merchant.active is the notification that the merchant can process payments.",
  "Merchant application statuses are CREATED, IN_PROGRESS, PROCESSING, NEEDS_INFORMATION, IN_REVIEW, COMPLETED and DECLINED; merchant_application events are named merchant_application.{status}, and completed and declined are the two terminal underwriting answers.",
  "Onboarding a merchant through the API runs in order: create a deposit method config, create an ACH deposit method with account_holder_type BUSINESS, create the merchant with deposit_routes naming that deposit method, update the merchant application, then submit the application for approval; get merchant application returns validation_errors while the application cannot be submitted.",
  "The onboarding requirements depend on the merchant type: name, dba_name, legal_name, merchant_type, mcc, email, website, phone_number, average_ticket, high_ticket, average_monthly_volume, the address block, owner_1 and, except for an individual, tax_id are required for every documented type.",
  "Every webhook delivery is a { data, event_type } envelope where event_type is {resource}.{status} and data carries the same fields the resource's GET endpoint returns.",
  "Each webhook endpoint has its own signing key, shown beside the endpoint in the platform portal, and every delivery is signed with it; webhooks are sent from 44.228.126.217, 50.112.21.217, 52.24.126.164 and 54.148.139.208.",
  "A delivery is retried on the documented exponential schedule for approximately 28 hours (immediately, 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, 10 hours), any 2XX answered inside 15 seconds acknowledges it, an exhausted attempt is reported as message.attempt.exhausted, and an endpoint failing for 5 consecutive days is disabled.",
  "Webhooks are at-least-once and can be replayed from the portal, so a consumer must be idempotent on the resource id and event_type rather than on the delivery.",
]);

/** The questions the pages read in this session did not answer, kept so nobody assumes an answer. */
export const RAINFOREST_OPEN_QUESTIONS: readonly string[] = deepFreeze([
  "The webhook signature scheme is not readable: the Webhooks page points to a Verify webhooks recipe for how to validate the signature, and that recipe answers not found at both /recipes/verify-webhooks-1 and /recipes/verify-webhooks in this environment. The header names, the signed content, the digest algorithm and the replay tolerance must be read from that recipe before STEP 160 implements verification, and until then no Rainforest signature may be trusted.",
  "Whether this platform is approved for the direct-to-API integrations is not public: the payin and merchant onboarding API guides both say the feature requires Rainforest approval. STEPs 159 and 160 must not assume the approval, and the PCI rule holds either way: no raw card number and no raw bank account number reaches this platform's servers or database.",
  "The platform's configured minimum API version is a portal setting the documentation does not expose, so STEP 158 must send the Rainforest-Api-Version header explicitly instead of relying on a default.",
  "No Rainforest sandbox account or API key exists in this environment: the sandbox keys are created in the Sandbox Platform Portal, so no sandbox call was executed, no webhook endpoint was registered and nothing in this record is claimed as passed.",
]);

/* -------------------------------------------------------------------------------------------------
 * The documented vocabularies
 * ---------------------------------------------------------------------------------------------- */

/**
 * The payin statuses, in the order the pages introduce them.
 *
 * The list is the vocabulary; `rainforestPayinOutcomeOf` is the only place that decides what a
 * status means for the platform, and it answers `null` for anything not in this list.
 */
export const RAINFOREST_PAYIN_STATUSES: readonly string[] = deepFreeze([
  "CREATED",
  "PRESENTING",
  "AUTHORIZED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "RETURNED",
  "CANCELED",
  "IN_REVIEW",
]);

/** What a payin status means for the platform's money. */
export type RainforestPayinOutcome = "succeeded" | "pending" | "failed";

/**
 * Map a documented payin status to what it means.
 *
 * `SUCCEEDED` is the only success: the pages define it as the funds being available to deposit.
 * `FAILED`, `RETURNED` and `CANCELED` are failures — a returned ACH payin is money the network took
 * back. Every other documented status is pending, and any unrecognised value is `null`: a value the
 * pages do not publish is never guessed into success or failure.
 */
export function rainforestPayinOutcomeOf(status: string): RainforestPayinOutcome | null {
  const normalized = status.trim().toUpperCase();
  if (normalized === "SUCCEEDED") return "succeeded";
  if (normalized === "FAILED" || normalized === "RETURNED" || normalized === "CANCELED") return "failed";
  if (
    normalized === "CREATED" ||
    normalized === "PRESENTING" ||
    normalized === "AUTHORIZED" ||
    normalized === "PROCESSING" ||
    normalized === "IN_REVIEW"
  ) {
    return "pending";
  }
  return null;
}

/** The merchant statuses, in the order the pages introduce them. */
export const RAINFOREST_MERCHANT_STATUSES: readonly string[] = deepFreeze([
  "PENDING",
  "ONBOARDING",
  "ACTIVE",
  "SUSPENDED",
  "DEACTIVATED",
  "CANCELED",
]);

/** What a merchant status allows. */
export type RainforestMerchantBehaviour = "processes" | "waiting" | "blocked";

/**
 * Map a documented merchant status to what it allows.
 *
 * `ACTIVE` is the only status in which the pages say a merchant can process payments; `SUSPENDED`,
 * `DEACTIVATED` and `CANCELED` are blocked, and `PENDING` and `ONBOARDING` are still waiting. An
 * unrecognised value is `null`.
 */
export function rainforestMerchantBehaviourOf(status: string): RainforestMerchantBehaviour | null {
  const normalized = status.trim().toUpperCase();
  if (normalized === "ACTIVE") return "processes";
  if (normalized === "SUSPENDED" || normalized === "DEACTIVATED" || normalized === "CANCELED") return "blocked";
  if (normalized === "PENDING" || normalized === "ONBOARDING") return "waiting";
  return null;
}

/** The merchant application statuses, in the order the pages introduce them. */
export const RAINFOREST_APPLICATION_STATUSES: readonly string[] = deepFreeze([
  "CREATED",
  "IN_PROGRESS",
  "PROCESSING",
  "NEEDS_INFORMATION",
  "IN_REVIEW",
  "COMPLETED",
  "DECLINED",
]);

/** What an underwriting answer means. */
export type RainforestApplicationOutcome = "approved" | "pending" | "declined";

/**
 * Map a documented merchant application status to its underwriting answer.
 *
 * `COMPLETED` is the approval the pages describe and `DECLINED` the refusal; `NEEDS_INFORMATION` and
 * `IN_REVIEW` are still pending because the platform may still have to act. An unrecognised value
 * is `null`, so a provisioning intent is never closed on a status nobody documented.
 */
export function rainforestApplicationOutcomeOf(status: string): RainforestApplicationOutcome | null {
  const normalized = status.trim().toUpperCase();
  if (normalized === "COMPLETED") return "approved";
  if (normalized === "DECLINED") return "declined";
  if (
    normalized === "CREATED" ||
    normalized === "IN_PROGRESS" ||
    normalized === "PROCESSING" ||
    normalized === "NEEDS_INFORMATION" ||
    normalized === "IN_REVIEW"
  ) {
    return "pending";
  }
  return null;
}

/** The resource names the documented event types use. */
export const RAINFOREST_EVENT_RESOURCES: readonly string[] = deepFreeze([
  "ach_return",
  "chargeback",
  "deposit",
  "merchant",
  "merchant_application",
  "message",
  "payin",
  "payment_method",
  "payout",
  "payout_receiver",
  "refund",
]);

/** One parsed event type: the documented resource and the status segment that follows it. */
export interface RainforestEventType {
  readonly resource: string;
  readonly status: string;
  readonly eventType: string;
}

/**
 * Parse the documented `{resource}.{status}` event type.
 *
 * The status segment is what remains after the first dot, which is why `message.attempt.exhausted`
 * parses as the `message` resource with the `attempt.exhausted` status. A value whose resource is
 * not one the pages document is refused as `null`: an unknown resource is not an event to act on.
 */
export function parseRainforestEventType(eventType: string): RainforestEventType | null {
  const trimmed = eventType.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  const separator = trimmed.indexOf(".");
  if (separator < 2) return null;
  const resource = trimmed.slice(0, separator);
  const status = trimmed.slice(separator + 1);
  if (/^[a-z][a-z0-9_]{1,40}$/u.test(resource) === false) return null;
  if (/^[a-z0-9][a-z0-9_.]{1,60}$/u.test(status) === false) return null;
  if (RAINFOREST_EVENT_RESOURCES.includes(resource) === false) return null;
  return { resource, status, eventType: trimmed };
}

/**
 * Map a payin event type to what it means, or `null` when it is not a documented payin event or its
 * status segment is not a documented payin status.
 *
 * This is the mapping STEP 159's webhook consumer uses: the event name carries the status, so a
 * `payin.succeeded` delivery and a `GET /v1/payins/{payin_id}` answer that says `SUCCEEDED` agree.
 */
export function rainforestPayinOutcomeOfEvent(eventType: string): RainforestPayinOutcome | null {
  const parsed = parseRainforestEventType(eventType);
  if (parsed === null || parsed.resource !== "payin") return null;
  const status = parsed.status.toUpperCase();
  if (RAINFOREST_PAYIN_STATUSES.includes(status) === false) return null;
  return rainforestPayinOutcomeOf(status);
}

/* -------------------------------------------------------------------------------------------------
 * The sandbox cycle an acceptance and sub-merchant provider must complete
 * ---------------------------------------------------------------------------------------------- */

/** One step of the cycle, with the documented call it exercises. */
export interface RainforestSandboxStep {
  readonly id: string;
  readonly test: string;
  readonly method: "POST" | "GET";
  readonly path: string;
}

/** The five steps, in the order an acceptance and sub-merchant integration has to run them. */
export const RAINFOREST_SANDBOX_CYCLE: readonly RainforestSandboxStep[] = deepFreeze([
  {
    id: "api_key_auth",
    test: "Call the API with a sandbox key and read the key list back",
    method: "GET",
    path: "/v1/api_keys",
  },
  {
    id: "merchant_onboarding",
    test: "Create a sandbox merchant with its deposit method and application, submit the application and see the merchant become ACTIVE",
    method: "POST",
    path: "/v1/merchants",
  },
  {
    id: "payin_config",
    test: "Create a payin config naming the merchant, an idempotency key and an amount",
    method: "POST",
    path: "/v1/payin_configs",
  },
  {
    id: "payin_card",
    test: "Process a payin with a documented sandbox test card and read it through to SUCCEEDED",
    method: "POST",
    path: "/v1/payins",
  },
  {
    id: "webhook_signature",
    test: "Receive a payin webhook delivery, verify its signature with the endpoint signing key and apply it once",
    method: "POST",
    path: "/webhooks/rainforest",
  },
]);

/** The cycle step ids, in the documented order. */
export const RAINFOREST_SANDBOX_STEP_IDS: readonly string[] = deepFreeze(
  RAINFOREST_SANDBOX_CYCLE.map((step) => step.id),
);

/* -------------------------------------------------------------------------------------------------
 * Provider text
 * ---------------------------------------------------------------------------------------------- */

/**
 * Clean provider text before it is recorded.
 *
 * A provider message is a string the platform did not write: control characters are removed so the
 * text cannot rewrite a log line, angle brackets are removed so it can never be markup, whitespace
 * is collapsed, and the result is capped.
 */
export function sanitizeRainforestText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const source =
    value.length > 4 * RAINFOREST_TEXT_MAXIMUM_LENGTH ? value.slice(0, 4 * RAINFOREST_TEXT_MAXIMUM_LENGTH) : value;
  let cleaned = "";

  for (const character of source) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) {
      cleaned += " ";
      continue;
    }
    if (character === "<" || character === ">") continue;
    cleaned += character;
  }

  cleaned = cleaned.replace(/\s+/gu, " ").trim();
  return cleaned.length <= RAINFOREST_TEXT_MAXIMUM_LENGTH ? cleaned : cleaned.slice(0, RAINFOREST_TEXT_MAXIMUM_LENGTH);
}

/**
 * True when a text carries something that looks like an API key.
 *
 * A verification record is written by a human and stored for later reading; a key accidentally
 * pasted into a note would be a secret in a record, so validation refuses it rather than storing it.
 */
export function carriesRainforestApiKeyShapedText(value: string): boolean {
  return value
    .split(/\s+/u)
    .some((token) => isRainforestApiKeyShaped(token.replace(/[.,;:]$/u, "")));
}

/** The host of a documentation URL, or null when the URL is not an https URL with a host. */
export function rainforestDocumentationHostOf(url: string): string | null {
  if (url.length === 0 || url.length > 300) return null;
  const match = /^https:\/\/([A-Za-z0-9][A-Za-z0-9.-]{0,190})\/[!-~]{0,200}$/u.exec(url);
  return match === null ? null : (match[1] ?? null);
}

/** True when a URL belongs to Rainforest's own documentation host. */
export function isRainforestDocumentationUrl(url: string): boolean {
  const host = rainforestDocumentationHostOf(url);
  return host !== null && RAINFOREST_DOCUMENTATION_HOSTS.includes(host);
}

/* -------------------------------------------------------------------------------------------------
 * The record
 * ---------------------------------------------------------------------------------------------- */

/** One documentation check: one topic reviewed, where it was read, and whether it verified. */
export interface RainforestDocumentationCheck {
  readonly topic: string;
  readonly url: string;
  readonly verified: boolean;
  readonly notes: string | null;
}

/** One sandbox note: one cycle step and what actually happened when it was run. */
export interface RainforestSandboxNote {
  /** One of `RAINFOREST_SANDBOX_STEP_IDS`. */
  readonly test: string;
  readonly result: "pass" | "fail" | "not_tested";
  readonly details: string | null;
}

/** The calculated verification status. */
export type RainforestVerificationStatus = "verified" | "partial" | "not_verified";

/** One verification record for the Rainforest provider. */
export interface RainforestVerificationRecord {
  readonly id: string;
  readonly providerKey: typeof RAINFOREST_PROVIDER_KEY;
  readonly providerName: typeof RAINFOREST_PROVIDER_NAME;
  /** Sandbox or production: which environment the notes were taken in. */
  readonly environment: RainforestEnvironment;
  readonly documentationChecks: readonly RainforestDocumentationCheck[];
  readonly sandboxNotes: readonly RainforestSandboxNote[];
  readonly status: RainforestVerificationStatus;
  readonly verifiedAtEpochMs: number;
  readonly verifiedBy: string;
}

/** What the store reads and writes. The store is the caller's. */
export interface RainforestVerificationStore {
  insert(record: RainforestVerificationRecord): void;
  findById(id: string): RainforestVerificationRecord | null;
  findByProvider(): RainforestVerificationRecord[];
  findLatest(): RainforestVerificationRecord | null;
}

/** The in-memory store: a reference implementation keyed on record id. */
export class InMemoryRainforestVerificationStore implements RainforestVerificationStore {
  private readonly records = new Map<string, RainforestVerificationRecord>();

  insert(record: RainforestVerificationRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate verification record id");
    this.records.set(record.id, record);
  }

  findById(id: string): RainforestVerificationRecord | null {
    return this.records.get(id) ?? null;
  }

  findByProvider(): RainforestVerificationRecord[] {
    return [...this.records.values()];
  }

  findLatest(): RainforestVerificationRecord | null {
    const records = this.findByProvider();
    records.sort((left, right) => right.verifiedAtEpochMs - left.verifiedAtEpochMs);
    return records[0] ?? null;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Validation
 * ---------------------------------------------------------------------------------------------- */

const TOPIC_PATTERN = /^[^\u0000-\u001f\u007f<>]{3,120}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@:-]{2,119}$/u;

/** The reason a documentation check is invalid, or null when it is valid. */
export function validateRainforestDocumentationCheck(check: RainforestDocumentationCheck): string | null {
  if (TOPIC_PATTERN.test(check.topic.trim()) === false) return "a documentation check needs a topic of 3 to 120 characters";
  if (isRainforestDocumentationUrl(check.url) === false) {
    return "a documentation check must name a page on Rainforest's own documentation host";
  }
  if (check.notes !== null && carriesRainforestApiKeyShapedText(check.notes)) {
    return "a documentation note must not carry an API key";
  }
  if (check.notes !== null && sanitizeRainforestText(check.notes).length === 0 && check.notes.trim().length > 0) {
    return "a documentation note must carry readable text";
  }
  return null;
}

/** The reason a sandbox note is invalid, or null when it is valid. */
export function validateRainforestSandboxNote(note: RainforestSandboxNote): string | null {
  if (RAINFOREST_SANDBOX_STEP_IDS.includes(note.test) === false) {
    return "a sandbox note must name one step of the documented sandbox cycle";
  }
  if (note.result === "not_tested" && (note.details === null || sanitizeRainforestText(note.details).length === 0)) {
    return "a sandbox note for a step that was not run must state why";
  }
  if (note.result === "fail" && (note.details === null || sanitizeRainforestText(note.details).length === 0)) {
    return "a failed sandbox step must carry the provider's answer";
  }
  if (note.details !== null && carriesRainforestApiKeyShapedText(note.details)) {
    return "a sandbox note must not carry an API key";
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------------------------------- */

/**
 * Calculate the status of a record.
 *
 * `verified` requires a documentation check that verified, every check verified, at least one
 * sandbox note, every note passed, and every step of the documented cycle present and passed. The
 * last clause is what stops a documentation review from being recorded as a live verification.
 */
export function calculateRainforestStatus(
  checks: readonly RainforestDocumentationCheck[],
  notes: readonly RainforestSandboxNote[],
): RainforestVerificationStatus {
  const everyCheckVerified = checks.length > 0 && checks.every((check) => check.verified);
  const everyNotePassed = notes.length > 0 && notes.every((note) => note.result === "pass");
  const cycleComplete = RAINFOREST_SANDBOX_STEP_IDS.every((id) =>
    notes.some((note) => note.test === id && note.result === "pass"),
  );

  if (everyCheckVerified && everyNotePassed && cycleComplete) return "verified";

  const anyVerified = checks.some((check) => check.verified);
  const anyPassed = notes.some((note) => note.result === "pass");
  return anyVerified || anyPassed ? "partial" : "not_verified";
}

/* -------------------------------------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------------------------------------- */

/** The input to recording a verification. */
export interface RecordRainforestVerificationInput {
  readonly environment: RainforestEnvironment;
  readonly documentationChecks: readonly RainforestDocumentationCheck[];
  readonly sandboxNotes: readonly RainforestSandboxNote[];
  readonly verifiedBy: string;
}

/** The audit entry a recording hands to the caller's audit writer. */
export interface RainforestVerificationAuditEntry {
  readonly action: "provider_verification.recorded";
  readonly providerKey: typeof RAINFOREST_PROVIDER_KEY;
  readonly status: RainforestVerificationStatus;
  readonly environment: RainforestEnvironment;
  readonly verifiedBy: string;
  readonly occurredAtEpochMs: number;
}

/** The result of recording a verification. */
export type RecordRainforestVerificationResult =
  | { readonly status: "recorded"; readonly record: RainforestVerificationRecord }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Record one verification: validate every part, calculate the status, store it, hand the audit entry
 * to the caller.
 *
 * The first invalid part fails the whole recording, so a record never mixes a verified page with a
 * check that names a page outside Rainforest's documentation, and never carries a duplicate step.
 * The status is calculated here, never supplied by the caller, so it cannot be inflated.
 */
export function recordRainforestVerification(
  input: RecordRainforestVerificationInput,
  options: {
    readonly store: RainforestVerificationStore;
    readonly occurredAtEpochMs: number;
    readonly recordAudit?: (entry: RainforestVerificationAuditEntry) => void;
  },
): RecordRainforestVerificationResult {
  if (input.documentationChecks.length === 0) {
    return { status: "failed", reason: "a verification needs at least one documentation check" };
  }
  if (VERIFIER_PATTERN.test(input.verifiedBy.trim()) === false) {
    return { status: "failed", reason: "a verification needs the name of who verified it" };
  }

  for (const check of input.documentationChecks) {
    const reason = validateRainforestDocumentationCheck(check);
    if (reason !== null) return { status: "failed", reason };
  }
  for (const note of input.sandboxNotes) {
    const reason = validateRainforestSandboxNote(note);
    if (reason !== null) return { status: "failed", reason };
  }

  const seen = new Set<string>();
  for (const note of input.sandboxNotes) {
    if (seen.has(note.test)) return { status: "failed", reason: "a sandbox step may be recorded once per verification" };
    seen.add(note.test);
  }

  const record: RainforestVerificationRecord = {
    id: randomUUID(),
    providerKey: RAINFOREST_PROVIDER_KEY,
    providerName: RAINFOREST_PROVIDER_NAME,
    environment: input.environment,
    documentationChecks: deepFreeze(
      input.documentationChecks.map((check) => ({
        topic: check.topic.trim(),
        url: check.url,
        verified: check.verified,
        notes: check.notes === null ? null : sanitizeRainforestText(check.notes),
      })),
    ),
    sandboxNotes: deepFreeze(
      input.sandboxNotes.map((note) => ({
        test: note.test,
        result: note.result,
        details: note.details === null ? null : sanitizeRainforestText(note.details),
      })),
    ),
    status: calculateRainforestStatus(input.documentationChecks, input.sandboxNotes),
    verifiedAtEpochMs: options.occurredAtEpochMs,
    verifiedBy: input.verifiedBy.trim(),
  };

  options.store.insert(record);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_verification.recorded",
      providerKey: RAINFOREST_PROVIDER_KEY,
      status: record.status,
      environment: record.environment,
      verifiedBy: record.verifiedBy,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return { status: "recorded", record };
}

/* -------------------------------------------------------------------------------------------------
 * This session's review
 * ---------------------------------------------------------------------------------------------- */

/**
 * The review this STEP actually produced: every source read and verified as documentation, and every
 * sandbox step recorded as not run, with the reason, because no Rainforest sandbox account or API
 * key exists in this environment.
 *
 * The record these produce is `partial` by construction, which is the honest status: the
 * documentation was read and the platform's rules are recorded, and nothing was processed at
 * Rainforest.
 */
export const RAINFOREST_SESSION_CHECKS: readonly RainforestDocumentationCheck[] = deepFreeze(
  RAINFOREST_DOCUMENTATION_SOURCES.map((source) => ({
    topic: source.topic,
    url: source.url,
    verified: true,
    notes: source.establishes,
  })),
);

/** The sandbox notes of this session: five steps, none run, each with the reason stated. */
export const RAINFOREST_SESSION_SANDBOX_NOTES: readonly RainforestSandboxNote[] = deepFreeze(
  RAINFOREST_SANDBOX_CYCLE.map((step) => ({
    test: step.id,
    result: "not_tested" as const,
    details:
      "No Rainforest sandbox account or API key exists in this environment; the sandbox keys are created in the Rainforest Sandbox Platform Portal, so this step has not been run and must not be recorded as passed.",
  })),
);

/** The status this session's review yields; asserted by the gate so nobody can claim otherwise. */
export const RAINFOREST_SESSION_STATUS: RainforestVerificationStatus = calculateRainforestStatus(
  RAINFOREST_SESSION_CHECKS,
  RAINFOREST_SESSION_SANDBOX_NOTES,
);
