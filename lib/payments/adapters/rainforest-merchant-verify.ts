// path: lib/payments/adapters/rainforest-merchant-verify.ts

/**
 * The gate for STEP 160's onboarding half: Rainforest sub-merchant creation through the documented
 * component path.
 *
 * A check script, not a test file: it exercises the provisioning service, the store's invariants, the
 * onboarding session and the component contract with recording transports and keyrings built for the
 * run, then fails and names every check that did not hold. No network call is made, no real credential
 * is used, and no tax identifier, owner record, SSN or bank account number exists anywhere in this file
 * or in the code under test.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  activateRainforestConfig,
  configureRainforestKeys,
  InMemoryRainforestConfigStore,
  testRainforestConnection,
  type RainforestConfigStore,
} from "./rainforest-client.ts";
import { RAINFOREST_PRODUCTION_API_BASE, RAINFOREST_SANDBOX_API_BASE } from "./rainforest.ts";
import { RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS, type RainforestPaymentAuditEntry, type RainforestPaymentTransport } from "./rainforest-payment.ts";
import {
  buildRainforestMerchantBody,
  InMemoryRainforestMerchantProvisionStore,
  isRainforestSandboxMerchantId,
  PROVISION_OUTCOMES,
  provisionRainforestMerchant,
  rainforestMerchantTransport,
  rainforestMerchantsEndpointFor,
  rainforestOnboardingComponentFor,
  rainforestOnboardingScriptUrlFor,
  rainforestOnboardingStateOf,
  RAINFOREST_APPLICATION_ID_PATTERN,
  RAINFOREST_APPLICATION_ID_PREFIXES,
  RAINFOREST_MCC_PATTERN,
  RAINFOREST_MERCHANTS_PATH,
  RAINFOREST_MERCHANT_ID_PATTERN,
  RAINFOREST_MERCHANT_ID_PREFIXES,
  RAINFOREST_MERCHANT_TYPES,
  RAINFOREST_ONBOARDING_COMPONENT_TAG,
  RAINFOREST_ONBOARDING_DEFAULT_TTL_SECONDS,
  RAINFOREST_ONBOARDING_SCRIPT_URLS,
  startRainforestOnboarding,
  validateRainforestMerchantProfile,
  type RainforestMerchantProfile,
  type RainforestMerchantProvisionStore,
} from "./rainforest-merchant.ts";

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

async function expectRejection(action: () => Promise<unknown>, description: string): Promise<void> {
  try {
    await action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

/* ---- fixtures ---- */

const keyring: EncryptionKeyring = {
  primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") },
};
const foreignKeyring: EncryptionKeyring = {
  primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") },
};

const companyId = "018f2b8a-0000-4000-8000-00000000d001";
const otherCompanyId = "018f2b8a-0000-4000-8000-00000000d002";
const sandboxKey = "sbx_apikey_GATEMERCHANTSANDBOX0001ABCDEF";
const productionKey = "apikey_GATEMERCHANTPRODUCTION0002ABCDEF";
const merchantId = "sbx_mid_2DrDFJPutxE5AIbJSopAnqniEbr";
const applicationId = "sbx_app_2DrD4yH7fH8aLIA7ZCnyVPcL9V9";
const productionMerchantId = "mid_2DrDFJPutxE5AIbJSopAnqniEbr";
const sessionKey = "sessionkey_4b7d1c9e2a5f8b3d6c9a4e7f1b8d2c5a";
const sessionId = "sbx_ses_2DrDPKzdQypRudLd8DhQKZX27dA";
const termsUrl = "https://app.kdsolution.example/terms";

/** A store holding one active configuration for a company, built through the STEP 158 service. */
async function activeStoreFor(
  company: string,
  environment: "production" | "sandbox" = "sandbox",
): Promise<InMemoryRainforestConfigStore> {
  const store = new InMemoryRainforestConfigStore();
  const configured = configureRainforestKeys(
    { companyId: company, environment, apiKey: environment === "sandbox" ? sandboxKey : productionKey },
    { store, keyring, occurredAtEpochMs: 1_000 },
  );
  if (configured.status !== "configured") throw new Error("the fixture key could not be configured");
  await testRainforestConnection(configured.config.id, {
    store,
    keyring,
    occurredAtEpochMs: 1_100,
    transport: async () => ({ status: 200, body: JSON.stringify({ data: [] }) }),
  });
  const activated = activateRainforestConfig(configured.config.id, { store, occurredAtEpochMs: 1_200 });
  if (activated.status !== "activated") throw new Error("the fixture key could not be activated");
  return store;
}

/** A transport that answers one fixed status and body and records what it was asked. */
function merchantTransport(status: number, body: string) {
  const calls: { endpoint: string; method: string; apiKey: string; body: string | null }[] = [];
  const transport: RainforestPaymentTransport = async (endpoint, method, apiKey, requestBody) => {
    calls.push({ endpoint, method, apiKey, body: requestBody });
    return { status, body };
  };
  return { transport, calls };
}

/** A transport that routes the merchant and session calls to separate answers. */
function routedTransport(merchantAnswer: { status: number; body: string }, sessionAnswer?: { status: number; body: string }) {
  const calls: { endpoint: string; method: string; body: string | null }[] = [];
  const transport: RainforestPaymentTransport = async (endpoint, method, _apiKey, body) => {
    calls.push({ endpoint, method, body });
    if (endpoint.endsWith("/v1/sessions") && sessionAnswer !== undefined) return sessionAnswer;
    return merchantAnswer;
  };
  return { transport, calls };
}

const throwingTransport: RainforestPaymentTransport = async () => {
  throw new Error("network down");
};

function merchantOptions(
  configStore: RainforestConfigStore,
  audits: RainforestPaymentAuditEntry[],
  transport?: RainforestPaymentTransport,
  keyringOverride: EncryptionKeyring = keyring,
) {
  return {
    configStore,
    keyring: keyringOverride,
    occurredAtEpochMs: 5_000,
    recordAudit: (entry: RainforestPaymentAuditEntry) => audits.push(entry),
    ...(transport === undefined ? {} : { transport }),
  };
}

function profileOf(overrides: Partial<RainforestMerchantProfile> = {}): RainforestMerchantProfile {
  return {
    companyId,
    legalName: "KD Solution LLC",
    dbaName: "KD Solution",
    merchantType: "LLC",
    mcc: "7372",
    email: "billing@kdsolution.example",
    website: "https://kdsolution.example",
    phoneNumber: "+14045550100",
    averageTicketMinor: 25_000n,
    highTicketMinor: 500_000n,
    averageMonthlyVolumeMinor: 5_000_000n,
    address: {
      addressLine1: "123 Example Street",
      addressLine2: "Suite 400",
      city: "Atlanta",
      state: "GA",
      postalCode: "30305",
      country: "US",
    },
    ...overrides,
  };
}

/** A profile with no trading name, built by omission rather than by setting an optional field to undefined. */
function profileWithoutTradingName(): RainforestMerchantProfile {
  return {
    companyId,
    legalName: "KD Solution LLC",
    merchantType: "LLC",
    mcc: "7372",
    email: "billing@kdsolution.example",
    website: "https://kdsolution.example",
    phoneNumber: "+14045550100",
    averageTicketMinor: 25_000n,
    highTicketMinor: 500_000n,
    averageMonthlyVolumeMinor: 5_000_000n,
    address: {
      addressLine1: "123 Example Street",
      city: "Atlanta",
      state: "GA",
      postalCode: "30305",
      country: "US",
    },
  };
}

function json(payload: unknown): string {
  return JSON.stringify(payload);
}

function dump(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? entry.toString() : entry));
}

/** A documented create-merchant answer. */
function createdAnswer(overrides: Record<string, unknown> = {}): string {
  return json({
    status: "SUCCESS",
    data: {
      merchant_id: merchantId,
      merchant_status: "PENDING",
      merchant_application_id: applicationId,
      merchant_application_status: "CREATED",
      ...overrides,
    },
  });
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: documented paths, ids, types and component facts
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_MERCHANTS_PATH, "/v1/merchants", "the documented merchant path is recorded");
expectEqual(rainforestMerchantsEndpointFor("sandbox"), `${RAINFOREST_SANDBOX_API_BASE}/v1/merchants`, "the sandbox merchant endpoint is documented");
expectEqual(rainforestMerchantsEndpointFor("production"), `${RAINFOREST_PRODUCTION_API_BASE}/v1/merchants`, "the production merchant endpoint is documented");
expectEqual(RAINFOREST_MERCHANT_ID_PREFIXES.length, 2, "the two documented merchant id prefixes are recorded");
expect(RAINFOREST_MERCHANT_ID_PREFIXES.includes("sbx_mid_"), "the sandbox merchant prefix is recorded");
expect(RAINFOREST_MERCHANT_ID_PREFIXES.includes("mid_"), "the production merchant prefix is recorded");
expect(RAINFOREST_APPLICATION_ID_PREFIXES.includes("sbx_app_"), "the sandbox application prefix is recorded");
expect(RAINFOREST_APPLICATION_ID_PREFIXES.includes("app_"), "the production application prefix is recorded");
expectEqual(RAINFOREST_MERCHANT_ID_PATTERN.test(merchantId), true, "a sandbox merchant id is accepted");
expectEqual(RAINFOREST_MERCHANT_ID_PATTERN.test(productionMerchantId), true, "a production merchant id is accepted");
expectEqual(RAINFOREST_MERCHANT_ID_PATTERN.test(applicationId), false, "an application id is not a merchant id");
expectEqual(RAINFOREST_MERCHANT_ID_PATTERN.test("mid_AB"), false, "a merchant id of the wrong shape is refused");
expectEqual(RAINFOREST_APPLICATION_ID_PATTERN.test(applicationId), true, "a sandbox application id is accepted");
expectEqual(RAINFOREST_APPLICATION_ID_PATTERN.test("app_2DrD4yH7fH8aLIA7ZCnyVPcL9V9"), true, "a production application id is accepted");
expectEqual(RAINFOREST_APPLICATION_ID_PATTERN.test(merchantId), false, "a merchant id is not an application id");
expectEqual(isRainforestSandboxMerchantId(merchantId), true, "a sandbox merchant is recognised");
expectEqual(isRainforestSandboxMerchantId(productionMerchantId), false, "a production merchant is not a sandbox one");
expectEqual(RAINFOREST_MERCHANT_TYPES.length, 8, "the eight documented merchant types are recorded");
expect(RAINFOREST_MERCHANT_TYPES.includes("SOLE_PROPRIETORSHIP") === false, "an undocumented merchant type is not invented");
expect(RAINFOREST_MERCHANT_TYPES.includes("NON_PROFIT_ORGANIZATION"), "the non-profit type is recorded");
expectEqual(RAINFOREST_MCC_PATTERN.test("7372"), true, "a four digit merchant category code is accepted");
expectEqual(RAINFOREST_MCC_PATTERN.test("737"), false, "a three digit code is refused");
expectEqual(RAINFOREST_MCC_PATTERN.test("73721"), false, "a five digit code is refused");
expectEqual(RAINFOREST_MCC_PATTERN.test("73a2"), false, "a code with a letter is refused");
expectEqual(RAINFOREST_ONBOARDING_COMPONENT_TAG, "rainforest-merchant-onboarding", "the documented onboarding element is recorded");
expectEqual(
  RAINFOREST_ONBOARDING_SCRIPT_URLS["sandbox"],
  "https://static.rainforestpay.com/sandbox.merchant.js",
  "the documented sandbox merchant bundle is recorded",
);
expectEqual(
  RAINFOREST_ONBOARDING_SCRIPT_URLS["production"],
  "https://static.rainforestpay.com/merchant.js",
  "the documented production merchant bundle is recorded",
);
expectEqual(rainforestOnboardingScriptUrlFor("sandbox"), RAINFOREST_ONBOARDING_SCRIPT_URLS["sandbox"], "the onboarding bundle follows the environment");
expectEqual(RAINFOREST_ONBOARDING_DEFAULT_TTL_SECONDS, RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS, "the onboarding default is the documented example lifetime");
expect(Object.isFrozen(RAINFOREST_MERCHANT_TYPES), "the merchant types are frozen");
expect(Object.isFrozen(RAINFOREST_ONBOARDING_SCRIPT_URLS), "the bundle table is frozen");
expect(Object.isFrozen(PROVISION_OUTCOMES), "the provision outcome table is frozen");

/* ------------------------------------------------------------------------------------------------
 * Section 2: validating the profile
 * --------------------------------------------------------------------------------------------- */

expectEqual(validateRainforestMerchantProfile(profileOf()), null, "a complete profile is valid");
expectEqual(validateRainforestMerchantProfile(profileOf({ companyId: " " })), "the company id is required", "a blank company is refused");
expectEqual(
  validateRainforestMerchantProfile(profileOf({ legalName: "<b>KD</b>" })),
  "the legal name must be readable business text",
  "a legal name carrying markup is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ legalName: "" })),
  "the legal name must be readable business text",
  "an empty legal name is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ dbaName: "KD<script>" })),
  "the trading name must be readable business text",
  "a trading name carrying markup is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ merchantType: "SOLE_PROPRIETORSHIP" })),
  "the merchant type must be one the requirements table names",
  "an undocumented merchant type is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ merchantType: "llc" })),
  "the merchant type must be one the requirements table names",
  "a lower case merchant type is refused rather than guessed",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ mcc: "73" })),
  "the merchant category code must be four digits",
  "a short merchant category code is refused",
);
expectEqual(validateRainforestMerchantProfile(profileOf({ email: "not-an-email" })), "the email is invalid", "an invalid email is refused");
expectEqual(
  validateRainforestMerchantProfile(profileOf({ website: "http://kdsolution.example" })),
  "the website must be an https address",
  "a plain-http website is refused",
);
expectEqual(validateRainforestMerchantProfile(profileOf({ phoneNumber: "abc" })), "the phone number is invalid", "an invalid phone number is refused");
expectEqual(validateRainforestMerchantProfile(profileOf({ averageTicketMinor: 0n })), "the average ticket must be positive", "a zero average ticket is refused");
expectEqual(validateRainforestMerchantProfile(profileOf({ highTicketMinor: 0n })), "the high ticket must be positive", "a zero high ticket is refused");
expectEqual(
  validateRainforestMerchantProfile(profileOf({ averageMonthlyVolumeMinor: 0n })),
  "the average monthly volume must be positive",
  "a zero monthly volume is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ highTicketMinor: 1n })),
  "the high ticket cannot be below the average ticket",
  "a high ticket below the average is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ averageMonthlyVolumeMinor: 10_000_000_000_000_000_000n })),
  "the average monthly volume is larger than the provider's integer field can carry",
  "an amount past the safe integer is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ address: { ...profileOf().address, state: "!!" } })),
  "the state must be a two letter code",
  "a state of the wrong shape is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ address: { ...profileOf().address, country: "USA" } })),
  "the country must be a two letter code",
  "a three letter country is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ address: { ...profileOf().address, postalCode: "!!" } })),
  "the postal code is invalid",
  "an invalid postal code is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ address: { ...profileOf().address, city: "  " } })),
  "the city must be readable text",
  "a blank city is refused",
);
expectEqual(
  validateRainforestMerchantProfile(profileOf({ address: { ...profileOf().address, addressLine2: "<x>" } })),
  "the second address line must be readable text",
  "a second address line carrying markup is refused",
);
expectEqual(validateRainforestMerchantProfile(profileWithoutTradingName()), null, "a business without a trading name is valid");

/* ------------------------------------------------------------------------------------------------
 * Section 3: the documented create merchant body
 * --------------------------------------------------------------------------------------------- */

const body = buildRainforestMerchantBody(profileOf());
expectEqual(body["name"], "KD Solution", "the request name is the trading name when there is one");
expectEqual(body["dba_name"], "KD Solution", "the trading name is sent under its documented key");
expectEqual(body["legal_name"], "KD Solution LLC", "the legal name is sent under its documented key");
expectEqual(body["merchant_type"], "LLC", "the merchant type is sent under its documented key");
expectEqual(body["mcc"], "7372", "the merchant category code is sent under its documented key");
expectEqual(body["email"], "billing@kdsolution.example", "the email is sent under its documented key");
expectEqual(body["website"], "https://kdsolution.example", "the website is sent under its documented key");
expectEqual(body["phone_number"], "+14045550100", "the phone number is sent under its documented key");
expectEqual(body["average_ticket"], 25_000, "the average ticket is sent in minor units under its documented key");
expectEqual(body["high_ticket"], 500_000, "the high ticket is sent in minor units under its documented key");
expectEqual(body["average_monthly_volume"], 5_000_000, "the monthly volume is sent in minor units under its documented key");
const contact = body["billing_contact"] as Record<string, string>;
expectEqual(contact["address_line_1"], "123 Example Street", "the first address line is sent under its documented key");
expectEqual(contact["address_line_2"], "Suite 400", "the second address line is sent under its documented key");
expectEqual(contact["city"], "Atlanta", "the city is sent under its documented key");
expectEqual(contact["state"], "GA", "the state is sent under its documented key");
expectEqual(contact["postal_code"], "30305", "the postal code is sent under its documented key");
expectEqual(contact["country"], "US", "the country is sent under its documented key");

const noTradingName = buildRainforestMerchantBody(profileWithoutTradingName());
expectEqual(noTradingName["name"], "KD Solution LLC", "without a trading name the request name is the legal name");
expectEqual(noTradingName["dba_name"], undefined, "without a trading name no dba_name is sent");
const sameTradingName = buildRainforestMerchantBody(profileOf({ dbaName: "KD Solution LLC" }));
expectEqual(sameTradingName["dba_name"], undefined, "a trading name equal to the legal name is not duplicated");
const noSecondLine = buildRainforestMerchantBody(profileWithoutTradingName());
expectEqual((noSecondLine["billing_contact"] as Record<string, string>)["address_line_2"], undefined, "an absent second line is not sent");

/* ---- nothing sensitive can be in the body ---- */

const sensitiveKeys = [
  "tax_id",
  "tax_id_last_4",
  "encrypted_tax_id",
  "owner_1",
  "owner_2",
  "owner_3",
  "owner_4",
  "encrypted_ssn",
  "ssn_last_4",
  "dob",
  "deposit_routes",
  "deposit_method_id",
  "account_number",
  "routing_number",
  "iban",
  "card_number",
  "cvv",
];
for (const key of sensitiveKeys) {
  expect(
    Object.prototype.hasOwnProperty.call(body, key) === false &&
      Object.prototype.hasOwnProperty.call(contact, key) === false,
    `the merchant body carries no ${key} field`,
  );
}
const bodyDump = dump(body);
expect(bodyDump.includes("4111") === false, "the merchant body carries no card number");
expect(bodyDump.includes("123456789") === false, "the merchant body carries no tax identifier");
expect(bodyDump.includes("078-05-1120") === false, "the merchant body carries no social security number");
expectEqual(Object.keys(body).length, 12, "the body carries the documented fields and nothing more");

/* ------------------------------------------------------------------------------------------------
 * Section 4: provisioning
 * --------------------------------------------------------------------------------------------- */

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const recorded = merchantTransport(200, createdAnswer());
  const store = new InMemoryRainforestMerchantProvisionStore();

  const created = await provisionRainforestMerchant(profileOf(), store, merchantOptions(configStore, audits, recorded.transport));
  expectEqual(created.status, "created", "a 2XX naming a merchant id creates the merchant");
  if (created.status === "created") {
    expectEqual(created.provision.merchantId, merchantId, "the provision carries the merchant id");
    expectEqual(created.provision.applicationId, applicationId, "the provision carries the application id");
    expectEqual(created.provision.merchantStatus, "PENDING", "the provision records the documented merchant status");
    expectEqual(created.provision.applicationStatus, "CREATED", "the provision records the documented application status");
    expectEqual(created.provision.status, "created", "the provision is created");
    expectEqual(created.provision.version, 2, "the provision advanced one version");
    expectEqual(created.provision.requiresReconciliation, false, "a complete creation needs no reconciliation");
  }
  expectEqual(recorded.calls.length, 1, "one call creates one merchant");
  expectEqual(recorded.calls[0]?.endpoint, `${RAINFOREST_SANDBOX_API_BASE}/v1/merchants`, "the call uses the documented endpoint");
  expectEqual(recorded.calls[0]?.method, "POST", "the call posts");
  expectEqual(recorded.calls[0]?.apiKey, sandboxKey, "the call opens the active key");
  const sent = JSON.parse(recorded.calls[0]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(sent["legal_name"], "KD Solution LLC", "the sent body carries the legal name");
  expectEqual(sent["mcc"], "7372", "the sent body carries the merchant category code");

  const provisionAudits = audits.filter((entry) => entry.action === "payin.rainforest_merchant_provisioned");
  expectEqual(provisionAudits.length, 1, "a creation writes one audit entry");
  expectEqual(provisionAudits[0]?.providerObjectId, applicationId, "the audit entry names the application first");
  expectEqual(provisionAudits[0]?.outcome, "created", "the audit entry records the outcome");
  expectEqual(dump(provisionAudits).includes(sandboxKey), false, "no audit entry carries the API key");

  const again = await provisionRainforestMerchant(profileOf(), store, merchantOptions(configStore, audits, recorded.transport));
  expectEqual(again.status, "already_created", "a second attempt answers the stored merchant");
  if (again.status === "already_created") expectEqual(again.provision.merchantId, merchantId, "the answer carries the same merchant");
  expectEqual(recorded.calls.length, 1, "a second attempt makes no provider call");

  const store2 = store.findByCompany(companyId);
  expectEqual(store2?.status, "created", "the store keeps the created provision");
}

/* ---- an attempt in flight is never sent twice ---- */

{
  const configStore = await activeStoreFor(companyId);
  const recorded = merchantTransport(200, createdAnswer());
  const store = new InMemoryRainforestMerchantProvisionStore();
  store.insert({
    id: "00000000-0000-4000-8000-00000000cc01",
    companyId,
    status: "pending",
    reason: null,
    requiresReconciliation: false,
    merchantId: null,
    applicationId: null,
    merchantStatus: null,
    applicationStatus: null,
    version: 1,
    createdAtEpochMs: 4_000,
    updatedAtEpochMs: 4_000,
  });
  const inFlight = await provisionRainforestMerchant(profileOf(), store, merchantOptions(configStore, [], recorded.transport));
  expectEqual(inFlight.status, "in_flight", "a pending attempt answers in flight");
  if (inFlight.status === "in_flight") {
    expectEqual(inFlight.requiresReconciliation, true, "an in-flight attempt needs reconciling");
    expectEqual(
      inFlight.reason,
      "a merchant creation is already in flight for this company; it is not sent twice",
      "the reason says it was not resent",
    );
  }
  expectEqual(recorded.calls.length, 0, "an in-flight attempt makes no provider call");
}

/* ---- the failure table ---- */

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];

  async function attempt(status: number, answer: string, transport?: RainforestPaymentTransport) {
    const store = new InMemoryRainforestMerchantProvisionStore();
    const result = await provisionRainforestMerchant(
      profileOf(),
      store,
      merchantOptions(configStore, audits, transport ?? merchantTransport(status, answer).transport),
    );
    return { result, provision: store.findByCompany(companyId) };
  }

  const validation = await attempt(
    400,
    json({ status: "ERROR", data: null, errors: [{ field: "mcc", code: "RequestBody", message: "MCC is invalid" }] }),
  );
  expectEqual(validation.result.status, "rejected", "a 400 is a rejection");
  if (validation.result.status === "rejected") {
    expectEqual(validation.result.reason, "mcc: MCC is invalid", "the rejection carries the documented field and message");
  }
  expectEqual(validation.provision?.status, "rejected", "the store records the rejection");

  const conflict = await attempt(409, json({ errors: [{ message: "A merchant already exists" }] }));
  expectEqual(conflict.result.status, "rejected", "a 409 is a rejection");
  const sanitised = await attempt(422, json({ errors: [{ message: "<b>bad</b> input" }] }));
  if (sanitised.result.status === "rejected") {
    expectEqual(sanitised.result.reason, "bbad/b input", "the provider message is sanitised of markup");
  } else {
    expectEqual(sanitised.result.status, "rejected", "a 422 is a rejection");
  }
  const silent = await attempt(422, "");
  if (silent.result.status === "rejected") {
    expectEqual(silent.result.reason, "the API refused the merchant with status 422", "the fallback reason names the status");
  } else {
    expectEqual(silent.result.status, "rejected", "a silent 422 is a rejection");
  }

  const unauthorised = await attempt(401, json({ errors: [{ message: "Invalid API key" }] }));
  expectEqual(unauthorised.result.status, "failed", "a 401 fails the attempt");
  if (unauthorised.result.status === "failed") {
    expectEqual(unauthorised.result.reason, "the API rejected the credential", "the 401 reason names the credential");
    expect(unauthorised.result.reason.includes(sandboxKey) === false, "the 401 reason carries no key");
  }
  expectEqual(unauthorised.provision?.merchantId, null, "a failed attempt records no merchant id");

  const forbidden = await attempt(403, json({ errors: [{ message: "Forbidden" }] }));
  expectEqual(forbidden.result.status, "failed", "a 403 fails the attempt");
  if (forbidden.result.status === "failed") {
    expectEqual(forbidden.result.reason, "the API rejected the credential", "the 403 reason names the credential");
  }

  for (const status of [404, 405, 415, 302]) {
    const refused = await attempt(status, json({ errors: [{ message: "no route" }] }));
    expectEqual(refused.result.status, "failed", `a ${status} proves no merchant was created`);
    if (refused.result.status === "failed") {
      expectEqual(refused.result.reason, `the API refused the request with status ${status}`, `the ${status} reason names the status`);
    }
  }

  for (const status of [408, 425, 429, 500, 503]) {
    const unknown = await attempt(status, json({ errors: [{ message: "try later" }] }));
    expectEqual(unknown.result.status, "unknown", `a ${status} leaves the creation unknown`);
    if (unknown.result.status === "unknown") {
      expectEqual(unknown.result.requiresReconciliation, true, `a ${status} needs reconciling`);
      expect(unknown.result.reason.includes(`${status}`), `the ${status} reason names the status`);
    }
    expectEqual(unknown.provision?.status, "unknown", `a ${status} is stored as unknown`);
  }

  const thrown = await attempt(200, "", throwingTransport);
  expectEqual(thrown.result.status, "unknown", "an unreachable API leaves the creation unknown");
  if (thrown.result.status === "unknown") {
    expectEqual(thrown.result.reason, "the API could not be reached, so the merchant may exist", "the unreachable reason says the merchant may exist");
  }

  const noId = await attempt(200, json({ status: "SUCCESS", data: { merchant_status: "PENDING" } }));
  expectEqual(noId.result.status, "unknown", "a 2XX without a merchant id leaves the creation unknown");
  if (noId.result.status === "unknown") {
    expectEqual(noId.result.reason, "the answer named no usable merchant id", "the reason names the missing id");
  }

  const wrongId = await attempt(200, json({ data: { merchant_id: applicationId, merchant_application_id: applicationId } }));
  expectEqual(wrongId.result.status, "unknown", "a 2XX naming an application id as the merchant leaves the creation unknown");

  const noApplication = await attempt(200, json({ data: { merchant_id: merchantId, merchant_status: "PENDING" } }));
  expectEqual(noApplication.result.status, "created", "a merchant without an application id is created");
  if (noApplication.result.status === "created") {
    expectEqual(noApplication.result.provision.applicationId, null, "the missing application id is recorded as absent");
    expectEqual(noApplication.result.provision.requiresReconciliation, true, "a merchant without an application id needs reconciling");
    expectEqual(
      noApplication.result.provision.reason,
      "the answer named the merchant but no usable application id",
      "the reason names the missing application id",
    );
  }

  const provisionAudits = audits.filter((entry) => entry.action === "payin.rainforest_merchant_provisioned");
  expect(provisionAudits.length >= 14, "every settled attempt writes an audit entry");
}

/* ---- retrying a rejected attempt is allowed, and it reuses the same row ---- */

{
  const configStore = await activeStoreFor(companyId);
  const store = new InMemoryRainforestMerchantProvisionStore();
  const rejected = await provisionRainforestMerchant(
    profileOf(),
    store,
    merchantOptions(configStore, [], merchantTransport(400, json({ errors: [{ message: "MCC is invalid" }] })).transport),
  );
  expectEqual(rejected.status, "rejected", "the first attempt is rejected");
  const firstId = rejected.status === "rejected" ? rejected.provision.id : "";

  const retried = await provisionRainforestMerchant(
    profileOf({ mcc: "7372" }),
    store,
    merchantOptions(configStore, [], merchantTransport(200, createdAnswer()).transport),
  );
  expectEqual(retried.status, "created", "a rejected attempt can be retried");
  if (retried.status === "created") {
    expectEqual(retried.provision.id, firstId, "the retry reuses the same provision row");
    expectEqual(retried.provision.version, 4, "the retry advanced the version by two writes");
  }
  expectEqual(store.findByCompany(companyId)?.merchantId, merchantId, "the retried attempt stores the merchant");

  const afterCreate = await provisionRainforestMerchant(
    profileOf(),
    store,
    merchantOptions(configStore, [], throwingTransport),
  );
  expectEqual(afterCreate.status, "already_created", "a company with a merchant never calls the provider again");
}

/* ---- no active key, an unreadable key, and an invalid profile ---- */

{
  const noKey = await provisionRainforestMerchant(profileOf(), new InMemoryRainforestMerchantProvisionStore(), {
    configStore: new InMemoryRainforestConfigStore(),
    keyring,
    occurredAtEpochMs: 5_000,
  });
  expectEqual(noKey.status, "failed", "a company without an active key cannot create a merchant");
  if (noKey.status === "failed") {
    expectEqual(noKey.reason, "no active Rainforest key configuration exists for this company", "the refusal names the missing configuration");
  }

  const configStore = await activeStoreFor(otherCompanyId);
  const recorded = merchantTransport(200, createdAnswer());
  const unreadable = await provisionRainforestMerchant(
    profileOf({ companyId: otherCompanyId }),
    new InMemoryRainforestMerchantProvisionStore(),
    merchantOptions(configStore, [], recorded.transport, foreignKeyring),
  );
  expectEqual(unreadable.status, "failed", "a key this keyring cannot open creates no merchant");
  if (unreadable.status === "failed") {
    expectEqual(unreadable.reason, "the sealed credentials cannot be opened with this keyring", "the unreadable key says why");
  }
  expectEqual(recorded.calls.length, 0, "an unreadable key makes no provider call");

  const invalidStore = new InMemoryRainforestMerchantProvisionStore();
  const invalid = await provisionRainforestMerchant(
    profileOf({ mcc: "1" }),
    invalidStore,
    merchantOptions(configStore, [], recorded.transport),
  );
  expectEqual(invalid.status, "failed", "an invalid profile fails before any call");
  if (invalid.status === "failed") {
    expectEqual(invalid.reason, "the merchant category code must be four digits", "the refusal is the validation reason");
  }
  expectEqual(invalidStore.findByCompany(companyId), null, "an invalid profile stores nothing");
}

/* ---- the store's invariants ---- */

{
  const store = new InMemoryRainforestMerchantProvisionStore();
  const base = {
    id: "00000000-0000-4000-8000-00000000dd01",
    companyId,
    status: "pending" as const,
    reason: null,
    requiresReconciliation: false,
    merchantId: null,
    applicationId: null,
    merchantStatus: null,
    applicationStatus: null,
    version: 1,
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
  };
  store.insert(base);
  expectEqual(store.findById(base.id)?.companyId, companyId, "the store reads back what it wrote");

  let threw = false;
  try {
    store.insert({ ...base, id: "00000000-0000-4000-8000-00000000dd02" });
  } catch {
    threw = true;
  }
  expectEqual(threw, true, "a second row for the same company is refused");

  threw = false;
  try {
    store.insert({ ...base, id: "00000000-0000-4000-8000-00000000dd03", companyId: otherCompanyId, status: "created", merchantId });
  } catch {
    threw = true;
  }
  expectEqual(threw, true, "a new row cannot start outside pending");

  const created = { ...base, status: "created" as const, merchantId, applicationId, version: 2 };
  expectEqual(store.save(created, 1), true, "a pending row advances to created");
  expectEqual(store.save({ ...created, status: "unknown", version: 3 }, 2), false, "a created row never leaves created");
  expectEqual(store.save({ ...created, version: 3 }, 1), false, "a stale version writes nothing");
  expectEqual(store.save({ ...created, merchantId: productionMerchantId, version: 3 }, 2), false, "the merchant id is immutable");
  expectEqual(
    store.save({ ...created, applicationId: "sbx_app_AnotherApplication0000000001", version: 3 }, 2),
    false,
    "the application id is immutable",
  );

  const noMerchant = { ...base, id: "00000000-0000-4000-8000-00000000dd04", companyId: otherCompanyId, status: "created" as const, version: 2 };
  store.insert({ ...noMerchant, status: "pending", version: 1 });
  expectEqual(store.save(noMerchant, 1), false, "a created row must carry a merchant id");

  const retryable = {
    ...base,
    id: "00000000-0000-4000-8000-00000000dd05",
    companyId: "018f2b8a-0000-4000-8000-00000000d003",
    status: "rejected" as const,
    reason: "MCC is invalid",
    version: 2,
  };
  store.insert({ ...retryable, status: "pending", version: 1 });
  expectEqual(store.save(retryable, 1), true, "a pending row advances to rejected");
  expectEqual(
    store.save({ ...retryable, status: "pending", reason: null, version: 3 }, 2),
    true,
    "a rejected row with no merchant id may be reopened",
  );
  const settled = { ...created, id: retryable.id, companyId: retryable.companyId, status: "rejected" as const, version: 2 };
  expectEqual(store.save({ ...settled, merchantId: null, status: "pending", version: 3 }, 2), false, "a merchant id cannot be dropped");

  expectEqual(PROVISION_OUTCOMES["created"].length, 1, "a created row is final");
  expectEqual(PROVISION_OUTCOMES["rejected"].includes("pending"), true, "a rejected row may be retried");
  expectEqual(PROVISION_OUTCOMES["pending"].includes("created"), true, "a pending row may become created");
  expectEqual(PROVISION_OUTCOMES["unknown"].includes("pending"), true, "an unknown row may be retried");
}

/* ------------------------------------------------------------------------------------------------
 * Section 5: the onboarding session and the component
 * --------------------------------------------------------------------------------------------- */

{
  const configStore = await activeStoreFor(companyId);
  const store = new InMemoryRainforestMerchantProvisionStore();
  await provisionRainforestMerchant(
    profileOf(),
    store,
    merchantOptions(configStore, [], merchantTransport(200, createdAnswer()).transport),
  );

  const audits: RainforestPaymentAuditEntry[] = [];
  const routed = routedTransport(
    { status: 200, body: createdAnswer() },
    { status: 200, body: json({ data: { session_id: sessionId, session_key: sessionKey, expires_at: "2099-01-01T00:00:00Z" } }) },
  );
  const started = await startRainforestOnboarding(
    { companyId, termsAndConditionsUrl: termsUrl },
    store,
    merchantOptions(configStore, audits, routed.transport),
  );

  expectEqual(started.status, "ready", "a created merchant can start onboarding");
  if (started.status === "ready") {
    expectEqual(started.merchantId, merchantId, "the ready result carries the merchant id");
    expectEqual(started.applicationId, applicationId, "the ready result carries the application id");
    expectEqual(started.component.tag, "rainforest-merchant-onboarding", "the component is the documented element");
    expectEqual(
      started.component.scriptUrl,
      "https://static.rainforestpay.com/sandbox.merchant.js",
      "the component loads the documented merchant bundle",
    );
    expectEqual(started.component.attributes["session-key"], sessionKey, "the component carries the session key attribute");
    expectEqual(started.component.attributes["merchant-id"], merchantId, "the component carries the merchant id attribute");
    expectEqual(
      started.component.attributes["merchant-application-id"],
      applicationId,
      "the component carries the application id attribute",
    );
    expectEqual(
      started.component.attributes["terms-and-conditions-url"],
      termsUrl,
      "the component carries the terms and conditions attribute",
    );
    expectEqual(started.expiresAtEpochMs, Date.parse("2099-01-01T00:00:00Z"), "the component carries the session expiry");
  }

  const sessionCall = routed.calls.find((call) => call.endpoint.endsWith("/v1/sessions"));
  expect(sessionCall !== undefined, "starting onboarding creates one session");
  const sessionBody = JSON.parse(sessionCall?.body ?? "{}") as Record<string, unknown>;
  expectEqual(sessionBody["ttl"], RAINFOREST_ONBOARDING_DEFAULT_TTL_SECONDS, "the onboarding session asks for the documented example lifetime");
  const statement = (sessionBody["statements"] as Array<Record<string, unknown>>)[0];
  expectEqual(
    (statement?.["permissions"] as string[])[0],
    "group#merchant_onboarding_component",
    "the onboarding session asks for the documented onboarding group",
  );
  expectEqual(
    ((statement?.["constraints"] as Record<string, Record<string, string>>)["merchant"] ?? {})["merchant_id"],
    merchantId,
    "the onboarding session is constrained to the merchant",
  );
  expectEqual(json(sessionBody).includes("group#all"), false, "an onboarding session never asks for group#all");
  expectEqual(json(sessionBody).includes("group#payment_component"), false, "an onboarding session never asks for the payment group");
  expectEqual(dump(audits).includes(sessionKey), false, "no audit entry carries the session key");
  expectEqual(dump(audits).includes(sandboxKey), false, "no audit entry carries the API key");

  const missingMerchant = await startRainforestOnboarding(
    { companyId: otherCompanyId, termsAndConditionsUrl: termsUrl },
    store,
    merchantOptions(configStore, [], routed.transport),
  );
  expectEqual(missingMerchant.status, "not_created", "a company without a merchant cannot start onboarding");
  if (missingMerchant.status === "not_created") {
    expectEqual(missingMerchant.reason, "this company has no Rainforest merchant yet", "the refusal names the missing merchant");
  }

  const badTerms = await startRainforestOnboarding(
    { companyId, termsAndConditionsUrl: "http://insecure.example" },
    store,
    merchantOptions(configStore, [], routed.transport),
  );
  expectEqual(badTerms.status, "failed", "a plain-http terms url is refused");
  if (badTerms.status === "failed") {
    expectEqual(badTerms.reason, "the terms and conditions url must be an https address", "the refusal names the terms url");
  }

  const failingSession = await startRainforestOnboarding(
    { companyId, termsAndConditionsUrl: termsUrl },
    store,
    merchantOptions(configStore, [], routedTransport({ status: 200, body: createdAnswer() }, { status: 500, body: "" }).transport),
  );
  expectEqual(failingSession.status, "failed", "a refused session fails the start");
  if (failingSession.status === "failed") {
    expectEqual(failingSession.reason, "the API refused the session request with status 500", "the failure carries the session reason");
  }
}

/* ---- a merchant without an application id cannot show the component ---- */

{
  const configStore = await activeStoreFor(companyId);
  const store = new InMemoryRainforestMerchantProvisionStore();
  await provisionRainforestMerchant(
    profileOf(),
    store,
    merchantOptions(configStore, [], merchantTransport(200, json({ data: { merchant_id: merchantId } })).transport),
  );
  const started = await startRainforestOnboarding(
    { companyId, termsAndConditionsUrl: termsUrl },
    store,
    merchantOptions(configStore, [], merchantTransport(200, json({})).transport),
  );
  expectEqual(started.status, "failed", "a merchant without an application id cannot start onboarding");
  if (started.status === "failed") {
    expectEqual(
      started.reason,
      "the merchant application id is unknown, so the onboarding component cannot be shown",
      "the refusal names the missing application id",
    );
  }
}

/* ---- the component builder refuses half a contract ---- */

{
  expectEqual(rainforestOnboardingComponentFor("sandbox", "not-a-key", merchantId, applicationId, termsUrl), null, "a session key of the wrong shape yields no component");
  expectEqual(rainforestOnboardingComponentFor("sandbox", sessionKey, "mid_AB", applicationId, termsUrl), null, "a merchant id of the wrong shape yields no component");
  expectEqual(rainforestOnboardingComponentFor("sandbox", sessionKey, merchantId, "app_AB", termsUrl), null, "an application id of the wrong shape yields no component");
  expectEqual(rainforestOnboardingComponentFor("sandbox", sessionKey, merchantId, applicationId, "http://insecure.example"), null, "a plain-http terms url yields no component");
  const production = rainforestOnboardingComponentFor("production", sessionKey, productionMerchantId, "app_2DrD4yH7fH8aLIA7ZCnyVPcL9V9", termsUrl);
  expect(production !== null, "a production component is built");
  if (production !== null) {
    expectEqual(production.scriptUrl, "https://static.rainforestpay.com/merchant.js", "the production component loads the production bundle");
    expectEqual(dump(production).includes(sandboxKey), false, "the component contract carries no API key");
  }
}

/* ------------------------------------------------------------------------------------------------
 * Section 6: reading the onboarding state
 * --------------------------------------------------------------------------------------------- */

{
  const created = {
    id: "00000000-0000-4000-8000-00000000ee01",
    companyId,
    status: "created" as const,
    reason: null,
    requiresReconciliation: false,
    merchantId,
    applicationId,
    merchantStatus: "ACTIVE",
    applicationStatus: "COMPLETED",
    version: 2,
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
  };
  const state = rainforestOnboardingStateOf(created);
  expectEqual(state.merchantId, merchantId, "the state carries the merchant id");
  expectEqual(state.merchantStatus, "ACTIVE", "the state carries the merchant status");
  expectEqual(state.behaviour, "processes", "an ACTIVE merchant processes payments");
  expectEqual(state.applicationStatus, "COMPLETED", "the state carries the application status");
  expectEqual(state.decision, "approved", "a COMPLETED application is approved");

  expectEqual(rainforestOnboardingStateOf({ ...created, merchantStatus: "PENDING" }).behaviour, "waiting", "a pending merchant is waiting");
  expectEqual(rainforestOnboardingStateOf({ ...created, merchantStatus: "SUSPENDED" }).behaviour, "blocked", "a suspended merchant is blocked");
  expectEqual(rainforestOnboardingStateOf({ ...created, applicationStatus: "DECLINED" }).decision, "declined", "a declined application is declined");
  expectEqual(
    rainforestOnboardingStateOf({ ...created, applicationStatus: "NEEDS_INFORMATION" }).decision,
    "pending",
    "an application needing information is pending",
  );
  expectEqual(rainforestOnboardingStateOf({ ...created, merchantStatus: "SETTLED" }).behaviour, null, "an undocumented merchant status maps to nothing");
  expectEqual(rainforestOnboardingStateOf({ ...created, applicationStatus: "MAYBE" }).decision, null, "an undocumented application status maps to nothing");
  expectEqual(rainforestOnboardingStateOf({ ...created, merchantStatus: null, applicationStatus: null }).behaviour, null, "an absent status maps to nothing");
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: the transport and the security sweep
 * --------------------------------------------------------------------------------------------- */

{
  const realFetch = globalThis.fetch;
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string> });
    return { status: 200, text: async () => json({ data: {} }) } as unknown as Response;
  }) as unknown as typeof fetch;

  await rainforestMerchantTransport(`${RAINFOREST_SANDBOX_API_BASE}/v1/merchants`, "POST", sandboxKey, "{}");
  expectEqual(calls.length, 1, "the merchant transport reaches the merchant endpoint");
  expectEqual(calls[0]?.url, `${RAINFOREST_SANDBOX_API_BASE}/v1/merchants`, "the merchant transport uses the documented url");
  expectEqual(calls[0]?.headers["Authorization"], `Bearer ${sandboxKey}`, "the merchant transport carries the bearer credential");

  await expectRejection(
    async () => rainforestMerchantTransport(`${RAINFOREST_SANDBOX_API_BASE}/v1/api_keys`, "POST", sandboxKey, "{}"),
    "the merchant transport refuses an endpoint it was not given",
  );
  await expectRejection(
    async () => rainforestMerchantTransport("https://api.example.com/v1/merchants", "POST", sandboxKey, "{}"),
    "the merchant transport refuses a foreign host",
  );
  await expectRejection(
    async () => rainforestMerchantTransport(`${RAINFOREST_SANDBOX_API_BASE}/v1/merchants`, "POST", "", "{}"),
    "the merchant transport refuses a call without a key",
  );
  expectEqual(calls.length, 1, "no refused call reached fetch");
  globalThis.fetch = realFetch;
}

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const store: RainforestMerchantProvisionStore = new InMemoryRainforestMerchantProvisionStore();
  await provisionRainforestMerchant(profileOf(), store, merchantOptions(configStore, audits, merchantTransport(200, createdAnswer()).transport));

  const auditDump = dump(audits);
  expect(auditDump.includes(sandboxKey) === false, "the audit trail carries no API key");
  expect(auditDump.includes("123456789") === false, "the audit trail carries no tax identifier");
  expect(auditDump.includes("4111") === false, "the audit trail carries no card number");

  const storedDump = dump(store.findByCompany(companyId));
  expect(storedDump.includes(sandboxKey) === false, "the stored provision carries no API key");
  expect(storedDump.includes("billing@kdsolution.example") === false, "the stored provision carries no business data");
  expect(dump(configStore.findActiveByCompany(companyId)).includes(sandboxKey) === false, "the stored configuration carries no plaintext key");
}

/* ---- the verdict ---- */

const label =
  "payments Rainforest merchant gate passed: " +
  `${checks} checks (a create merchant body of documented non-sensitive fields only, one merchant per company with a ` +
  "reopenable attempt and a final created row, an onboarding session scoped to one merchant and the onboarding group, " +
  "and a component contract that carries the merchant, the application and the terms url)";

if (failures.length > 0) {
  process.stderr.write(`payments Rainforest merchant gate failed: ${failures.length} of ${checks} checks\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`${label}\n`);
