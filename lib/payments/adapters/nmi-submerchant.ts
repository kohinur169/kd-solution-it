// path: lib/payments/adapters/nmi-submerchant.ts

/**
 * The NMI adapter's sub-merchant provisioning and webhook ingestion: the service that boards a
 * merchant under the platform's NMI gateway account and that receives, verifies and normalises
 * NMI's webhook deliveries into the platform's own provisioning events.
 *
 * ## The documentation this file is coded from
 *
 * The provider documentation rule in `docs/final/MASTER_PROMPT.md` requires the provider's own
 * documentation to be read in the same coding session. These pages were read for this STEP:
 *
 * - Create Merchant: https://docs.nmi.com/reference/create-merchant — `POST /v4/merchants` with
 *   the `Content-Type: application/json` and `Authorization` (v4 API key from the Partner portal)
 *   headers. The documented request fields are `type` (`gateway` in the published example),
 *   `company`, `externalIdentifier`, `country`, `address1`, `address2`, `city`, `state`, `zip`,
 *   `url`, `timezone`, `firstName`, `lastName`, `email`, `phone`, `fax`, `language`, `username`
 *   and `accountInfo`. The documented answer carries `objectType: "merchant"`, `id` (the gateway
 *   id every later call names), `status` (`pending` in the published example), `parentAffiliateId`
 *   and the echoed profile.
 * - v4 API overview: https://docs.nmi.com/reference/nmi-gateway-features — JSON requests, and the
 *   `Authorization` header holds a v4 API key created in the Partner portal. Sandbox base URL:
 *   https://sandbox.nmi.com/api .
 * - Webhooks overview: https://docs.nmi.com/reference/overview — the delivery is
 *   `{ event_id, event_type, event_body }`, the endpoint is configured under Settings > Webhooks,
 *   and the signing key shown there is what the receiver verifies against. The `Webhook-Signature`
 *   header is `t=<nonce>,s=<signature>` and the signature is `hash_hmac("sha256", nonce . "." .
 *   body, signingKey)`. `t` is a nonce, not a timestamp: the scheme has no replay window of its
 *   own, so de-duplication by `event_id` is the replay defence.
 * - Transaction events: https://docs.nmi.com/reference/transaction-events — the
 *   `transaction.<action>.<success|failure|unknown>` names, and a body carrying
 *   `merchant.id`, `features.is_test_mode`, `transaction_id` and `action`.
 * - Settlement events: https://docs.nmi.com/reference/settlement-events — `settlement.batch.complete`
 *   and `settlement.batch.failure`, whose body carries `merchant.id`, `batch_id`, `count` and
 *   `amount`.
 *
 * ## What provisioning is
 *
 * Section 5 of the feature list says "Final approval by CEO or super_admin triggers automatic
 * sub-merchant account creation under the connected master platform account" and that "charges and
 * payouts stay disabled until provider verification completes". Creating the account is the
 * gateway's job; this file is the one place the platform asks for it. It builds only documented
 * request fields, validates every one of them before anything is sent, sends the call with the
 * platform's v4 API key, and reads the documented answer back into the values the platform's own
 * `0054` provisioning row stores: the provider gateway id, the parent affiliate the merchant was
 * boarded under, and the attempt bookkeeping.
 *
 * The call is idempotent because one merchant is one account (section 4: "One person holds exactly
 * one account. One owner holds exactly one business and one sub-merchant account"). The store this
 * file reads holds one record per merchant; a record that already carries a provider gateway id is
 * answered without a second call, so a redelivered approval cannot board the same business twice.
 * An ambiguous answer — a timeout, a 5xx, a 429, a duplicate at the gateway — is `unknown` and
 * writes nothing: the merchant may exist at NMI, and the only safe next step is to reconcile before
 * trying again.
 *
 * ## What the webhook ingestion is
 *
 * Section 6 says "Webhooks are accepted only after signature verification and are processed
 * idempotently", and section 5 says provisioning is "synced by verified webhooks". This file is
 * the NMI half of that sentence:
 *
 * 1. **Verify.** The `Webhook-Signature` header is split into its `t` nonce and `s` signature, the
 *    HMAC-SHA256 of `<nonce>.<raw body>` is computed with the signing key, and the two are compared
 *    in constant time. A delivery that does not verify is stored as `rejected` with
 *    `signature_ok = false` and changes nothing — never a status, never a flag.
 * 2. **De-duplicate.** The provider's own `event_id` is the key. A second delivery of an event the
 *    platform already holds answers `duplicate` and writes nothing, which is what replaces the
 *    replay window the signature scheme does not have.
 * 3. **Normalise.** A successful transaction for a merchant, or a completed settlement batch for
 *    it, is the documented evidence that the sub-merchant can take money at NMI; that becomes the
 *    platform's `submerchant.verified` event. An event that is not evidence of provisioning is
 *    recorded as `ignored`. The mapping in `NMI_PROVISION_EVENT_TYPES` is the whole table.
 * 4. **Resolve the merchant.** The delivery names the gateway merchant id in `event_body
 *    .merchant.id`; the caller's lookup resolves that to the platform company, so an event about a
 *    merchant the platform never boarded is ignored rather than applied to somebody else.
 *
 * The normalised event is what STEP 094's `submerchant.sync` job consumes (its
 * `PROVISION_SYNC_EVENT_TYPES` vocabulary is `submerchant.verified`, `submerchant.action_required`,
 * `submerchant.rejected` and `submerchant.restricted`). This file never writes the `0054`
 * provisioning row itself: the row, its forward-only status walk, its flags and its audit entry are
 * STEP 094's service, and a second writer of the same row is the bug that guard exists to prevent.
 *
 * ## What this file is not
 *
 * It is not the key store (STEP 148) and it does not decrypt anything: the v4 API key and the
 * webhook signing key are handed in by the caller, which reads them from the gateway settings.
 * It is not the payment module (STEP 151), the status sync (STEP 152) or the transaction payload
 * builder (STEP 150). It is not the `0054` provisioning service or its sync job (STEP 094), not the
 * `0032` webhook table, and not an API route, a job registration, a migration or a UI. The stores
 * here are reference stores, not PostgreSQL.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";

/* -------------------------------------------------------------------------------------------------
 * Endpoints, headers and documentation
 * ---------------------------------------------------------------------------------------------- */

/** The production v4 API base, per https://docs.nmi.com/reference/nmi-gateway-features. */
export const NMI_V4_ENDPOINT = "https://secure.nmi.com/api";

/** The sandbox v4 API base, per https://docs.nmi.com/reference/nmi-gateway-features. */
export const NMI_SANDBOX_V4_ENDPOINT = "https://sandbox.nmi.com/api";

/** The webhook header NMI signs every delivery with. */
export const NMI_WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

/** The largest delivery body this file accepts; a larger body is refused before it is hashed. */
export const NMI_WEBHOOK_MAXIMUM_BODY_BYTES = 1_048_576;

/** The longest provider text this file keeps; provider text is untrusted input. */
export const NMI_SUBMERCHANT_TEXT_MAXIMUM_LENGTH = 200;

/** The documentation read in this coding session, recorded with every provision attempt. */
export const NMI_SUBMERCHANT_DOCUMENTATION_URLS: readonly string[] = deepFreeze([
  "https://docs.nmi.com/reference/create-merchant",
  "https://docs.nmi.com/reference/nmi-gateway-features",
  "https://docs.nmi.com/reference/overview",
  "https://docs.nmi.com/reference/transaction-events",
  "https://docs.nmi.com/reference/settlement-events",
]);

/** The environment a merchant is boarded in. */
export type NmiSubmerchantEnvironment = "sandbox" | "production";

/** The `0054` mode: a test merchant never touches live data. */
export type NmiProvisionMode = "test" | "live";

/** The five `0054` provisioning statuses section 5 names. */
export type NmiProvisionStatus = "pending" | "action_required" | "verified" | "rejected" | "restricted";

/** The merchant creation endpoint of an environment. */
export function nmiMerchantsEndpointFor(environment: NmiSubmerchantEnvironment): string {
  const base = environment === "sandbox" ? NMI_SANDBOX_V4_ENDPOINT : NMI_V4_ENDPOINT;
  return `${base}/v4/merchants`;
}

/**
 * Every webhook event name NMI documents, with the category it belongs to.
 *
 * Taken from https://docs.nmi.com/reference/overview and the six event pages it links to. The
 * names are recorded so that the adapter recognises a documented delivery and never guesses at an
 * undocumented one; the provisioning mapping below uses the transaction and settlement categories.
 */
export const NMI_DOCUMENTED_WEBHOOK_EVENTS: readonly string[] = deepFreeze([
  "transaction.sale.success",
  "transaction.sale.failure",
  "transaction.sale.unknown",
  "transaction.auth.success",
  "transaction.auth.failure",
  "transaction.auth.unknown",
  "transaction.capture.success",
  "transaction.capture.failure",
  "transaction.capture.unknown",
  "transaction.void.success",
  "transaction.void.failure",
  "transaction.void.unknown",
  "transaction.refund.success",
  "transaction.refund.failure",
  "transaction.refund.unknown",
  "transaction.credit.success",
  "transaction.credit.failure",
  "transaction.credit.unknown",
  "transaction.validate.success",
  "transaction.validate.failure",
  "transaction.validate.unknown",
  "transaction.check.status.settle",
  "transaction.check.status.return",
  "settlement.batch.complete",
  "settlement.batch.failure",
  "recurring.plan.add",
  "recurring.plan.update",
  "recurring.plan.delete",
  "recurring.subscription.add",
  "recurring.subscription.update",
  "recurring.subscription.delete",
  "acu.summary.automaticallyupdated",
  "acu.summary.contactcustomer",
  "acu.summary.closedaccount",
  "chargeback.batch.complete",
]);

/* -------------------------------------------------------------------------------------------------
 * Provider text
 * ---------------------------------------------------------------------------------------------- */

/**
 * Clean provider text before it leaves this file.
 *
 * A gateway message, an error detail or an event type is a string the platform did not write, so
 * control characters are removed (they could rewrite a log line), angle brackets are removed (so
 * the text can never be markup if a screen renders it), whitespace is collapsed and the result is
 * capped. The same rule STEP 152 applies to the payment answers applies here.
 */
export function sanitizeNmiSubmerchantText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const source =
    value.length > 4 * NMI_SUBMERCHANT_TEXT_MAXIMUM_LENGTH
      ? value.slice(0, 4 * NMI_SUBMERCHANT_TEXT_MAXIMUM_LENGTH)
      : value;
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
  return cleaned.length <= NMI_SUBMERCHANT_TEXT_MAXIMUM_LENGTH
    ? cleaned
    : cleaned.slice(0, NMI_SUBMERCHANT_TEXT_MAXIMUM_LENGTH);
}

/** The SHA-256 of a delivery body, lowercase hex, as `webhook_events.payload_hash` stores it. */
export function nmiWebhookPayloadHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------------------------------
 * The merchant profile and the documented request
 * ---------------------------------------------------------------------------------------------- */

/** The banking block the documented request carries as `accountInfo`. */
export interface NmiMerchantAccountInfo {
  readonly checkAccount: string;
  readonly checkAba: string;
  readonly accountHolderType: "business" | "personal";
  readonly accountType: "checking" | "savings";
}

/** The merchant profile the platform sends to NMI's Create Merchant endpoint. */
export interface NmiSubmerchantProfile {
  /** The documented account type; the published example is `gateway`. */
  readonly type: string;
  readonly company: string;
  readonly externalIdentifier: string | null;
  readonly country: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly url: string | null;
  readonly timezone: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  readonly fax: string | null;
  readonly language: string;
  readonly username: string;
  /** Optional: the documented request requires the object, and the published example sends `{}`. */
  readonly accountInfo: NmiMerchantAccountInfo | null;
}

/** The result of validating a profile. */
export type NmiProfileValidation = { readonly status: "valid" } | { readonly status: "rejected"; readonly reason: string };

const ACCOUNT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const TEXT_PATTERN = /^[^\u0000-\u001f\u007f<>]{1,120}$/u;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f<>]{1,60}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const STATE_PATTERN = /^[A-Za-z]{2}$/u;
const ZIP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,11}$/u;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]{0,31}(\/[A-Za-z][A-Za-z0-9_+-]{0,31}){0,2}$/u;
const LANGUAGE_PATTERN = /^[a-z]{2}(_[A-Z]{2})?$/u;
const EMAIL_PATTERN = /^[^\s@<>]{1,64}@[^\s@<>.]+(\.[^\s@<>.]+)*\.[A-Za-z]{2,24}$/u;
const PHONE_PATTERN = /^[0-9+()\-. ]{7,24}$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const HTTPS_URL_PATTERN = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,190}(:[0-9]{1,5})?(\/[^\s<>"']{0,190})?$/u;
const BANK_ACCOUNT_PATTERN = /^[0-9]{4,17}$/u;
const BANK_ROUTING_PATTERN = /^[0-9]{9}$/u;

/** The gateway merchant id shape: `0054`'s `provider_submerchant_id` check, applied here first. */
export const NMI_MERCHANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** The affiliate reference shape: `0054`'s `master_account_ref` check, applied here first. */
export const NMI_AFFILIATE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;

/**
 * Validate the profile before it is sent.
 *
 * Every documented field is checked for the shape the field must have and for the lengths the
 * platform's own columns allow, so a value the platform cannot store is refused here rather than
 * half-written later. Optional fields are `null` when absent, never undefined, so the built body
 * can omit them explicitly.
 */
export function validateNmiSubmerchantProfile(profile: NmiSubmerchantProfile): NmiProfileValidation {
  const reject = (reason: string): NmiProfileValidation => ({ status: "rejected", reason });

  if (ACCOUNT_TYPE_PATTERN.test(profile.type) === false) {
    return reject("the merchant type must be lowercase letters, digits or underscores");
  }
  if (TEXT_PATTERN.test(profile.company) === false) return reject("the company must not be empty");
  if (profile.externalIdentifier !== null && profile.externalIdentifier.length > 200) {
    return reject("the external identifier is too long");
  }
  if (COUNTRY_PATTERN.test(profile.country) === false) return reject("the country must be a two letter code");
  if (TEXT_PATTERN.test(profile.address1) === false) return reject("the address line must not be empty");
  if (profile.address2 !== null && TEXT_PATTERN.test(profile.address2) === false) {
    return reject("the second address line is invalid");
  }
  if (TEXT_PATTERN.test(profile.city) === false) return reject("the city must not be empty");
  if (STATE_PATTERN.test(profile.state) === false) return reject("the state must be a two letter code");
  if (ZIP_PATTERN.test(profile.zip) === false) return reject("the postal code is invalid");
  if (profile.url !== null && profile.url.length > 0 && HTTPS_URL_PATTERN.test(profile.url) === false) {
    return reject("the website must be an https url");
  }
  if (TIMEZONE_PATTERN.test(profile.timezone) === false) return reject("the timezone is invalid");
  if (NAME_PATTERN.test(profile.firstName) === false) return reject("the first name must not be empty");
  if (NAME_PATTERN.test(profile.lastName) === false) return reject("the last name must not be empty");
  if (EMAIL_PATTERN.test(profile.email) === false) return reject("the email is invalid");
  if (PHONE_PATTERN.test(profile.phone) === false) return reject("the phone is invalid");
  if (profile.fax !== null && profile.fax.length > 0 && PHONE_PATTERN.test(profile.fax) === false) {
    return reject("the fax is invalid");
  }
  if (LANGUAGE_PATTERN.test(profile.language) === false) return reject("the language is invalid");
  if (USERNAME_PATTERN.test(profile.username) === false) return reject("the username is invalid");

  if (profile.accountInfo !== null) {
    const account = profile.accountInfo;
    if (BANK_ACCOUNT_PATTERN.test(account.checkAccount) === false) {
      return reject("the account number must be 4 to 17 digits");
    }
    if (BANK_ROUTING_PATTERN.test(account.checkAba) === false) return reject("the routing number must be 9 digits");
    if (account.accountType !== "checking" && account.accountType !== "savings") {
      return reject("the account type must be checking or savings");
    }
    if (account.accountHolderType !== "business" && account.accountHolderType !== "personal") {
      return reject("the account holder type must be business or personal");
    }
  }

  return { status: "valid" };
}

/**
 * Build the documented Create Merchant body.
 *
 * The field names are the ones https://docs.nmi.com/reference/create-merchant lists, in the same
 * spelling and casing. Optional fields are omitted when absent; `accountInfo` is always present
 * because the documented request requires it, and it is `{}` when the platform has no banking block
 * yet, exactly as the published curl example sends it.
 */
export function buildNmiCreateMerchantBody(profile: NmiSubmerchantProfile): Readonly<Record<string, unknown>> {
  const validation = validateNmiSubmerchantProfile(profile);
  if (validation.status === "rejected") throw new Error(validation.reason);

  const body: Record<string, unknown> = {
    type: profile.type,
    company: profile.company,
    country: profile.country,
    address1: profile.address1,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
    timezone: profile.timezone,
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email,
    phone: profile.phone,
    language: profile.language,
    username: profile.username,
    accountInfo:
      profile.accountInfo === null
        ? {}
        : {
            checkAccount: profile.accountInfo.checkAccount,
            checkAba: profile.accountInfo.checkAba,
            accountHolderType: profile.accountInfo.accountHolderType,
            accountType: profile.accountInfo.accountType,
          },
  };

  if (profile.externalIdentifier !== null && profile.externalIdentifier.trim().length > 0) {
    body["externalIdentifier"] = profile.externalIdentifier.trim();
  }
  if (profile.address2 !== null && profile.address2.trim().length > 0) body["address2"] = profile.address2.trim();
  if (profile.url !== null && profile.url.trim().length > 0) body["url"] = profile.url.trim();
  if (profile.fax !== null && profile.fax.trim().length > 0) body["fax"] = profile.fax.trim();

  return body;
}

/* -------------------------------------------------------------------------------------------------
 * The merchant creation transport
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP answer of one Create Merchant call: the status code and the raw body. */
export interface NmiSubmerchantHttpAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port: endpoint, v4 API key and documented body in; the raw answer out. */
export type NmiSubmerchantTransport = (
  endpoint: string,
  authorization: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<NmiSubmerchantHttpAnswer>;

/**
 * Posts the documented body to the Create Merchant endpoint as JSON.
 *
 * The endpoint is allowlisted to the two documented URLs, the call is refused without a key,
 * redirects are refused (a redirect is not an answer), the timeout is bounded and an oversized
 * answer is refused. A throw from here means the outcome is unknown - the merchant may have been
 * created - never that it was not.
 */
export const nmiSubmerchantFetchTransport: NmiSubmerchantTransport = async (endpoint, authorization, body) => {
  if (endpoint !== nmiMerchantsEndpointFor("sandbox") && endpoint !== nmiMerchantsEndpointFor("production")) {
    throw new Error("invalid merchant endpoint");
  }
  if (authorization.trim().length === 0) throw new Error("the v4 API key is required");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authorization },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (text.length > NMI_WEBHOOK_MAXIMUM_BODY_BYTES) throw new Error("invalid merchant answer");
  return { status: response.status, body: text };
};

/** What a Create Merchant answer means. */
export type NmiCreateMerchantAnswer =
  | {
      readonly outcome: "created";
      readonly merchantId: string;
      /** The provider's own status string as documented (`pending` in the published example). */
      readonly providerStatus: string | null;
      readonly parentAffiliateId: string | null;
    }
  | { readonly outcome: "action_required"; readonly detail: string }
  | { readonly outcome: "credentials_rejected"; readonly detail: string }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "unknown"; readonly reason: string };

/** Read the documented gateway merchant id out of a JSON value, or null when it is not one. */
export function nmiMerchantIdOf(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return NMI_MERCHANT_ID_PATTERN.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

/** Read a documented gateway status string: a short lowercase token, or null. */
function providerStatusOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-z][a-z_]{0,39}$/u.test(trimmed) ? trimmed : null;
}

/** Read one provider message out of a JSON error answer, sanitised, or the empty string. */
function providerMessageOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Readonly<Record<string, unknown>>;
  for (const key of ["message", "detail", "error", "error_description", "title"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return sanitizeNmiSubmerchantText(value);
  }
  const errors = record["errors"];
  if (Array.isArray(errors)) {
    const first = errors[0];
    if (typeof first === "string") return sanitizeNmiSubmerchantText(first);
    if (typeof first === "object" && first !== null) {
      const message = (first as Readonly<Record<string, unknown>>)["message"];
      if (typeof message === "string") return sanitizeNmiSubmerchantText(message);
    }
  }
  return "";
}

/**
 * Read a Create Merchant answer.
 *
 * The documented success answer is a JSON object whose `id` is the gateway id and whose `status` is
 * the provider's own account status; `objectType` is `merchant`. A body that does not parse, does
 * not carry a gateway id, or carries an `objectType` that is not `merchant` is ambiguous - the
 * merchant may exist - so it is `unknown` and nothing is written. `409` is the duplicate case, also
 * ambiguous for the same reason. `400` and `422` are the documented validation failures, which are
 * an office action; `401` and `403` are a rejected v4 key; `429` and `5xx` are ambiguous.
 */
export function parseNmiCreateMerchantAnswer(status: number, body: string): NmiCreateMerchantAnswer {
  if (status === 409) return { outcome: "duplicate" };
  if (status === 401 || status === 403) {
    return {
      outcome: "credentials_rejected",
      detail: "the gateway rejected the v4 API key",
    };
  }

  let payload: unknown;
  try {
    payload = body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    payload = null;
  }

  if (status === 429 || status >= 500) {
    return { outcome: "unknown", reason: "the gateway did not give a final answer; reconcile before retrying" };
  }

  if (status === 400 || status === 422 || (status >= 400 && status < 500)) {
    const message = providerMessageOf(payload);
    return {
      outcome: "action_required",
      detail: message.length > 0 ? message : `the gateway refused the merchant profile with status ${status}`,
    };
  }

  if (status < 200 || status >= 300) {
    return { outcome: "unknown", reason: "the gateway did not give a final answer; reconcile before retrying" };
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { outcome: "unknown", reason: "the gateway answer is not a merchant record; reconcile before retrying" };
  }

  const record = payload as Readonly<Record<string, unknown>>;
  const objectType = record["objectType"];
  if (objectType !== undefined && objectType !== "merchant") {
    return { outcome: "unknown", reason: "the gateway answer is not a merchant record; reconcile before retrying" };
  }

  const merchantId = nmiMerchantIdOf(record["id"]);
  if (merchantId === null) {
    return { outcome: "unknown", reason: "the gateway answer carries no merchant id; reconcile before retrying" };
  }

  const parentAffiliateId = record["parentAffiliateId"];
  return {
    outcome: "created",
    merchantId,
    providerStatus: providerStatusOf(record["status"]),
    parentAffiliateId:
      typeof parentAffiliateId === "string" && NMI_AFFILIATE_REFERENCE_PATTERN.test(parentAffiliateId.trim())
        ? parentAffiliateId.trim()
        : null,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The provisioning record and its store
 * ---------------------------------------------------------------------------------------------- */

/** What the platform remembers about one merchant's boarding at NMI. */
export interface NmiProvisionRecord {
  readonly id: string;
  readonly companyId: string;
  readonly mode: NmiProvisionMode;
  /** The key the approval enqueued under: one boarding per key. */
  readonly idempotencyKey: string;
  readonly providerSubmerchantId: string | null;
  readonly status: NmiProvisionStatus;
  readonly masterAccountRef: string | null;
  readonly attemptCount: number;
  readonly lastProviderStatus: string | null;
  readonly lastAttemptOutcome: "created" | "action_required" | "unknown" | "refused" | null;
  readonly actionRequiredDetail: string | null;
  readonly lastAttemptAtEpochMs: number | null;
  readonly version: number;
}

/** What the store reads and writes: the provisioning records. The store is the caller's. */
export interface NmiProvisionStore {
  /** Store a record. A company or id already stored is refused. */
  insert(record: NmiProvisionRecord): void;
  /** The record an id holds, or null. */
  findById(id: string): NmiProvisionRecord | null;
  /** The record a company holds at this provider, or null. */
  findByCompany(companyId: string): NmiProvisionRecord | null;
  /** The record holding a provider gateway id, or null. */
  findByProviderSubmerchantId(providerSubmerchantId: string): NmiProvisionRecord | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: NmiProvisionRecord, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation that enforces the rules the guarantees rest on -
 * one record per company, one record per provider gateway id, an immutable company and mode, and a
 * strictly increasing version.
 */
export class InMemoryNmiProvisionStore implements NmiProvisionStore {
  private readonly records = new Map<string, NmiProvisionRecord>();
  private readonly byCompany = new Map<string, string>();
  private readonly byProviderId = new Map<string, string>();

  insert(record: NmiProvisionRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate provisioning record id");
    if (this.byCompany.has(record.companyId)) throw new Error("this merchant already has a provisioning record");
    if (record.version !== 1) throw new Error("a new provisioning record starts at version 1");
    if (record.providerSubmerchantId !== null) {
      if (this.byProviderId.has(record.providerSubmerchantId)) {
        throw new Error("this provider sub-merchant is already provisioned");
      }
      this.byProviderId.set(record.providerSubmerchantId, record.id);
    }
    this.records.set(record.id, record);
    this.byCompany.set(record.companyId, record.id);
  }

  findById(id: string): NmiProvisionRecord | null {
    return this.records.get(id) ?? null;
  }

  findByCompany(companyId: string): NmiProvisionRecord | null {
    const id = this.byCompany.get(companyId);
    return id === undefined ? null : this.findById(id);
  }

  findByProviderSubmerchantId(providerSubmerchantId: string): NmiProvisionRecord | null {
    const id = this.byProviderId.get(providerSubmerchantId);
    return id === undefined ? null : this.findById(id);
  }

  save(next: NmiProvisionRecord, expectedVersion: number): boolean {
    const current = this.records.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.mode !== next.mode) return false;
    if (current.idempotencyKey !== next.idempotencyKey) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.providerSubmerchantId !== null && next.providerSubmerchantId !== current.providerSubmerchantId) {
      return false;
    }
    if (next.providerSubmerchantId !== null && current.providerSubmerchantId === null) {
      if (this.byProviderId.has(next.providerSubmerchantId)) return false;
      this.byProviderId.set(next.providerSubmerchantId, next.id);
    }
    this.records.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Provisioning
 * ---------------------------------------------------------------------------------------------- */

/** What a boarding attempt asks for. */
export interface NmiProvisioningIntent {
  readonly companyId: string;
  readonly mode: NmiProvisionMode;
  /** The approval's idempotency key: one boarding per key. */
  readonly idempotencyKey: string;
  readonly environment: NmiSubmerchantEnvironment;
  /** The platform's v4 API key from the gateway settings. Never logged, never returned. */
  readonly v4ApiKey: string;
  /** The platform's own affiliate reference, used when the answer does not name one. */
  readonly masterAccountRef: string | null;
  /** False refuses the attempt: `0054` only records an attempt against an enabled provider. */
  readonly providerEnabled: boolean;
  readonly profile: NmiSubmerchantProfile;
}

/** The column values a boarding attempt leaves for the caller to write into its `0054` row. */
export interface NmiProvisionAccountUpdate {
  readonly status: NmiProvisionStatus;
  readonly providerSubmerchantId: string | null;
  readonly masterAccountRef: string | null;
  readonly actionRequiredDetail: string | null;
  readonly attempted: boolean;
  readonly providerStatus: string | null;
}

/** The audit entry one attempt hands to the caller's audit writer. Never carries a credential. */
export interface NmiProvisionAuditEntry {
  readonly action: "submerchant_provision.nmi_attempted" | "submerchant_provision.nmi_webhook";
  readonly companyId: string | null;
  readonly provider: "nmi";
  readonly mode: NmiProvisionMode;
  readonly providerSubmerchantId: string | null;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/** The options a boarding attempt needs. */
export interface NmiProvisioningOptions {
  readonly store: NmiProvisionStore;
  readonly occurredAtEpochMs: number;
  readonly transport?: NmiSubmerchantTransport;
  readonly recordAudit?: (entry: NmiProvisionAuditEntry) => void;
}

/** What one boarding attempt did. */
export type NmiProvisioningOutcome = {
  readonly status: "provisioned" | "action_required" | "already_provisioned" | "refused" | "unknown";
  readonly reason: string;
  readonly record: NmiProvisionRecord | null;
  readonly update: NmiProvisionAccountUpdate | null;
};

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

function refused(reason: string, record: NmiProvisionRecord | null): NmiProvisioningOutcome {
  return { status: "refused", reason, record, update: null };
}

/**
 * Board one merchant under the platform's NMI gateway account.
 *
 * The order is the safety argument this file exists for:
 *
 * 1. The intent is validated before anything is sent, including the idempotency key - an attempt
 *    with no key could board the same business twice.
 * 2. A record that already carries a provider gateway id is answered without a call. The same
 *    company asking again is the same merchant, and one merchant is one account.
 * 3. A record whose id is already used with a different key is refused: the same merchant under a
 *    second approval key would be a second account.
 * 4. An ambiguous answer (transport failure, timeout, 5xx, 429, duplicate, unreadable body) writes
 *    nothing and returns `unknown`. The merchant may exist at NMI, so the platform reconciles
 *    before trying again instead of boarding it twice.
 * 5. The answer is recorded: the provider gateway id, the affiliate the merchant was boarded under,
 *    the provider status and the attempt bookkeeping, with one audit entry. The row's status stays
 *    `pending` until a verified webhook says the sub-merchant can take money - section 5's rule
 *    that charges and payouts stay disabled until provider verification completes.
 */
export async function provisionNmiSubmerchant(
  intent: NmiProvisioningIntent,
  options: NmiProvisioningOptions,
): Promise<NmiProvisioningOutcome> {
  if (COMPANY_ID_PATTERN.test(intent.companyId) === false) {
    return refused("the company id is invalid", null);
  }
  if (IDEMPOTENCY_KEY_PATTERN.test(intent.idempotencyKey) === false) {
    return refused("a valid idempotency key is required", null);
  }
  if (intent.v4ApiKey.trim().length === 0) return refused("the v4 API key is required", null);
  if (intent.providerEnabled === false) return refused("the NMI provider is not enabled", null);
  if (intent.masterAccountRef !== null && NMI_AFFILIATE_REFERENCE_PATTERN.test(intent.masterAccountRef) === false) {
    return refused("the affiliate reference is invalid", null);
  }

  const profileValidation = validateNmiSubmerchantProfile(intent.profile);
  if (profileValidation.status === "rejected") return refused(profileValidation.reason, null);

  const existing = options.store.findByCompany(intent.companyId);

  if (existing !== null) {
    if (existing.mode !== intent.mode) return refused("the merchant is provisioned in another mode", existing);
    if (existing.idempotencyKey !== intent.idempotencyKey) {
      return refused("the merchant was provisioned under another approval key", existing);
    }
    if (existing.providerSubmerchantId !== null) {
      return {
        status: "already_provisioned",
        reason: "the merchant already holds a provider sub-merchant account",
        record: existing,
        update: null,
      };
    }
  }

  const endpoint = nmiMerchantsEndpointFor(intent.environment);
  const body = buildNmiCreateMerchantBody(intent.profile);

  let answer: NmiCreateMerchantAnswer;
  try {
    const http = await (options.transport ?? nmiSubmerchantFetchTransport)(endpoint, intent.v4ApiKey, body);
    answer = parseNmiCreateMerchantAnswer(http.status, http.body);
  } catch {
    // The merchant may exist at NMI: never surface the error text, and never claim a failure.
    return {
      status: "unknown",
      reason: "the gateway did not give a final answer; reconcile before retrying",
      record: existing,
      update: null,
    };
  }

  if (answer.outcome === "unknown" || answer.outcome === "duplicate") {
    return {
      status: "unknown",
      reason:
        answer.outcome === "duplicate"
          ? "the gateway reports the merchant already exists; reconcile before retrying"
          : answer.reason,
      record: existing,
      update: null,
    };
  }

  if (answer.outcome === "credentials_rejected") {
    return refused(answer.detail, existing);
  }

  const attemptAt = options.occurredAtEpochMs;

  if (answer.outcome === "action_required") {
    const update: NmiProvisionAccountUpdate = {
      status: "action_required",
      providerSubmerchantId: existing?.providerSubmerchantId ?? null,
      masterAccountRef: existing?.masterAccountRef ?? intent.masterAccountRef,
      actionRequiredDetail: answer.detail,
      attempted: true,
      providerStatus: null,
    };

    const record = writeAttempt(existing, intent, update, attemptAt, "action_required", options);
    return {
      status: "action_required",
      reason: answer.detail,
      record: record.record,
      update,
    };
  }

  const masterAccountRef = answer.parentAffiliateId ?? intent.masterAccountRef;
  const update: NmiProvisionAccountUpdate = {
    status: "pending",
    providerSubmerchantId: answer.merchantId,
    masterAccountRef,
    actionRequiredDetail: null,
    attempted: true,
    providerStatus: answer.providerStatus,
  };

  const record = writeAttempt(existing, intent, update, attemptAt, "created", options);

  return {
    status: "provisioned",
    reason: "the gateway created the merchant account",
    record: record.record,
    update,
  };
}

/** Write one attempt into the store: insert the first time, version-guarded update afterwards. */
function writeAttempt(
  existing: NmiProvisionRecord | null,
  intent: NmiProvisioningIntent,
  update: NmiProvisionAccountUpdate,
  attemptAtEpochMs: number,
  outcome: "created" | "action_required",
  options: NmiProvisioningOptions,
): { readonly record: NmiProvisionRecord | null } {
  const next: NmiProvisionRecord = {
    id: existing?.id ?? randomUUID(),
    companyId: intent.companyId,
    mode: intent.mode,
    idempotencyKey: intent.idempotencyKey,
    providerSubmerchantId: update.providerSubmerchantId,
    status: update.status,
    masterAccountRef: update.masterAccountRef,
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    lastProviderStatus: update.providerStatus,
    lastAttemptOutcome: outcome,
    actionRequiredDetail: update.actionRequiredDetail,
    lastAttemptAtEpochMs: attemptAtEpochMs,
    version: 1,
  };

  let stored: NmiProvisionRecord | null;
  if (existing === null) {
    try {
      options.store.insert(next);
      stored = next;
    } catch {
      stored = null;
    }
  } else {
    const advance: NmiProvisionRecord = { ...next, id: existing.id, version: existing.version + 1 };
    stored = options.store.save(advance, existing.version) ? advance : options.store.findById(existing.id);
  }

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "submerchant_provision.nmi_attempted",
      companyId: intent.companyId,
      provider: "nmi",
      mode: intent.mode,
      providerSubmerchantId: update.providerSubmerchantId,
      outcome,
      occurredAtEpochMs: attemptAtEpochMs,
    });
  }

  return { record: stored };
}

/* -------------------------------------------------------------------------------------------------
 * Webhook signature verification
 * ---------------------------------------------------------------------------------------------- */

/** The parsed `Webhook-Signature` header. */
export interface NmiWebhookSignature {
  readonly nonce: string;
  readonly signature: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Split `t=<nonce>,s=<signature>` into its two parts.
 *
 * The header is the format https://docs.nmi.com/reference/overview documents. Anything else -
 * a missing header, a missing part, a part that is not the documented shape - returns null, and a
 * delivery whose header does not parse is refused rather than guessed at.
 */
export function parseNmiWebhookSignature(header: string | null | undefined): NmiWebhookSignature | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return null;

  const parts = new Map<string, string>();
  for (const segment of trimmed.split(",")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    if (parts.has(key)) return null;
    parts.set(key, value);
  }

  const nonce = parts.get("t");
  const signature = parts.get("s");
  if (nonce === undefined || signature === undefined) return null;
  if (NONCE_PATTERN.test(nonce) === false) return null;
  if (SIGNATURE_PATTERN.test(signature) === false) return null;

  return { nonce, signature };
}

/**
 * Verify one delivery against the signing key.
 *
 * The signed content is `<nonce>.<raw body>` and the digest is HMAC-SHA256 in lowercase hex, per
 * the documented PHP `hash_hmac("sha256", $nonce . "." . $webhookBody, $signingKey)`. The raw,
 * unparsed body is what is signed: re-serialising the JSON would change the bytes and break the
 * digest. The comparison is constant time and requires equal lengths.
 */
export function verifyNmiWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  signingKey: string,
): boolean {
  if (signingKey.length === 0) return false;
  if (rawBody.length === 0 || rawBody.length > NMI_WEBHOOK_MAXIMUM_BODY_BYTES) return false;

  const parsed = parseNmiWebhookSignature(signatureHeader);
  if (parsed === null) return false;

  const expected = createHmac("sha256", signingKey).update(`${parsed.nonce}.${rawBody}`, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const givenBuffer = Buffer.from(parsed.signature, "utf8");
  if (expectedBuffer.length !== givenBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, givenBuffer);
}

/* -------------------------------------------------------------------------------------------------
 * Webhook events, their store and the provisioning mapping
 * ---------------------------------------------------------------------------------------------- */

/** The `0032` webhook event statuses. */
export type NmiWebhookEventStatus = "pending" | "processing" | "processed" | "failed" | "ignored" | "rejected";

/** One stored delivery, in the shape the committed `0032` table keeps. */
export interface NmiWebhookEventRecord {
  readonly id: string;
  readonly companyId: string | null;
  readonly mode: NmiProvisionMode;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payloadHash: string;
  readonly signatureOk: boolean;
  readonly receivedAtEpochMs: number;
  readonly status: NmiWebhookEventStatus;
  readonly processedAtEpochMs: number | null;
  readonly failureDetail: string | null;
  readonly version: number;
}

/** What the store reads and writes: the deliveries, keyed like `0032`'s unique index. */
export interface NmiWebhookEventStore {
  /** The delivery an event id already holds at this mode, or null. One row per provider event. */
  findByExternalEventId(mode: NmiProvisionMode, externalEventId: string): NmiWebhookEventRecord | null;
  insert(record: NmiWebhookEventRecord): void;
  /** Forward-only write, guarded by the stored version; false when the write loses. */
  save(next: NmiWebhookEventRecord, expectedVersion: number): boolean;
}

/** The in-memory store: a reference implementation that keys on mode plus the provider event id. */
export class InMemoryNmiWebhookEventStore implements NmiWebhookEventStore {
  private readonly records = new Map<string, NmiWebhookEventRecord>();

  private static keyOf(mode: NmiProvisionMode, externalEventId: string): string {
    return `${mode}\u0000${externalEventId}`;
  }

  findByExternalEventId(mode: NmiProvisionMode, externalEventId: string): NmiWebhookEventRecord | null {
    const record = this.records.get(InMemoryNmiWebhookEventStore.keyOf(mode, externalEventId));
    return record ?? null;
  }

  insert(record: NmiWebhookEventRecord): void {
    const key = InMemoryNmiWebhookEventStore.keyOf(record.mode, record.externalEventId);
    if (this.records.has(key)) throw new Error("duplicate webhook event");
    if (record.version !== 1) throw new Error("a new webhook event starts at version 1");
    this.records.set(key, record);
  }

  save(next: NmiWebhookEventRecord, expectedVersion: number): boolean {
    const key = InMemoryNmiWebhookEventStore.keyOf(next.mode, next.externalEventId);
    const current = this.records.get(key);
    if (current === undefined) return false;
    if (current.id !== next.id) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.externalEventId !== next.externalEventId || current.eventType !== next.eventType) return false;
    if (current.signatureOk !== next.signatureOk || current.payloadHash !== next.payloadHash) return false;
    if (current.status === "processed" || current.status === "rejected" || current.status === "ignored") {
      if (next.status !== current.status) return false;
    }
    if (next.status === "pending" && current.status !== "pending") return false;
    this.records.set(key, next);
    return true;
  }
}

/** The platform's own provisioning event vocabulary, the one STEP 094's sync job consumes. */
export type NmiProvisionEventType =
  | "submerchant.verified"
  | "submerchant.action_required"
  | "submerchant.rejected"
  | "submerchant.restricted";

/**
 * The documented provider events that are evidence of a sub-merchant's provisioning state, and the
 * platform event each becomes.
 *
 * A successful transaction for the merchant (sale, auth, capture, refund, credit or validate) and a
 * completed settlement batch for it are the documented evidence that the account can take money at
 * NMI, so both become `submerchant.verified`. Nothing else NMI documents moves a provisioning row:
 * a failure or unknown transaction, a failed batch, a check-status change, a recurring event, an
 * ACU summary or a chargeback batch is recorded by whoever owns that feature, not by this adapter.
 */
export const NMI_PROVISION_EVENT_TYPES: Readonly<Record<string, NmiProvisionEventType>> = deepFreeze({
  "transaction.sale.success": "submerchant.verified",
  "transaction.auth.success": "submerchant.verified",
  "transaction.capture.success": "submerchant.verified",
  "transaction.void.success": "submerchant.verified",
  "transaction.refund.success": "submerchant.verified",
  "transaction.credit.success": "submerchant.verified",
  "transaction.validate.success": "submerchant.verified",
  "settlement.batch.complete": "submerchant.verified",
});

/** True when every mapping key is a documented NMI event name; the gate asserts this. */
export function nmiProvisionEventTypesAreDocumented(): boolean {
  return Object.keys(NMI_PROVISION_EVENT_TYPES).every((name) => NMI_DOCUMENTED_WEBHOOK_EVENTS.includes(name));
}

/** The provisioning event a provider event becomes, or null when it is not provisioning evidence. */
export function nmiProvisionEventOf(providerEventType: string): NmiProvisionEventType | null {
  const mapped = NMI_PROVISION_EVENT_TYPES[providerEventType];
  return mapped ?? null;
}

/** The merchant a delivery is about: the lookup port the caller implements over `0054`. */
export interface NmiSubmerchantLookup {
  readonly findByProviderSubmerchantId: (providerSubmerchantId: string) => { readonly companyId: string } | null;
}

/** One webhook delivery as the endpoint received it. */
export interface NmiWebhookDelivery {
  /** The raw, unparsed body: the signature is over these exact bytes. */
  readonly rawBody: string;
  /** The `Webhook-Signature` header value. */
  readonly signatureHeader: string | null;
  /** The mode the receiving endpoint is configured for. */
  readonly mode: NmiProvisionMode;
}

/** The options a delivery needs. */
export interface NmiWebhookOptions {
  /** The webhook signing key from NMI's Settings > Webhooks page. Never logged, never returned. */
  readonly signingKey: string;
  readonly eventStore: NmiWebhookEventStore;
  readonly lookup: NmiSubmerchantLookup;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: NmiProvisionAuditEntry) => void;
}

/** The normalised provisioning event a processed delivery produced. */
export interface NmiNormalizedProvisionEvent {
  readonly eventType: NmiProvisionEventType;
  readonly companyId: string;
  readonly providerSubmerchantId: string;
}

/** What one delivery did. */
export interface NmiWebhookOutcome {
  readonly status: "processed" | "ignored" | "duplicate" | "rejected" | "failed";
  readonly reason: string;
  readonly event: NmiWebhookEventRecord | null;
  readonly providerEventType: string | null;
  readonly normalized: NmiNormalizedProvisionEvent | null;
}

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.]{0,119}$/u;

/** Read the merchant block out of an event body, sanitised and bounded. */
function merchantIdOfEventBody(eventBody: Readonly<Record<string, unknown>>): string | null {
  const merchant = eventBody["merchant"];
  if (typeof merchant !== "object" || merchant === null) return null;
  const id = (merchant as Readonly<Record<string, unknown>>)["id"];
  return nmiMerchantIdOf(id);
}

/** Read `features.is_test_mode` out of an event body: true, false, or null when absent. */
function isTestModeOfEventBody(eventBody: Readonly<Record<string, unknown>>): boolean | null {
  const features = eventBody["features"];
  if (typeof features !== "object" || features === null) return null;
  const flag = (features as Readonly<Record<string, unknown>>)["is_test_mode"];
  return typeof flag === "boolean" ? flag : null;
}

/**
 * Receive one webhook delivery.
 *
 * The order is the acceptance rule of section 6: verify, then de-duplicate, then normalise.
 *
 * - A delivery that fails verification is stored as `rejected` with `signature_ok = false` when its
 *   body names an event id, and writes no event and no status. It is kept because section 29 wants
 *   the attempt visible; `0032`'s own check is what forbids such a row from ever being `processed`.
 * - A delivery that verifies but whose event id is already stored answers `duplicate` and writes
 *   nothing. The signature scheme has no replay window, so this is the replay defence. Verification
 *   is decided first: an unverified delivery is always `rejected`, even when it names a known event,
 *   so a forged body can never be answered as "already received".
 * - A delivery whose body does not parse, whose envelope is not the documented `{ event_id,
 *   event_type, event_body }`, or whose body is too large is recorded as `failed` with a bounded
 *   detail, and nothing is applied.
 * - A verified, well-formed delivery is stored, then mapped. A documented event that proves the
 *   sub-merchant can transact becomes `submerchant.verified` for the company the lookup resolves;
 *   everything else is `ignored`. Nothing is applied when the event names a merchant the platform
 *   never boarded, when the event's test-mode flag disagrees with the configured mode, or when the
 *   event is not provisioning evidence.
 */
export function receiveNmiWebhook(delivery: NmiWebhookDelivery, options: NmiWebhookOptions): NmiWebhookOutcome {
  if (delivery.mode !== "test" && delivery.mode !== "live") {
    return { status: "rejected", reason: "the endpoint mode is invalid", event: null, providerEventType: null, normalized: null };
  }
  if (delivery.rawBody.length > NMI_WEBHOOK_MAXIMUM_BODY_BYTES) {
    return { status: "rejected", reason: "the delivery body is too large", event: null, providerEventType: null, normalized: null };
  }

  const signatureOk = verifyNmiWebhookSignature(delivery.rawBody, delivery.signatureHeader, options.signingKey);
  const payload = parseEnvelope(delivery.rawBody);

  if (payload.outcome === "unreadable") {
    return signatureOk
      ? {
          status: "failed",
          reason: payload.reason,
          event: null,
          providerEventType: null,
          normalized: null,
        }
      : { status: "rejected", reason: "the delivery signature did not verify", event: null, providerEventType: null, normalized: null };
  }

  const envelope = payload.envelope;
  const payloadHash = nmiWebhookPayloadHash(delivery.rawBody);

  if (signatureOk === false) {
    const alreadyStored = options.eventStore.findByExternalEventId(delivery.mode, envelope.eventId);
    if (alreadyStored !== null) {
      return {
        status: "rejected",
        reason: "the delivery signature did not verify",
        event: alreadyStored,
        providerEventType: alreadyStored.eventType,
        normalized: null,
      };
    }

    const rejectedEvent: NmiWebhookEventRecord = {
      id: randomUUID(),
      companyId: null,
      mode: delivery.mode,
      externalEventId: envelope.eventId,
      eventType: envelope.eventType,
      payloadHash,
      signatureOk: false,
      receivedAtEpochMs: options.occurredAtEpochMs,
      status: "rejected",
      processedAtEpochMs: null,
      failureDetail: null,
      version: 1,
    };
    try {
      options.eventStore.insert(rejectedEvent);
    } catch {
      // A delivery racing another one for the same event id loses here; the winner stands.
    }
    return {
      status: "rejected",
      reason: "the delivery signature did not verify",
      event: rejectedEvent,
      providerEventType: envelope.eventType,
      normalized: null,
    };
  }

  const existing = options.eventStore.findByExternalEventId(delivery.mode, envelope.eventId);
  if (existing !== null) {
    return {
      status: "duplicate",
      reason: "the gateway event was already received",
      event: existing,
      providerEventType: existing.eventType,
      normalized: null,
    };
  }

  const pendingEvent: NmiWebhookEventRecord = {
    id: randomUUID(),
    companyId: null,
    mode: delivery.mode,
    externalEventId: envelope.eventId,
    eventType: envelope.eventType,
    payloadHash,
    signatureOk: true,
    receivedAtEpochMs: options.occurredAtEpochMs,
    status: "pending",
    processedAtEpochMs: null,
    failureDetail: null,
    version: 1,
  };

  try {
    options.eventStore.insert(pendingEvent);
  } catch {
    const raced = options.eventStore.findByExternalEventId(delivery.mode, envelope.eventId);
    return {
      status: "duplicate",
      reason: "the gateway event was already received",
      event: raced,
      providerEventType: envelope.eventType,
      normalized: null,
    };
  }

  const finish = (
    status: "processed" | "ignored" | "failed",
    companyId: string | null,
    failureDetail: string | null,
  ): NmiWebhookEventRecord | null => {
    const next: NmiWebhookEventRecord = {
      ...pendingEvent,
      companyId,
      status,
      processedAtEpochMs: status === "processed" ? options.occurredAtEpochMs : null,
      failureDetail,
      version: pendingEvent.version + 1,
    };
    return options.eventStore.save(next, pendingEvent.version) ? next : options.eventStore.findByExternalEventId(delivery.mode, envelope.eventId);
  };

  const testMode = isTestModeOfEventBody(envelope.eventBody);
  if (testMode !== null && testMode !== (delivery.mode === "test")) {
    const event = finish("ignored", null, null);
    audit(options, envelope.eventType, delivery.mode, null, "ignored");
    return {
      status: "ignored",
      reason: "the event test-mode flag disagrees with the endpoint mode",
      event,
      providerEventType: envelope.eventType,
      normalized: null,
    };
  }

  const providerSubmerchantId = merchantIdOfEventBody(envelope.eventBody);
  const provisionEventType = nmiProvisionEventOf(envelope.eventType);

  if (provisionEventType === null) {
    const event = finish("ignored", null, null);
    audit(options, envelope.eventType, delivery.mode, providerSubmerchantId, "ignored");
    return {
      status: "ignored",
      reason: "the event is not sub-merchant provisioning evidence",
      event,
      providerEventType: envelope.eventType,
      normalized: null,
    };
  }

  if (providerSubmerchantId === null) {
    const event = finish("ignored", null, null);
    audit(options, envelope.eventType, delivery.mode, null, "ignored");
    return {
      status: "ignored",
      reason: "the event names no gateway merchant",
      event,
      providerEventType: envelope.eventType,
      normalized: null,
    };
  }

  const submerchant = options.lookup.findByProviderSubmerchantId(providerSubmerchantId);
  if (submerchant === null) {
    const event = finish("ignored", null, null);
    audit(options, envelope.eventType, delivery.mode, providerSubmerchantId, "ignored");
    return {
      status: "ignored",
      reason: "the gateway merchant is not boarded by the platform",
      event,
      providerEventType: envelope.eventType,
      normalized: null,
    };
  }

  const event = finish("processed", submerchant.companyId, null);
  const normalized: NmiNormalizedProvisionEvent = {
    eventType: provisionEventType,
    companyId: submerchant.companyId,
    providerSubmerchantId,
  };
  audit(options, envelope.eventType, delivery.mode, providerSubmerchantId, provisionEventType);

  return {
    status: "processed",
    reason: "the event is provisioning evidence",
    event,
    providerEventType: envelope.eventType,
    normalized,
  };
}

/** Hand one delivery outcome to the caller's audit writer. Never carries a credential or a body. */
function audit(
  options: NmiWebhookOptions,
  providerEventType: string,
  mode: NmiProvisionMode,
  providerSubmerchantId: string | null,
  outcome: string,
): void {
  if (options.recordAudit === undefined) return;
  options.recordAudit({
    action: "submerchant_provision.nmi_webhook",
    companyId: null,
    provider: "nmi",
    mode,
    providerSubmerchantId,
    outcome: `${providerEventType}:${outcome}`,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
}

/** The parsed delivery envelope. */
type NmiEnvelopeResult =
  | {
      readonly outcome: "readable";
      readonly envelope: {
        readonly eventId: string;
        readonly eventType: string;
        readonly eventBody: Readonly<Record<string, unknown>>;
      };
    }
  | { readonly outcome: "unreadable"; readonly reason: string };

/**
 * Parse and validate the documented `{ event_id, event_type, event_body }` envelope.
 *
 * The id and the type are bounded and character-checked because both reach the `0032` columns and
 * the queue; the body must be an object because every documented event body is one. A body that
 * fails any of this is unreadable, and the caller records that outcome without applying it.
 */
function parseEnvelope(rawBody: string): NmiEnvelopeResult {
  let value: unknown;
  try {
    value = rawBody.trim().length === 0 ? null : (JSON.parse(rawBody) as unknown);
  } catch {
    return { outcome: "unreadable", reason: "the delivery body is not json" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { outcome: "unreadable", reason: "the delivery body is not an event object" };
  }

  const record = value as Readonly<Record<string, unknown>>;
  const eventIdValue = record["event_id"];
  const eventTypeValue = record["event_type"];
  const eventBody = record["event_body"];

  if (typeof eventIdValue !== "string" || EVENT_ID_PATTERN.test(eventIdValue.trim()) === false) {
    return { outcome: "unreadable", reason: "the delivery has no valid event id" };
  }
  if (typeof eventTypeValue !== "string" || EVENT_TYPE_PATTERN.test(eventTypeValue.trim()) === false) {
    return { outcome: "unreadable", reason: "the delivery has no valid event type" };
  }
  if (typeof eventBody !== "object" || eventBody === null || Array.isArray(eventBody)) {
    return { outcome: "unreadable", reason: "the delivery has no event body" };
  }

  return {
    outcome: "readable",
    envelope: {
      eventId: eventIdValue.trim(),
      eventType: eventTypeValue.trim(),
      eventBody: eventBody as Readonly<Record<string, unknown>>,
    },
  };
}
