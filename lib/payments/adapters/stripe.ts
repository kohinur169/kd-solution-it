// path: lib/payments/adapters/stripe.ts

/**
 * Stripe Connect: the documentation record. Every URL below was read in the STEP 161 session, on
 * Stripe's own documentation host, and every rule in `STRIPE_RECORDED_RULES` is quoted or narrowed from
 * what those pages say. Nothing here talks to Stripe: this file is the recorded basis the adapter STEPs
 * 162-169 build on, and the verification record that says honestly what has and has not been run.
 *
 * ## What section 6 asks of this provider
 *
 * Section 6: "Stripe Connect: connected sub-merchant account creation, charges and payouts." The
 * provider must be able to create a connected account for a merchant, take a payment, and pay the
 * merchant out — under the same rules as every other adapter: one adapter file per provider, the
 * official documentation read in the coding session that writes the adapter, keys sealed with the
 * platform's encryption module, and no raw card number on this platform.
 *
 * ## What the pages changed about the obvious plan
 *
 * The legacy account types (Standard, Express, Custom) are **deprecated for new platforms**: Stripe's own
 * page tells an agent or LLM to use the Accounts v2 API with configurations, or Accounts v1 with
 * controller properties, and describes the type-based page only for platforms that already use it. That
 * is recorded here as a rule rather than a footnote, because it decides what STEPs 162-169 must call,
 * and getting it wrong would put a brand-new integration on a deprecated surface.
 *
 * The webhook signature scheme, unlike Rainforest's, is **fully published**: a `Stripe-Signature` header
 * carrying `t=<unix seconds>` and one or more `v1=<hex HMAC-SHA256>` entries, signed content
 * `<t>.<raw body>`, the endpoint's `whsec_` secret as the key, a constant-time comparison, and a five
 * minute tolerance whose `0` value disables the recency check entirely. It is implemented here in full,
 * because a recorded scheme is worth implementing and a guessed one is not (that distinction is what
 * STEP 160 had to draw for Rainforest).
 *
 * ## What this file is not
 *
 * It is not the adapter. It holds no transport, no key configuration, no account creation and no charge:
 * STEP 162 seals the keys and tests the connection, 163-166 build onboarding, charges and payouts, and
 * 167-169 record the sandbox cycle and the capability matrix. This file is the documentation record, the
 * vocabularies those steps map, the signature verifier they share, and the honest verdict.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";

/* -------------------------------------------------------------------------------------------------
 * The provider, its hosts and its documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The provider key the registry, the sealed credentials and the audit trail use. */
export const STRIPE_PROVIDER_KEY = "stripe";

/** The provider name a screen shows. */
export const STRIPE_PROVIDER_NAME = "Stripe";

/** The documented API base. Sandbox and live are not different hosts; they are different keys. */
export const STRIPE_API_BASE = "https://api.stripe.com";

/** The documented API version header. */
export const STRIPE_API_VERSION_HEADER = "Stripe-Version";

/**
 * The API version the documentation's own examples sent in this session.
 *
 * It is recorded so the next STEP knows which version the pages were written against, **not** so the
 * adapter can pin it blindly: Stripe versions the API per account and per request, and the v2 examples
 * here used a dated preview value. STEP 162 decides the pin and records why.
 */
export const STRIPE_OBSERVED_API_VERSION = "2026-10-28.preview";

/** The documented endpoints this record names. */
export const STRIPE_V1_ACCOUNTS_PATH = "/v1/accounts";
export const STRIPE_V2_ACCOUNTS_PATH = "/v2/core/accounts";
export const STRIPE_ACCOUNT_LINKS_PATH = "/v1/account_links";
export const STRIPE_PAYMENT_INTENTS_PATH = "/v1/payment_intents";
export const STRIPE_EVENTS_PATH = "/v1/events";

/** The documented id prefixes. */
export const STRIPE_ACCOUNT_ID_PREFIX = "acct_";
export const STRIPE_EVENT_ID_PREFIX = "evt_";
export const STRIPE_CUSTOMER_ID_PREFIX = "cus_";
export const STRIPE_PAYMENT_INTENT_ID_PREFIX = "pi_";
export const STRIPE_CHARGE_ID_PREFIX = "ch_";
export const STRIPE_OAUTH_CLIENT_ID_PREFIX = "ca_";

/** The documented API key prefixes: `pk_` publishable, `rk_` restricted, `sk_` secret. */
export const STRIPE_KEY_PREFIXES: readonly string[] = deepFreeze([
  "pk_test_",
  "pk_live_",
  "rk_test_",
  "rk_live_",
  "sk_test_",
  "sk_live_",
  "sk_org_",
]);

/** The documented webhook signing secret prefix. Signing secrets are not API keys. */
export const STRIPE_WEBHOOK_SECRET_PREFIX = "whsec_";

/** The documented maximum number of event destinations one account may register. */
export const STRIPE_MAXIMUM_WEBHOOK_ENDPOINTS = 16;

/** The documented retry window for a live delivery: three days of exponential backoff. */
export const STRIPE_WEBHOOK_RETRY_WINDOW_DAYS = 3;

/** The documented retry count for a sandbox delivery: three attempts over a few hours. */
export const STRIPE_SANDBOX_WEBHOOK_RETRY_ATTEMPTS = 3;

/** The documented manual resend windows, in days. */
export const STRIPE_WEBHOOK_RESEND_WINDOW_DAYS = deepFreeze({ dashboard: 15, cli: 30 });

/** The documented minimum TLS version a webhook endpoint must offer. */
export const STRIPE_MINIMUM_TLS_VERSION = "1.2";

/** The largest provider text this record keeps. */
export const STRIPE_TEXT_MAXIMUM_LENGTH = 500;

/** One environment, as the key prefixes describe it. */
export type StripeEnvironment = "sandbox" | "live";

/** The environment a key prefix names, or null when the value is not a documented key shape. */
export function stripeEnvironmentOfApiKey(apiKey: string): StripeEnvironment | null {
  if (apiKey.startsWith("sk_test_") || apiKey.startsWith("rk_test_") || apiKey.startsWith("pk_test_")) return "sandbox";
  if (apiKey.startsWith("sk_live_") || apiKey.startsWith("rk_live_") || apiKey.startsWith("pk_live_")) return "live";
  return null;
}

/** True for a documented secret or restricted key: the two shapes a server may hold. */
export function isStripeServerKeyShaped(value: string): boolean {
  if (value.startsWith("pk_test_") || value.startsWith("pk_live_")) return false;
  return /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,200}$/u.test(value) || /^sk_org_[A-Za-z0-9]{8,200}$/u.test(value);
}

/** True for a documented publishable key: the only key shape a browser may hold. */
export function isStripePublishableKeyShaped(value: string): boolean {
  return /^pk_(?:test|live)_[A-Za-z0-9]{8,200}$/u.test(value);
}

/** True for a documented webhook signing secret. */
export function isStripeWebhookSecretShaped(value: string): boolean {
  return /^whsec_[A-Za-z0-9]{8,200}$/u.test(value);
}

/** A documented account id. */
export const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{8,64}$/u;

/** A documented event id. */
export const STRIPE_EVENT_ID_PATTERN = /^evt_[A-Za-z0-9]{8,64}$/u;

/* -------------------------------------------------------------------------------------------------
 * The documentation sources read in the STEP 161 session
 * ---------------------------------------------------------------------------------------------- */

/** One page read, where it lives, and what it establishes for this platform. */
export interface StripeDocumentationSource {
  readonly topic: string;
  readonly url: string;
  readonly establishes: string;
}

/**
 * The pages read in the STEP 161 session (2026-11-06), on `docs.stripe.com` only.
 *
 * Each entry is a page that was actually fetched in this session, not a page remembered from training:
 * the Connect overview, the account model (v2 and the legacy type page), capabilities and requirements,
 * charge types, keys, webhooks and their signature scheme, event handling for account updates, and the
 * Connect testing guide.
 */
export const STRIPE_DOCUMENTATION_SOURCES: readonly StripeDocumentationSource[] = deepFreeze([
  {
    topic: "How Connect works",
    url: "https://docs.stripe.com/connect/how-connect-works",
    establishes:
      "Connect is Stripe's multiparty product: connected accounts are onboarded and verified, payments and payouts run through them, and the platform uses its own API keys to act on their behalf.",
  },
  {
    topic: "Accounts v2: configurations represent connected accounts",
    url: "https://docs.stripe.com/connect/accounts-v2",
    establishes:
      "Accounts v2 (`POST /v2/core/accounts`) is the recommended surface: configurations (`merchant`, `customer`, `recipient`) carry capabilities, the merchant configuration includes `card_payments` and `stripe_balance.payouts`, the recipient configuration includes `stripe_balance.stripe_transfers`, and `defaults.responsibilities` names the fees and losses collector.",
  },
  {
    topic: "Connected account types (legacy, deprecated for new platforms)",
    url: "https://docs.stripe.com/connect/accounts",
    establishes:
      "Standard, Express and Custom are legacy account types; the page tells new platforms to use Accounts v2 or Accounts v1 with controller properties, and warns that an account's type cannot be changed after creation.",
  },
  {
    topic: "Account capabilities",
    url: "https://docs.stripe.com/connect/account-capabilities",
    establishes:
      "A capability must be `active` before the connected account can perform the actions it names; `card_payments` requires requesting both `card_payments` and `transfers`; requesting more capabilities means verifying more information; some capabilities cannot be unrequested.",
  },
  {
    topic: "Charge types",
    url: "https://docs.stripe.com/connect/charges",
    establishes:
      "Direct charges put the payment in the connected account's balance and let the platform take an application fee; destination charges put it in the platform's balance and transfer a portion to the connected account; separate charges and transfers exist for multi-seller carts; the charge type decides who is merchant of record, whose descriptor appears, and whose balance absorbs refunds and chargebacks.",
  },
  {
    topic: "API keys and sandbox versus live mode",
    url: "https://docs.stripe.com/keys",
    establishes:
      "Secret keys are `sk_`, restricted keys `rk_`, publishable keys `pk_`, each with a `test` or `live` segment; sandbox and live are separate modes with separate keys and separate objects; webhook signing secrets are separate per endpoint and are not API keys.",
  },
  {
    topic: "Webhook endpoints and delivery behaviour",
    url: "https://docs.stripe.com/webhooks",
    establishes:
      "Events are delivered to registered HTTPS endpoints, at most 16 per account; a `2xx` must be returned quickly; live deliveries retry for up to three days and sandbox deliveries three times; delivery order is not guaranteed, so duplicates are tracked by event id; redirects, `4xx` and `5xx` are failures and TLS 1.2 or higher is required.",
  },
  {
    topic: "Webhook signature verification",
    url: "https://docs.stripe.com/webhooks#verify-manually",
    establishes:
      "The `Stripe-Signature` header carries `t=<unix seconds>` and one or more `v1=<hex HMAC-SHA256>` entries; the signed payload is `<t>.<raw body>`; the key is the endpoint's `whsec_` secret; schemes other than `v1` must be ignored; the comparison must be constant time; the documented default tolerance is five minutes and a tolerance of 0 disables the recency check.",
  },
  {
    topic: "Account updates, requirements and future requirements",
    url: "https://docs.stripe.com/connect/handle-verification-updates",
    establishes:
      "`account.updated` is the event to listen to for account status and requirement changes; `requirements` and `future_requirements` carry `currently_due`, `eventually_due`, `past_due`, `pending_verification`, `disabled_reason`, `current_deadline` and an `errors` array of `{code, requirement, reason}`; `controller.requirement_collection` decides whether Stripe or the platform collects requirements.",
  },
  {
    topic: "Testing Connect",
    url: "https://docs.stripe.com/connect/testing",
    establishes:
      "Sandboxes simulate live mode with special tokens: `000-000` is the SMS code, the test OAuth client id is published, and documented date-of-birth, address, id-number and file tokens drive verification outcomes; a `_high_risk` company name forces the high-risk path; sandboxes do not always enforce capabilities.",
  },
  {
    topic: "API v1 and v2 request shapes for accounts",
    url: "https://docs.stripe.com/api/accounts/create",
    establishes:
      "Accounts v1 creates an account with `type` or with `controller` properties, a `country`, a `business_type` and requested `capabilities`, and answers an `acct_` id; the Accounts v2 call takes nested `identity`, `configuration` and `defaults` objects and returns properties only when they are named in `include`.",
  },
]);

/** The documentation hosts a source may live on. */
export const STRIPE_DOCUMENTATION_HOSTS: readonly string[] = deepFreeze(["docs.stripe.com"]);

/* -------------------------------------------------------------------------------------------------
 * The rules this session recorded
 * ---------------------------------------------------------------------------------------------- */

/**
 * What the pages above established, in the platform's own words.
 *
 * These are the constraints the adapter STEPs 162-169 must obey. They are deliberately short and
 * checkable, because a rule that cannot be checked is a slogan.
 */
export const STRIPE_RECORDED_RULES: readonly string[] = deepFreeze([
  "New connected accounts use Accounts v2 configurations, or Accounts v1 with controller properties; the Standard, Express and Custom types are legacy and an account's type cannot be changed after creation.",
  "A connected account may accept payments only while its `card_payments` capability is `active`, and `card_payments` is requested together with `transfers`.",
  "The platform's charge type decides who is merchant of record, whose statement descriptor the customer sees and whose balance absorbs refunds and chargebacks; the platform's model (merchant accepts, platform pays out) is a destination-charge or separate-charges-and-transfers model, and the choice must be recorded in the adapter STEP that implements it.",
  "Sandbox and live mode are separate: separate keys, separate objects, and a sandbox key can never read or change a live object.",
  "A secret key is `sk_`, a restricted key `rk_`, a publishable key `pk_`, each with a `test` or `live` segment; only the publishable key may reach a browser, and only a server key may call the API.",
  "Every webhook delivery is signed: the `Stripe-Signature` header carries `t` and one or more `v1` signatures over `<t>.<raw body>` with the endpoint's `whsec_` secret, schemes other than `v1` are ignored, and the comparison is constant time.",
  "A signature is only believed when the timestamp is within the tolerance (five minutes by default, and never `0`, which disables the check), so a captured delivery cannot be replayed later.",
  "Delivery order is not guaranteed and a delivery may be retried for up to three days, so application must be idempotent on the event id, and a duplicate must still answer `2xx` to stop further retries.",
  "A webhook endpoint must answer `2xx` quickly, must be HTTPS with TLS 1.2 or higher, and must not redirect; redirects, `4xx` and `5xx` are delivery failures.",
  "Account and capability requirements are read from `requirements` and `future_requirements` (`currently_due`, `eventually_due`, `past_due`, `pending_verification`, `disabled_reason`, `current_deadline`, `errors`), and `account.updated` is the event that reports them changing.",
  "When `controller.requirement_collection` is `stripe`, Stripe collects requirement changes itself; when it is `application`, the platform must collect them, including the ones that arrive later in `future_requirements`.",
  "A sandbox does not always enforce capabilities, so a sandbox payment succeeding is not proof that the capability gate works in live mode; a live run is the only proof of that.",
  "No raw card number may reach this platform: card data is collected by Stripe's own interfaces and the platform handles only ids, amounts and statuses — the same rule section 6 applies to NMI and Rainforest.",
  "Stripe versions the API per account and per request, and the v2 examples in this session sent a dated preview version; the adapter must pin a version explicitly and record why rather than inherit whichever version the account happens to default to.",
  "The API has two families in play: `/v1/...` for the legacy and most payment resources, and `/v2/core/...` for Accounts v2 and event destinations; a v2 `Account` id may be passed to a v1 endpoint, which answers a v1-shaped object.",
]);

/** The questions this session could not answer from the pages, recorded rather than assumed. */
export const STRIPE_OPEN_QUESTIONS: readonly string[] = deepFreeze([
  "Which account surface the platform will use in code — Accounts v2 configurations, or Accounts v1 with controller properties — must be decided in STEP 162 with the platform's payout model in hand; this record names both because the pages recommend both depending on the integration.",
  "The API version to pin is not chosen here: the v2 examples carried a dated preview value, and the account's default version is not visible from the documentation. STEP 162 must choose and record it.",
  "The exact set of event types the platform subscribes to is decided when the receiving route exists, because the documentation recommends subscribing only to the events the integration needs.",
  "Stripe's webhook source IP list is published on a separate page (`docs.stripe.com/ips`) that was not read in this session, so IP allowlisting is recorded as available but unverified here.",
  "No Stripe account, API key or webhook secret exists in this environment, so no sandbox step has been run and no signature has been verified against a real delivery.",
]);

/* -------------------------------------------------------------------------------------------------
 * Vocabularies and their meanings
 * ---------------------------------------------------------------------------------------------- */

/** The documented capability statuses. */
export const STRIPE_CAPABILITY_STATUSES: readonly string[] = deepFreeze([
  "active",
  "inactive",
  "pending",
  "unrequested",
]);

/**
 * Whether a capability status lets the connected account perform the capability's actions.
 *
 * Only `active` does: the page says a capability "must be active for a connected account to perform
 * actions associated with that capability", and the other three are waiting, refused or never asked
 * for. An unrecognised value is null, so a new Stripe status can never be read as permission.
 */
export function stripeCapabilityAllowsActions(status: string): boolean | null {
  const normalized = status.trim().toLowerCase();
  if (normalized === "active") return true;
  if (normalized === "inactive" || normalized === "pending" || normalized === "unrequested") return false;
  return null;
}

/** The fields of a documented `requirements` or `future_requirements` hash. */
export const STRIPE_REQUIREMENT_FIELDS: readonly string[] = deepFreeze([
  "currently_due",
  "eventually_due",
  "past_due",
  "pending_verification",
  "disabled_reason",
  "current_deadline",
  "errors",
]);

/** What a requirements hash says about an account, in the platform's vocabulary. */
export type StripeOnboardingState = "ready" | "waiting" | "blocked";

/** The requirements hash, as far as this record reads it. */
export interface StripeRequirementSummary {
  readonly currentlyDue: number;
  readonly pastDue: number;
  readonly pendingVerification: number;
  readonly disabledReason: string | null;
}

/**
 * Read a requirements hash as an onboarding state.
 *
 * `blocked` when anything is `past_due` or a `disabled_reason` is set: the page says a disabled
 * capability carries a `disabled_reason` that decides what action is needed, and past-due requirements
 * are the ones that disable capabilities. `waiting` when something is due or in review. `ready` only
 * when all three counts are zero and no reason is set.
 */
export function stripeOnboardingStateOf(summary: StripeRequirementSummary): StripeOnboardingState {
  if (summary.pastDue > 0 || summary.disabledReason !== null) return "blocked";
  if (summary.currentlyDue > 0 || summary.pendingVerification > 0) return "waiting";
  return "ready";
}

/** The documented charge types. */
export const STRIPE_CHARGE_TYPES: readonly string[] = deepFreeze([
  "direct",
  "destination",
  "separate_charges_and_transfers",
]);

/** What a charge type means for the platform, as the charge-types page describes it. */
export interface StripeChargeTypeFacts {
  readonly type: string;
  /** The account whose balance the payment lands in first. */
  readonly fundsLandIn: "connected_account" | "platform";
  /** Who is merchant of record for the customer's statement. */
  readonly merchantOfRecord: "connected_account" | "platform";
  /** Whose balance absorbs refunds and chargebacks. */
  readonly lossesFallOn: "connected_account" | "platform";
  /** True when the platform takes its fee with an application fee on the same charge. */
  readonly applicationFee: boolean;
  readonly note: string;
}

/** The three documented charge types, each with what the page says it decides. */
export const STRIPE_CHARGE_TYPE_FACTS: readonly StripeChargeTypeFacts[] = deepFreeze([
  {
    type: "direct",
    fundsLandIn: "connected_account",
    merchantOfRecord: "connected_account",
    lossesFallOn: "connected_account",
    applicationFee: true,
    note: "The charge is created on the connected account, its descriptor appears on the customer's statement, its balance absorbs refunds and chargebacks, and the platform may take an application fee.",
  },
  {
    type: "destination",
    fundsLandIn: "platform",
    merchantOfRecord: "platform",
    lossesFallOn: "platform",
    applicationFee: true,
    note: "The charge is created on the platform, a portion transfers to the connected account, Stripe debits the platform's fees, and the platform's descriptor appears on the customer's statement.",
  },
  {
    type: "separate_charges_and_transfers",
    fundsLandIn: "platform",
    merchantOfRecord: "platform",
    lossesFallOn: "platform",
    applicationFee: false,
    note: "Charges and transfers are separate calls, so one payment can fund several connected accounts; the platform is responsible for negative balances.",
  },
]);

/** The facts of one documented charge type, or null for a value the page does not name. */
export function stripeChargeTypeFactsOf(type: string): StripeChargeTypeFacts | null {
  return STRIPE_CHARGE_TYPE_FACTS.find((facts) => facts.type === type.trim().toLowerCase()) ?? null;
}

/** The event types this session saw named in the documentation. */
export const STRIPE_RECORDED_EVENT_TYPES: readonly string[] = deepFreeze([
  "account.updated",
  "charge.created",
  "customer.created",
  "invoice.paid",
  "payment_intent.payment_failed",
  "payment_intent.succeeded",
  "payment_method.attached",
]);

/** The event resources this record knows. */
export const STRIPE_EVENT_RESOURCES: readonly string[] = deepFreeze([
  "account",
  "charge",
  "customer",
  "invoice",
  "payment_intent",
  "payment_method",
]);

/** One parsed event type: the documented resource and the action after the first dot. */
export interface StripeEventType {
  readonly resource: string;
  readonly action: string;
  readonly eventType: string;
}

/**
 * Parse a documented `{resource}.{action}` event type.
 *
 * The action may itself contain dots, and a resource this record does not know is refused as null: an
 * unrecorded resource is not an event the adapter may act on. `account.updated` is the one event the
 * pages tell the platform to listen to for account and requirement changes.
 */
export function parseStripeEventType(eventType: string): StripeEventType | null {
  const trimmed = eventType.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  const separator = trimmed.indexOf(".");
  if (separator < 2) return null;
  const resource = trimmed.slice(0, separator);
  const action = trimmed.slice(separator + 1);
  if (/^[a-z][a-z0-9_]{1,40}$/u.test(resource) === false) return null;
  if (/^[a-z0-9][a-z0-9_.]{1,60}$/u.test(action) === false) return null;
  if (STRIPE_EVENT_RESOURCES.includes(resource) === false) return null;
  return { resource, action, eventType: trimmed };
}

/* -------------------------------------------------------------------------------------------------
 * The documented webhook signature
 * ---------------------------------------------------------------------------------------------- */

/** The documented signature header. */
export const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";

/** The documented default tolerance, in seconds. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The only signature scheme the documentation says to believe. */
export const STRIPE_SIGNATURE_SCHEME = "v1";

/** More signatures than this in one header are not read. */
export const STRIPE_MAXIMUM_SIGNATURES = 5;

/** One parsed `Stripe-Signature` header. */
export interface StripeSignatureHeader {
  readonly timestamp: number;
  /** The `v1` signatures, in the order they appeared. `v0` and future schemes are dropped. */
  readonly signatures: readonly string[];
}

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Parse the documented `Stripe-Signature` header.
 *
 * The header is a comma separated list of `prefix=value` pairs. The `t` pair is the timestamp in Unix
 * seconds and each `v1` pair is a lowercase hex HMAC-SHA256; every other scheme — including the `v0`
 * signature Stripe adds for test events — is dropped, because the page says to ignore schemes that are
 * not `v1` to prevent downgrade attacks. A header with no usable timestamp, no `v1` signature or a
 * malformed value is refused as null rather than guessed at.
 */
export function parseStripeSignatureHeader(header: string | null | undefined): StripeSignatureHeader | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) return null;

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const element of trimmed.split(",")) {
    const separator = element.indexOf("=");
    if (separator <= 0) continue;
    const prefix = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (prefix.length === 0 || value.length === 0) continue;
    if (prefix === "t") {
      if (timestamp !== null) return null;
      if (/^[0-9]{1,12}$/u.test(value) === false) return null;
      timestamp = Number(value);
      continue;
    }
    if (prefix === STRIPE_SIGNATURE_SCHEME) {
      if (SIGNATURE_PATTERN.test(value) === false) return null;
      if (signatures.length < STRIPE_MAXIMUM_SIGNATURES) signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** The documented signed content: the timestamp, a dot, and the raw body. */
export function stripeSignedPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** The options of the verifier. */
export interface StripeSignatureOptions {
  /** The endpoint's `whsec_` secret. */
  readonly secret: string;
  /** How far the delivery timestamp may be from now, in seconds. Never 0, which disables the check. */
  readonly toleranceSeconds?: number;
  /** The clock, in Unix seconds. Defaults to the current time. */
  readonly nowSeconds?: () => number;
  /** The largest body this verifier reads. */
  readonly maximumBodyBytes?: number;
}

/** The verdict of a verification. No detail carries the secret, the signature or the body. */
export type StripeSignatureVerdict =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: string };

/** The largest body the verifier reads by default. */
export const STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES = 1_048_576;

/**
 * Verify one delivery, exactly as the documentation describes.
 *
 * The steps are the page's four: split the header, build `<t>.<raw body>`, HMAC-SHA256 it with the
 * `whsec_` secret, and compare in constant time — then check the timestamp against the tolerance, which
 * is what stops a captured delivery from being replayed. The raw body is used, never a re-serialised
 * payload, because any re-encoding changes the bytes that were signed.
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  options: StripeSignatureOptions,
): StripeSignatureVerdict {
  const secret = options.secret.trim();
  if (secret.length < 8) return { ok: false, reason: "the webhook signing secret is missing or unusable" };
  if (rawBody.length === 0) return { ok: false, reason: "the delivery carries no body" };
  if (rawBody.length > (options.maximumBodyBytes ?? STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES)) {
    return { ok: false, reason: "the delivery is larger than this receiver accepts" };
  }

  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (parsed === null) return { ok: false, reason: "the signature header carries no usable v1 signature" };

  const expected = createHmac("sha256", secret).update(stripeSignedPayload(parsed.timestamp, rawBody), "utf8").digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  let matched = false;
  for (const candidate of parsed.signatures) {
    const candidateBytes = Buffer.from(candidate, "utf8");
    if (candidateBytes.length !== expectedBytes.length) continue;
    if (timingSafeEqual(expectedBytes, candidateBytes)) matched = true;
  }
  if (matched === false) return { ok: false, reason: "the signature does not match" };

  const tolerance = options.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (tolerance <= 0) return { ok: false, reason: "the tolerance must be greater than zero" };
  const now = options.nowSeconds === undefined ? Math.floor(Date.now() / 1_000) : options.nowSeconds();
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "the delivery timestamp is outside the tolerance" };
  }

  return { ok: true, timestamp: parsed.timestamp };
}

/* -------------------------------------------------------------------------------------------------
 * The sandbox cycle an acceptance and sub-merchant provider must complete
 * ---------------------------------------------------------------------------------------------- */

/** One step of the cycle, with the documented call it exercises. */
export interface StripeSandboxStep {
  readonly id: string;
  readonly test: string;
  readonly method: "POST" | "GET";
  readonly path: string;
}

/**
 * The five steps a Stripe Connect integration has to run before it can be called verified.
 *
 * They follow the pages: authenticate a sandbox key, create a connected account with the capabilities
 * the platform needs, hand the merchant a hosted onboarding link, take a test payment, and receive one
 * signed webhook.
 */
export const STRIPE_SANDBOX_CYCLE: readonly StripeSandboxStep[] = deepFreeze([
  {
    id: "key_auth",
    test: "Call the API with a sandbox secret key and read the accounts back",
    method: "GET",
    path: STRIPE_V1_ACCOUNTS_PATH,
  },
  {
    id: "connected_account_create",
    test: "Create a connected account with the card_payments and transfers capabilities and read its acct_ id",
    method: "POST",
    path: STRIPE_V2_ACCOUNTS_PATH,
  },
  {
    id: "hosted_onboarding",
    test: "Create an account link, complete the merchant's onboarding and see the capabilities become active",
    method: "POST",
    path: STRIPE_ACCOUNT_LINKS_PATH,
  },
  {
    id: "test_payment",
    test: "Take a test payment on the connected account with a documented test card and read the PaymentIntent to succeeded",
    method: "POST",
    path: STRIPE_PAYMENT_INTENTS_PATH,
  },
  {
    id: "signed_webhook",
    test: "Receive one signed account.updated delivery and verify its Stripe-Signature before applying it",
    method: "POST",
    path: "/webhooks/stripe",
  },
]);

/** The ids of the cycle steps, for validation and for a screen. */
export const STRIPE_SANDBOX_STEP_IDS: readonly string[] = deepFreeze(
  STRIPE_SANDBOX_CYCLE.map((step) => step.id),
);

/* -------------------------------------------------------------------------------------------------
 * Text handling
 * ---------------------------------------------------------------------------------------------- */

/**
 * Strip anything that is not printable text from provider-supplied text.
 *
 * The same rule the other adapters use: markup, control characters and the emoji plane are dropped, the
 * result is trimmed and capped, and the caller's text is never interpreted. A refusal message from a
 * payment provider is text to show, not markup to render.
 */
export function sanitizeStripeText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const stripped = value.replace(/<[^>]*>/gu, "");
  const printable = stripped.replace(/[^\P{C}\n\t]/gu, "");
  return printable.trim().slice(0, STRIPE_TEXT_MAXIMUM_LENGTH);
}

/** True when a string carries something shaped like a Stripe key or signing secret. */
export function carriesStripeKeyShapedText(value: string): boolean {
  return /(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{8,}|sk_org_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/u.test(value);
}

/** The documentation host of a URL, or null when the URL is not shaped like one. */
export function stripeDocumentationHostOf(url: string): string | null {
  if (url.length === 0 || url.length > 300) return null;
  const match = /^https:\/\/([A-Za-z0-9][A-Za-z0-9.-]{0,190})\/[!-~]{0,200}$/u.exec(url);
  return match === null ? null : (match[1] ?? null);
}

/** True when a URL belongs to Stripe's own documentation host. */
export function isStripeDocumentationUrl(url: string): boolean {
  const host = stripeDocumentationHostOf(url);
  return host !== null && STRIPE_DOCUMENTATION_HOSTS.includes(host);
}

/* -------------------------------------------------------------------------------------------------
 * The record
 * ---------------------------------------------------------------------------------------------- */

/** One documentation check: one topic reviewed, where it was read, and whether it verified. */
export interface StripeDocumentationCheck {
  readonly topic: string;
  readonly url: string;
  readonly verified: boolean;
  readonly notes: string | null;
}

/** One sandbox note: one cycle step and what actually happened when it was run. */
export interface StripeSandboxNote {
  /** One of `STRIPE_SANDBOX_STEP_IDS`. */
  readonly test: string;
  readonly result: "pass" | "fail" | "not_tested";
  readonly details: string | null;
}

/** The calculated verification status. */
export type StripeVerificationStatus = "verified" | "partial" | "not_verified";

/** One verification record for the Stripe provider. */
export interface StripeVerificationRecord {
  readonly id: string;
  readonly providerKey: typeof STRIPE_PROVIDER_KEY;
  readonly providerName: typeof STRIPE_PROVIDER_NAME;
  /** Sandbox or live: which mode the notes were taken in. */
  readonly environment: StripeEnvironment;
  readonly documentationChecks: readonly StripeDocumentationCheck[];
  readonly sandboxNotes: readonly StripeSandboxNote[];
  readonly status: StripeVerificationStatus;
  readonly verifiedAtEpochMs: number;
  readonly verifiedBy: string;
}

/** What the store reads and writes. The store is the caller's. */
export interface StripeVerificationStore {
  insert(record: StripeVerificationRecord): void;
  findById(id: string): StripeVerificationRecord | null;
  findByProvider(): StripeVerificationRecord[];
  findLatest(): StripeVerificationRecord | null;
}

/** The in-memory store: a reference implementation keyed on record id. */
export class InMemoryStripeVerificationStore implements StripeVerificationStore {
  private readonly records = new Map<string, StripeVerificationRecord>();

  insert(record: StripeVerificationRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate verification record id");
    this.records.set(record.id, record);
  }

  findById(id: string): StripeVerificationRecord | null {
    return this.records.get(id) ?? null;
  }

  findByProvider(): StripeVerificationRecord[] {
    return [...this.records.values()];
  }

  findLatest(): StripeVerificationRecord | null {
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
export function validateStripeDocumentationCheck(check: StripeDocumentationCheck): string | null {
  if (TOPIC_PATTERN.test(check.topic.trim()) === false) return "a documentation check needs a topic of 3 to 120 characters";
  if (isStripeDocumentationUrl(check.url) === false) {
    return "a documentation check must name a page on Stripe's own documentation host";
  }
  if (check.notes !== null && carriesStripeKeyShapedText(check.notes)) {
    return "a documentation note must not carry an API key or a signing secret";
  }
  if (check.notes !== null && sanitizeStripeText(check.notes).length === 0 && check.notes.trim().length > 0) {
    return "a documentation note must carry readable text";
  }
  return null;
}

/** The reason a sandbox note is invalid, or null when it is valid. */
export function validateStripeSandboxNote(note: StripeSandboxNote): string | null {
  if (STRIPE_SANDBOX_STEP_IDS.includes(note.test) === false) {
    return "a sandbox note must name one of the documented cycle steps";
  }
  if (note.result !== "pass" && note.result !== "fail" && note.result !== "not_tested") {
    return "a sandbox note result must be pass, fail or not_tested";
  }
  if (note.result !== "not_tested" && (note.details === null || note.details.trim().length === 0)) {
    return "a sandbox note that was run must say what happened";
  }
  if (note.details !== null && carriesStripeKeyShapedText(note.details)) {
    return "a sandbox note must not carry an API key or a signing secret";
  }
  if (note.details !== null && note.details.length > STRIPE_TEXT_MAXIMUM_LENGTH) {
    return "a sandbox note is too long";
  }
  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Calculating the status
 * ---------------------------------------------------------------------------------------------- */

/**
 * Calculate what the evidence supports: `verified`, `partial` or `not_verified`.
 *
 * `verified` requires every documentation check to have verified **and** every documented cycle step to
 * carry a `pass`. That last clause is what stops a documentation review from being recorded as a live
 * verification — the exact mistake STEP 157 built the same guard against for Rainforest.
 */
export function calculateStripeStatus(
  checks: readonly StripeDocumentationCheck[],
  notes: readonly StripeSandboxNote[],
): StripeVerificationStatus {
  const everyCheckVerified = checks.length > 0 && checks.every((check) => check.verified);
  const everyNotePassed = notes.length > 0 && notes.every((note) => note.result === "pass");
  const cycleComplete = STRIPE_SANDBOX_STEP_IDS.every((id) =>
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
export interface RecordStripeVerificationInput {
  readonly environment: StripeEnvironment;
  readonly documentationChecks: readonly StripeDocumentationCheck[];
  readonly sandboxNotes: readonly StripeSandboxNote[];
  readonly verifiedBy: string;
}

/** The audit entry a recording hands to the caller's audit writer. */
export interface StripeVerificationAuditEntry {
  readonly action: "provider_verification.recorded";
  readonly providerKey: typeof STRIPE_PROVIDER_KEY;
  readonly status: StripeVerificationStatus;
  readonly environment: StripeEnvironment;
  readonly verifiedBy: string;
  readonly occurredAtEpochMs: number;
}

/** The result of recording a verification. */
export type RecordStripeVerificationResult =
  | { readonly status: "recorded"; readonly record: StripeVerificationRecord }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Record one verification: validate every part, calculate the status, store it, hand the audit entry to
 * the caller.
 *
 * The first invalid part fails the whole recording, so a record never mixes a verified page with a check
 * that names a page outside Stripe's documentation, and never carries a duplicate step. The status is
 * calculated here, never supplied by the caller, so it cannot be inflated.
 */
export function recordStripeVerification(
  input: RecordStripeVerificationInput,
  options: {
    readonly store: StripeVerificationStore;
    readonly occurredAtEpochMs: number;
    readonly recordAudit?: (entry: StripeVerificationAuditEntry) => void;
  },
): RecordStripeVerificationResult {
  if (input.documentationChecks.length === 0) {
    return { status: "failed", reason: "a verification needs at least one documentation check" };
  }
  if (VERIFIER_PATTERN.test(input.verifiedBy.trim()) === false) {
    return { status: "failed", reason: "a verification needs the name of who verified it" };
  }

  for (const check of input.documentationChecks) {
    const reason = validateStripeDocumentationCheck(check);
    if (reason !== null) return { status: "failed", reason };
  }
  for (const note of input.sandboxNotes) {
    const reason = validateStripeSandboxNote(note);
    if (reason !== null) return { status: "failed", reason };
  }

  const seen = new Set<string>();
  for (const note of input.sandboxNotes) {
    if (seen.has(note.test)) return { status: "failed", reason: "a sandbox step may be recorded once per verification" };
    seen.add(note.test);
  }

  const record: StripeVerificationRecord = {
    id: randomUUID(),
    providerKey: STRIPE_PROVIDER_KEY,
    providerName: STRIPE_PROVIDER_NAME,
    environment: input.environment,
    documentationChecks: deepFreeze(
      input.documentationChecks.map((check) => ({
        topic: check.topic.trim(),
        url: check.url,
        verified: check.verified,
        notes: check.notes === null ? null : sanitizeStripeText(check.notes),
      })),
    ),
    sandboxNotes: deepFreeze(
      input.sandboxNotes.map((note) => ({
        test: note.test,
        result: note.result,
        details: note.details === null ? null : sanitizeStripeText(note.details),
      })),
    ),
    status: calculateStripeStatus(input.documentationChecks, input.sandboxNotes),
    verifiedAtEpochMs: options.occurredAtEpochMs,
    verifiedBy: input.verifiedBy.trim(),
  };

  options.store.insert(record);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "provider_verification.recorded",
      providerKey: STRIPE_PROVIDER_KEY,
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
 * sandbox step recorded as not run, with the reason, because no Stripe account, API key or webhook
 * signing secret exists in this environment.
 *
 * The record these produce is `partial` by construction, which is the honest status: the documentation
 * was read and the platform's rules are recorded, and nothing was processed at Stripe.
 */
export const STRIPE_SESSION_CHECKS: readonly StripeDocumentationCheck[] = deepFreeze(
  STRIPE_DOCUMENTATION_SOURCES.map((source) => ({
    topic: source.topic,
    url: source.url,
    verified: true,
    notes: source.establishes,
  })),
);

/** The sandbox notes of this session: five steps, none run, each with the reason stated. */
export const STRIPE_SESSION_SANDBOX_NOTES: readonly StripeSandboxNote[] = deepFreeze(
  STRIPE_SANDBOX_CYCLE.map((step) => ({
    test: step.id,
    result: "not_tested" as const,
    details:
      "No Stripe account, sandbox key or webhook signing secret exists in this environment, so this step has not been run and must not be recorded as passed.",
  })),
);

/** The status this session's review yields; asserted by the gate so nobody can claim otherwise. */
export const STRIPE_SESSION_STATUS: StripeVerificationStatus = calculateStripeStatus(
  STRIPE_SESSION_CHECKS,
  STRIPE_SESSION_SANDBOX_NOTES,
);
