// path: lib/payments/adapters/stripe-accounts.ts

/**
 * The Stripe Connect adapter's connected-account provisioning: creating the `acct_` behind a company's
 * KYC approval, recording it once and only once, and handing the merchant the documented onboarding link.
 *
 * ## What section 6 asks of this provider
 *
 * Section 6: "Stripe Connect: connected sub-merchant account creation, charges and payouts." STEP 161
 * read the documentation, STEP 162 sealed the key and proved it, and this is the creation half: a
 * company that has passed this platform's own KYC review gets one Stripe connected account, recorded
 * before the call so a replay cannot create a second one.
 *
 * ## The configuration this STEP fixes, and why the pages fix it
 *
 * Accounts v2 requires `defaults.responsibilities` and `dashboard` to be chosen when the merchant
 * configuration is added, and **neither can be changed afterwards**. The connected-account-configuration
 * page read for this STEP says:
 *
 * - `fees_collector` is `application` or `stripe`: for destination charges "Stripe always collects fees
 *   from your platform", so the platform's fee split (STEP 133) is an application fee either way.
 * - `losses_collector` is `application` or `stripe`: `application` means this platform is responsible
 *   for the connected account's negative balances and manages its risk — which is exactly what the
 *   platform's reserve and negative-balance model (STEPs 139-140) already does.
 * - If `losses_collector` is `application` then `fees_collector` must also be `application`.
 * - The page recommends both `application` for destination charges.
 * - `dashboard` is `express`, `full` or `none`; `none` means the connected account has no Stripe
 *   Dashboard at all, because this platform's own merchant dashboard is the only one a merchant sees.
 * - Requirement collection follows from those two: the platform is the `requirements_collector` only
 *   when `losses_collector` is `application` **and** `dashboard` is `none`.
 *
 * So this file records one configuration — `fees_collector: application`, `losses_collector:
 * application`, `dashboard: none` — and therefore, by the page's own rule, **this platform collects the
 * requirements**. That is consistent rather than convenient: the company was already KYC-approved here,
 * and what Stripe returns in `requirements` is the delta this platform still has to satisfy. The
 * `requirements` hash is therefore requested on the create call (`include`) and summarised in the
 * record, and `stripeOnboardingStateOf` from STEP 161 turns it into `ready`/`waiting`/`blocked`.
 *
 * ## What is asked of Stripe, and what deliberately is not
 *
 * The create body carries the business identity this platform already holds — legal name, display name,
 * contact email, country, entity type, currency, locale — and the two capabilities a seller needs:
 * `configuration.merchant.capabilities.card_payments.requested` and
 * `configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested` (STEP 161 recorded
 * that `card_payments` must be requested together with transfers). It carries **no tax identifier, no
 * owner record, no date of birth, no SSN and no bank account number**: the input type has no field for
 * any of them, and the gate asserts that a built body contains none of the shapes they take. That is the
 * section 6 PCI rule applied to onboarding data, exactly as STEP 160 did for Rainforest.
 *
 * ## The provisioning rules
 *
 * One connected account per company and mode. The attempt is stored before the call, so a replay answers
 * from the store and a crash cannot silently create a second account; a row carrying an `acct_` id is
 * final, and a row that does not may be reopened for another attempt (a rejected or unreachable attempt
 * created nothing at Stripe, so retrying it cannot duplicate an account). A `2XX` naming an `acct_` id is
 * `created`; `400`, `409` and `422` are `rejected` with the provider's message; `401`, `403`, `404`,
 * `405`, `415` and redirects are `failed`; and a timeout-class code, `429`, a `5XX`, a thrown transport
 * or a `2XX` without an `acct_` id are `unknown` with `requiresReconciliation`, because the account may
 * exist and only a person or a replay can settle it.
 *
 * ## What this file is not
 *
 * It does not charge anything and receives no webhook (STEP 164), it does not post ledger entries (an
 * account moves no money), and it is not a screen: no route, component or permission check is added, and
 * the caller passes its own store, config store, keyring, audit writer and clock.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { openSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  STRIPE_ACCOUNT_ID_PATTERN,
  STRIPE_ACCOUNT_LINKS_PATH,
  STRIPE_API_BASE,
  STRIPE_API_VERSION_HEADER,
  STRIPE_PROVIDER_KEY,
  sanitizeStripeText,
  stripeOnboardingStateOf,
  type StripeOnboardingState,
  type StripeRequirementSummary,
} from "./stripe.ts";
import {
  STRIPE_ACCOUNT_SURFACE_PATH,
  stripeSecretKeyScope,
  type StripeConfigStore,
  type StripeKeyConfig,
} from "./stripe-client.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The documented Accounts v2 collection this file posts to. */
export const STRIPE_ACCOUNTS_PATH = STRIPE_ACCOUNT_SURFACE_PATH;

/** The documented account-link collection used for hosted onboarding. */
export const STRIPE_ONBOARDING_LINK_PATH = STRIPE_ACCOUNT_LINKS_PATH;

/** The two endpoints this file may call. */
export const STRIPE_ACCOUNT_ALLOWED_PATHS: readonly string[] = deepFreeze([
  STRIPE_ACCOUNTS_PATH,
  STRIPE_ONBOARDING_LINK_PATH,
]);

/** The documented dashboard values. */
export const STRIPE_DASHBOARD_VALUES: readonly string[] = deepFreeze(["express", "full", "none"]);

/** The documented responsibility values. */
export const STRIPE_RESPONSIBILITY_VALUES: readonly string[] = deepFreeze(["application", "stripe"]);

/** The documented entity types. */
export const STRIPE_ENTITY_TYPES: readonly string[] = deepFreeze(["company", "individual"]);

/** The documented account-link types. */
export const STRIPE_ACCOUNT_LINK_TYPES: readonly string[] = deepFreeze(["account_onboarding", "account_update"]);

/**
 * The responsibilities this platform sets on every connected account.
 *
 * Both are `application`: the platform's ledger owns the fee split (STEP 133) and the reserve and
 * negative-balance model (STEPs 139-140), and the configuration page recommends both for destination
 * charges. The pair is validated against the page's own restriction before a body is built.
 */
export const STRIPE_PLATFORM_RESPONSIBILITIES = deepFreeze({
  feesCollector: "application",
  lossesCollector: "application",
} as const);

/** The dashboard value this platform sets: the merchant's dashboard is this platform's. */
export const STRIPE_PLATFORM_DASHBOARD = "none" as const;

/** Why the merchant gets no Stripe Dashboard. */
export const STRIPE_PLATFORM_DASHBOARD_REASON =
  "The merchant's only dashboard is this platform's; Stripe is not asked to host a second one, and the page records that `none` means the platform provides all Stripe-related functionality.";

/** The KYC status that authorizes provisioning: the value `services/kyc/kyc-review.ts` writes on approval. */
export const STRIPE_KYC_APPROVED_STATUS = "approved";

/** The capabilities requested on every account, in the documented nesting. */
export const STRIPE_REQUESTED_CAPABILITIES: readonly string[] = deepFreeze([
  "configuration.merchant.capabilities.card_payments.requested",
  "configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested",
]);

/** The `include` values the create call asks for, so the answer carries what this file records. */
export const STRIPE_ACCOUNT_INCLUDE_VALUES: readonly string[] = deepFreeze([
  "configuration.merchant",
  "identity",
  "requirements",
]);

/** The largest answer this file reads. */
export const STRIPE_ACCOUNT_ANSWER_MAXIMUM_BYTES = 65_536;

/** The longest provider text this file keeps. */
export const STRIPE_ACCOUNT_TEXT_MAXIMUM_LENGTH = 200;

/** How long a call waits for Stripe. */
export const STRIPE_ACCOUNT_TIMEOUT_MS = 20_000;

/** The documented lifetime of an account link, in seconds, used when the answer does not carry one. */
export const STRIPE_ACCOUNT_LINK_DEFAULT_TTL_SECONDS = 300;

/** The endpoint a call is made to. */
export function stripeAccountEndpointFor(path: string): string {
  return `${STRIPE_API_BASE}${path}`;
}

/* -------------------------------------------------------------------------------------------------
 * The configuration the pages fix, and its consequences
 * ---------------------------------------------------------------------------------------------- */

/** The two responsibilities as this platform sets them. */
export interface StripeResponsibilities {
  readonly feesCollector: string;
  readonly lossesCollector: string;
}

/** The reason a responsibility pair is invalid, or null when it is valid. */
export function validateStripeResponsibilities(responsibilities: StripeResponsibilities): string | null {
  if (STRIPE_RESPONSIBILITY_VALUES.includes(responsibilities.feesCollector) === false) {
    return "the fees collector must be application or stripe";
  }
  if (STRIPE_RESPONSIBILITY_VALUES.includes(responsibilities.lossesCollector) === false) {
    return "the losses collector must be application or stripe";
  }
  if (responsibilities.lossesCollector === "application" && responsibilities.feesCollector !== "application") {
    return "a platform that collects losses must also collect fees; Stripe refuses the pair the other way round";
  }
  return null;
}

/**
 * Who collects the connected account's requirements, as the configuration page derives it.
 *
 * The page's rule: the platform is responsible only when `losses_collector` is `application` **and**
 * `dashboard` is `none`. It is derived here rather than stored, because storing a derived value invites
 * it to disagree with the two values it comes from.
 */
export function stripeRequirementsCollectorOf(
  dashboard: string,
  lossesCollector: string,
): "stripe" | "application" | null {
  if (STRIPE_DASHBOARD_VALUES.includes(dashboard) === false) return null;
  if (STRIPE_RESPONSIBILITY_VALUES.includes(lossesCollector) === false) return null;
  return lossesCollector === "application" && dashboard === "none" ? "application" : "stripe";
}

/** True when the platform is the one collecting requirements for this configuration. */
export function stripePlatformCollectsRequirements(): boolean {
  return (
    stripeRequirementsCollectorOf(STRIPE_PLATFORM_DASHBOARD, STRIPE_PLATFORM_RESPONSIBILITIES.lossesCollector) ===
    "application"
  );
}

/* -------------------------------------------------------------------------------------------------
 * The profile this platform may send
 * ---------------------------------------------------------------------------------------------- */

/**
 * The business identity this platform sends to Stripe.
 *
 * Every field here is data this platform already holds and would show a merchant on their own profile
 * screen. There is no field for a tax identifier, an owner, a date of birth, an SSN, a bank account or a
 * routing number, because Stripe's own interface or this platform's own KYC pipeline collects those.
 */
export interface StripeCompanyProfile {
  readonly legalName: string;
  readonly displayName: string;
  readonly contactEmail: string;
  /** ISO 3166-1 alpha-2, lower case, as the documented examples write it. */
  readonly country: string;
  readonly entityType: string;
  /** ISO 4217, lower case. */
  readonly currency: string;
  /** A documented locale such as `en-US`. */
  readonly locale: string;
}

const LEGAL_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()\-]{1,99}$/u;
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()\-]{1,99}$/u;
const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/u;
const COUNTRY_PATTERN = /^[a-z]{2}$/u;
const CURRENCY_PATTERN = /^[a-z]{3}$/u;
const LOCALE_PATTERN = /^[a-z]{2}-[A-Z]{2}$/u;

/** The reason a profile is invalid, or null when it is valid. */
export function validateStripeCompanyProfile(profile: StripeCompanyProfile): string | null {
  if (LEGAL_NAME_PATTERN.test(profile.legalName.trim()) === false) {
    return "the legal name must be 2 to 100 letters, digits or common business punctuation";
  }
  if (DISPLAY_NAME_PATTERN.test(profile.displayName.trim()) === false) {
    return "the display name must be 2 to 100 letters, digits or common business punctuation";
  }
  if (EMAIL_PATTERN.test(profile.contactEmail.trim()) === false) return "the contact email is invalid";
  if (COUNTRY_PATTERN.test(profile.country) === false) {
    return "the country must be a two letter lower case code, as the documented examples write it";
  }
  if (STRIPE_ENTITY_TYPES.includes(profile.entityType) === false) {
    return "the entity type must be company or individual";
  }
  if (CURRENCY_PATTERN.test(profile.currency) === false) {
    return "the currency must be a three letter lower case code";
  }
  if (LOCALE_PATTERN.test(profile.locale) === false) return "the locale must be written like en-US";
  if (sanitizeStripeText(profile.legalName).length === 0) return "the legal name carries no readable text";
  return null;
}

/**
 * Build the documented Accounts v2 create body.
 *
 * The nesting follows the page's example and the property paths the configuration page links to, so
 * `configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested` is the documented way
 * to ask for the transfers capability on a v2 account. `include` asks for the merchant configuration,
 * the identity and the requirements, because those are what this file records from the answer.
 */
export function buildStripeAccountBody(profile: StripeCompanyProfile): Record<string, unknown> {
  return {
    contact_email: profile.contactEmail.trim(),
    display_name: profile.displayName.trim(),
    dashboard: STRIPE_PLATFORM_DASHBOARD,
    identity: {
      business_details: { registered_name: profile.legalName.trim() },
      country: profile.country,
      entity_type: profile.entityType,
    },
    configuration: {
      merchant: {
        capabilities: { card_payments: { requested: true } },
      },
      recipient: {
        capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
      },
    },
    defaults: {
      currency: profile.currency,
      responsibilities: {
        fees_collector: STRIPE_PLATFORM_RESPONSIBILITIES.feesCollector,
        losses_collector: STRIPE_PLATFORM_RESPONSIBILITIES.lossesCollector,
      },
      locales: [profile.locale],
    },
    include: [...STRIPE_ACCOUNT_INCLUDE_VALUES],
  };
}

/* -------------------------------------------------------------------------------------------------
 * The transport
 * ---------------------------------------------------------------------------------------------- */

/** One call: the path, the encoding, the body and the credentials it is made with. */
export interface StripeAccountRequest {
  readonly path: string;
  readonly contentType: "application/json" | "application/x-www-form-urlencoded";
  readonly body: string;
  readonly secretKey: string;
  readonly apiVersion: string;
}

/** The HTTP answer: the status code and the raw body. */
export interface StripeAccountAnswer {
  readonly status: number;
  readonly body: string;
}

/** The transport port: one request in, the raw answer out. */
export type StripeAccountTransport = (request: StripeAccountRequest) => Promise<StripeAccountAnswer>;

/**
 * Performs the documented calls against the documented API base.
 *
 * The path is allowlisted to the two endpoints this file owns, the call is refused without a key, a
 * dated version or a body, redirects are refused (Stripe treats a redirect as a failure), the timeout is
 * bounded and an oversized answer is refused. The documented `Stripe-Version` header is always sent,
 * because the Accounts v2 surface is versioned and the configuration pins the version it was proven on.
 */
export const stripeAccountFetchTransport: StripeAccountTransport = async (request) => {
  if (STRIPE_ACCOUNT_ALLOWED_PATHS.includes(request.path) === false) throw new Error("invalid API path");
  if (request.secretKey.trim().length === 0) throw new Error("a secret key is required");
  if (request.apiVersion.trim().length === 0) throw new Error("an API version is required");
  if (request.body.length === 0) throw new Error("a request body is required");

  const response = await fetch(stripeAccountEndpointFor(request.path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.secretKey}`,
      "Content-Type": request.contentType,
      Accept: "application/json",
      [STRIPE_API_VERSION_HEADER]: request.apiVersion.trim(),
    },
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(STRIPE_ACCOUNT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (text.length > STRIPE_ACCOUNT_ANSWER_MAXIMUM_BYTES) throw new Error("invalid API answer");
  return { status: response.status, body: text };
};

/* -------------------------------------------------------------------------------------------------
 * Reading a provider answer
 * ---------------------------------------------------------------------------------------------- */

/** Read one provider message out of an answer, sanitised, or the empty string. */
export function stripeAccountMessageOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Readonly<Record<string, unknown>>;
  const error = record["error"];
  if (typeof error === "object" && error !== null) {
    const fields = error as Readonly<Record<string, unknown>>;
    for (const key of ["message", "code", "type"]) {
      const value = fields[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return sanitizeStripeText(value).slice(0, STRIPE_ACCOUNT_TEXT_MAXIMUM_LENGTH);
      }
    }
  }
  for (const key of ["message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return sanitizeStripeText(value).slice(0, STRIPE_ACCOUNT_TEXT_MAXIMUM_LENGTH);
    }
  }
  return "";
}

function parseJsonBody(body: string): unknown {
  try {
    return body.trim().length === 0 ? null : (JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;
}

function stringAt(value: unknown, ...path: readonly string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    const record = recordOf(current);
    if (record === null) return null;
    current = record[key];
  }
  return typeof current === "string" ? current : null;
}

function numberArrayLengthAt(value: unknown, ...path: readonly string[]): number {
  let current: unknown = value;
  for (const key of path) {
    const record = recordOf(current);
    if (record === null) return 0;
    current = record[key];
  }
  return Array.isArray(current) ? current.length : 0;
}

/* -------------------------------------------------------------------------------------------------
 * The provisioning record
 * ---------------------------------------------------------------------------------------------- */

/** Where one company's connected account stands at Stripe. */
export type StripeAccountProvisionStatus = "pending" | "created" | "rejected" | "unknown";

/** The requirements a created account carries, as this platform summarises them. */
export interface StripeAccountRequirementState {
  readonly currentlyDue: number;
  readonly pastDue: number;
  readonly pendingVerification: number;
  readonly disabledReason: string | null;
  readonly state: StripeOnboardingState;
}

/** One company's connected account attempt, with the provider id it produced. */
export interface StripeAccountProvision {
  readonly id: string;
  readonly companyId: string;
  readonly environment: "sandbox" | "live";
  /** The KYC submission the attempt was authorized by. */
  readonly kycSubmissionId: string;
  readonly accountId: string | null;
  /** The capabilities the answer reported as active, in the documented order. */
  readonly activeCapabilities: readonly string[];
  /** The requirements the account answered with, summarised; null until an account exists. */
  readonly requirements: StripeAccountRequirementState | null;
  /** Who collects requirements for this account, as the configuration derives it. */
  readonly requirementsCollector: "stripe" | "application" | null;
  readonly status: StripeAccountProvisionStatus;
  readonly reason: string | null;
  readonly requiresReconciliation: boolean;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** The only moves a provision may make. A row carrying an account id never leaves `created`. */
export const STRIPE_ACCOUNT_OUTCOMES: Readonly<
  Record<StripeAccountProvisionStatus, readonly StripeAccountProvisionStatus[]>
> = deepFreeze({
  pending: ["pending", "created", "rejected", "unknown"],
  unknown: ["unknown", "created", "rejected", "pending"],
  rejected: ["rejected", "pending"],
  created: ["created"],
});

/** What the store reads and writes. One row per company and mode. The store is the caller's. */
export interface StripeAccountProvisionStore {
  insert(provision: StripeAccountProvision): void;
  findById(id: string): StripeAccountProvision | null;
  findByCompany(companyId: string): StripeAccountProvision | null;
  /** Write the next record only when the stored version is `expectedVersion` and it advances by one. */
  save(next: StripeAccountProvision, expectedVersion: number): boolean;
}

/**
 * The in-memory store: a reference implementation of the invariants the real table must enforce — one
 * row per company, an immutable company, mode, id and KYC submission, a version guard, forward-only
 * outcomes, a `created` row that carries an `acct_` id, and a row carrying an id that is final.
 */
export class InMemoryStripeAccountProvisionStore implements StripeAccountProvisionStore {
  private readonly provisions = new Map<string, StripeAccountProvision>();

  insert(provision: StripeAccountProvision): void {
    if (this.provisions.has(provision.id)) throw new Error("duplicate provision id");
    if (provision.version !== 1) throw new Error("a new provision starts at version 1");
    if (provision.status !== "pending") throw new Error("a new provision is pending");
    if (this.findByCompany(provision.companyId) !== null) throw new Error("this company already has a provision");
    this.provisions.set(provision.id, provision);
  }

  findById(id: string): StripeAccountProvision | null {
    return this.provisions.get(id) ?? null;
  }

  findByCompany(companyId: string): StripeAccountProvision | null {
    return [...this.provisions.values()].find((provision) => provision.companyId === companyId) ?? null;
  }

  save(next: StripeAccountProvision, expectedVersion: number): boolean {
    const current = this.provisions.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.environment !== next.environment) return false;
    if (current.kycSubmissionId !== next.kycSubmissionId) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (STRIPE_ACCOUNT_OUTCOMES[current.status].includes(next.status) === false) return false;
    if (current.accountId !== null && next.accountId !== current.accountId) return false;
    if (next.status === "created" && next.accountId === null) return false;
    if (current.accountId !== null && next.status !== "created") return false;
    this.provisions.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/** One audit entry this file hands to the caller's audit writer. Never carries a credential. */
export interface StripeAccountAuditEntry {
  readonly action:
    | "connected_account.created"
    | "connected_account.rejected"
    | "connected_account.unknown"
    | "connected_account.onboarding_link_issued";
  readonly providerKey: typeof STRIPE_PROVIDER_KEY;
  readonly companyId: string;
  readonly provisionId: string;
  readonly accountId: string | null;
  readonly environment: "sandbox" | "live";
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/* -------------------------------------------------------------------------------------------------
 * Provisioning
 * ---------------------------------------------------------------------------------------------- */

/** The KYC decision that authorizes a connected account. */
export interface StripeKycApproval {
  readonly submissionId: string;
  readonly companyId: string;
  readonly status: string;
  readonly decidedAtEpochMs: number;
}

/** What a caller asks for. */
export interface ProvisionStripeAccountInput {
  readonly companyId: string;
  readonly profile: StripeCompanyProfile;
  readonly kyc: StripeKycApproval;
}

/** What provisioning needs. */
export interface StripeAccountOptions {
  readonly configStore: StripeConfigStore;
  readonly provisionStore: StripeAccountProvisionStore;
  readonly keyring: EncryptionKeyring;
  readonly occurredAtEpochMs: number;
  readonly transport?: StripeAccountTransport;
  readonly recordAudit?: (entry: StripeAccountAuditEntry) => void;
}

/** What one provisioning attempt did. */
export type ProvisionStripeAccountResult =
  | { readonly status: "created"; readonly provision: StripeAccountProvision }
  | { readonly status: "already_created"; readonly provision: StripeAccountProvision }
  | {
      readonly status: "in_flight";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: StripeAccountProvision;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly provision: StripeAccountProvision }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "unknown";
      readonly requiresReconciliation: true;
      readonly reason: string;
      readonly provision: StripeAccountProvision;
    };

/** The active configuration of a company opened for one call, or the reason there is none. */
function activeConfigurationOf(
  companyId: string,
  options: StripeAccountOptions,
):
  | { readonly ok: true; readonly config: StripeKeyConfig; readonly secretKey: string }
  | { readonly ok: false; readonly reason: string } {
  const config = options.configStore.findActiveByCompany(companyId);
  if (config === null) {
    return { ok: false, reason: "no active Stripe key configuration exists for this company" };
  }
  if (config.accountSurface !== "accounts_v2") {
    return { ok: false, reason: "the active configuration was not proven on the Accounts v2 surface" };
  }
  try {
    const secretKey = openSecret(options.keyring, config.secretKeySealed, {
      purpose: "secret",
      scope: stripeSecretKeyScope(companyId),
    });
    return { ok: true, config, secretKey };
  } catch {
    return { ok: false, reason: "the sealed secret key cannot be opened with this keyring" };
  }
}

/** Summarise the requirements an answer carries. */
function requirementStateOf(payload: unknown): StripeAccountRequirementState {
  const summary: StripeRequirementSummary = {
    currentlyDue: numberArrayLengthAt(payload, "requirements", "currently_due"),
    pastDue: numberArrayLengthAt(payload, "requirements", "past_due"),
    pendingVerification: numberArrayLengthAt(payload, "requirements", "pending_verification"),
    disabledReason: stringAt(payload, "requirements", "disabled_reason"),
  };
  return { ...summary, state: stripeOnboardingStateOf(summary) };
}

/** The capabilities the answer reports as active, without reading anything else. */
function activeCapabilitiesOf(payload: unknown): readonly string[] {
  const active: string[] = [];
  if (stringAt(payload, "configuration", "merchant", "capabilities", "card_payments", "status") === "active") {
    active.push("card_payments");
  }
  if (
    stringAt(payload, "configuration", "recipient", "capabilities", "stripe_balance", "stripe_transfers", "status") ===
    "active"
  ) {
    active.push("stripe_transfers");
  }
  return active;
}

/** The `acct_` id an answer names, or null. */
function accountIdOf(payload: unknown): string | null {
  const id = stringAt(payload, "id");
  return id !== null && STRIPE_ACCOUNT_ID_PATTERN.test(id) ? id : null;
}

/** What a create answer means for the provision it was made for. */
export type StripeAccountVerdict =
  | {
      readonly outcome: "created";
      readonly accountId: string;
      readonly activeCapabilities: readonly string[];
      readonly requirements: StripeAccountRequirementState;
      readonly requirementsCollector: "stripe" | "application" | null;
    }
  | { readonly outcome: "rejected"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string }
  | { readonly outcome: "unknown"; readonly detail: string };

/**
 * Read a create answer.
 *
 * Only the statuses the payment providers share can judge a request: `400`, `409` and `422` mean Stripe
 * refused the body, so nothing was created and the attempt may be reopened. `401` and `403` mean the key
 * was rejected or not permitted, and `404`, `405`, `415` and redirects mean the call was refused — all
 * `failed`, with the reason sanitised. A timeout-class code, `429`, any `5XX`, or a `2XX` that names no
 * `acct_` id leaves the outcome unknown: the account may exist, and only a replay or a person can settle
 * it.
 */
export function parseStripeAccountAnswer(statusCode: number, body: string): StripeAccountVerdict {
  const payload = parseJsonBody(body);

  if (statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500) {
    return { outcome: "unknown", detail: "the API did not answer finally; the account may exist" };
  }

  if (statusCode === 400 || statusCode === 409 || statusCode === 422) {
    const message = stripeAccountMessageOf(payload);
    return {
      outcome: "rejected",
      detail: message.length > 0 ? message : `Stripe refused the account with status ${statusCode}`,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    const message = stripeAccountMessageOf(payload);
    return {
      outcome: "failed",
      detail: message.length > 0 ? message : "the API rejected the key or refused the permission",
    };
  }

  if (statusCode >= 300 && statusCode < 400) {
    return { outcome: "failed", detail: "the API answered with a redirect, which proves nothing" };
  }

  if (statusCode < 200 || statusCode >= 300) {
    const message = stripeAccountMessageOf(payload);
    return {
      outcome: "failed",
      detail: message.length > 0 ? message : `the API refused the call with status ${statusCode}`,
    };
  }

  const accountId = accountIdOf(payload);
  if (accountId === null) {
    return { outcome: "unknown", detail: "the answer names no account id, so the account may or may not exist" };
  }

  return {
    outcome: "created",
    accountId,
    activeCapabilities: activeCapabilitiesOf(payload),
    requirements: requirementStateOf(payload),
    // The dashboard value is read from the answer; when a v2 answer omits it, the value this platform
    // set on the create call is the one the account has, because `dashboard` can never be changed once
    // the merchant configuration exists. The losses collector is this platform's own fixed choice.
    requirementsCollector: stripeRequirementsCollectorOf(
      stringAt(payload, "dashboard") ?? STRIPE_PLATFORM_DASHBOARD,
      STRIPE_PLATFORM_RESPONSIBILITIES.lossesCollector,
    ),
  };
}

/** Write the settled outcome onto the provision, version-guarded. */
function settleProvision(
  provision: StripeAccountProvision,
  next: StripeAccountProvision,
  options: StripeAccountOptions,
): StripeAccountProvision {
  const saved = options.provisionStore.save(next, provision.version);
  return saved ? next : (options.provisionStore.findById(provision.id) ?? provision);
}

/** Audit one provisioning outcome. */
function auditProvision(
  action: StripeAccountAuditEntry["action"],
  provision: StripeAccountProvision,
  outcome: string,
  options: StripeAccountOptions,
): void {
  if (options.recordAudit === undefined) return;
  options.recordAudit({
    action,
    providerKey: STRIPE_PROVIDER_KEY,
    companyId: provision.companyId,
    provisionId: provision.id,
    accountId: provision.accountId,
    environment: provision.environment,
    outcome,
    occurredAtEpochMs: options.occurredAtEpochMs,
  });
}

/**
 * Create the connected account for a KYC-approved company, once.
 *
 * The order is what makes this safe to retry: the approval is checked, the profile is validated, the
 * active key is opened, a `pending` row is written **before** the call, and only then is Stripe asked.
 * A replay with the row already `created` answers `already_created` without a call; a row left `unknown`
 * answers `in_flight` and asks for reconciliation rather than creating a second account; a `rejected` row
 * may be reopened, because Stripe created nothing.
 */
export async function provisionStripeAccount(
  input: ProvisionStripeAccountInput,
  options: StripeAccountOptions,
): Promise<ProvisionStripeAccountResult> {
  if (input.kyc.status !== STRIPE_KYC_APPROVED_STATUS) {
    return { status: "failed", reason: "the company's KYC review is not approved, so no account may be created" };
  }
  if (input.kyc.companyId !== input.companyId) {
    return { status: "failed", reason: "the KYC approval belongs to another company" };
  }
  if (input.kyc.submissionId.trim().length === 0) {
    return { status: "failed", reason: "the KYC approval names no submission" };
  }

  const profileProblem = validateStripeCompanyProfile(input.profile);
  if (profileProblem !== null) return { status: "failed", reason: profileProblem };

  const responsibilitiesProblem = validateStripeResponsibilities(STRIPE_PLATFORM_RESPONSIBILITIES);
  if (responsibilitiesProblem !== null) return { status: "failed", reason: responsibilitiesProblem };

  const configuration = activeConfigurationOf(input.companyId, options);
  if (configuration.ok === false) return { status: "failed", reason: configuration.reason };

  const existing = options.provisionStore.findByCompany(input.companyId);
  if (existing !== null) {
    if (existing.status === "created") return { status: "already_created", provision: existing };
    if (existing.status === "unknown") {
      return {
        status: "in_flight",
        requiresReconciliation: true,
        reason: "an earlier attempt has an unknown outcome; reconcile it before creating another account",
        provision: existing,
      };
    }
    if (existing.status === "rejected") {
      const reopened: StripeAccountProvision = {
        ...existing,
        status: "pending",
        reason: null,
        requiresReconciliation: false,
        version: existing.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      };
      const saved = options.provisionStore.save(reopened, existing.version);
      if (saved === false) return { status: "failed", reason: "the provision changed while it was being reopened" };
      return await attemptAccountCreation(reopened, input.profile, configuration.config, configuration.secretKey, options);
    }
    return { status: "failed", reason: "an attempt for this company is already in flight" };
  }

  const provision: StripeAccountProvision = {
    id: randomUUID(),
    companyId: input.companyId,
    environment: configuration.config.environment,
    kycSubmissionId: input.kyc.submissionId,
    accountId: null,
    activeCapabilities: [],
    requirements: null,
    requirementsCollector: null,
    status: "pending",
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: options.occurredAtEpochMs,
    updatedAtEpochMs: options.occurredAtEpochMs,
  };

  try {
    options.provisionStore.insert(provision);
  } catch {
    return { status: "failed", reason: "this company already has a connected-account attempt" };
  }

  return await attemptAccountCreation(provision, input.profile, configuration.config, configuration.secretKey, options);
}

/** The call itself, made only after the pending row exists. */
async function attemptAccountCreation(
  provision: StripeAccountProvision,
  profile: StripeCompanyProfile,
  config: StripeKeyConfig,
  secretKey: string,
  options: StripeAccountOptions,
): Promise<ProvisionStripeAccountResult> {
  let verdict: StripeAccountVerdict;
  try {
    const answer = await (options.transport ?? stripeAccountFetchTransport)({
      path: STRIPE_ACCOUNTS_PATH,
      contentType: "application/json",
      body: JSON.stringify(buildStripeAccountBody(profile)),
      secretKey,
      apiVersion: config.apiVersion,
    });
    verdict = parseStripeAccountAnswer(answer.status, answer.body);
  } catch {
    verdict = { outcome: "unknown", detail: "the API could not be reached, so the account may or may not exist" };
  }

  if (verdict.outcome === "created") {
    const created = settleProvision(
      provision,
      {
        ...provision,
        status: "created",
        accountId: verdict.accountId,
        activeCapabilities: verdict.activeCapabilities,
        requirements: verdict.requirements,
        requirementsCollector: verdict.requirementsCollector,
        reason: null,
        requiresReconciliation: false,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditProvision("connected_account.created", created, "created", options);
    return { status: "created", provision: created };
  }

  if (verdict.outcome === "rejected") {
    const rejected = settleProvision(
      provision,
      {
        ...provision,
        status: "rejected",
        reason: verdict.detail,
        requiresReconciliation: false,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditProvision("connected_account.rejected", rejected, "rejected", options);
    return { status: "rejected", reason: verdict.detail, provision: rejected };
  }

  if (verdict.outcome === "unknown") {
    const unknown = settleProvision(
      provision,
      {
        ...provision,
        status: "unknown",
        reason: verdict.detail,
        requiresReconciliation: true,
        version: provision.version + 1,
        updatedAtEpochMs: options.occurredAtEpochMs,
      },
      options,
    );
    auditProvision("connected_account.unknown", unknown, "unknown", options);
    return { status: "unknown", requiresReconciliation: true, reason: verdict.detail, provision: unknown };
  }

  return { status: "failed", reason: verdict.detail };
}

/* -------------------------------------------------------------------------------------------------
 * The documented onboarding link
 * ---------------------------------------------------------------------------------------------- */

/** What a caller asks for when it needs an onboarding link. */
export interface StripeOnboardingLinkInput {
  readonly provisionId: string;
  readonly type: string;
  readonly refreshUrl: string;
  readonly returnUrl: string;
}

/** What issuing a link needs. */
export type StripeOnboardingLinkOptions = StripeAccountOptions;

/** What issuing a link did. Never carries the key. */
export type CreateStripeOnboardingLinkResult =
  | { readonly status: "issued"; readonly url: string; readonly expiresAtEpochMs: number; readonly type: string }
  | { readonly status: "failed"; readonly reason: string };

const URL_PATTERN = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,190}(?::[0-9]{1,5})?(?:\/[^\s"<>]{0,200})?$/u;

/** The reason a return or refresh URL is unusable, or null when it is usable. */
export function validateOnboardingUrl(url: string): string | null {
  if (URL_PATTERN.test(url.trim()) === false) return "an onboarding URL must be an absolute HTTPS URL";
  return null;
}

/** Encode the documented form body an account link takes. */
export function buildStripeAccountLinkBody(input: StripeOnboardingLinkInput, accountId: string): string {
  return [
    `account=${encodeURIComponent(accountId)}`,
    `type=${encodeURIComponent(input.type)}`,
    `refresh_url=${encodeURIComponent(input.refreshUrl.trim())}`,
    `return_url=${encodeURIComponent(input.returnUrl.trim())}`,
  ].join("&");
}

/** Read an account-link answer. */
export type StripeAccountLinkVerdict =
  | { readonly outcome: "issued"; readonly url: string; readonly expiresAtEpochMs: number | null }
  | { readonly outcome: "failed"; readonly detail: string };

/**
 * Read an account-link answer.
 *
 * The documented answer is `{ object: "account_link", url, expires_at }`, and the URL is the only thing a
 * caller may redirect to — so it is checked to be an absolute HTTPS URL before it is returned. An answer
 * that names no such URL is a failure, whatever its status code says.
 */
export function parseStripeAccountLinkAnswer(statusCode: number, body: string): StripeAccountLinkVerdict {
  const payload = parseJsonBody(body);

  if (statusCode < 200 || statusCode >= 300) {
    const message = stripeAccountMessageOf(payload);
    return {
      outcome: "failed",
      detail: message.length > 0 ? message : `the API refused the onboarding link with status ${statusCode}`,
    };
  }

  if (stringAt(payload, "object") !== "account_link") {
    return { outcome: "failed", detail: "the answer is not an account link, so nothing may be redirected to" };
  }

  const url = stringAt(payload, "url");
  if (url === null || validateOnboardingUrl(url) !== null) {
    return { outcome: "failed", detail: "the account link carries no usable HTTPS URL" };
  }

  const expiresAt = recordOf(payload)?.["expires_at"];
  return {
    outcome: "issued",
    url,
    expiresAtEpochMs: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt * 1_000 : null,
  };
}

/**
 * Issue a documented onboarding link for a created account.
 *
 * Only an account that exists can be linked, so the provision must be `created` and carry an `acct_` id.
 * The link is single use and short lived — the documented answer carries `expires_at` — and the caller's
 * `refresh_url` is what it sends a merchant back to when the link has expired, exactly as the page
 * describes.
 */
export async function createStripeOnboardingLink(
  input: StripeOnboardingLinkInput,
  options: StripeOnboardingLinkOptions,
): Promise<CreateStripeOnboardingLinkResult> {
  if (STRIPE_ACCOUNT_LINK_TYPES.includes(input.type) === false) {
    return { status: "failed", reason: "the link type must be account_onboarding or account_update" };
  }
  const refreshProblem = validateOnboardingUrl(input.refreshUrl);
  if (refreshProblem !== null) return { status: "failed", reason: refreshProblem };
  const returnProblem = validateOnboardingUrl(input.returnUrl);
  if (returnProblem !== null) return { status: "failed", reason: returnProblem };

  const provision = options.provisionStore.findById(input.provisionId);
  if (provision === null) return { status: "failed", reason: "no connected-account provision holds that id" };
  if (provision.status !== "created" || provision.accountId === null) {
    return { status: "failed", reason: "the connected account does not exist yet, so there is nothing to onboard" };
  }

  const configuration = activeConfigurationOf(provision.companyId, options);
  if (configuration.ok === false) return { status: "failed", reason: configuration.reason };

  let verdict: StripeAccountLinkVerdict;
  try {
    const answer = await (options.transport ?? stripeAccountFetchTransport)({
      path: STRIPE_ONBOARDING_LINK_PATH,
      contentType: "application/x-www-form-urlencoded",
      body: buildStripeAccountLinkBody(input, provision.accountId),
      secretKey: configuration.secretKey,
      apiVersion: configuration.config.apiVersion,
    });
    verdict = parseStripeAccountLinkAnswer(answer.status, answer.body);
  } catch {
    return { status: "failed", reason: "the API could not be reached, so no link was issued" };
  }

  if (verdict.outcome === "failed") return { status: "failed", reason: verdict.detail };

  auditProvision("connected_account.onboarding_link_issued", provision, input.type, options);
  return {
    status: "issued",
    url: verdict.url,
    expiresAtEpochMs:
      verdict.expiresAtEpochMs ?? options.occurredAtEpochMs + STRIPE_ACCOUNT_LINK_DEFAULT_TTL_SECONDS * 1_000,
    type: input.type,
  };
}

/* -------------------------------------------------------------------------------------------------
 * What a provision means for the platform
 * ---------------------------------------------------------------------------------------------- */

/** Whether a company's account can accept payments yet, and what stops it. */
export interface StripeAccountReadiness {
  /** True only when the account exists and both requested capabilities are active. */
  readonly canAcceptPayments: boolean;
  /** True when the account exists and every outstanding requirement is satisfied. */
  readonly onboarded: boolean;
  /** What stops it, in one sentence, or null when nothing does. */
  readonly blockingReason: string | null;
}

/**
 * Read a provision as readiness for payment acceptance.
 *
 * STEP 162 recorded the capability rule: a capability must be `active` for the account to perform its
 * actions. So an account can accept payments only when it exists and both `card_payments` and
 * `stripe_transfers` are active, and it is onboarded only when this platform — which collects the
 * requirements, per the configuration — has nothing outstanding on it.
 */
export function stripeAccountReadinessOf(provision: StripeAccountProvision): StripeAccountReadiness {
  if (provision.status !== "created" || provision.accountId === null) {
    return {
      canAcceptPayments: false,
      onboarded: false,
      blockingReason:
        provision.status === "unknown"
          ? "the account's creation has an unknown outcome and needs reconciliation"
          : "the account has not been created",
    };
  }

  const hasCardPayments = provision.activeCapabilities.includes("card_payments");
  const hasTransfers = provision.activeCapabilities.includes("stripe_transfers");
  const requirements = provision.requirements;
  const outstanding =
    requirements === null
      ? 0
      : requirements.currentlyDue + requirements.pastDue + requirements.pendingVerification;

  if (hasCardPayments === false || hasTransfers === false) {
    return {
      canAcceptPayments: false,
      onboarded: false,
      blockingReason:
        hasCardPayments === false
          ? "the card_payments capability is not active yet"
          : "the stripe_transfers capability is not active yet",
    };
  }

  if (requirements !== null && requirements.state === "blocked") {
    return {
      canAcceptPayments: false,
      onboarded: false,
      blockingReason:
        requirements.disabledReason !== null
          ? `the account is blocked: ${requirements.disabledReason}`
          : "the account has requirements past due",
    };
  }

  if (outstanding > 0) {
    return {
      canAcceptPayments: true,
      onboarded: false,
      blockingReason: "the account still has requirements due, but the capabilities are active",
    };
  }

  return { canAcceptPayments: true, onboarded: true, blockingReason: null };
}
