// path: lib/payments/adapters/rainforest-payment.ts

/**
 * The Rainforest adapter's payment acceptance: the payin config, the component session, the hosted
 * component contract and the payin read that turns a Rainforest answer into a platform outcome.
 *
 * ## What section 6 asks of this provider
 *
 * Section 6: "Rainforest (rainforestpay.com): payment acceptance and sub-merchant creation." This STEP
 * is the acceptance half: taking a card or ACH payment for a merchant through Rainforest. The merchant
 * onboarding half is STEP 160.
 *
 * Section 6 also says the platform keeps its PCI scope small, and Rainforest's own documentation says
 * the same thing from its side: "The payment component collects sensitive payment data from your user
 * without exposing your platform to the sensitive payment data - increasing security and decreasing
 * PCI DSS scope." So this adapter never sees a card number. It does what the documented component
 * integration does, in three steps:
 *
 * 1. **Create the payin config** — `POST /v1/payin_configs` with the merchant, the idempotency key,
 *    the amount in minor units, the currency and optional billing-contact pre-fill, metadata and
 *    amount splits.
 * 2. **Create the component session** — `POST /v1/sessions` with a `group#payment_component`
 *    statement constrained to that merchant, which answers the short-lived `session_key` the browser
 *    passes into the component.
 * 3. **Read the outcome** — `GET /v1/payins/{payin_id}`, which is what the component's `approved`
 *    event hands back as `payin_id`, and which the webhooks of STEP 160 will also point at.
 *
 * ## The money rule, and why `SUCCEEDED` is the only success
 *
 * Rainforest's own status table (STEP 157 recorded it in `lib/payments/adapters/rainforest.ts`) defines
 * `SUCCEEDED` as the funds becoming available to deposit. Every other documented status is either
 * still moving (`CREATED`, `PRESENTING`, `AUTHORIZED`, `PROCESSING`, `IN_REVIEW`) or has lost the money
 * (`FAILED`, `RETURNED`, `CANCELED`). So `readRainforestPayin` answers `succeeded` **only** for
 * `SUCCEEDED`, and only when the amount and the currency it reads are the amount and currency the
 * platform asked for: a payin whose amount does not match is `unknown` with
 * `requiresReconciliation: true`, never a success. The platform posts ledger entries only for
 * `succeeded` (STEP 132), so nothing else can move money.
 *
 * A payin config being created is **not** a payment. Every creation answer is therefore a statement
 * about the configuration, never about money.
 *
 * ## Idempotency
 *
 * A payin config is created with the platform's idempotency key, and the submission is stored *before*
 * the call is made: a replay of the same key answers from the store without a second provider call, a
 * replay with a different amount, merchant or currency is refused (the same key with different details
 * is a mistake, not a retry, as `lib/payments/creation.ts` says), and an in-flight duplicate is answered
 * as unknown rather than resent. A creation whose outcome could not be read is `unknown` with
 * `requiresReconciliation`, and replaying the same key is how the caller resolves it.
 *
 * ## What is never stored, logged or audited
 *
 * The API key (STEP 158's sealed configuration opens it for one call), the session key and the payment
 * details. The session key is returned to the caller because the browser is where it belongs, and the
 * documentation says a session is "designed to be transmitted to the front-end"; it is never written to
 * the submission store, an audit entry or an error message.
 *
 * ## What this file is not
 *
 * It is not the payment core: no ledger entry, no payment record and no invoice is touched here. There
 * is no core acceptance port to implement — the payout ports of STEPs 133/134 exist, an acceptance port
 * does not — so this adapter publishes the provider-side contract (`succeeded` / `pending` / `failed` /
 * `unknown`) that the route or job consumes and maps onto STEP 130's payment and STEP 132's ledger.
 * It is not a route and not a screen: STEP 183 renders the component, and this file only says what the
 * server must hand that page. It is not the webhook receiver: STEP 160 owns delivery verification.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { isCurrency, MAXIMUM_MINOR } from "../money.ts";
import { openSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  RAINFOREST_API_VERSION,
  RAINFOREST_API_VERSION_HEADER,
  RAINFOREST_PROVIDER_KEY,
  rainforestApiUrlFor,
  rainforestPayinOutcomeOf,
  sanitizeRainforestText,
  type RainforestEnvironment,
} from "./rainforest.ts";
import { rainforestApiKeyScope, type RainforestConfigStore } from "./rainforest-client.ts";

/* -------------------------------------------------------------------------------------------------
 * Documented endpoints, limits and component facts
 * ---------------------------------------------------------------------------------------------- */

/** The documented payin config endpoint path. */
export const RAINFOREST_PAYIN_CONFIGS_PATH = "/v1/payin_configs";

/** The documented session endpoint path. */
export const RAINFOREST_SESSIONS_PATH = "/v1/sessions";

/** The documented payin read path, with its parameter. */
export const RAINFOREST_PAYIN_PATH_TEMPLATE = "/v1/payins/{payin_id}";

/** The documented payin id prefixes: production `pyi_`, sandbox `sbx_pyi`. */
export const RAINFOREST_PAYIN_ID_PREFIXES: readonly string[] = deepFreeze(["sbx_pyi_", "pyi_"]);

/** The documented payin config id prefixes: production `cfg_`, sandbox `sbx_cfg`. */
export const RAINFOREST_PAYIN_CONFIG_ID_PREFIXES: readonly string[] = deepFreeze(["sbx_cfg_", "cfg_"]);

/** The documented session key prefix. */
export const RAINFOREST_SESSION_KEY_PREFIX = "sessionkey_";

/** The documented maximum session lifetime: 24 hours. */
export const RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS = 86_400;

/** The documented default session lifetime this adapter asks for. */
export const RAINFOREST_SESSION_DEFAULT_TTL_SECONDS = 3_600;

/** The documented permission group the payment component needs. */
export const RAINFOREST_PAYMENT_COMPONENT_PERMISSION = "group#payment_component";

/** The documented permission group the merchant onboarding component needs (STEP 160). */
export const RAINFOREST_MERCHANT_ONBOARDING_PERMISSION = "group#merchant_onboarding_component";

/** The two documented component purposes a session may be created for. */
export const RAINFOREST_SESSION_PURPOSES: readonly RainforestSessionPurpose[] = deepFreeze(["payment", "onboarding"]);

/**
 * What a session is for.
 *
 * A session grants one documented component group. Keeping the purpose in the input rather than letting
 * a caller name a permission is what makes "a payment session cannot ask for onboarding" a property of
 * the code: the group is chosen from this table, and the gate asserts the two never cross.
 */
export type RainforestSessionPurpose = "payment" | "onboarding";

/** The documented permission group of a session purpose. */
export function rainforestSessionPermissionOf(purpose: RainforestSessionPurpose): string {
  return purpose === "onboarding" ? RAINFOREST_MERCHANT_ONBOARDING_PERMISSION : RAINFOREST_PAYMENT_COMPONENT_PERMISSION;
}

/** The documented component element name. */
export const RAINFOREST_COMPONENT_TAG = "rainforest-payment";

/** The documented JavaScript bundles, one per environment. */
export const RAINFOREST_COMPONENT_SCRIPT_URLS: Readonly<Record<RainforestEnvironment, string>> = deepFreeze({
  sandbox: "https://static.rainforestpay.com/sandbox.payment.js",
  production: "https://static.rainforestpay.com/payment.js",
});

/** The documented hosts a Content Security Policy must allow for the component to load. */
export const RAINFOREST_COMPONENT_CSP_HOSTS: readonly string[] = deepFreeze(["*.rainforestpay.com"]);

/** The largest API answer this file reads. */
export const RAINFOREST_PAYMENT_ANSWER_MAXIMUM_BYTES = 65_536;

/** The longest provider text this file keeps. */
export const RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH = 200;

/** The largest amount the provider's documented `integer` amount field can carry safely. */
export const RAINFOREST_MAXIMUM_AMOUNT_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** The documented JavaScript bundle of an environment. */
export function rainforestComponentScriptUrlFor(environment: RainforestEnvironment): string {
  return RAINFOREST_COMPONENT_SCRIPT_URLS[environment];
}

/** The documented payin config endpoint of an environment. */
export function rainforestPayinConfigEndpointFor(environment: RainforestEnvironment): string {
  return rainforestApiUrlFor(environment, RAINFOREST_PAYIN_CONFIGS_PATH) ?? "";
}

/** The documented session endpoint of an environment. */
export function rainforestSessionEndpointFor(environment: RainforestEnvironment): string {
  return rainforestApiUrlFor(environment, RAINFOREST_SESSIONS_PATH) ?? "";
}

/** The documented payin read endpoint of an environment and a payin, or null when the id is invalid. */
export function rainforestPayinEndpointFor(environment: RainforestEnvironment, payinId: string): string | null {
  if (RAINFOREST_PAYIN_ID_PATTERN.test(payinId) === false) return null;
  return rainforestApiUrlFor(environment, `/v1/payins/${payinId}`);
}

/* -------------------------------------------------------------------------------------------------
 * The documented refusal vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The refusal codes the payment refusal codes page publishes, returned by the payin reads as
 * `refusal_code` and `detailed_refusal_code`.
 *
 * The list is the vocabulary this adapter accepts as a *code*; the description that accompanies it is
 * the provider's text and is carried through sanitised. A code outside this list is carried as text
 * but is not treated as a known refusal, so a caller can tell the documented vocabulary from a new
 * value Rainforest may add.
 */
export const RAINFOREST_REFUSAL_CODES: readonly string[] = deepFreeze([
  "ACCOUNT_CLOSED",
  "DECLINED",
  "DO_NOT_HONOR",
  "EXPIRED_CARD",
  "FRAUDULENT_CARD",
  "INCORRECT_PAYMENT_INFORMATION",
  "INSUFFICIENT_FUNDS",
  "INVALID_CARD_SECURITY_CODE",
  "INVALID_EXPIRATION_DATE",
  "INVALID_PIN",
  "LOST_CARD",
  "NO_CARD_NUMBER_ON_FILE_WITH_ISSUER",
  "NO_SUCH_CARD_ISSUER",
  "OVER_LIMIT",
  "PROCESSING_ERROR",
  "RETRY",
  "RETRY_WITH_THREEDS",
  "RISK_DECLINE",
  "STOLEN_CARD",
  "THREEDS_CHALLENGE_FAILED",
  "UNEXPECTED_PAYIN_TOKEN",
  "UNSUPPORTED_ACCOUNT_TYPE",
  "UNSUPPORTED_CARD_TYPE",
]);

/** True when a code is one the payment refusal codes page publishes. */
export function isRainforestRefusalCode(code: string): boolean {
  return RAINFOREST_REFUSAL_CODES.includes(code);
}

/* -------------------------------------------------------------------------------------------------
 * Validation patterns
 * ---------------------------------------------------------------------------------------------- */

/** A merchant id: the documented `mid` production and `sbx_mid` sandbox prefix. */
export const RAINFOREST_MERCHANT_ID_PATTERN = /^(?:sbx_)?mid_[A-Za-z0-9]{4,64}$/u;

/** A payin config id: the documented `cfg` production and `sbx_cfg` sandbox prefix. */
export const RAINFOREST_PAYIN_CONFIG_ID_PATTERN = /^(?:sbx_)?cfg_[A-Za-z0-9]{4,64}$/u;

/** A payin id: the documented `pyi` production and `sbx_pyi` sandbox prefix. */
export const RAINFOREST_PAYIN_ID_PATTERN = /^(?:sbx_)?pyi_[A-Za-z0-9]{4,64}$/u;

/** A session key: the documented `sessionkey_` prefix and an opaque body. */
export const RAINFOREST_SESSION_KEY_PATTERN = /^sessionkey_[A-Za-z0-9]{16,128}$/u;

/** An idempotency key: the platform's own key shape, 8 to 128 URL-safe characters. */
export const RAINFOREST_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

/** A metadata key: short, readable and safe as a JSON key. */
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/u;

/** The largest number of metadata entries this adapter sends. */
export const RAINFOREST_METADATA_MAXIMUM_KEYS = 20;

/** The longest metadata value this adapter sends. */
export const RAINFOREST_METADATA_MAXIMUM_VALUE_LENGTH = 200;

/* -------------------------------------------------------------------------------------------------
 * The payin config input
 * ---------------------------------------------------------------------------------------------- */

/**
 * The billing contact a payin config may pre-fill.
 *
 * Rainforest documents that a card payin needs the postal code and an ACH payin needs the name, and
 * that a billing contact supplied on the config pre-fills the component; when it is absent the
 * component asks the user for the fields it needs. The names here are the documented `billing_contact`
 * fields this adapter sends: `name`, `postal_code`, `country`, `state`, `email` and `phone`.
 */
export interface RainforestBillingContact {
  readonly name?: string;
  readonly postalCode?: string;
  readonly country?: string;
  readonly state?: string;
  readonly email?: string;
  readonly phone?: string;
}

/** One documented amount split: a platform fee or a share for another merchant. */
export interface RainforestAmountSplit {
  readonly type: "PLATFORM" | "MERCHANT";
  readonly amountMinor: bigint;
  /** Required for a `MERCHANT` split, refused for a `PLATFORM` split. */
  readonly merchantId?: string;
}

/** What creating a payin config needs. */
export interface RainforestPayinConfigInput {
  readonly companyId: string;
  /** The Rainforest merchant the payin is for: `mid_` production, `sbx_mid_` sandbox. */
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** The platform's idempotency key: the same key never creates a second config. */
  readonly idempotencyKey: string;
  readonly billingContact?: RainforestBillingContact;
  readonly amountSplits?: readonly RainforestAmountSplit[];
  /** Non-sensitive metadata stored on the payin and queryable by JSONPath. */
  readonly metadata?: Readonly<Record<string, string>>;
}

const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/u;
const PHONE_PATTERN = /^[0-9+()\-. ]{5,32}$/u;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const REGION_PATTERN = /^[A-Za-z0-9 -]{1,32}$/u;

/** The validation failure of a billing contact, or null when it is valid. */
function billingContactProblem(contact: RainforestBillingContact): string | null {
  const present = [
    contact.name,
    contact.postalCode,
    contact.country,
    contact.state,
    contact.email,
    contact.phone,
  ].filter((value) => value !== undefined && value.trim().length > 0);
  if (present.length === 0) return "a billing contact that is sent must carry at least one field";
  if (contact.name !== undefined && sanitizeRainforestText(contact.name).length === 0) {
    return "the billing contact name must carry readable text";
  }
  if (contact.name !== undefined && contact.name.length > 100) return "the billing contact name is too long";
  if (contact.postalCode !== undefined && POSTAL_CODE_PATTERN.test(contact.postalCode) === false) {
    return "the billing contact postal code is invalid";
  }
  if (contact.country !== undefined && COUNTRY_PATTERN.test(contact.country) === false) {
    return "the billing contact country must be a two letter code";
  }
  if (contact.state !== undefined && REGION_PATTERN.test(contact.state) === false) {
    return "the billing contact state is invalid";
  }
  if (contact.email !== undefined && EMAIL_PATTERN.test(contact.email) === false) {
    return "the billing contact email is invalid";
  }
  if (contact.phone !== undefined && PHONE_PATTERN.test(contact.phone) === false) {
    return "the billing contact phone is invalid";
  }
  return null;
}

/** The validation failure of the amount splits, or null when they are valid. */
function amountSplitsProblem(splits: readonly RainforestAmountSplit[], amountMinor: bigint): string | null {
  if (splits.length === 0) return null;
  let platformSplits = 0;
  let total = 0n;
  const merchantIds = new Set<string>();
  for (const split of splits) {
    if (split.type !== "PLATFORM" && split.type !== "MERCHANT") return "an amount split must be PLATFORM or MERCHANT";
    if (split.amountMinor <= 0n) return "an amount split must be a positive amount";
    if (split.amountMinor > amountMinor) return "an amount split cannot exceed the payin amount";
    total += split.amountMinor;
    if (split.type === "PLATFORM") {
      platformSplits += 1;
      if (split.merchantId !== undefined) return "a PLATFORM split names no merchant";
    } else {
      if (split.merchantId === undefined || RAINFOREST_MERCHANT_ID_PATTERN.test(split.merchantId) === false) {
        return "a MERCHANT split must name a valid merchant id";
      }
      if (merchantIds.has(split.merchantId)) return "each MERCHANT split must name a unique merchant";
      merchantIds.add(split.merchantId);
    }
  }
  if (platformSplits > 1) return "at most one PLATFORM split is permitted";
  if (total > amountMinor) return "the amount splits cannot add up to more than the payin amount";
  return null;
}

/** The validation failure of a payin config input, or null when it is valid. */
export function validateRainforestPayinConfigInput(input: RainforestPayinConfigInput): string | null {
  if (input.companyId.trim().length === 0) return "the company id is required";
  if (RAINFOREST_MERCHANT_ID_PATTERN.test(input.merchantId) === false) {
    return "the merchant id must carry the documented mid_ or sbx_mid_ prefix";
  }
  if (input.amountMinor <= 0n) return "the amount must be positive";
  if (input.amountMinor > MAXIMUM_MINOR) return "the amount exceeds the platform's money maximum";
  if (input.amountMinor > RAINFOREST_MAXIMUM_AMOUNT_MINOR) {
    return "the amount is larger than the provider's documented integer amount field can carry";
  }
  if (isCurrency(input.currency) === false) return "the currency must be USD";
  if (RAINFOREST_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) === false) {
    return "the idempotency key must be 8 to 128 characters of letters, digits, dot, colon, dash or underscore";
  }
  if (input.billingContact !== undefined) {
    const contactProblem = billingContactProblem(input.billingContact);
    if (contactProblem !== null) return contactProblem;
  }
  if (input.amountSplits !== undefined) {
    const splitProblem = amountSplitsProblem(input.amountSplits, input.amountMinor);
    if (splitProblem !== null) return splitProblem;
  }
  if (input.metadata !== undefined) {
    const keys = Object.keys(input.metadata);
    if (keys.length > RAINFOREST_METADATA_MAXIMUM_KEYS) return "the metadata carries too many keys";
    for (const key of keys) {
      if (METADATA_KEY_PATTERN.test(key) === false) return "a metadata key is invalid";
      const value = input.metadata[key] ?? "";
      if (value.length > RAINFOREST_METADATA_MAXIMUM_VALUE_LENGTH) return "a metadata value is too long";
      if (sanitizeRainforestText(value).length === 0 && value.trim().length > 0) {
        return "a metadata value must carry readable text";
      }
    }
  }
  return null;
}

/**
 * Build the documented payin config body.
 *
 * Only documented fields are sent: `merchant_id`, `idempotency_key`, `amount` in minor units,
 * `currency_code`, and — when the caller supplies them — `billing_contact`, `amount_splits` and
 * `metadata`. Nothing else is invented, and no payment detail is part of this body: the sensitive data
 * is collected by the component, never by the platform.
 */
export function buildRainforestPayinConfigBody(input: RainforestPayinConfigInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    merchant_id: input.merchantId,
    idempotency_key: input.idempotencyKey,
    amount: Number(input.amountMinor),
    currency_code: input.currency,
  };

  if (input.billingContact !== undefined) {
    const contact = input.billingContact;
    const billingContact: Record<string, string> = {};
    if (contact.name !== undefined && contact.name.trim().length > 0) billingContact["name"] = contact.name.trim();
    if (contact.postalCode !== undefined && contact.postalCode.trim().length > 0) {
      billingContact["postal_code"] = contact.postalCode.trim();
    }
    if (contact.country !== undefined && contact.country.trim().length > 0) billingContact["country"] = contact.country.trim();
    if (contact.state !== undefined && contact.state.trim().length > 0) billingContact["state"] = contact.state.trim();
    if (contact.email !== undefined && contact.email.trim().length > 0) billingContact["email"] = contact.email.trim();
    if (contact.phone !== undefined && contact.phone.trim().length > 0) billingContact["phone"] = contact.phone.trim();
    body["billing_contact"] = billingContact;
  }

  if (input.amountSplits !== undefined && input.amountSplits.length > 0) {
    body["amount_splits"] = input.amountSplits.map((split) => {
      const entry: Record<string, unknown> = {
        type: split.type,
        amount: Number(split.amountMinor),
        currency_code: input.currency,
      };
      if (split.merchantId !== undefined) entry["merchant_id"] = split.merchantId;
      return entry;
    });
  }

  if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.metadata)) metadata[key] = value;
    body["metadata"] = metadata;
  }

  return body;
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP answer of an API call: the status code and the raw body. */
export interface RainforestPaymentAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port: endpoint, method, key and optional JSON body in; the raw answer out. */
export type RainforestPaymentTransport = (
  endpoint: string,
  method: "GET" | "POST",
  apiKey: string,
  body: string | null,
) => Promise<RainforestPaymentAnswer>;

/** The documented endpoints this adapter may call, for one environment. */
function paymentEndpointsFor(environment: RainforestEnvironment): readonly string[] {
  const payinPrefix = rainforestApiUrlFor(environment, "/v1/payins/");
  return [
    rainforestPayinConfigEndpointFor(environment),
    rainforestSessionEndpointFor(environment),
    ...(payinPrefix === null ? [] : [payinPrefix]),
  ];
}

/** True when an endpoint is one of the three documented payment endpoints of one of the environments. */
function isPaymentEndpoint(endpoint: string): boolean {
  return (["sandbox", "production"] as const).some((environment) =>
    paymentEndpointsFor(environment).some((prefix) =>
      prefix.endsWith("/v1/payins/")
        ? endpoint.startsWith(prefix) && RAINFOREST_PAYIN_ID_PATTERN.test(endpoint.slice(prefix.length))
        : endpoint === prefix,
    ),
  );
}

/**
 * Perform one API call against an endpoint the caller's allowlist already approved.
 *
 * The call is refused without a key, `POST` carries a JSON body and a content type while `GET` carries
 * neither, redirects are refused, the timeout is bounded and an oversized answer is refused. The
 * documented `Rainforest-Api-Version` header is always sent, because the platform's minimum version is
 * a portal setting the documentation does not expose.
 */
async function performRainforestRequest(
  endpoint: string,
  method: "GET" | "POST",
  apiKey: string,
  body: string | null,
): Promise<RainforestPaymentAnswer> {
  if (apiKey.trim().length === 0) throw new Error("an API key is required");
  if (method === "POST" && (body === null || body.trim().length === 0)) throw new Error("a POST needs a body");
  if (method === "GET" && body !== null) throw new Error("a GET carries no body");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    [RAINFOREST_API_VERSION_HEADER]: RAINFOREST_API_VERSION,
  };
  if (method === "POST") headers["Content-Type"] = "application/json";

  const response = await fetch(endpoint, {
    method,
    headers,
    ...(body === null ? {} : { body }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (text.length > RAINFOREST_PAYMENT_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
}

/**
 * The payment transport: the three documented payment endpoints and nothing else.
 *
 * STEP 160's merchant onboarding needs the merchant endpoints, and rather than widening this allowlist
 * for every adapter, `rainforestTransportAllowing` builds a transport for a named set of extra
 * documented paths — so a transport's ability is always the list its own adapter wrote down.
 */
export const rainforestFetchPaymentTransport: RainforestPaymentTransport = async (endpoint, method, apiKey, body) => {
  if (isPaymentEndpoint(endpoint) === false) throw new Error("invalid API endpoint");
  return performRainforestRequest(endpoint, method, apiKey, body);
};

/**
 * A transport for the documented payment endpoints plus the extra documented paths an adapter names.
 *
 * Each extra path must be a documented `/v1/...` path; the endpoint the caller passes must equal the
 * absolute URL that path builds for one of the two environments. Everything else is refused before a
 * request is made.
 */
export function rainforestTransportAllowing(extraPaths: readonly string[]): RainforestPaymentTransport {
  return async (endpoint, method, apiKey, body) => {
    if (isPaymentEndpoint(endpoint)) return performRainforestRequest(endpoint, method, apiKey, body);
    const extra = extraPaths.some((path) =>
      (["sandbox", "production"] as const).some((environment) => rainforestApiUrlFor(environment, path) === endpoint),
    );
    if (extra === false) throw new Error("invalid API endpoint");
    return performRainforestRequest(endpoint, method, apiKey, body);
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a provider answer
 * ---------------------------------------------------------------------------------------------- */

/** The documented error object: a field, a code and a message, sanitised and capped. */
export function rainforestErrorMessageOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const errors = (payload as Readonly<Record<string, unknown>>)["errors"];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "object" && entry !== null) {
        const record = entry as Readonly<Record<string, unknown>>;
        const message = record["message"];
        if (typeof message === "string" && message.trim().length > 0) {
          const field = record["field"];
          const prefix = typeof field === "string" && field.trim().length > 0 ? `${sanitizeRainforestText(field)}: ` : "";
          return sanitizeRainforestText(`${prefix}${message}`).slice(0, RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH);
        }
      }
    }
  }
  for (const key of ["message", "detail", "error"]) {
    const value = (payload as Readonly<Record<string, unknown>>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizeRainforestText(value).slice(0, RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH);
    }
  }
  return "";
}

/** Parse a body as JSON, or null. */
function parseJson(body: string): unknown {
  if (body.trim().length === 0) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** The `data` object of a documented envelope, or null. */
function dataOf(payload: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const data = (payload as Readonly<Record<string, unknown>>)["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Readonly<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------------------------------
 * The submission record and its store
 * ---------------------------------------------------------------------------------------------- */

/** Where one payin config creation stands. */
export type RainforestConfigOutcome = "pending" | "created" | "rejected" | "unknown";

/** One stored attempt to create a payin config, keyed on the platform's idempotency key. */
export interface RainforestPayinConfigSubmission {
  readonly id: string;
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** The provider's config id, once one is known. */
  readonly providerConfigId: string | null;
  readonly outcome: RainforestConfigOutcome;
  readonly reason: string | null;
  readonly requiresReconciliation: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The only moves a submission may make: forward, never back to pending, and never out of a final state. */
export const SUBMISSION_OUTCOMES: Readonly<Record<RainforestConfigOutcome, readonly RainforestConfigOutcome[]>> =
  deepFreeze({
    pending: ["pending", "created", "rejected", "unknown"],
    unknown: ["unknown", "created", "rejected"],
    created: ["created"],
    rejected: ["rejected"],
  });

/** What the store reads and writes. The store is the caller's; PostgreSQL owns the real rows. */
export interface RainforestPayinConfigStore {
  insert(submission: RainforestPayinConfigSubmission): void;
  findById(id: string): RainforestPayinConfigSubmission | null;
  /** The submission one company made with one idempotency key, or null. */
  findByIdempotencyKey(companyId: string, idempotencyKey: string): RainforestPayinConfigSubmission | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: RainforestPayinConfigSubmission, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation of the invariants the real table must enforce — one
 * row per company and idempotency key, an immutable company, key, merchant, amount and currency, a
 * version guard on every write, and forward-only outcomes.
 */
export class InMemoryRainforestPayinConfigStore implements RainforestPayinConfigStore {
  private readonly submissions = new Map<string, RainforestPayinConfigSubmission>();

  insert(submission: RainforestPayinConfigSubmission): void {
    if (this.submissions.has(submission.id)) throw new Error("duplicate submission id");
    if (submission.version !== 1) throw new Error("a new submission starts at version 1");
    if (submission.outcome !== "pending") throw new Error("a new submission is pending");
    if (this.findByIdempotencyKey(submission.companyId, submission.idempotencyKey) !== null) {
      throw new Error("this company already used that idempotency key");
    }
    this.submissions.set(submission.id, submission);
  }

  findById(id: string): RainforestPayinConfigSubmission | null {
    return this.submissions.get(id) ?? null;
  }

  findByIdempotencyKey(companyId: string, idempotencyKey: string): RainforestPayinConfigSubmission | null {
    return (
      [...this.submissions.values()].find(
        (submission) => submission.companyId === companyId && submission.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  save(next: RainforestPayinConfigSubmission, expectedVersion: number): boolean {
    const current = this.submissions.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.idempotencyKey !== next.idempotencyKey) return false;
    if (current.merchantId !== next.merchantId) return false;
    if (current.amountMinor !== next.amountMinor || current.currency !== next.currency) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (SUBMISSION_OUTCOMES[current.outcome].includes(next.outcome) === false) return false;
    if (next.outcome === "created" && next.providerConfigId === null) return false;
    this.submissions.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a key or a payment detail. */
export interface RainforestPaymentAuditEntry {
  readonly action:
    | "payin.rainforest_config_created"
    | "payin.rainforest_session_created"
    | "payin.rainforest_status_read"
    | "payin.rainforest_merchant_provisioned"
    | "webhook.rainforest_verified"
    | "webhook.rainforest_refused"
    | "webhook.rainforest_applied"
    | "webhook.rainforest_duplicate";
  readonly providerKey: typeof RAINFOREST_PROVIDER_KEY;
  readonly companyId: string;
  readonly merchantId: string;
  /** The provider's object id the action concerns, when there is one. */
  readonly providerObjectId: string | null;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Creating a payin config
 * ---------------------------------------------------------------------------------------------- */

/** The options every call in this file needs. */
export interface RainforestPaymentOptions {
  readonly configStore: RainforestConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: RainforestPaymentTransport;
  readonly recordAudit?: (entry: RainforestPaymentAuditEntry) => void;
}

/** What creating a payin config did. */
export type CreateRainforestPayinConfigResult =
  | {
      readonly status: "created";
      readonly payinConfigId: string;
      readonly submission: RainforestPayinConfigSubmission;
    }
  | {
      readonly status: "replayed";
      readonly payinConfigId: string;
      readonly submission: RainforestPayinConfigSubmission;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly submission: RainforestPayinConfigSubmission | null;
    }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly submission: RainforestPayinConfigSubmission;
    }
  | { readonly status: "failed"; readonly reason: string };

/** The active configuration of a company opened for one call, or the reason there is none. */
function activeKeyOf(
  companyId: string,
  options: RainforestPaymentOptions,
): { readonly ok: true; readonly apiKey: string; readonly environment: RainforestEnvironment } | { readonly ok: false; readonly reason: string } {
  const config = options.configStore.findActiveByCompany(companyId);
  if (config === null) return { ok: false, reason: "no active Rainforest key configuration exists for this company" };
  try {
    const apiKey = openSecret(options.keyring, config.apiKeySealed, {
      purpose: "secret",
      scope: rainforestApiKeyScope(companyId),
    });
    return { ok: true, apiKey, environment: config.environment };
  } catch {
    return { ok: false, reason: "the sealed credentials cannot be opened with this keyring" };
  }
}

/**
 * Create one payin config, idempotently.
 *
 * The submission is stored before the call, so a crash between the call and the answer leaves a
 * `pending` row rather than a silent duplicate; a replay answers from the store and makes no provider
 * call; and a replay with a different amount, merchant or currency is refused.
 *
 * The answer table is deliberately narrow: a `2XX` naming a documented `cfg`/`sbx_cfg` config id is
 * `created`; `400`, `409` and `422` are the documented validation answers and are `rejected` with the
 * provider's message sanitised; `401`, `403`, `404`, `405` and `415` prove no config was created and are
 * `failed`; a timeout-class code, `429`, a `5XX`, a thrown transport and a `2XX` without a usable id are
 * `unknown` with `requiresReconciliation`, because the config may exist and only a replay can settle it.
 */
export async function createRainforestPayinConfig(
  input: RainforestPayinConfigInput,
  store: RainforestPayinConfigStore,
  options: RainforestPaymentOptions,
): Promise<CreateRainforestPayinConfigResult> {
  const invalid = validateRainforestPayinConfigInput(input);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const existing = store.findByIdempotencyKey(input.companyId, input.idempotencyKey);
  if (existing !== null) {
    if (
      existing.amountMinor !== input.amountMinor ||
      existing.merchantId !== input.merchantId ||
      existing.currency !== input.currency
    ) {
      return {
        status: "rejected",
        reason: "the idempotency key was already used with another amount, merchant or currency",
        submission: existing,
      };
    }
    if (existing.outcome === "created" && existing.providerConfigId !== null) {
      return { status: "replayed", payinConfigId: existing.providerConfigId, submission: existing };
    }
    if (existing.outcome === "rejected") {
      return { status: "rejected", reason: existing.reason ?? "the provider refused this payin config", submission: existing };
    }
    if (existing.outcome === "unknown") {
      return {
        status: "unknown",
        requiresReconciliation: true,
        reason: existing.reason ?? "the previous attempt has no readable outcome; reconcile before retrying",
        submission: existing,
      };
    }
    return {
      status: "unknown",
      requiresReconciliation: true,
      reason: "the same payin config is already in flight; it is not sent twice",
      submission: existing,
    };
  }

  const key = activeKeyOf(input.companyId, options);
  if (key.ok === false) return { status: "failed", reason: key.reason };

  const submission: RainforestPayinConfigSubmission = {
    id: randomUUID(),
    companyId: input.companyId,
    idempotencyKey: input.idempotencyKey,
    merchantId: input.merchantId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    providerConfigId: null,
    outcome: "pending",
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  try {
    store.insert(submission);
  } catch {
    return { status: "failed", reason: "the submission could not be stored, so nothing was sent" };
  }

  let answer: RainforestPaymentAnswer;
  try {
    answer = await (options.transport ?? rainforestFetchPaymentTransport)(
      rainforestPayinConfigEndpointFor(key.environment),
      "POST",
      key.apiKey,
      JSON.stringify(buildRainforestPayinConfigBody(input)),
    );
  } catch {
    return settleUnknown(store, submission, "the API could not be reached, so the config may exist", options);
  }

  const payload = parseJson(answer.body);

  if (answer.status >= 200 && answer.status < 300) {
    const data = dataOf(payload);
    const providerConfigId = data === null ? null : data["payin_config_id"];
    if (typeof providerConfigId === "string" && RAINFOREST_PAYIN_CONFIG_ID_PATTERN.test(providerConfigId)) {
      const created = settle(store, submission, "created", null, false, providerConfigId, options);
      return { status: "created", payinConfigId: providerConfigId, submission: created };
    }
    return settleUnknown(store, submission, "the answer named no usable payin config id", options);
  }

  if (answer.status === 400 || answer.status === 409 || answer.status === 422) {
    const message = rainforestErrorMessageOf(payload);
    const reason = message.length > 0 ? message : `the API refused the payin config with status ${answer.status}`;
    const rejected = settle(store, submission, "rejected", reason, false, null, options);
    return { status: "rejected", reason, submission: rejected };
  }

  if (answer.status === 401 || answer.status === 403) {
    const failed = settle(store, submission, "rejected", "the API rejected the credential", false, null, options);
    return { status: "failed", reason: failed.reason ?? "the API rejected the credential" };
  }

  if (answer.status === 404 || answer.status === 405 || answer.status === 415 || (answer.status >= 300 && answer.status < 400)) {
    const failed = settle(store, submission, "rejected", `the API refused the request with status ${answer.status}`, false, null, options);
    return { status: "failed", reason: failed.reason ?? "the API refused the request" };
  }

  return settleUnknown(store, submission, `the API did not answer finally (status ${answer.status})`, options);
}

/** Write one outcome onto a submission, version-guarded, and hand the audit entry to the caller. */
function settle(
  store: RainforestPayinConfigStore,
  submission: RainforestPayinConfigSubmission,
  outcome: RainforestConfigOutcome,
  reason: string | null,
  requiresReconciliation: boolean,
  providerConfigId: string | null,
  options: RainforestPaymentOptions,
): RainforestPayinConfigSubmission {
  const next: RainforestPayinConfigSubmission = {
    ...submission,
    outcome,
    reason,
    requiresReconciliation,
    providerConfigId: providerConfigId ?? submission.providerConfigId,
    version: submission.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const stored = store.save(next, submission.version);
  const recorded = stored ? next : (store.findById(submission.id) ?? next);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "payin.rainforest_config_created",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: recorded.companyId,
      merchantId: recorded.merchantId,
      providerObjectId: recorded.providerConfigId,
      outcome: recorded.outcome,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return recorded;
}

/** Settle an attempt whose outcome could not be read as `unknown`, remembering that it needs reconciling. */
function settleUnknown(
  store: RainforestPayinConfigStore,
  submission: RainforestPayinConfigSubmission,
  reason: string,
  options: RainforestPaymentOptions,
): CreateRainforestPayinConfigResult {
  const recorded = settle(store, submission, "unknown", reason, true, null, options);
  return { status: "unknown", requiresReconciliation: true, reason, submission: recorded };
}

/* -------------------------------------------------------------------------------------------------
 * Creating a component session
 * ---------------------------------------------------------------------------------------------- */

/** What creating a session needs: the merchant the component may take payments for, and a lifetime. */
export interface RainforestSessionInput {
  readonly companyId: string;
  readonly merchantId: string;
  /** The documented lifetime in seconds, at most 86,400. */
  readonly ttlSeconds?: number;
  /** What the session is for: the payment component (the default) or the onboarding component. */
  readonly purpose?: RainforestSessionPurpose;
}

/** The component contract a page renders: the element, its attributes and the bundle to load. */
export interface RainforestPaymentComponent {
  readonly tag: string;
  readonly scriptUrl: string;
  readonly attributes: {
    readonly "session-key": string;
    readonly "payin-config-id": string;
  };
}

/** What creating a session did. */
export type CreateRainforestSessionResult =
  | {
      readonly status: "created";
      /** The short-lived browser credential: returned to the caller, never stored or audited. */
      readonly sessionKey: string;
      readonly sessionId: string | null;
      readonly expiresAtEpochMs: number;
    }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** The validation failure of a session input, or null when it is valid. */
export function validateRainforestSessionInput(input: RainforestSessionInput): string | null {
  if (input.companyId.trim().length === 0) return "the company id is required";
  if (RAINFOREST_MERCHANT_ID_PATTERN.test(input.merchantId) === false) {
    return "the merchant id must carry the documented mid_ or sbx_mid_ prefix";
  }
  const purpose = input.purpose ?? "payment";
  if (RAINFOREST_SESSION_PURPOSES.includes(purpose) === false) return "the session purpose must be payment or onboarding";
  const ttl = input.ttlSeconds ?? RAINFOREST_SESSION_DEFAULT_TTL_SECONDS;
  if (Number.isInteger(ttl) === false) return "the session lifetime must be a whole number of seconds";
  if (ttl < 60) return "the session lifetime must be at least 60 seconds";
  if (ttl > RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS) {
    return "the session lifetime cannot exceed the documented 24 hours";
  }
  return null;
}

/**
 * Build the documented session body.
 *
 * The statement grants exactly the documented payment-component permission group, constrained to the
 * merchant the payin is for. It never asks for `group#all`: a browser credential must be able to do the
 * one thing the page needs and nothing else.
 */
export function buildRainforestSessionBody(input: RainforestSessionInput): Record<string, unknown> {
  return {
    ttl: input.ttlSeconds ?? RAINFOREST_SESSION_DEFAULT_TTL_SECONDS,
    statements: [
      {
        permissions: [rainforestSessionPermissionOf(input.purpose ?? "payment")],
        constraints: { merchant: { merchant_id: input.merchantId } },
      },
    ],
  };
}

/**
 * Create one component session for a merchant.
 *
 * A session moves no money, so an ambiguous answer is a plain `failed` the caller may retry; the only
 * thing a duplicate costs is another short-lived session. A `2XX` carrying a documented session key is a
 * success, and the expiry is the provider's `expires_at` when it parses, otherwise the requested
 * lifetime from the instant of the call.
 */
export async function createRainforestSession(
  input: RainforestSessionInput,
  options: RainforestPaymentOptions,
): Promise<CreateRainforestSessionResult> {
  const invalid = validateRainforestSessionInput(input);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const key = activeKeyOf(input.companyId, options);
  if (key.ok === false) return { status: "failed", reason: key.reason };

  const ttl = input.ttlSeconds ?? RAINFOREST_SESSION_DEFAULT_TTL_SECONDS;
  let answer: RainforestPaymentAnswer;
  try {
    answer = await (options.transport ?? rainforestFetchPaymentTransport)(
      rainforestSessionEndpointFor(key.environment),
      "POST",
      key.apiKey,
      JSON.stringify(buildRainforestSessionBody(input)),
    );
  } catch {
    return { status: "failed", reason: "the API could not be reached, so no session was created" };
  }

  const payload = parseJson(answer.body);
  if (answer.status === 400 || answer.status === 422) {
    const message = rainforestErrorMessageOf(payload);
    return { status: "rejected", reason: message.length > 0 ? message : "the API refused the session request" };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { status: "failed", reason: `the API refused the session request with status ${answer.status}` };
  }

  const data = dataOf(payload);
  const sessionKey = data === null ? null : data["session_key"];
  if (typeof sessionKey !== "string" || RAINFOREST_SESSION_KEY_PATTERN.test(sessionKey) === false) {
    return { status: "failed", reason: "the answer carries no usable session key" };
  }
  const sessionIdValue = data === null ? null : data["session_id"];
  const sessionId = typeof sessionIdValue === "string" && sessionIdValue.length > 0 ? sessionIdValue : null;

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "payin.rainforest_session_created",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: input.companyId,
      merchantId: input.merchantId,
      providerObjectId: sessionId,
      outcome: "created",
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return {
    status: "created",
    sessionKey,
    sessionId,
    expiresAtEpochMs: expiresAtOf(data, ttl, options.occurredAtEpochMs),
  };
}

/** The session expiry: the provider's `expires_at` when it parses, otherwise the requested lifetime. */
function expiresAtOf(data: Readonly<Record<string, unknown>> | null, ttlSeconds: number, occurredAtEpochMs: number): number {
  const raw = data === null ? null : data["expires_at"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return occurredAtEpochMs + ttlSeconds * 1_000;
}

/**
 * The documented component contract for one payin: the element name, the bundle of the environment and
 * the two attributes the page passes. Returns null when the session key or the config id is not of the
 * documented shape, so a page can never render half a contract.
 */
export function rainforestPaymentComponentFor(
  environment: RainforestEnvironment,
  sessionKey: string,
  payinConfigId: string,
): RainforestPaymentComponent | null {
  if (RAINFOREST_SESSION_KEY_PATTERN.test(sessionKey) === false) return null;
  if (RAINFOREST_PAYIN_CONFIG_ID_PATTERN.test(payinConfigId) === false) return null;
  return {
    tag: RAINFOREST_COMPONENT_TAG,
    scriptUrl: rainforestComponentScriptUrlFor(environment),
    attributes: { "session-key": sessionKey, "payin-config-id": payinConfigId },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a payin
 * ---------------------------------------------------------------------------------------------- */

/** What reading a payin needs, and what the platform expected to see. */
export interface RainforestPayinReadInput {
  readonly companyId: string;
  readonly payinId: string;
  /** The amount the platform created the payin config for; a mismatch is never a success. */
  readonly expectedAmountMinor: bigint;
  /** The currency the platform created the payin config for. */
  readonly expectedCurrency: string;
}

/** What one payin read concluded. */
export type RainforestPayinReadResult =
  | {
      readonly status: "succeeded";
      readonly payinId: string;
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly methodType: string | null;
    }
  | {
      readonly status: "pending";
      readonly payinId: string;
      readonly payinStatus: string;
      readonly amountMinor: bigint | null;
      readonly currency: string | null;
    }
  | {
      readonly status: "failed";
      readonly payinId: string;
      readonly payinStatus: string;
      readonly refusalCode: string | null;
      /** True when the code is one the payment refusal codes page publishes. */
      readonly refusalCodeKnown: boolean;
      readonly refusalDescription: string | null;
    }
  | {
      readonly status: "unknown";
      readonly payinId: string;
      readonly requiresReconciliation: true;
      readonly reason: string;
    };

/** Read an integer amount from a provider field, or null when it is not one. */
function amountOf(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]{1,16}$/u.test(value)) return BigInt(value);
  return null;
}

/** Read a string field from a provider object, trimmed, or null. */
function stringOf(data: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read one payin and turn it into a platform outcome.
 *
 * Only `SUCCEEDED` is a success, and only when the amount and the currency the provider reports are the
 * ones the platform asked for; a mismatch is `unknown` with `requiresReconciliation`, because a payin
 * that settled a different amount must be looked at by a person, never posted as if it were ours. A
 * documented failure status carries the provider's `refusal_code` and its description (sanitised), with
 * the documented vocabulary distinguishing a known code from a new one. Every other documented status
 * is `pending`. An undocumented status, a missing `data`, an unreadable body, and every non-`2XX` answer
 * or thrown transport are `unknown` — a read can never be evidence that no money moved.
 */
export async function readRainforestPayin(
  input: RainforestPayinReadInput,
  options: RainforestPaymentOptions,
): Promise<RainforestPayinReadResult> {
  if (RAINFOREST_PAYIN_ID_PATTERN.test(input.payinId) === false) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the payin id does not carry the documented pyi or sbx_pyi prefix",
    };
  }
  if (input.expectedAmountMinor <= 0n) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the expected amount must be positive to compare a payin against it",
    };
  }

  const key = activeKeyOf(input.companyId, options);
  if (key.ok === false) {
    return { status: "unknown", payinId: input.payinId, requiresReconciliation: true, reason: key.reason };
  }

  const endpoint = rainforestPayinEndpointFor(key.environment, input.payinId);
  if (endpoint === null) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the payin id does not carry the documented pyi or sbx_pyi prefix",
    };
  }

  let answer: RainforestPaymentAnswer;
  try {
    answer = await (options.transport ?? rainforestFetchPaymentTransport)(endpoint, "GET", key.apiKey, null);
  } catch {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the API could not be reached",
    };
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "payin.rainforest_status_read",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: input.companyId,
      merchantId: "",
      providerObjectId: input.payinId,
      outcome: `${answer.status}`,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  if (answer.status < 200 || answer.status >= 300) {
    const message = rainforestErrorMessageOf(parseJson(answer.body));
    const suffix = message.length > 0 ? `: ${message}` : "";
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: `the API did not answer the read (status ${answer.status})${suffix}`,
    };
  }

  const data = dataOf(parseJson(answer.body));
  if (data === null) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the answer carries no readable payin",
    };
  }

  const payinStatus = stringOf(data, "status");
  if (payinStatus === null) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the payin carries no status",
    };
  }

  const outcome = rainforestPayinOutcomeOf(payinStatus);
  if (outcome === null) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: `the payin carries an undocumented status (${sanitizeRainforestText(payinStatus).slice(0, 40)})`,
    };
  }

  const amountMinor = amountOf(data["amount"]);
  const currency = stringOf(data, "currency_code");

  if (amountMinor === null) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the payin carries no readable amount",
    };
  }
  if (currency === null || currency !== input.expectedCurrency) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the payin settled another currency than the platform asked for",
    };
  }
  if (amountMinor !== input.expectedAmountMinor) {
    return {
      status: "unknown",
      payinId: input.payinId,
      requiresReconciliation: true,
      reason: "the payin settled another amount than the platform asked for",
    };
  }

  if (outcome === "succeeded") {
    return {
      status: "succeeded",
      payinId: input.payinId,
      amountMinor,
      currency,
      methodType: stringOf(data, "method_type"),
    };
  }

  if (outcome === "failed") {
    const refusalCode = stringOf(data, "refusal_code");
    const cleanCode =
      refusalCode === null ? null : sanitizeRainforestText(refusalCode).slice(0, RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH);
    return {
      status: "failed",
      payinId: input.payinId,
      payinStatus,
      refusalCode: cleanCode,
      refusalCodeKnown: cleanCode === null ? false : isRainforestRefusalCode(cleanCode),
      refusalDescription: refusalDescriptionOf(data),
    };
  }

  return { status: "pending", payinId: input.payinId, payinStatus, amountMinor, currency };
}

/**
 * The provider's refusal description, preferring the detailed one.
 *
 * Both are provider text, so both are sanitised and capped; the documented `refusal_desc` is used when
 * the detailed description is absent.
 */
function refusalDescriptionOf(data: Readonly<Record<string, unknown>>): string | null {
  for (const field of ["detailed_refusal_desc", "refusal_desc"]) {
    const value = data[field];
    if (typeof value === "string" && value.trim().length > 0) {
      const cleaned = sanitizeRainforestText(value).slice(0, RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH);
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}
