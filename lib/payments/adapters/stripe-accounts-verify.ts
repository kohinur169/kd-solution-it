// path: lib/payments/adapters/stripe-accounts-verify.ts

/**
 * The gate for STEP 163: Stripe Connect connected account creation after KYC approval.
 *
 * A check script, not a test file: it exercises provisioning, the documented onboarding link and the
 * readiness mapping against a recording transport, then fails and names every check that did not hold.
 * No network call is made and no real credential is used.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  buildStripeAccountBody,
  buildStripeAccountLinkBody,
  createStripeOnboardingLink,
  InMemoryStripeAccountProvisionStore,
  parseStripeAccountAnswer,
  parseStripeAccountLinkAnswer,
  provisionStripeAccount,
  stripeAccountEndpointFor,
  stripeAccountFetchTransport,
  stripeAccountMessageOf,
  stripeAccountReadinessOf,
  stripePlatformCollectsRequirements,
  stripeRequirementsCollectorOf,
  STRIPE_ACCOUNT_ALLOWED_PATHS,
  STRIPE_ACCOUNT_ANSWER_MAXIMUM_BYTES,
  STRIPE_ACCOUNT_INCLUDE_VALUES,
  STRIPE_ACCOUNT_LINK_DEFAULT_TTL_SECONDS,
  STRIPE_ACCOUNT_LINK_TYPES,
  STRIPE_ACCOUNT_OUTCOMES,
  STRIPE_ACCOUNT_TEXT_MAXIMUM_LENGTH,
  STRIPE_ACCOUNTS_PATH,
  STRIPE_DASHBOARD_VALUES,
  STRIPE_ENTITY_TYPES,
  STRIPE_KYC_APPROVED_STATUS,
  STRIPE_ONBOARDING_LINK_PATH,
  STRIPE_PLATFORM_DASHBOARD,
  STRIPE_PLATFORM_DASHBOARD_REASON,
  STRIPE_PLATFORM_RESPONSIBILITIES,
  STRIPE_REQUESTED_CAPABILITIES,
  STRIPE_RESPONSIBILITY_VALUES,
  validateOnboardingUrl,
  validateStripeCompanyProfile,
  validateStripeResponsibilities,
  type ProvisionStripeAccountInput,
  type StripeAccountAuditEntry,
  type StripeAccountProvision,
  type StripeAccountTransport,
  type StripeCompanyProfile,
  type StripeKycApproval,
} from "./stripe-accounts.ts";
import { configureStripeKeys, type StripeConfigStore, type StripeKeyConfig } from "./stripe-client.ts";
import { STRIPE_ACCOUNT_LINKS_PATH, STRIPE_ACCOUNT_ID_PATTERN, STRIPE_PROVIDER_KEY } from "./stripe.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) failures.push(description);
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectThrows(action: () => void, description: string): void {
  try {
    action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

/* ---- fixtures ---- */

const fixture = (prefix: string, body: string): string => `${prefix}_${body}`;
const sandboxSecret = fixture("sk_test", "51NxAbCdEfGhIjKlMnOpQrStUvWx");
const webhookSecret = fixture("whsec", "abcdefghijklmnopqrstuvwx");
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const NOW = 1_760_000_000_000;
const ACCOUNT_ID = "acct_1QxAbCdEfGhIjKlMnOpQ";

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const foreignKeyring: EncryptionKeyring = { primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") } };

const profile: StripeCompanyProfile = {
  legalName: "Kohinur Digital Ltd",
  displayName: "Kohinur",
  contactEmail: "billing@kohinur.example",
  country: "bd",
  entityType: "company",
  currency: "usd",
  locale: "en-US",
};

const approval: StripeKycApproval = {
  submissionId: "0c3e4f5a-0000-4000-8000-000000000010",
  companyId,
  status: "approved",
  decidedAtEpochMs: NOW - 86_400_000,
};

const createdAnswer = JSON.stringify({
  id: ACCOUNT_ID,
  object: "account",
  dashboard: "none",
  contact_email: "billing@kohinur.example",
  display_name: "Kohinur",
  identity: { country: "bd", entity_type: "company", business_details: { registered_name: "Kohinur Digital Ltd" } },
  configuration: {
    merchant: { capabilities: { card_payments: { status: "active" } } },
    recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" } } } },
  },
  requirements: {
    currently_due: [],
    past_due: [],
    pending_verification: [],
    eventually_due: [],
    disabled_reason: null,
  },
});

function configStoreFor(
  overrides: Partial<StripeKeyConfig> = {},
  targetCompanyId: string = companyId,
): { store: StripeConfigStore; config: StripeKeyConfig } {
  const store = new (class {
    private readonly configs = new Map<string, StripeKeyConfig>();
    insert(config: StripeKeyConfig): void {
      this.configs.set(config.id, config);
    }
    findById(id: string): StripeKeyConfig | null {
      return this.configs.get(id) ?? null;
    }
    findByCompany(target: string): StripeKeyConfig[] {
      return [...this.configs.values()].filter((config) => config.companyId === target);
    }
    findActiveByCompany(target: string): StripeKeyConfig | null {
      return this.findByCompany(target).find((config) => config.status === "active") ?? null;
    }
    findPendingByCompany(target: string): StripeKeyConfig | null {
      return this.findByCompany(target).find((config) => config.status === "pending_activation") ?? null;
    }
    save(next: StripeKeyConfig): boolean {
      this.configs.set(next.id, next);
      return true;
    }
  })();

  // Build a real configuration through STEP 162's service, so the sealed key is genuine.
  const inner = new (class {
    private readonly configs = new Map<string, StripeKeyConfig>();
    insert(config: StripeKeyConfig): void {
      this.configs.set(config.id, config);
    }
    findById(id: string): StripeKeyConfig | null {
      return this.configs.get(id) ?? null;
    }
    findByCompany(target: string): StripeKeyConfig[] {
      return [...this.configs.values()].filter((config) => config.companyId === target);
    }
    findActiveByCompany(target: string): StripeKeyConfig | null {
      return this.findByCompany(target).find((config) => config.status === "active") ?? null;
    }
    findPendingByCompany(target: string): StripeKeyConfig | null {
      return this.findByCompany(target).find((config) => config.status === "pending_activation") ?? null;
    }
    save(next: StripeKeyConfig): boolean {
      this.configs.set(next.id, next);
      return true;
    }
  })();
  const configured = configureStripeKeys(
    { companyId: targetCompanyId, environment: "sandbox", secretKey: sandboxSecret, publishableKey: null, webhookSecret },
    { store: inner, keyring, occurredAtEpochMs: NOW },
  );
  const base = configured.status === "configured" ? configured.config : null;
  if (base === null) throw new Error("the fixture configuration could not be built");
  const active: StripeKeyConfig = {
    ...base,
    ...overrides,
    status: "active",
    lastTest: {
      outcome: "connected",
      testedAtEpochMs: NOW,
      environment: "sandbox",
      apiVersionSent: base.apiVersion,
    },
  };
  store.insert(active);
  return { store, config: active };
}

type Captured = {
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
  readonly secretKey: string;
  readonly apiVersion: string;
};

function transportReturning(
  answer: { readonly status: number; readonly body: string },
  captured: Captured[] = [],
): StripeAccountTransport {
  return async (request) => {
    captured.push({
      path: request.path,
      contentType: request.contentType,
      body: request.body,
      secretKey: request.secretKey,
      apiVersion: request.apiVersion,
    });
    return answer;
  };
}

const failingTransport: StripeAccountTransport = async () => {
  throw new Error("no transport in this check");
};

function inputOf(overrides: Partial<ProvisionStripeAccountInput> = {}): ProvisionStripeAccountInput {
  return { companyId, profile, kyc: approval, ...overrides };
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the configuration the pages fix
 * ---------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_ACCOUNTS_PATH, "/v2/core/accounts", "the create call uses the Accounts v2 collection");
expectEqual(STRIPE_ONBOARDING_LINK_PATH, "/v1/account_links", "the onboarding link uses the documented collection");
expectEqual(STRIPE_ACCOUNT_LINKS_PATH, STRIPE_ONBOARDING_LINK_PATH, "the path agrees with the one STEP 161 recorded");
expectEqual(STRIPE_ACCOUNT_ALLOWED_PATHS.length, 2, "exactly two endpoints are allowed");
expect(STRIPE_ACCOUNT_ALLOWED_PATHS.includes(STRIPE_ACCOUNTS_PATH), "the accounts path is allowed");
expect(STRIPE_ACCOUNT_ALLOWED_PATHS.includes(STRIPE_ONBOARDING_LINK_PATH), "the account-link path is allowed");
expect(!STRIPE_ACCOUNT_ALLOWED_PATHS.includes("/v1/charges"), "a charge path is not allowed by this file");
expectEqual(stripeAccountEndpointFor(STRIPE_ACCOUNTS_PATH), "https://api.stripe.com/v2/core/accounts", "the endpoint is the documented base plus the path");

expectEqual(STRIPE_DASHBOARD_VALUES.join(","), "express,full,none", "the three documented dashboard values are recorded");
expectEqual(STRIPE_RESPONSIBILITY_VALUES.join(","), "application,stripe", "the two documented responsibility values are recorded");
expectEqual(STRIPE_ENTITY_TYPES.join(","), "company,individual", "the two documented entity types are recorded");
expectEqual(STRIPE_ACCOUNT_LINK_TYPES.join(","), "account_onboarding,account_update", "the two documented link types are recorded");
expectEqual(STRIPE_PLATFORM_DASHBOARD, "none", "the merchant gets no Stripe Dashboard");
expect(STRIPE_PLATFORM_DASHBOARD_REASON.includes("platform"), "the dashboard reason says why");
expectEqual(STRIPE_PLATFORM_RESPONSIBILITIES.feesCollector, "application", "the platform collects fees");
expectEqual(STRIPE_PLATFORM_RESPONSIBILITIES.lossesCollector, "application", "the platform carries the losses");
expectEqual(STRIPE_KYC_APPROVED_STATUS, "approved", "the approving status is the one the KYC service writes");
expectEqual(
  STRIPE_REQUESTED_CAPABILITIES.join(","),
  "configuration.merchant.capabilities.card_payments.requested,configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested",
  "both documented capabilities are requested",
);
expectEqual(
  STRIPE_ACCOUNT_INCLUDE_VALUES.join(","),
  "configuration.merchant,identity,requirements",
  "the answer is asked for the configuration, the identity and the requirements",
);
expectEqual(STRIPE_ACCOUNT_ANSWER_MAXIMUM_BYTES, 65_536, "the answer ceiling is recorded");
expectEqual(STRIPE_ACCOUNT_TEXT_MAXIMUM_LENGTH, 200, "the provider text ceiling is recorded");

expectEqual(validateStripeResponsibilities({ feesCollector: "application", lossesCollector: "application" }), null, "both application is a valid pair");
expectEqual(validateStripeResponsibilities({ feesCollector: "stripe", lossesCollector: "stripe" }), null, "both stripe is a valid pair");
expectEqual(
  validateStripeResponsibilities({ feesCollector: "stripe", lossesCollector: "application" }),
  "a platform that collects losses must also collect fees; Stripe refuses the pair the other way round",
  "the documented restriction on the pair is enforced",
);
expectEqual(
  validateStripeResponsibilities({ feesCollector: "platform", lossesCollector: "stripe" }),
  "the fees collector must be application or stripe",
  "an invented fees collector is refused",
);
expectEqual(
  validateStripeResponsibilities({ feesCollector: "application", lossesCollector: "platform" }),
  "the losses collector must be application or stripe",
  "an invented losses collector is refused",
);

expectEqual(stripeRequirementsCollectorOf("none", "application"), "application", "the platform collects requirements for this configuration");
expectEqual(stripeRequirementsCollectorOf("none", "stripe"), "stripe", "Stripe collects when it carries the losses");
expectEqual(stripeRequirementsCollectorOf("full", "application"), "stripe", "Stripe collects when the merchant has a full dashboard");
expectEqual(stripeRequirementsCollectorOf("express", "stripe"), "stripe", "Stripe collects for an express dashboard");
expectEqual(stripeRequirementsCollectorOf("platform", "application"), null, "an invented dashboard value derives nothing");
expectEqual(stripeRequirementsCollectorOf("none", "banana"), null, "an invented losses collector derives nothing");
expect(stripePlatformCollectsRequirements(), "this platform is the requirements collector for the chosen configuration");

/* ------------------------------------------------------------------------------------------------
 * Section 2: the profile, and what it may not carry
 * ---------------------------------------------------------------------------------------------- */

expectEqual(validateStripeCompanyProfile(profile), null, "a well formed profile is valid");
expectEqual(validateStripeCompanyProfile({ ...profile, entityType: "individual" }), null, "an individual entity is valid");
expectEqual(
  validateStripeCompanyProfile({ ...profile, legalName: "<script>Kohinur</script>" }),
  "the legal name must be 2 to 100 letters, digits or common business punctuation",
  "a legal name carrying markup is refused",
);
expectEqual(
  validateStripeCompanyProfile({ ...profile, legalName: "K" }),
  "the legal name must be 2 to 100 letters, digits or common business punctuation",
  "a one character legal name is refused",
);
expectEqual(validateStripeCompanyProfile({ ...profile, contactEmail: "not-an-email" }), "the contact email is invalid", "an unshaped email is refused");
expectEqual(
  validateStripeCompanyProfile({ ...profile, country: "BD" }),
  "the country must be a two letter lower case code, as the documented examples write it",
  "an upper case country is refused, because the documented examples are lower case",
);
expectEqual(
  validateStripeCompanyProfile({ ...profile, entityType: "charity" }),
  "the entity type must be company or individual",
  "an invented entity type is refused",
);
expectEqual(
  validateStripeCompanyProfile({ ...profile, currency: "US" }),
  "the currency must be a three letter lower case code",
  "an unshaped currency is refused",
);
expectEqual(validateStripeCompanyProfile({ ...profile, locale: "en_US" }), "the locale must be written like en-US", "an unshaped locale is refused");

const body = buildStripeAccountBody(profile);
const bodyJson = JSON.stringify(body);
expectEqual(body["contact_email"], "billing@kohinur.example", "the body carries the contact email");
expectEqual(body["display_name"], "Kohinur", "the body carries the display name");
expectEqual(body["dashboard"], "none", "the body sets the platform's dashboard value");
expectEqual((body["identity"] as Record<string, unknown>)["country"], "bd", "the body carries the country");
expectEqual((body["identity"] as Record<string, unknown>)["entity_type"], "company", "the body carries the entity type");
expectEqual(
  ((body["identity"] as Record<string, Record<string, unknown>>)["business_details"]?.["registered_name"]),
  "Kohinur Digital Ltd",
  "the body carries the registered name",
);
expectEqual(
  ((body["configuration"] as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>)["merchant"]?.["capabilities"]?.["card_payments"]?.["requested"]),
  true,
  "the body requests card_payments in the documented nesting",
);
expectEqual(
  ((body["configuration"] as Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>>>)["recipient"]?.["capabilities"]?.["stripe_balance"]?.["stripe_transfers"]?.["requested"]),
  true,
  "the body requests stripe_transfers in the documented nesting",
);
expectEqual(
  ((body["defaults"] as Record<string, Record<string, unknown>>)["responsibilities"]?.["fees_collector"]),
  "application",
  "the body sets the fees collector",
);
expectEqual(
  ((body["defaults"] as Record<string, Record<string, unknown>>)["responsibilities"]?.["losses_collector"]),
  "application",
  "the body sets the losses collector",
);
expectEqual((body["defaults"] as Record<string, unknown>)["currency"], "usd", "the body sets the currency");
expectEqual(((body["defaults"] as Record<string, unknown[]>)["locales"] ?? []).join(","), "en-US", "the body sets the locale");
expectEqual((body["include"] as string[]).join(","), STRIPE_ACCOUNT_INCLUDE_VALUES.join(","), "the body asks for the documented include values");
expect(!Object.keys(body).includes("type"), "the body carries no legacy account type");
expect(!bodyJson.includes("\"type\":"), "the legacy account-type field is absent from the body");
expect(!JSON.stringify(Object.keys(body)).includes("controller"), "the v1 controller properties are absent from the v2 body");

expect(!bodyJson.includes("tax_id"), "the body carries no tax identifier");
expect(!bodyJson.includes("ssn"), "the body carries no SSN");
expect(!bodyJson.includes("dob"), "the body carries no date of birth");
expect(!bodyJson.includes("account_number"), "the body carries no bank account number");
expect(!bodyJson.includes("routing_number"), "the body carries no routing number");
expect(!bodyJson.includes("iban"), "the body carries no IBAN");
expect(!/\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/u.test(bodyJson), "no SSN-shaped value appears anywhere in the body");
expect(!/\b[0-9]{9}\b/u.test(bodyJson), "no nine-digit identifier appears anywhere in the body");

/* ------------------------------------------------------------------------------------------------
 * Section 3: reading a create answer
 * ---------------------------------------------------------------------------------------------- */

const createdVerdict = parseStripeAccountAnswer(200, createdAnswer);
expectEqual(createdVerdict.outcome, "created", "a 2XX naming an acct_ id creates the account");
expectEqual(createdVerdict.outcome === "created" ? createdVerdict.accountId : "", ACCOUNT_ID, "the account id is read");
expect(STRIPE_ACCOUNT_ID_PATTERN.test(ACCOUNT_ID), "the account id matches the documented shape");
expectEqual(
  createdVerdict.outcome === "created" ? createdVerdict.activeCapabilities.join(",") : "",
  "card_payments,stripe_transfers",
  "both active capabilities are read",
);
expectEqual(
  createdVerdict.outcome === "created" ? createdVerdict.requirements.state : "",
  "ready",
  "an account with nothing outstanding is ready",
);
expectEqual(
  createdVerdict.outcome === "created" ? createdVerdict.requirementsCollector : "",
  "application",
  "the collector is derived for the answer's configuration",
);
expectEqual(parseStripeAccountAnswer(201, createdAnswer).outcome, "created", "a 201 also creates");

const waitingAnswer = JSON.stringify({
  id: ACCOUNT_ID,
  dashboard: "none",
  configuration: { merchant: { capabilities: { card_payments: { status: "pending" } } } },
  requirements: { currently_due: ["identity.business_details.registered_name"], past_due: [], pending_verification: [] },
});
const waitingVerdict = parseStripeAccountAnswer(200, waitingAnswer);
expectEqual(waitingVerdict.outcome === "created" ? waitingVerdict.requirements.state : "", "waiting", "an outstanding requirement is waiting");
expectEqual(waitingVerdict.outcome === "created" ? waitingVerdict.activeCapabilities.length : 9, 0, "a pending capability is not counted as active");

const blockedAnswer = JSON.stringify({
  id: ACCOUNT_ID,
  dashboard: "none",
  requirements: { currently_due: ["company.tax_id"], past_due: ["company.tax_id"], pending_verification: [], disabled_reason: "requirements.past_due" },
});
const blockedVerdict = parseStripeAccountAnswer(200, blockedAnswer);
expectEqual(blockedVerdict.outcome === "created" ? blockedVerdict.requirements.state : "", "blocked", "a disabled reason blocks the account");
expectEqual(
  blockedVerdict.outcome === "created" ? blockedVerdict.requirements.disabledReason : "",
  "requirements.past_due",
  "the documented disabled reason is kept",
);

const rejectionBody = JSON.stringify({ error: { type: "invalid_request_error", message: "The country bd is not supported" } });
const rejectedVerdict = parseStripeAccountAnswer(400, rejectionBody);
expectEqual(rejectedVerdict.outcome, "rejected", "a 400 is a rejection");
expectEqual(rejectedVerdict.outcome === "rejected" ? rejectedVerdict.detail : "", "The country bd is not supported", "the provider message is the reason");
expectEqual(parseStripeAccountAnswer(409, rejectionBody).outcome, "rejected", "a 409 is a rejection");
expectEqual(parseStripeAccountAnswer(422, rejectionBody).outcome, "rejected", "a 422 is a rejection");
expectEqual(parseStripeAccountAnswer(400, "").outcome, "rejected", "a 400 without a body still rejects");
expect(
  parseStripeAccountAnswer(400, "").outcome === "rejected" &&
    (parseStripeAccountAnswer(400, "") as { detail: string }).detail.includes("400"),
  "a 400 without a message names the status",
);

expectEqual(parseStripeAccountAnswer(401, "").outcome, "failed", "a 401 is a failure, not a rejection");
expectEqual(parseStripeAccountAnswer(403, "").outcome, "failed", "a 403 is a failure");
expectEqual(parseStripeAccountAnswer(404, "").outcome, "failed", "a 404 is a failure");
expectEqual(parseStripeAccountAnswer(405, "").outcome, "failed", "a 405 is a failure");
expectEqual(parseStripeAccountAnswer(415, "").outcome, "failed", "a 415 is a failure");
expectEqual(parseStripeAccountAnswer(302, "").outcome, "failed", "a redirect is a failure");

expectEqual(parseStripeAccountAnswer(408, "").outcome, "unknown", "a timeout is unknown");
expectEqual(parseStripeAccountAnswer(425, "").outcome, "unknown", "a too-early answer is unknown");
expectEqual(parseStripeAccountAnswer(429, "").outcome, "unknown", "a rate limit is unknown");
expectEqual(parseStripeAccountAnswer(500, "").outcome, "unknown", "a server error is unknown");
expectEqual(parseStripeAccountAnswer(503, rejectionBody).outcome, "unknown", "a 503 is unknown even with a message");
expectEqual(parseStripeAccountAnswer(200, JSON.stringify({ object: "account" })).outcome, "unknown", "a 200 without an id is unknown");
expectEqual(parseStripeAccountAnswer(200, "not json").outcome, "unknown", "a 200 that is not JSON is unknown");
expectEqual(parseStripeAccountAnswer(200, JSON.stringify({ id: "cus_1NxAbCdEfGhIjKl" })).outcome, "unknown", "a 200 naming a customer id is unknown");
expect(
  parseStripeAccountAnswer(429, "").outcome === "unknown" &&
    (parseStripeAccountAnswer(429, "") as { detail: string }).detail.includes("may exist"),
  "an unknown outcome says the account may exist",
);

expectEqual(stripeAccountMessageOf({ error: { message: "Nope" } }), "Nope", "the documented error object is read");
expectEqual(stripeAccountMessageOf({ error: { code: "resource_missing" } }), "resource_missing", "a code is used when there is no message");
expectEqual(stripeAccountMessageOf({ message: "plain" }), "plain", "a bare message is read");
expectEqual(stripeAccountMessageOf(null), "", "no payload has no message");
expect(stripeAccountMessageOf({ error: { message: "<b>x</b>" } }) === "x", "the message is sanitised");
expect(stripeAccountMessageOf({ error: { message: "a".repeat(500) } }).length <= STRIPE_ACCOUNT_TEXT_MAXIMUM_LENGTH, "the message is capped");

/* ------------------------------------------------------------------------------------------------
 * Section 4: the KYC gate and the configuration gate
 * ---------------------------------------------------------------------------------------------- */

const gateStore = new InMemoryStripeAccountProvisionStore();
const gateConfig = configStoreFor();

const notApproved = await provisionStripeAccount(inputOf({ kyc: { ...approval, status: "pending" } }), {
  configStore: gateConfig.store,
  provisionStore: gateStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }),
});
expectEqual(
  notApproved.status === "failed" ? notApproved.reason : "",
  "the company's KYC review is not approved, so no account may be created",
  "the refusal says the review is not approved",
);
expectEqual(
  (await provisionStripeAccount(inputOf({ kyc: { ...approval, status: "rejected" } }), {
    configStore: gateConfig.store,
    provisionStore: gateStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: transportReturning({ status: 200, body: createdAnswer }),
  })).status,
  "failed",
  "a rejected review cannot be provisioned",
);
const otherCompanyApproval = await provisionStripeAccount(
  inputOf({ kyc: { ...approval, companyId: otherCompanyId } }),
  { configStore: gateConfig.store, provisionStore: gateStore, keyring, occurredAtEpochMs: NOW, transport: transportReturning({ status: 200, body: createdAnswer }) },
);
expectEqual(
  otherCompanyApproval.status === "failed" ? otherCompanyApproval.reason : "",
  "the KYC approval belongs to another company",
  "an approval for another company is refused",
);
const noSubmission = await provisionStripeAccount(inputOf({ kyc: { ...approval, submissionId: " " } }), {
  configStore: gateConfig.store,
  provisionStore: gateStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }),
});
expectEqual(
  noSubmission.status === "failed" ? noSubmission.reason : "",
  "the KYC approval names no submission",
  "an approval without a submission is refused",
);
const badProfile = await provisionStripeAccount(inputOf({ profile: { ...profile, contactEmail: "nope" } }), {
  configStore: gateConfig.store,
  provisionStore: gateStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }),
});
expectEqual(badProfile.status === "failed" ? badProfile.reason : "", "the contact email is invalid", "an invalid profile is refused before any call");
expectEqual(gateStore.findByCompany(companyId), null, "a refusal writes no provision");

const noConfigStore = new (class {
  insert(): void {}
  findById(): null {
    return null;
  }
  findByCompany(): StripeKeyConfig[] {
    return [];
  }
  findActiveByCompany(): StripeKeyConfig | null {
    return null;
  }
  findPendingByCompany(): StripeKeyConfig | null {
    return null;
  }
  save(): boolean {
    return false;
  }
}) satisfies StripeConfigStore;

const noConfig = await provisionStripeAccount(inputOf(), {
  configStore: noConfigStore,
  provisionStore: new InMemoryStripeAccountProvisionStore(),
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }),
});
expectEqual(
  noConfig.status === "failed" ? noConfig.reason : "",
  "no active Stripe key configuration exists for this company",
  "provisioning needs an active key",
);

const legacySurfaceStore = configStoreFor({ accountSurface: "accounts_v2" });
const legacySurfaceConfig: StripeKeyConfig = { ...legacySurfaceStore.config, accountSurface: "accounts_v1" as unknown as "accounts_v2" };
const legacySurface = await provisionStripeAccount(inputOf(), {
  configStore: {
    insert: () => undefined,
    save: () => false,
    findByCompany: () => [legacySurfaceConfig],
    findActiveByCompany: () => legacySurfaceConfig,
    findPendingByCompany: () => null,
    findById: () => legacySurfaceConfig,
  },
  provisionStore: new InMemoryStripeAccountProvisionStore(),
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }),
});
expectEqual(
  legacySurface.status === "failed" ? legacySurface.reason : "",
  "the active configuration was not proven on the Accounts v2 surface",
  "a configuration proven on another surface cannot provision",
);

const foreignKey = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: new InMemoryStripeAccountProvisionStore(),
  keyring: foreignKeyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }),
});
expectEqual(
  foreignKey.status === "failed" ? foreignKey.reason : "",
  "the sealed secret key cannot be opened with this keyring",
  "a keyring that cannot open the key refuses to provision",
);

/* ------------------------------------------------------------------------------------------------
 * Section 5: provisioning, and provisioning again
 * ---------------------------------------------------------------------------------------------- */

const store = new InMemoryStripeAccountProvisionStore();
const auditLog: StripeAccountAuditEntry[] = [];
const captured: Captured[] = [];

const first = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: store,
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }, captured),
  recordAudit: (entry) => auditLog.push(entry),
});
expectEqual(first.status, "created", "an approved company with a valid profile creates an account");
const provision = first.status === "created" ? first.provision : null;
expectEqual(provision?.accountId, ACCOUNT_ID, "the account id is recorded");
expectEqual(provision?.status, "created", "the provision is created");
expectEqual(provision?.companyId, companyId, "the provision names the company");
expectEqual(provision?.environment, "sandbox", "the provision records the mode of the key that made it");
expectEqual(provision?.kycSubmissionId, approval.submissionId, "the provision names the KYC submission that authorized it");
expectEqual(provision?.version, 2, "creating advances the provision version");
expectEqual(provision?.requiresReconciliation, false, "a created provision needs no reconciliation");
expectEqual(provision?.requirements?.state, "ready", "the requirements are summarised on the record");
expectEqual(provision?.requirementsCollector, "application", "the record says who collects requirements");
expectEqual((provision?.activeCapabilities ?? []).join(","), "card_payments,stripe_transfers", "the active capabilities are recorded");

expectEqual(captured.length, 1, "exactly one call is made");
expectEqual(captured[0]?.path, STRIPE_ACCOUNTS_PATH, "the call goes to the documented collection");
expectEqual(captured[0]?.contentType, "application/json", "the create body is JSON, as the documented example sends it");
expectEqual(captured[0]?.secretKey, sandboxSecret, "the call uses the sealed key, opened in memory");
expectEqual(captured[0]?.apiVersion, gateConfig.config.apiVersion, "the call sends the pinned version");
expect(captured[0]?.body.includes("\"dashboard\":\"none\"") === true, "the sent body carries the platform's dashboard value");
expect(captured[0]?.body.includes("stripe_transfers") === true, "the sent body requests transfers");

expectEqual(auditLog.length, 1, "creating writes one audit entry");
expectEqual(auditLog[0]?.action, "connected_account.created", "the audit entry names the creation");
expectEqual(auditLog[0]?.providerKey, "stripe", "the audit entry names the provider");
expectEqual(auditLog[0]?.accountId, ACCOUNT_ID, "the audit entry names the account");
expectEqual(auditLog[0]?.companyId, companyId, "the audit entry names the company");
expect(JSON.stringify(first).includes(sandboxSecret) === false, "the result never carries the key");
expect(JSON.stringify(auditLog).includes(sandboxSecret) === false, "the audit entry never carries the key");

const replayCaptured: Captured[] = [];
const replay = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: store,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: createdAnswer }, replayCaptured),
});
expectEqual(replay.status, "already_created", "a replay answers from the record");
expectEqual(replay.status === "already_created" ? replay.provision.accountId : "", ACCOUNT_ID, "the replay returns the same account");
expectEqual(replayCaptured.length, 0, "a replay makes no call, so no second account can exist");

const unknownStore = new InMemoryStripeAccountProvisionStore();
const unknown = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: unknownStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: failingTransport,
});
expectEqual(unknown.status, "unknown", "a transport that throws leaves the outcome unknown");
expectEqual(unknown.status === "unknown" ? unknown.requiresReconciliation : false, true, "an unknown outcome asks for reconciliation");
expectEqual(unknown.status === "unknown" ? unknown.provision.status : "", "unknown", "the record is stored as unknown");
expectEqual(unknownStore.findByCompany(companyId)?.accountId, null, "an unknown attempt carries no account id");
const inFlightCaptured: Captured[] = [];
const inFlight = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: unknownStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: createdAnswer }, inFlightCaptured),
});
expectEqual(inFlight.status, "in_flight", "a second attempt over an unknown one is in flight");
expectEqual(inFlightCaptured.length, 0, "an in-flight answer makes no call, so no duplicate account is created");
expect(
  inFlight.status === "in_flight" && inFlight.reason.includes("reconcile"),
  "the in-flight refusal asks for reconciliation",
);

const rejectedStore = new InMemoryStripeAccountProvisionStore();
const rejected = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: rejectedStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 400, body: rejectionBody }),
});
expectEqual(rejected.status, "rejected", "a refused body is a rejection");
expectEqual(rejected.status === "rejected" ? rejected.reason : "", "The country bd is not supported", "the provider's reason is kept");
expectEqual(rejectedStore.findByCompany(companyId)?.status, "rejected", "the rejection is recorded");
const reopenedCaptured: Captured[] = [];
const reopened = await provisionStripeAccount(inputOf(), {
  configStore: gateConfig.store,
  provisionStore: rejectedStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: createdAnswer }, reopenedCaptured),
});
expectEqual(reopened.status, "created", "a rejected attempt may be reopened");
expectEqual(reopened.status === "created" ? reopened.provision.version : 0, 4, "the reopened attempt advances the version twice: reopened, then created");
expectEqual(reopenedCaptured.length, 1, "the reopened attempt makes one call");
expectEqual(rejectedStore.findByCompany(companyId)?.accountId, ACCOUNT_ID, "the reopened attempt records the account");

const inFlightStore = new InMemoryStripeAccountProvisionStore();
inFlightStore.insert({
  ...(provision as StripeAccountProvision),
  id: "11111111-1111-4111-8111-111111111111",
  companyId: otherCompanyId,
  status: "pending",
  accountId: null,
  requirements: null,
  requirementsCollector: null,
  activeCapabilities: [],
  version: 1,
});
const pendingCaptured: Captured[] = [];
const pendingAnswer = await provisionStripeAccount(inputOf({ companyId: otherCompanyId }), {
  configStore: configStoreForWithCompany(otherCompanyId),
  provisionStore: inFlightStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: transportReturning({ status: 200, body: createdAnswer }, pendingCaptured),
});
expectEqual(pendingAnswer.status, "failed", "a pending attempt blocks a second one");
expectEqual(pendingCaptured.length, 0, "the blocked attempt makes no call");

function configStoreForWithCompany(target: string): StripeConfigStore {
  return configStoreFor({}, target).store;
}

/* ------------------------------------------------------------------------------------------------
 * Section 6: the store's invariants
 * ---------------------------------------------------------------------------------------------- */

const rulesStore = new InMemoryStripeAccountProvisionStore();
const seed: StripeAccountProvision = {
  ...(provision as StripeAccountProvision),
  id: "22222222-2222-4222-8222-222222222222",
  companyId: otherCompanyId,
  status: "pending",
  accountId: null,
  requirements: null,
  requirementsCollector: null,
  activeCapabilities: [],
  version: 1,
};
rulesStore.insert(seed);
expectEqual(rulesStore.findByCompany(otherCompanyId)?.id, seed.id, "the store finds the company's provision");
expectEqual(rulesStore.findById(seed.id)?.id, seed.id, "the store finds a provision by id");
expectEqual(rulesStore.findById("22222222-2222-4222-8222-222222222223"), null, "an unknown id reads as null");
expectThrows(() => rulesStore.insert(seed), "a duplicate provision id is refused");
expectThrows(
  () => rulesStore.insert({ ...seed, id: "33333333-3333-4333-8333-333333333333" }),
  "a second provision for one company is refused",
);
expectThrows(
  () => rulesStore.insert({ ...seed, id: "44444444-4444-4444-8444-444444444444", companyId: "company-four", version: 2 }),
  "a provision that starts at another version is refused",
);
expectEqual(rulesStore.save({ ...seed, version: 2 }, 0), false, "a stale expected version is refused");
expectEqual(rulesStore.save({ ...seed, version: 3 }, 1), false, "a write that skips a version is refused");
expectEqual(rulesStore.save({ ...seed, version: 2, companyId: "company-five" }, 1), false, "the company of a provision cannot change");
expectEqual(rulesStore.save({ ...seed, version: 2, kycSubmissionId: "another" }, 1), false, "the authorizing submission cannot change");
expectEqual(rulesStore.save({ ...seed, version: 2, status: "created" }, 1), false, "a created row must carry an account id");
expectEqual(rulesStore.save({ ...seed, version: 2, status: "created", accountId: ACCOUNT_ID }, 1), true, "a created row with an id is accepted");
expectEqual(
  rulesStore.save({ ...seed, version: 3, status: "created", accountId: "acct_1QxAbCdEfGhIjKlMnOpZ" }, 2),
  false,
  "a recorded account id cannot be replaced",
);
expectEqual(rulesStore.save({ ...seed, version: 3, status: "rejected", accountId: ACCOUNT_ID }, 2), false, "a created row never leaves created");
expectEqual(
  rulesStore.save({ ...seed, version: 3, status: "created", accountId: ACCOUNT_ID, requirements: seed.requirements }, 2),
  true,
  "a created row may be written again to refresh its requirements",
);
expectEqual(STRIPE_ACCOUNT_OUTCOMES.created.join(","), "created", "the outcome table makes created final");
expectEqual(STRIPE_ACCOUNT_OUTCOMES.rejected.join(","), "rejected,pending", "a rejection may be reopened");
expect(STRIPE_ACCOUNT_OUTCOMES.unknown.includes("created"), "an unknown attempt may still be settled as created");

/* ------------------------------------------------------------------------------------------------
 * Section 7: the documented onboarding link
 * ---------------------------------------------------------------------------------------------- */

const linkAnswer = JSON.stringify({
  object: "account_link",
  created: 1_680_577_733,
  expires_at: 1_680_578_033,
  url: "https://connect.stripe.com/setup/c/acct_1QxAbCdEfGhIjKlMnOpQ/TqckGNUHg2mG",
});
const linkBody = buildStripeAccountLinkBody(
  { provisionId: "ignored", type: "account_onboarding", refreshUrl: "https://app.example.com/onboarding/refresh", returnUrl: "https://app.example.com/onboarding/return" },
  ACCOUNT_ID,
);
expect(linkBody.startsWith(`account=${ACCOUNT_ID}`), "the link body names the account first");
expect(linkBody.includes("type=account_onboarding"), "the link body names the type");
expect(linkBody.includes("refresh_url=https%3A%2F%2Fapp.example.com%2Fonboarding%2Frefresh"), "the refresh url is encoded");
expect(linkBody.includes("return_url=https%3A%2F%2Fapp.example.com%2Fonboarding%2Freturn"), "the return url is encoded");
expect(linkBody.split("&").length === 4, "the link body carries exactly the four documented fields");

expectEqual(validateOnboardingUrl("https://app.example.com/x"), null, "an HTTPS url is usable");
expectEqual(validateOnboardingUrl("http://app.example.com/x"), "an onboarding URL must be an absolute HTTPS URL", "a plain HTTP url is refused");
expectEqual(validateOnboardingUrl("javascript:alert(1)"), "an onboarding URL must be an absolute HTTPS URL", "a javascript url is refused");
expectEqual(validateOnboardingUrl("   "), "an onboarding URL must be an absolute HTTPS URL", "an empty url is refused");

const issued = parseStripeAccountLinkAnswer(200, linkAnswer);
expectEqual(issued.outcome, "issued", "a documented account link is read");
expectEqual(issued.outcome === "issued" ? issued.url : "", "https://connect.stripe.com/setup/c/acct_1QxAbCdEfGhIjKlMnOpQ/TqckGNUHg2mG", "the url is kept");
expectEqual(issued.outcome === "issued" ? issued.expiresAtEpochMs : 0, 1_680_578_033_000, "the documented expiry is converted to milliseconds");
expectEqual(parseStripeAccountLinkAnswer(200, JSON.stringify({ object: "account_link", url: "https://connect.stripe.com/x" })).outcome, "issued", "a link without an expiry is still issued");
expectEqual(
  parseStripeAccountLinkAnswer(200, JSON.stringify({ object: "account_link", url: "https://connect.stripe.com/x" })).outcome === "issued"
    ? (parseStripeAccountLinkAnswer(200, JSON.stringify({ object: "account_link", url: "https://connect.stripe.com/x" })) as { expiresAtEpochMs: number | null }).expiresAtEpochMs
    : 1,
  null,
  "a missing expiry is reported as unknown rather than invented",
);
expectEqual(parseStripeAccountLinkAnswer(200, JSON.stringify({ object: "account", url: "https://connect.stripe.com/x" })).outcome, "failed", "a non-link answer is refused");
expectEqual(
  parseStripeAccountLinkAnswer(200, JSON.stringify({ object: "account_link", url: "http://connect.stripe.com/x" })).outcome,
  "failed",
  "a link that is not HTTPS is refused",
);
expectEqual(parseStripeAccountLinkAnswer(400, rejectionBody).outcome, "failed", "a refused link is a failure");
expectEqual(
  parseStripeAccountLinkAnswer(400, "").outcome === "failed" ? (parseStripeAccountLinkAnswer(400, "") as { detail: string }).detail : "",
  "the API refused the onboarding link with status 400",
  "a refused link without a message names the status",
);

const linkStore = new InMemoryStripeAccountProvisionStore();
const linkAudits: StripeAccountAuditEntry[] = [];
const linkPending: StripeAccountProvision = {
  ...(provision as StripeAccountProvision),
  id: "55555555-5555-4555-8555-555555555555",
  companyId: otherCompanyId,
  status: "pending",
  accountId: null,
  activeCapabilities: [],
  requirements: null,
  requirementsCollector: null,
  version: 1,
};
linkStore.insert(linkPending);
linkStore.save(
  {
    ...linkPending,
    status: "created",
    accountId: ACCOUNT_ID,
    activeCapabilities: ["card_payments", "stripe_transfers"],
    requirements: (provision as StripeAccountProvision).requirements,
    version: 2,
  },
  1,
);
const linkCaptured: Captured[] = [];
const linkResult = await createStripeOnboardingLink(
  { provisionId: "55555555-5555-4555-8555-555555555555", type: "account_onboarding", refreshUrl: "https://app.example.com/onboarding/refresh", returnUrl: "https://app.example.com/onboarding/return" },
  {
    configStore: configStoreForWithCompany(otherCompanyId) as unknown as StripeConfigStore,
    provisionStore: linkStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: transportReturning({ status: 200, body: linkAnswer }, linkCaptured),
    recordAudit: (entry) => linkAudits.push(entry),
  },
);
expectEqual(linkResult.status, "issued", "a link is issued for a created account");
expectEqual(linkResult.status === "issued" ? linkResult.type : "", "account_onboarding", "the result names the link type");
expectEqual(linkResult.status === "issued" ? linkResult.expiresAtEpochMs : 0, 1_680_578_033_000, "the result carries the documented expiry");
expectEqual(linkCaptured.length, 1, "issuing a link makes one call");
expectEqual(linkCaptured[0]?.path, STRIPE_ONBOARDING_LINK_PATH, "the link call goes to the documented collection");
expectEqual(linkCaptured[0]?.contentType, "application/x-www-form-urlencoded", "the link body is form encoded, as the documented example sends it");
expect(linkCaptured[0]?.body.includes(`account=${ACCOUNT_ID}`) === true, "the link call names the account");
expectEqual(linkAudits.length, 1, "issuing a link writes one audit entry");
expectEqual(linkAudits[0]?.action, "connected_account.onboarding_link_issued", "the audit entry names the link");
expect(JSON.stringify(linkAudits).includes(sandboxSecret) === false, "the link audit never carries the key");
expect(JSON.stringify(linkResult).includes(sandboxSecret) === false, "the link result never carries the key");

const noExpiryLink = await createStripeOnboardingLink(
  { provisionId: "55555555-5555-4555-8555-555555555555", type: "account_update", refreshUrl: "https://app.example.com/r", returnUrl: "https://app.example.com/x" },
  {
    configStore: configStoreForWithCompany(otherCompanyId),
    provisionStore: linkStore,
    keyring,
    occurredAtEpochMs: NOW,
    transport: transportReturning({ status: 200, body: JSON.stringify({ object: "account_link", url: "https://connect.stripe.com/x" }) }),
  },
);
expectEqual(
  noExpiryLink.status === "issued" ? noExpiryLink.expiresAtEpochMs : 0,
  NOW + STRIPE_ACCOUNT_LINK_DEFAULT_TTL_SECONDS * 1_000,
  "a link without an expiry falls back to the documented lifetime",
);

const pendingLinkStore = new InMemoryStripeAccountProvisionStore();
pendingLinkStore.insert({ ...seed, id: "66666666-6666-4666-8666-666666666666" });
expectEqual(
  (await createStripeOnboardingLink(
    { provisionId: "66666666-6666-4666-8666-666666666666", type: "account_onboarding", refreshUrl: "https://app.example.com/r", returnUrl: "https://app.example.com/x" },
    { configStore: configStoreForWithCompany(otherCompanyId), provisionStore: pendingLinkStore, keyring, occurredAtEpochMs: NOW, transport: transportReturning({ status: 200, body: linkAnswer }) },
  )).status === "failed"
    ? "refused"
    : "allowed",
  "refused",
  "an account that does not exist cannot be linked",
);
expectEqual(
  (await createStripeOnboardingLink(
    { provisionId: "missing", type: "account_onboarding", refreshUrl: "https://app.example.com/r", returnUrl: "https://app.example.com/x" },
    { configStore: configStoreForWithCompany(otherCompanyId), provisionStore: pendingLinkStore, keyring, occurredAtEpochMs: NOW, transport: transportReturning({ status: 200, body: linkAnswer }) },
  )).status,
  "failed",
  "an unknown provision cannot be linked",
);
expectEqual(
  (await createStripeOnboardingLink(
    { provisionId: "55555555-5555-4555-8555-555555555555", type: "account_launch", refreshUrl: "https://app.example.com/r", returnUrl: "https://app.example.com/x" },
    { configStore: configStoreForWithCompany(otherCompanyId), provisionStore: linkStore, keyring, occurredAtEpochMs: NOW, transport: transportReturning({ status: 200, body: linkAnswer }) },
  )).status === "failed"
    ? "refused"
    : "allowed",
  "refused",
  "an invented link type is refused",
);
expectEqual(
  (await createStripeOnboardingLink(
    { provisionId: "55555555-5555-4555-8555-555555555555", type: "account_onboarding", refreshUrl: "http://app.example.com/r", returnUrl: "https://app.example.com/x" },
    { configStore: configStoreForWithCompany(otherCompanyId), provisionStore: linkStore, keyring, occurredAtEpochMs: NOW, transport: transportReturning({ status: 200, body: linkAnswer }) },
  )).status,
  "failed",
  "a non-HTTPS refresh url is refused before any call",
);
const unreachableLink = await createStripeOnboardingLink(
  { provisionId: "55555555-5555-4555-8555-555555555555", type: "account_onboarding", refreshUrl: "https://app.example.com/r", returnUrl: "https://app.example.com/x" },
  { configStore: configStoreForWithCompany(otherCompanyId), provisionStore: linkStore, keyring, occurredAtEpochMs: NOW, transport: failingTransport },
);
expectEqual(
  unreachableLink.status === "failed" ? unreachableLink.reason : "",
  "the API could not be reached, so no link was issued",
  "an unreachable host issues no link",
);

/* ------------------------------------------------------------------------------------------------
 * Section 8: readiness
 * --------------------------------------------------------------------------------------------- */

const createdProvision = provision as StripeAccountProvision;

expectEqual(stripeAccountReadinessOf(createdProvision).canAcceptPayments, true, "an account with both capabilities can accept payments");
expectEqual(stripeAccountReadinessOf(createdProvision).onboarded, true, "an account with nothing due is onboarded");
expectEqual(stripeAccountReadinessOf(createdProvision).blockingReason, null, "a ready account has nothing blocking it");

const notCreated: StripeAccountProvision = { ...createdProvision, status: "pending", accountId: null };
expectEqual(stripeAccountReadinessOf(notCreated).canAcceptPayments, false, "an account that does not exist cannot accept payments");
expectEqual(stripeAccountReadinessOf(notCreated).blockingReason, "the account has not been created", "the reason says the account does not exist");

const unknownProvision: StripeAccountProvision = { ...createdProvision, status: "unknown", accountId: null };
expect(
  (stripeAccountReadinessOf(unknownProvision).blockingReason ?? "").includes("reconciliation"),
  "an unknown provision names reconciliation as the blocker",
);

const noCardPayments: StripeAccountProvision = { ...createdProvision, activeCapabilities: ["stripe_transfers"] };
expectEqual(stripeAccountReadinessOf(noCardPayments).canAcceptPayments, false, "an account without card_payments cannot accept payments");
expect(
  (stripeAccountReadinessOf(noCardPayments).blockingReason ?? "").includes("card_payments"),
  "the blocker names the missing card capability",
);
const noTransfers: StripeAccountProvision = { ...createdProvision, activeCapabilities: ["card_payments"] };
expect(
  (stripeAccountReadinessOf(noTransfers).blockingReason ?? "").includes("stripe_transfers"),
  "the blocker names the missing transfers capability",
);

const blockedProvision: StripeAccountProvision = {
  ...createdProvision,
  requirements: { currentlyDue: 0, pastDue: 1, pendingVerification: 0, disabledReason: "requirements.past_due", state: "blocked" },
};
expectEqual(stripeAccountReadinessOf(blockedProvision).canAcceptPayments, false, "a blocked account cannot accept payments");
expect(
  (stripeAccountReadinessOf(blockedProvision).blockingReason ?? "").includes("requirements.past_due"),
  "the blocker names the disabled reason",
);

const waitingProvision: StripeAccountProvision = {
  ...createdProvision,
  requirements: { currentlyDue: 2, pastDue: 0, pendingVerification: 0, disabledReason: null, state: "waiting" },
};
expectEqual(stripeAccountReadinessOf(waitingProvision).canAcceptPayments, true, "an account with active capabilities may accept payments while requirements are being collected");
expectEqual(stripeAccountReadinessOf(waitingProvision).onboarded, false, "an account with requirements due is not onboarded");

/* ------------------------------------------------------------------------------------------------
 * Section 9: the transport contract
 * ---------------------------------------------------------------------------------------------- */

let pathThrew = "";
try {
  await stripeAccountFetchTransport({ path: "/v1/charges", contentType: "application/json", body: "{}", secretKey: sandboxSecret, apiVersion: "2026-10-28" });
} catch (error) {
  pathThrew = error instanceof Error ? error.message : "";
}
expectEqual(pathThrew, "invalid API path", "the transport refuses a path this file does not own");
let keyThrew = "";
try {
  await stripeAccountFetchTransport({ path: STRIPE_ACCOUNTS_PATH, contentType: "application/json", body: "{}", secretKey: " ", apiVersion: "2026-10-28" });
} catch (error) {
  keyThrew = error instanceof Error ? error.message : "";
}
expectEqual(keyThrew, "a secret key is required", "the transport refuses to call without a key");
let versionThrew = "";
try {
  await stripeAccountFetchTransport({ path: STRIPE_ACCOUNTS_PATH, contentType: "application/json", body: "{}", secretKey: sandboxSecret, apiVersion: " " });
} catch (error) {
  versionThrew = error instanceof Error ? error.message : "";
}
expectEqual(versionThrew, "an API version is required", "the transport refuses to call without a version");
let bodyThrew = "";
try {
  await stripeAccountFetchTransport({ path: STRIPE_ACCOUNTS_PATH, contentType: "application/json", body: "", secretKey: sandboxSecret, apiVersion: "2026-10-28" });
} catch (error) {
  bodyThrew = error instanceof Error ? error.message : "";
}
expectEqual(bodyThrew, "a request body is required", "the transport refuses to call without a body");

/* ---- the immutability of the recorded vocabulary ---- */

expect(Object.isFrozen(STRIPE_ACCOUNT_ALLOWED_PATHS), "the allowed paths are frozen");
expect(Object.isFrozen(STRIPE_DASHBOARD_VALUES), "the dashboard values are frozen");
expect(Object.isFrozen(STRIPE_RESPONSIBILITY_VALUES), "the responsibility values are frozen");
expect(Object.isFrozen(STRIPE_ENTITY_TYPES), "the entity types are frozen");
expect(Object.isFrozen(STRIPE_ACCOUNT_LINK_TYPES), "the link types are frozen");
expect(Object.isFrozen(STRIPE_ACCOUNT_OUTCOMES), "the outcome table is frozen");
expect(Object.isFrozen(STRIPE_PLATFORM_RESPONSIBILITIES), "the platform responsibilities are frozen");
expect(Object.isFrozen(STRIPE_REQUESTED_CAPABILITIES), "the requested capabilities are frozen");
expect(Object.isFrozen(STRIPE_ACCOUNT_INCLUDE_VALUES), "the include values are frozen");
expectEqual(STRIPE_PROVIDER_KEY, "stripe", "the provider key is the registry key");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Stripe Connect accounts gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Stripe Connect accounts gate passed: ${checks} checks (the fixed v2 responsibilities and dashboard with their derived requirements collector, a create body with no onboarding secret in it, one account per company created after KYC approval and never twice, an honest unknown outcome that asks for reconciliation, the documented onboarding link with its expiry, and a readiness answer that only lets a proven account take payments)\n`,
);
