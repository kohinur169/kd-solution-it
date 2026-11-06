// path: lib/payments/adapters/rainforest-merchant.ts

/**
 * The Rainforest adapter's sub-merchant onboarding: creating the merchant, handing the merchant the
 * documented onboarding component under a scoped session, and tracking the application to a decision.
 *
 * ## What section 6 asks of this provider
 *
 * Section 6: "Rainforest (rainforestpay.com): payment acceptance and sub-merchant creation." STEP 159
 * built the acceptance half; this is the creation half. Section 6 also lists the platform's PCI rule,
 * and this half has the same shape of problem: the onboarding data Rainforest wants includes a tax
 * identifier, the owners' dates of birth and SSNs, and the merchant's bank account number.
 *
 * ## Why the component path and not the API path
 *
 * Rainforest publishes two onboarding integrations. The direct-to-API one
 * (`docs/onboarding-merchants-via-api.md`) is gated behind Rainforest approval and its payload carries
 * `encrypted_tax_id`, `owner_1.encrypted_ssn` and the deposit method's `account_number` and
 * `routing_number`. The component one (`docs/onboarding-merchants-via-component.md`) is four steps:
 *
 * 1. `POST /v1/merchants` with the business information the platform already has, which answers
 *    `merchant_id` (`mid_`/`sbx_mid_`) and `merchant_application_id` (`app_`/`sbx_app_`).
 * 2. A session with `group#merchant_onboarding_component` constrained to that merchant.
 * 3. `<rainforest-merchant-onboarding session-key merchant-id merchant-application-id
 *    terms-and-conditions-url>` with the merchant bundle.
 * 4. The `merchant_application.*` and `merchant.*` webhooks, which STEP 160's receiver consumes.
 *
 * This file takes the component path, so **no tax identifier, no owner record, no SSN, no bank account
 * number and no routing number can appear in any input type here.** The gate asserts that a built body
 * carries none of them, and the component collects them in the browser. That is the same rule STEP 159
 * applied to card data, applied to onboarding data.
 *
 * ## The provisioning rules
 *
 * One merchant per company. The attempt is stored before the call, so a replay answers from the store
 * and a crash cannot silently create a second merchant; a row that carries a provider merchant id is
 * final, and a row that does not may be reopened for another attempt (a rejected or unreachable attempt
 * created nothing at Rainforest, so retrying it cannot duplicate a merchant). A `2XX` naming a merchant
 * id is `created`; `400`, `409` and `422` are `rejected` with the provider's message; `401`, `403`,
 * `404`, `405`, `415` and redirects are `failed`; and a timeout-class code, `429`, a `5XX`, a thrown
 * transport or a `2XX` without a merchant id are `unknown` with `requiresReconciliation`, because the
 * merchant may exist and only a person or a replay can settle it.
 *
 * ## What this file is not
 *
 * It does not render the component — it publishes the contract the page renders (STEP 183's work), and
 * the terms URL is a required attribute because Rainforest's terms of service must be accepted inside
 * the component. It does not receive webhooks (STEP 160's receiver is `rainforest-webhook.ts`), and it
 * does not post ledger entries: onboarding moves no money.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { openSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  RAINFOREST_PROVIDER_KEY,
  rainforestApiUrlFor,
  rainforestApplicationOutcomeOf,
  rainforestMerchantBehaviourOf,
  sanitizeRainforestText,
  type RainforestApplicationOutcome,
  type RainforestEnvironment,
  type RainforestMerchantBehaviour,
} from "./rainforest.ts";
import { rainforestApiKeyScope, type RainforestConfigStore } from "./rainforest-client.ts";
import {
  createRainforestSession,
  rainforestErrorMessageOf,
  rainforestTransportAllowing,
  RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH,
  type RainforestPaymentAnswer,
  type RainforestPaymentAuditEntry,
  type RainforestPaymentTransport,
} from "./rainforest-payment.ts";

/* -------------------------------------------------------------------------------------------------
 * Documented paths, ids, types and the onboarding component
 * ---------------------------------------------------------------------------------------------- */

/** The documented merchant endpoint path. */
export const RAINFOREST_MERCHANTS_PATH = "/v1/merchants";

/** The documented merchant id prefixes: production `mid_`, sandbox `sbx_mid_`. */
export const RAINFOREST_MERCHANT_ID_PREFIXES: readonly string[] = deepFreeze(["sbx_mid_", "mid_"]);

/** The documented merchant application id prefixes: production `app_`, sandbox `sbx_app_`. */
export const RAINFOREST_APPLICATION_ID_PREFIXES: readonly string[] = deepFreeze(["sbx_app_", "app_"]);

/** A merchant id as the documentation describes it. */
export const RAINFOREST_MERCHANT_ID_PATTERN = /^(?:sbx_)?mid_[A-Za-z0-9]{4,64}$/u;

/** A merchant application id as the documentation describes it. */
export const RAINFOREST_APPLICATION_ID_PATTERN = /^(?:sbx_)?app_[A-Za-z0-9]{4,64}$/u;

/** The documented merchant types, in the order the requirements table lists them. */
export const RAINFOREST_MERCHANT_TYPES: readonly string[] = deepFreeze([
  "INDIVIDUAL",
  "LLC",
  "LLP",
  "PARTNERSHIP",
  "PRIVATE_CORPORATION",
  "PUBLIC_CORPORATION",
  "NON_PROFIT_ORGANIZATION",
  "GOVERNMENT",
]);

/** A merchant category code: the documented four digit value. */
export const RAINFOREST_MCC_PATTERN = /^[0-9]{4}$/u;

/** The documented element name of the merchant onboarding component. */
export const RAINFOREST_ONBOARDING_COMPONENT_TAG = "rainforest-merchant-onboarding";

/** The documented merchant JavaScript bundles, one per environment. */
export const RAINFOREST_ONBOARDING_SCRIPT_URLS: Readonly<Record<RainforestEnvironment, string>> = deepFreeze({
  sandbox: "https://static.rainforestpay.com/sandbox.merchant.js",
  production: "https://static.rainforestpay.com/merchant.js",
});

/** The documented lifetime the onboarding guide's own session example asks for: 24 hours. */
export const RAINFOREST_ONBOARDING_DEFAULT_TTL_SECONDS = 86_400;

/** The largest number of API attempts this file records for one company. */
export const RAINFOREST_MERCHANT_TEXT_MAXIMUM_LENGTH = RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH;

/** The documented merchant endpoint of an environment. */
export function rainforestMerchantsEndpointFor(environment: RainforestEnvironment): string {
  return rainforestApiUrlFor(environment, RAINFOREST_MERCHANTS_PATH) ?? "";
}

/** The documented merchant bundle of an environment. */
export function rainforestOnboardingScriptUrlFor(environment: RainforestEnvironment): string {
  return RAINFOREST_ONBOARDING_SCRIPT_URLS[environment];
}

/** True for a sandbox merchant, whose ids carry the documented sandbox prefix. */
export function isRainforestSandboxMerchantId(merchantId: string): boolean {
  return merchantId.startsWith("sbx_mid_");
}

/* -------------------------------------------------------------------------------------------------
 * The merchant profile: the documented fields the platform may send, and nothing sensitive
 * ---------------------------------------------------------------------------------------------- */

/** The documented billing contact an onboarding request carries: a business address, no person. */
export interface RainforestMerchantAddress {
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * What the platform knows about a business before the merchant fills in the rest.
 *
 * Every field here is one the documented create merchant request carries and the requirements table
 * marks required. The sensitive fields the same request accepts — `encrypted_tax_id`, `tax_id_last_4`,
 * `owner_1..4`, `deposit_routes`, and the deposit method's `account_number` and `routing_number` — are
 * deliberately absent from this type: they are collected by the onboarding component, in the browser,
 * and never pass through this platform.
 */
export interface RainforestMerchantProfile {
  readonly companyId: string;
  /** The legal name of the business. */
  readonly legalName: string;
  /** The trading name, when the business has one; the request's `name` falls back to the legal name. */
  readonly dbaName?: string;
  readonly merchantType: string;
  /** The documented four digit merchant category code. */
  readonly mcc: string;
  readonly email: string;
  readonly website: string;
  readonly phoneNumber: string;
  /** The documented `average_ticket`, in minor units. */
  readonly averageTicketMinor: bigint;
  /** The documented `high_ticket`, in minor units. */
  readonly highTicketMinor: bigint;
  /** The documented `average_monthly_volume`, in minor units. */
  readonly averageMonthlyVolumeMinor: bigint;
  readonly address: RainforestMerchantAddress;
}

const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/u;
const WEBSITE_PATTERN = /^https:\/\/[A-Za-z0-9.-]{3,190}(?::[0-9]{1,5})?(?:\/[^\s"<>]*)?$/u;
const PHONE_PATTERN = /^\+?[0-9][0-9()\-. ]{6,24}$/u;
const TEXT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()\-/]{0,99}$/u;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const REGION_PATTERN = /^[A-Za-z0-9 -]{1,32}$/u;

/** True when a value is readable business text: no markup, no control characters, bounded length. */
function isBusinessText(value: string): boolean {
  if (value.trim().length === 0) return false;
  const cleaned = sanitizeRainforestText(value);
  return cleaned.length === value.trim().length && TEXT_PATTERN.test(value.trim());
}

/** The largest safe amount the provider's integer fields carry. */
const MAXIMUM_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** The validation failure of an address, or null when it is valid. */
function addressProblem(address: RainforestMerchantAddress): string | null {
  if (isBusinessText(address.addressLine1) === false) return "the address line must be readable text";
  if (address.addressLine2 !== undefined && isBusinessText(address.addressLine2) === false) {
    return "the second address line must be readable text";
  }
  if (isBusinessText(address.city) === false) return "the city must be readable text";
  if (REGION_PATTERN.test(address.state) === false) return "the state must be a two letter code";
  if (POSTAL_CODE_PATTERN.test(address.postalCode) === false) return "the postal code is invalid";
  if (COUNTRY_PATTERN.test(address.country) === false) return "the country must be a two letter code";
  return null;
}

/**
 * The validation failure of a merchant profile, or null when it is valid.
 *
 * The rules are the documented requirements table's: every listed field is required, the merchant type
 * is one of the eight the table names, the merchant category code is four digits, the three volume
 * fields are positive minor-unit integers and the high ticket cannot be below the average ticket.
 */
export function validateRainforestMerchantProfile(profile: RainforestMerchantProfile): string | null {
  if (profile.companyId.trim().length === 0) return "the company id is required";
  if (isBusinessText(profile.legalName) === false) return "the legal name must be readable business text";
  if (profile.dbaName !== undefined && isBusinessText(profile.dbaName) === false) {
    return "the trading name must be readable business text";
  }
  if (RAINFOREST_MERCHANT_TYPES.includes(profile.merchantType) === false) {
    return "the merchant type must be one the requirements table names";
  }
  if (RAINFOREST_MCC_PATTERN.test(profile.mcc) === false) return "the merchant category code must be four digits";
  if (EMAIL_PATTERN.test(profile.email) === false) return "the email is invalid";
  if (WEBSITE_PATTERN.test(profile.website) === false) return "the website must be an https address";
  if (PHONE_PATTERN.test(profile.phoneNumber) === false) return "the phone number is invalid";
  for (const [label, amount] of [
    ["average ticket", profile.averageTicketMinor],
    ["high ticket", profile.highTicketMinor],
    ["average monthly volume", profile.averageMonthlyVolumeMinor],
  ] as const) {
    if (amount <= 0n) return `the ${label} must be positive`;
    if (amount > MAXIMUM_SAFE_MINOR) return `the ${label} is larger than the provider's integer field can carry`;
  }
  if (profile.highTicketMinor < profile.averageTicketMinor) return "the high ticket cannot be below the average ticket";
  return addressProblem(profile.address);
}

/**
 * Build the documented create merchant body.
 *
 * Only fields the documented request and requirements table name are sent, under their documented
 * names: `name` (the trading name, falling back to the legal name), `dba_name` when it differs,
 * `legal_name`, `merchant_type`, `mcc`, `email`, `website`, `phone_number`, the three volume fields in
 * minor units, and `billing_contact` with the business address. Nothing sensitive is here, because
 * nothing sensitive can reach this function.
 */
export function buildRainforestMerchantBody(profile: RainforestMerchantProfile): Record<string, unknown> {
  const tradingName = profile.dbaName?.trim();
  const body: Record<string, unknown> = {
    name: tradingName !== undefined && tradingName.length > 0 ? tradingName : profile.legalName.trim(),
    legal_name: profile.legalName.trim(),
    merchant_type: profile.merchantType,
    mcc: profile.mcc,
    email: profile.email.trim(),
    website: profile.website.trim(),
    phone_number: profile.phoneNumber.trim(),
    average_ticket: Number(profile.averageTicketMinor),
    high_ticket: Number(profile.highTicketMinor),
    average_monthly_volume: Number(profile.averageMonthlyVolumeMinor),
    billing_contact: {
      address_line_1: profile.address.addressLine1.trim(),
      ...(profile.address.addressLine2 === undefined ? {} : { address_line_2: profile.address.addressLine2.trim() }),
      city: profile.address.city.trim(),
      state: profile.address.state.trim(),
      postal_code: profile.address.postalCode.trim(),
      country: profile.address.country.trim(),
    },
  };
  if (tradingName !== undefined && tradingName.length > 0 && tradingName !== profile.legalName.trim()) {
    body["dba_name"] = tradingName;
  }
  return body;
}

/* -------------------------------------------------------------------------------------------------
 * The provisioning record
 * ---------------------------------------------------------------------------------------------- */

/** Where one company's merchant stands at Rainforest. */
export type RainforestProvisionStatus = "pending" | "created" | "rejected" | "unknown";

/** The provider objects one attempt produced, once known. */
export interface RainforestMerchantIds {
  readonly merchantId: string | null;
  readonly applicationId: string | null;
  readonly merchantStatus: string | null;
  readonly applicationStatus: string | null;
}

/** One company's onboarding attempt, with the provider ids it produced. */
export interface RainforestMerchantProvision extends RainforestMerchantIds {
  readonly id: string;
  readonly companyId: string;
  readonly status: RainforestProvisionStatus;
  readonly reason: string | null;
  readonly requiresReconciliation: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The only moves a provision may make. A row carrying a merchant id never leaves `created`. */
export const PROVISION_OUTCOMES: Readonly<Record<RainforestProvisionStatus, readonly RainforestProvisionStatus[]>> =
  deepFreeze({
    pending: ["pending", "created", "rejected", "unknown"],
    unknown: ["unknown", "created", "rejected", "pending"],
    rejected: ["rejected", "pending"],
    created: ["created"],
  });

/** What the store reads and writes. One row per company. The store is the caller's. */
export interface RainforestMerchantProvisionStore {
  insert(provision: RainforestMerchantProvision): void;
  findById(id: string): RainforestMerchantProvision | null;
  findByCompany(companyId: string): RainforestMerchantProvision | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: RainforestMerchantProvision, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation of the invariants the real table must enforce — one
 * row per company, an immutable company and id, a version guard, forward-only outcomes, a `created` row
 * that carries a provider merchant id, and a row carrying a provider merchant id that is final.
 */
export class InMemoryRainforestMerchantProvisionStore implements RainforestMerchantProvisionStore {
  private readonly provisions = new Map<string, RainforestMerchantProvision>();

  insert(provision: RainforestMerchantProvision): void {
    if (this.provisions.has(provision.id)) throw new Error("duplicate provision id");
    if (provision.version !== 1) throw new Error("a new provision starts at version 1");
    if (provision.status !== "pending") throw new Error("a new provision is pending");
    if (this.findByCompany(provision.companyId) !== null) throw new Error("this company already has a provision");
    this.provisions.set(provision.id, provision);
  }

  findById(id: string): RainforestMerchantProvision | null {
    return this.provisions.get(id) ?? null;
  }

  findByCompany(companyId: string): RainforestMerchantProvision | null {
    return [...this.provisions.values()].find((provision) => provision.companyId === companyId) ?? null;
  }

  save(next: RainforestMerchantProvision, expectedVersion: number): boolean {
    const current = this.provisions.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (PROVISION_OUTCOMES[current.status].includes(next.status) === false) return false;
    if (current.merchantId !== null && next.merchantId !== current.merchantId) return false;
    if (current.applicationId !== null && next.applicationId !== current.applicationId) return false;
    if (next.status === "created" && next.merchantId === null) return false;
    if (current.merchantId !== null && next.status !== "created") return false;
    this.provisions.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Options and results
 * ---------------------------------------------------------------------------------------------- */

/** The options every call in this file needs. */
export interface RainforestMerchantOptions {
  readonly configStore: RainforestConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: RainforestPaymentTransport;
  readonly recordAudit?: (entry: RainforestPaymentAuditEntry) => void;
}

/** What one onboarding attempt did. */
export type ProvisionRainforestMerchantResult =
  | { readonly status: "created"; readonly provision: RainforestMerchantProvision }
  | { readonly status: "already_created"; readonly provision: RainforestMerchantProvision }
  | {
      readonly status: "in_flight";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: RainforestMerchantProvision;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly provision: RainforestMerchantProvision }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: RainforestMerchantProvision;
    };

/** The transport of this adapter: the documented payment endpoints plus the merchant endpoint. */
export const rainforestMerchantTransport: RainforestPaymentTransport = rainforestTransportAllowing([
  RAINFOREST_MERCHANTS_PATH,
]);

/** The active configuration of a company opened for one call, or the reason there is none. */
function activeKeyOf(
  companyId: string,
  options: RainforestMerchantOptions,
):
  | { readonly ok: true; readonly apiKey: string; readonly environment: RainforestEnvironment }
  | { readonly ok: false; readonly reason: string } {
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

/** A trimmed string field of a provider object, or null. */
function stringOf(data: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/* -------------------------------------------------------------------------------------------------
 * Provisioning
 * ---------------------------------------------------------------------------------------------- */

/** Write one provision forward, version-guarded, and hand the audit entry to the caller. */
function settleProvision(
  store: RainforestMerchantProvisionStore,
  provision: RainforestMerchantProvision,
  next: {
    readonly status: RainforestProvisionStatus;
    readonly reason: string | null;
    readonly requiresReconciliation: boolean;
    readonly ids?: RainforestMerchantIds;
  },
  options: RainforestMerchantOptions,
): RainforestMerchantProvision {
  const record: RainforestMerchantProvision = {
    ...provision,
    merchantId: next.ids?.merchantId ?? provision.merchantId,
    applicationId: next.ids?.applicationId ?? provision.applicationId,
    merchantStatus: next.ids?.merchantStatus ?? provision.merchantStatus,
    applicationStatus: next.ids?.applicationStatus ?? provision.applicationStatus,
    status: next.status,
    reason: next.reason,
    requiresReconciliation: next.requiresReconciliation,
    version: provision.version + 1,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };
  const stored = store.save(record, provision.version);
  const settled = stored ? record : (store.findById(provision.id) ?? record);

  if (options.recordAudit !== undefined) {
    options.recordAudit({
      action: "payin.rainforest_merchant_provisioned",
      providerKey: RAINFOREST_PROVIDER_KEY,
      companyId: settled.companyId,
      merchantId: settled.merchantId ?? "",
      providerObjectId: settled.applicationId ?? settled.merchantId,
      outcome: settled.status,
      occurredAtEpochMs: options.occurredAtEpochMs,
    });
  }

  return settled;
}

/**
 * Create the Rainforest merchant for one company, idempotently.
 *
 * The row is stored before the call so a crash between the call and the answer leaves a `pending` row
 * rather than a silent duplicate. A row that already carries a provider merchant id is answered as
 * `already_created` without a call — the platform has one merchant per company. A `pending` row is
 * answered `in_flight` without a call. A `rejected` or `unknown` row with no provider merchant id is
 * reopened and retried, because neither created anything Rainforest could duplicate.
 */
export async function provisionRainforestMerchant(
  profile: RainforestMerchantProfile,
  store: RainforestMerchantProvisionStore,
  options: RainforestMerchantOptions,
): Promise<ProvisionRainforestMerchantResult> {
  const invalid = validateRainforestMerchantProfile(profile);
  if (invalid !== null) return { status: "failed", reason: invalid };

  const existing = store.findByCompany(profile.companyId);

  if (existing !== null) {
    if (existing.merchantId !== null) return { status: "already_created", provision: existing };
    if (existing.status === "pending") {
      return {
        status: "in_flight",
        requiresReconciliation: true,
        reason: "a merchant creation is already in flight for this company; it is not sent twice",
        provision: existing,
      };
    }
  }

  const key = activeKeyOf(profile.companyId, options);
  if (key.ok === false) return { status: "failed", reason: key.reason };

  let provision: RainforestMerchantProvision;
  if (existing === null) {
    provision = {
      id: randomUUID(),
      companyId: profile.companyId,
      status: "pending",
      reason: null,
      requiresReconciliation: false,
      merchantId: null,
      applicationId: null,
      merchantStatus: null,
      applicationStatus: null,
      version: 1,
      createdAtEpochMs: options.occurredAtEpochMs,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    try {
      store.insert(provision);
    } catch {
      return { status: "failed", reason: "the provisioning record could not be stored, so nothing was sent" };
    }
  } else {
    const reopened: RainforestMerchantProvision = {
      ...existing,
      status: "pending",
      reason: null,
      requiresReconciliation: false,
      version: existing.version + 1,
      updatedAtEpochMs: options.occurredAtEpochMs,
    };
    if (store.save(reopened, existing.version) === false) {
      return { status: "failed", reason: "the provisioning record could not be reopened, so nothing was sent" };
    }
    provision = reopened;
  }

  let answer: RainforestPaymentAnswer;
  try {
    answer = await (options.transport ?? rainforestMerchantTransport)(
      rainforestMerchantsEndpointFor(key.environment),
      "POST",
      key.apiKey,
      JSON.stringify(buildRainforestMerchantBody(profile)),
    );
  } catch {
    return unknownProvision(store, provision, "the API could not be reached, so the merchant may exist", options);
  }

  const payload = parseJson(answer.body);

  if (answer.status >= 200 && answer.status < 300) {
    const data = dataOf(payload);
    const merchantId = data === null ? null : data["merchant_id"];
    const applicationId = data === null ? null : data["merchant_application_id"];
    if (typeof merchantId === "string" && RAINFOREST_MERCHANT_ID_PATTERN.test(merchantId)) {
      const application =
        typeof applicationId === "string" && RAINFOREST_APPLICATION_ID_PATTERN.test(applicationId) ? applicationId : null;
      const created = settleProvision(
        store,
        provision,
        {
          status: "created",
          reason: application === null ? "the answer named the merchant but no usable application id" : null,
          requiresReconciliation: application === null,
          ids: {
            merchantId,
            applicationId: application,
            merchantStatus: data === null ? null : stringOf(data, "merchant_status"),
            applicationStatus: data === null ? null : stringOf(data, "merchant_application_status"),
          },
        },
        options,
      );
      return { status: "created", provision: created };
    }
    return unknownProvision(store, provision, "the answer named no usable merchant id", options);
  }

  if (answer.status === 400 || answer.status === 409 || answer.status === 422) {
    const message = rainforestErrorMessageOf(payload);
    const reason = message.length > 0 ? message : `the API refused the merchant with status ${answer.status}`;
    const rejected = settleProvision(
      store,
      provision,
      { status: "rejected", reason, requiresReconciliation: false },
      options,
    );
    return { status: "rejected", reason, provision: rejected };
  }

  if (answer.status === 401 || answer.status === 403) {
    const rejected = settleProvision(
      store,
      provision,
      { status: "rejected", reason: "the API rejected the credential", requiresReconciliation: false },
      options,
    );
    return { status: "failed", reason: rejected.reason ?? "the API rejected the credential" };
  }

  if (answer.status === 404 || answer.status === 405 || answer.status === 415 || (answer.status >= 300 && answer.status < 400)) {
    const reason = `the API refused the request with status ${answer.status}`;
    settleProvision(store, provision, { status: "rejected", reason, requiresReconciliation: false }, options);
    return { status: "failed", reason };
  }

  return unknownProvision(store, provision, `the API did not answer finally (status ${answer.status})`, options);
}

/** Settle an attempt whose outcome could not be read as `unknown`, remembering that it needs reconciling. */
function unknownProvision(
  store: RainforestMerchantProvisionStore,
  provision: RainforestMerchantProvision,
  reason: string,
  options: RainforestMerchantOptions,
): ProvisionRainforestMerchantResult {
  const recorded = settleProvision(
    store,
    provision,
    { status: "unknown", reason, requiresReconciliation: true },
    options,
  );
  return { status: "unknown", requiresReconciliation: true, reason, provision: recorded };
}

/* -------------------------------------------------------------------------------------------------
 * The onboarding component and its session
 * ---------------------------------------------------------------------------------------------- */

/** The component contract a page renders for onboarding. */
export interface RainforestOnboardingComponent {
  readonly tag: string;
  readonly scriptUrl: string;
  readonly attributes: {
    readonly "session-key": string;
    readonly "merchant-id": string;
    readonly "merchant-application-id": string;
    readonly "terms-and-conditions-url": string;
  };
}

/**
 * The documented onboarding component for one merchant, or null when an id or the terms URL is not of
 * the documented shape. The terms URL is required because the documentation says the platform's terms
 * of service must be accepted inside the component.
 */
export function rainforestOnboardingComponentFor(
  environment: RainforestEnvironment,
  sessionKey: string,
  merchantId: string,
  applicationId: string,
  termsAndConditionsUrl: string,
): RainforestOnboardingComponent | null {
  if (/^sessionkey_[A-Za-z0-9]{16,128}$/u.test(sessionKey) === false) return null;
  if (RAINFOREST_MERCHANT_ID_PATTERN.test(merchantId) === false) return null;
  if (RAINFOREST_APPLICATION_ID_PATTERN.test(applicationId) === false) return null;
  if (WEBSITE_PATTERN.test(termsAndConditionsUrl) === false) return null;
  return {
    tag: RAINFOREST_ONBOARDING_COMPONENT_TAG,
    scriptUrl: rainforestOnboardingScriptUrlFor(environment),
    attributes: {
      "session-key": sessionKey,
      "merchant-id": merchantId,
      "merchant-application-id": applicationId,
      "terms-and-conditions-url": termsAndConditionsUrl,
    },
  };
}

/** What starting onboarding for a company needs. */
export interface RainforestOnboardingInput {
  readonly companyId: string;
  readonly termsAndConditionsUrl: string;
  readonly ttlSeconds?: number;
}

/** What starting onboarding did. */
export type StartRainforestOnboardingResult =
  | {
      readonly status: "ready";
      readonly component: RainforestOnboardingComponent;
      readonly merchantId: string;
      readonly applicationId: string;
      readonly expiresAtEpochMs: number;
    }
  | { readonly status: "not_created"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Start onboarding for a company whose merchant already exists at Rainforest.
 *
 * This is the step a page calls: it finds the company's created merchant and its application, asks for
 * an onboarding session scoped to that one merchant, and answers the component contract the page
 * renders. A company whose merchant is not created has nothing to render, and a company whose
 * application id is unknown needs reconciliation before the component can be shown — both are answered
 * without a provider call.
 */
export async function startRainforestOnboarding(
  input: RainforestOnboardingInput,
  store: RainforestMerchantProvisionStore,
  options: RainforestMerchantOptions,
): Promise<StartRainforestOnboardingResult> {
  const provision = store.findByCompany(input.companyId);
  if (provision === null || provision.merchantId === null) {
    return { status: "not_created", reason: "this company has no Rainforest merchant yet" };
  }
  if (provision.applicationId === null) {
    return {
      status: "failed",
      reason: "the merchant application id is unknown, so the onboarding component cannot be shown",
    };
  }
  if (WEBSITE_PATTERN.test(input.termsAndConditionsUrl) === false) {
    return { status: "failed", reason: "the terms and conditions url must be an https address" };
  }

  const config = options.configStore.findActiveByCompany(input.companyId);
  if (config === null) return { status: "failed", reason: "no active Rainforest key configuration exists for this company" };

  const session = await createRainforestSession(
    {
      companyId: input.companyId,
      merchantId: provision.merchantId,
      purpose: "onboarding",
      ttlSeconds: input.ttlSeconds ?? RAINFOREST_ONBOARDING_DEFAULT_TTL_SECONDS,
    },
    {
      configStore: options.configStore,
      keyring: options.keyring,
      occurredAtEpochMs: options.occurredAtEpochMs,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.recordAudit === undefined ? {} : { recordAudit: options.recordAudit }),
    },
  );
  if (session.status !== "created") return { status: "failed", reason: session.reason };

  const component = rainforestOnboardingComponentFor(
    config.environment,
    session.sessionKey,
    provision.merchantId,
    provision.applicationId,
    input.termsAndConditionsUrl,
  );
  if (component === null) return { status: "failed", reason: "the onboarding component contract could not be built" };

  return {
    status: "ready",
    component,
    merchantId: provision.merchantId,
    applicationId: provision.applicationId,
    expiresAtEpochMs: session.expiresAtEpochMs,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Reading a decision
 * ---------------------------------------------------------------------------------------------- */

/** What a merchant and its application currently allow. */
export interface RainforestOnboardingState {
  readonly merchantId: string;
  readonly merchantStatus: string | null;
  readonly applicationStatus: string | null;
  readonly behaviour: RainforestMerchantBehaviour | null;
  readonly decision: RainforestApplicationOutcome | null;
}

/**
 * Read what a stored provision says about onboarding, in the documented vocabulary.
 *
 * `behaviour` is `processes` only for the documented `ACTIVE` status, and `decision` is `approved` only
 * for a `COMPLETED` application; both are `null` for a value Rainforest has not published, so nothing
 * downstream can treat an unknown status as an approval.
 */
export function rainforestOnboardingStateOf(provision: RainforestMerchantProvision): RainforestOnboardingState {
  return {
    merchantId: provision.merchantId ?? "",
    merchantStatus: provision.merchantStatus,
    applicationStatus: provision.applicationStatus,
    behaviour: provision.merchantStatus === null ? null : rainforestMerchantBehaviourOf(provision.merchantStatus),
    decision:
      provision.applicationStatus === null ? null : rainforestApplicationOutcomeOf(provision.applicationStatus),
  };
}
