// path: lib/payments/adapters/nmi-submerchant-verify.ts

/**
 * The gate for STEP 153: NMI sub-merchant provisioning through the gateway and signature verified
 * idempotent webhooks.
 *
 * The gate is a check script, not a test file: it exercises the service with the documented
 * Create Merchant answer and with NMI's documented webhook envelope, signing each delivery the way
 * the documentation says the gateway signs it, then fails the run and names every check that did
 * not hold. No network call is made and no credential is used.
 */

import { createHmac } from "node:crypto";
import process from "node:process";
import {
  buildNmiCreateMerchantBody,
  InMemoryNmiProvisionStore,
  InMemoryNmiWebhookEventStore,
  NMI_DOCUMENTED_WEBHOOK_EVENTS,
  NMI_PROVISION_EVENT_TYPES,
  NMI_SANDBOX_V4_ENDPOINT,
  NMI_SUBMERCHANT_DOCUMENTATION_URLS,
  NMI_V4_ENDPOINT,
  NMI_WEBHOOK_SIGNATURE_HEADER,
  nmiMerchantIdOf,
  nmiMerchantsEndpointFor,
  nmiProvisionEventOf,
  nmiProvisionEventTypesAreDocumented,
  nmiSubmerchantFetchTransport,
  nmiWebhookPayloadHash,
  parseNmiCreateMerchantAnswer,
  parseNmiWebhookSignature,
  provisionNmiSubmerchant,
  receiveNmiWebhook,
  sanitizeNmiSubmerchantText,
  validateNmiSubmerchantProfile,
  verifyNmiWebhookSignature,
  type NmiProvisionAuditEntry,
  type NmiProvisionMode,
  type NmiProvisionRecord,
  type NmiProvisioningIntent,
  type NmiSubmerchantProfile,
  type NmiWebhookOptions,
} from "./nmi-submerchant.ts";

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

/* ---- shared fixtures ---- */

const v4ApiKey = "v4-api-key-000000000000";
const signingKey = "whsec_sandbox_signing_key_0001";
const merchantId = "1587";

const profile: NmiSubmerchantProfile = {
  type: "gateway",
  company: "ACME, Inc.",
  externalIdentifier: "A Company That Makes Everything",
  country: "US",
  address1: "123 Fake St.",
  address2: "Unit 101",
  city: "Chicago",
  state: "IL",
  zip: "60601",
  url: null,
  timezone: "America/Chicago",
  firstName: "Jane",
  lastName: "Doe",
  email: "someone@example.com",
  phone: "555-555-5555",
  fax: null,
  language: "en_US",
  username: "acme_inc",
  accountInfo: null,
};

/** The documented Create Standard Merchant answer, verbatim in the fields this file reads. */
const documentedCreateAnswer = JSON.stringify({
  objectType: "merchant",
  id: merchantId,
  type: "gateway",
  created: "2022-09-26T13:20:03+00:00",
  updated: "2022-09-26T13:20:03+00:00",
  firstName: "Jane",
  lastName: "Doe",
  company: "ACME, Inc.",
  email: "someone@example.com",
  phone: "555-555-5555",
  fax: "123-456-7890",
  url: "",
  address1: "123 Fake St.",
  address2: "Unit 101",
  city: "Chicago",
  state: "IL",
  zip: "60601",
  country: "US",
  timezone: "America/Chicago",
  costPlan: null,
  status: "pending",
  externalIdentifier: "A Company That Makes Everything",
  lastTransactionDate: null,
  parentAffiliateId: "1",
  accountInfo: { checkAba: "123123123", checkAccount: "*****3123", accountType: "checking", accountHolderType: "business" },
  needsPendingServicesActivated: true,
});

function intentOf(overrides: Partial<NmiProvisioningIntent> = {}): NmiProvisioningIntent {
  return {
    companyId: "company-1",
    mode: "test",
    idempotencyKey: "kyc-approval-0001",
    environment: "sandbox",
    v4ApiKey,
    masterAccountRef: "platform-affiliate-1",
    providerEnabled: true,
    profile,
    ...overrides,
  };
}

function transportOf(
  answer: { readonly status: number; readonly body: string },
  calls: { count: number },
): (endpoint: string, authorization: string, body: Readonly<Record<string, unknown>>) => Promise<{ status: number; body: string }> {
  return async (endpoint, authorization, body) => {
    calls.count += 1;
    expectEqual(endpoint, nmiMerchantsEndpointFor("sandbox"), "the provisioning call goes to the sandbox merchant endpoint");
    expectEqual(authorization, v4ApiKey, "the provisioning call sends the v4 API key");
    expectEqual(body["company"], "ACME, Inc.", "the provisioning call sends the documented body");
    return answer;
  };
}

/** Sign a delivery the way https://docs.nmi.com/reference/overview documents it. */
function signedDeliveryOf(
  event: unknown,
  mode: NmiProvisionMode = "test",
  nonce = "9f8e7d6c5b4a",
): { readonly rawBody: string; readonly signatureHeader: string; readonly mode: NmiProvisionMode } {
  const rawBody = typeof event === "string" ? event : JSON.stringify(event);
  const signature = createHmac("sha256", signingKey).update(`${nonce}.${rawBody}`, "utf8").digest("hex");
  return { rawBody, signatureHeader: `t=${nonce},s=${signature}`, mode };
}

function saleSuccessEvent(overrides: { readonly merchant?: string; readonly isTestMode?: boolean } = {}): Record<string, unknown> {
  return {
    event_id: "2aa1bb86-c790-4231-a46e-7cc544a8dc5c",
    event_type: "transaction.sale.success",
    event_body: {
      merchant: { id: overrides.merchant ?? merchantId, name: "Test merchant account" },
      features: { is_test_mode: overrides.isTestMode ?? true },
      transaction_id: "8584364761",
      transaction_type: "cc",
      condition: "pendingsettlement",
      requested_amount: "10.00",
      action: { type: "sale", success: "1", response_code: "100" },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the documented constants
 * --------------------------------------------------------------------------------------------- */

expectEqual(NMI_V4_ENDPOINT, "https://secure.nmi.com/api", "the production v4 base is the documented one");
expectEqual(NMI_SANDBOX_V4_ENDPOINT, "https://sandbox.nmi.com/api", "the sandbox v4 base is the documented one");
expectEqual(
  nmiMerchantsEndpointFor("sandbox"),
  "https://sandbox.nmi.com/api/v4/merchants",
  "the sandbox create merchant endpoint is the documented one",
);
expectEqual(
  nmiMerchantsEndpointFor("production"),
  "https://secure.nmi.com/api/v4/merchants",
  "the production create merchant endpoint is the documented one",
);
expectEqual(NMI_WEBHOOK_SIGNATURE_HEADER, "webhook-signature", "the signature header is the documented one");
expectEqual(NMI_DOCUMENTED_WEBHOOK_EVENTS.length, 35, "every documented webhook event name is recorded");
expectEqual(new Set(NMI_DOCUMENTED_WEBHOOK_EVENTS).size, 35, "the documented event names are unique");
expect(NMI_DOCUMENTED_WEBHOOK_EVENTS.includes("transaction.sale.success"), "a transaction event is recorded");
expect(NMI_DOCUMENTED_WEBHOOK_EVENTS.includes("settlement.batch.complete"), "a settlement event is recorded");
expect(NMI_SUBMERCHANT_DOCUMENTATION_URLS.length >= 5, "the documentation urls are recorded");
expect(
  NMI_SUBMERCHANT_DOCUMENTATION_URLS.includes("https://docs.nmi.com/reference/create-merchant"),
  "the create merchant documentation is recorded",
);
expect(
  NMI_SUBMERCHANT_DOCUMENTATION_URLS.includes("https://docs.nmi.com/reference/overview"),
  "the webhook overview documentation is recorded",
);
expect(nmiProvisionEventTypesAreDocumented(), "every provisioning mapping key is a documented event name");

/* ------------------------------------------------------------------------------------------------
 * Section 2: provider text
 * --------------------------------------------------------------------------------------------- */

expectEqual(sanitizeNmiSubmerchantText("<script>alert(1)</script>"), "scriptalert(1)/script", "markup is stripped");
expectEqual(sanitizeNmiSubmerchantText("line1\nline2\ttabbed"), "line1 line2 tabbed", "control characters collapse");
expectEqual(sanitizeNmiSubmerchantText(null), "", "missing provider text is empty");
expectEqual(sanitizeNmiSubmerchantText("x".repeat(500)).length, 200, "provider text is capped");
expectEqual(sanitizeNmiSubmerchantText("  padded  "), "padded", "provider text is trimmed");
expectEqual(nmiWebhookPayloadHash("{}").length, 64, "the payload hash is a sha-256 hex digest");
expectEqual(nmiWebhookPayloadHash("{}"), nmiWebhookPayloadHash("{}"), "the payload hash is deterministic");
expect(nmiWebhookPayloadHash("{}") !== nmiWebhookPayloadHash("[]"), "a different body has a different hash");

/* ------------------------------------------------------------------------------------------------
 * Section 3: the merchant profile
 * --------------------------------------------------------------------------------------------- */

expectEqual(validateNmiSubmerchantProfile(profile).status, "valid", "the documented profile is valid");

const invalidProfiles: readonly (readonly [Partial<NmiSubmerchantProfile>, string])[] = [
  [{ type: "Gateway!" }, "an invalid merchant type is refused"],
  [{ company: "" }, "an empty company is refused"],
  [{ company: "x".repeat(121) }, "an over-long company is refused"],
  [{ country: "USA" }, "a three letter country is refused"],
  [{ country: "us" }, "a lowercase country is refused"],
  [{ address1: "" }, "an empty address is refused"],
  [{ city: "" }, "an empty city is refused"],
  [{ state: "Illinois" }, "a spelled-out state is refused"],
  [{ zip: "-6060" }, "an invalid postal code is refused"],
  [{ url: "http://example.com" }, "a non-https website is refused"],
  [{ url: "javascript:alert(1)" }, "a javascript url is refused"],
  [{ timezone: "Chicago time" }, "an invalid timezone is refused"],
  [{ timezone: "America/Chicago/Extra/More" }, "an over-nested timezone is refused"],
  [{ firstName: "" }, "an empty first name is refused"],
  [{ lastName: "x".repeat(61) }, "an over-long last name is refused"],
  [{ email: "not-an-email" }, "an invalid email is refused"],
  [{ email: "a@b" }, "an email without a top level domain is refused"],
  [{ phone: "call me" }, "an invalid phone is refused"],
  [{ fax: "call me" }, "an invalid fax is refused"],
  [{ language: "en_US_en" }, "an invalid language is refused"],
  [{ username: "no" }, "a too-short username is refused"],
  [{ username: "user name" }, "a username with a space is refused"],
  [{ externalIdentifier: "x".repeat(201) }, "an over-long external identifier is refused"],
  [{ address2: "" }, "an empty second address line is refused"],
];

for (const [overrides, description] of invalidProfiles) {
  expectEqual(validateNmiSubmerchantProfile({ ...profile, ...overrides }).status, "rejected", description);
}

const accountInfoProfile: NmiSubmerchantProfile = {
  ...profile,
  accountInfo: { checkAccount: "123123123", checkAba: "123123123", accountHolderType: "business", accountType: "checking" },
};
expectEqual(validateNmiSubmerchantProfile(accountInfoProfile).status, "valid", "the documented banking block is valid");
for (const [accountInfo, description] of [
  [{ ...accountInfoProfile.accountInfo, checkAccount: "12" }, "a short account number is refused"],
  [{ ...accountInfoProfile.accountInfo, checkAccount: "1234abc" }, "an alphanumeric account number is refused"],
  [{ ...accountInfoProfile.accountInfo, checkAba: "12345678" }, "a short routing number is refused"],
  [{ ...accountInfoProfile.accountInfo, accountType: "credit" }, "an invalid account type is refused"],
  [{ ...accountInfoProfile.accountInfo, accountHolderType: "joint" }, "an invalid holder type is refused"],
] as readonly (readonly [NmiSubmerchantProfile["accountInfo"], string])[]) {
  const candidate: NmiSubmerchantProfile = { ...profile, accountInfo };
  expectEqual(validateNmiSubmerchantProfile(candidate).status, "rejected", description);
}

expectEqual(validateNmiSubmerchantProfile({ ...profile, url: null, fax: null }).status, "valid", "absent optional fields are valid");
expectEqual(
  validateNmiSubmerchantProfile({ ...profile, url: "https://acme.example.com/store?a=1" }).status,
  "valid",
  "an https website with a path is valid",
);

/* ------------------------------------------------------------------------------------------------
 * Section 4: the documented request body
 * --------------------------------------------------------------------------------------------- */

const minimalProfile: NmiSubmerchantProfile = {
  ...profile,
  externalIdentifier: null,
  address2: null,
  url: null,
  fax: null,
  accountInfo: null,
};
const minimalBody = buildNmiCreateMerchantBody(minimalProfile);
expectEqual(
  Object.keys(minimalBody).sort().join(","),
  "accountInfo,address1,city,company,country,email,firstName,language,lastName,phone,state,timezone,type,username,zip",
  "the minimal body carries the documented required fields and nothing else",
);
expectEqual(minimalBody["type"], "gateway", "the documented account type is sent");
expectEqual(minimalBody["accountInfo"] === undefined, false, "the required accountInfo object is always present");
expectEqual(JSON.stringify(minimalBody["accountInfo"]), "{}", "an absent banking block is sent as the documented empty object");
expectEqual(minimalBody["company"], "ACME, Inc.", "the company is sent");
expectEqual(minimalBody["timezone"], "America/Chicago", "the timezone is sent");
expectEqual(minimalBody["language"], "en_US", "the language is sent");

const fullBody = buildNmiCreateMerchantBody(accountInfoProfile);
expectEqual(fullBody["externalIdentifier"], "A Company That Makes Everything", "the external identifier is sent");
expectEqual(fullBody["address2"], "Unit 101", "the second address line is sent");
expectEqual(JSON.stringify(fullBody["accountInfo"]), JSON.stringify({
  checkAccount: "123123123",
  checkAba: "123123123",
  accountHolderType: "business",
  accountType: "checking",
}), "the documented banking fields are sent");
expectEqual(fullBody["url"] === undefined, true, "an absent website is omitted");

const urlBody = buildNmiCreateMerchantBody({ ...minimalProfile, url: "https://acme.example.com" });
expectEqual(urlBody["url"], "https://acme.example.com", "a website is sent when present");
expectThrows(() => buildNmiCreateMerchantBody({ ...profile, company: "" }), "an invalid profile is never built into a body");

/* ------------------------------------------------------------------------------------------------
 * Section 5: the create merchant answer
 * --------------------------------------------------------------------------------------------- */

const created = parseNmiCreateMerchantAnswer(200, documentedCreateAnswer);
expectEqual(created.outcome, "created", "the documented success answer is a created merchant");
if (created.outcome === "created") {
  expectEqual(created.merchantId, "1587", "the documented gateway id is read");
  expectEqual(created.providerStatus, "pending", "the documented provider status is read");
  expectEqual(created.parentAffiliateId, "1", "the documented parent affiliate is read");
}

const numericId = parseNmiCreateMerchantAnswer(200, JSON.stringify({ objectType: "merchant", id: 1587 }));
expectEqual(numericId.outcome, "created", "a numeric gateway id is accepted");
if (numericId.outcome === "created") expectEqual(numericId.merchantId, "1587", "a numeric gateway id becomes a string");

expectEqual(parseNmiCreateMerchantAnswer(201, documentedCreateAnswer).outcome, "created", "a 201 answer is a created merchant");
expectEqual(parseNmiCreateMerchantAnswer(409, "{}").outcome, "duplicate", "409 is the duplicate answer");
expectEqual(parseNmiCreateMerchantAnswer(401, "{}").outcome, "credentials_rejected", "401 is a rejected v4 key");
expectEqual(parseNmiCreateMerchantAnswer(403, "{}").outcome, "credentials_rejected", "403 is a rejected v4 key");
expectEqual(parseNmiCreateMerchantAnswer(429, "{}").outcome, "unknown", "429 is an unknown outcome");
expectEqual(parseNmiCreateMerchantAnswer(500, "<html>oops</html>").outcome, "unknown", "500 is an unknown outcome");
expectEqual(parseNmiCreateMerchantAnswer(502, "{}").outcome, "unknown", "502 is an unknown outcome");
expectEqual(parseNmiCreateMerchantAnswer(200, "not json").outcome, "unknown", "a non-json answer is unknown");
expectEqual(parseNmiCreateMerchantAnswer(200, "[]").outcome, "unknown", "an array answer is unknown");
expectEqual(parseNmiCreateMerchantAnswer(200, JSON.stringify({ objectType: "merchant", id: "<script>" })).outcome, "unknown", "an invalid gateway id is unknown");
expectEqual(parseNmiCreateMerchantAnswer(200, JSON.stringify({ objectType: "merchant", id: "x".repeat(65) })).outcome, "unknown", "an over-long gateway id is unknown");
expectEqual(parseNmiCreateMerchantAnswer(200, JSON.stringify({ objectType: "transaction", id: "1587" })).outcome, "unknown", "a foreign object type is unknown");
expectEqual(parseNmiCreateMerchantAnswer(200, JSON.stringify({ objectType: "merchant" })).outcome, "unknown", "an answer without an id is unknown");

const validationAnswer = parseNmiCreateMerchantAnswer(422, JSON.stringify({ message: "<b>company</b> is required" }));
expectEqual(validationAnswer.outcome, "action_required", "422 is a validation failure for the office");
if (validationAnswer.outcome === "action_required") {
  expectEqual(validationAnswer.detail, "bcompany/b is required", "the provider detail is sanitised");
}

const plainValidation = parseNmiCreateMerchantAnswer(400, JSON.stringify({ errors: ["country is invalid"] }));
expectEqual(plainValidation.outcome, "action_required", "400 is a validation failure for the office");
if (plainValidation.outcome === "action_required") {
  expectEqual(plainValidation.detail, "country is invalid", "a list of errors is read");
}
expectEqual(
  parseNmiCreateMerchantAnswer(400, "{}").outcome === "action_required" ? "action" : "other",
  "action",
  "an empty validation answer is still an office action",
);
const affiliateAnswer = parseNmiCreateMerchantAnswer(
  200,
  JSON.stringify({ objectType: "merchant", id: "1587", parentAffiliateId: "bad affiliate!" }),
);
expectEqual(affiliateAnswer.outcome, "created", "an invalid affiliate still creates the merchant");
if (affiliateAnswer.outcome === "created") {
  expectEqual(affiliateAnswer.parentAffiliateId, null, "an invalid affiliate reference is dropped");
}

expectEqual(nmiMerchantIdOf("1587"), "1587", "a string gateway id is read");
expectEqual(nmiMerchantIdOf(1587), "1587", "a numeric gateway id is read");
expectEqual(nmiMerchantIdOf("15 87"), null, "an id with a space is refused");
expectEqual(nmiMerchantIdOf("-1587"), null, "a negative id is refused");
expectEqual(nmiMerchantIdOf(0), null, "a zero id is refused");
expectEqual(nmiMerchantIdOf(true), null, "a boolean id is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 6: the transport
 * --------------------------------------------------------------------------------------------- */

const originalFetch = globalThis.fetch;
try {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(documentedCreateAnswer, { status: 200 });
  };
  const http = await nmiSubmerchantFetchTransport(nmiMerchantsEndpointFor("sandbox"), v4ApiKey, { company: "ACME, Inc." });
  expectEqual(seenUrl, "https://sandbox.nmi.com/api/v4/merchants", "the transport posts to the documented endpoint");
  expectEqual(seenInit?.method, "POST", "the transport posts");
  expectEqual(seenInit?.redirect, "error", "the transport refuses redirects");
  expectEqual(JSON.stringify(seenInit?.headers).includes("application/json"), true, "the transport sends json");
  expectEqual(JSON.stringify(seenInit?.headers).includes(v4ApiKey), true, "the transport sends the v4 key in the header");
  expectEqual(typeof seenInit?.body, "string", "the transport sends a json string body");
  expectEqual(String(seenInit?.body).includes("ACME, Inc."), true, "the transport sends the profile");
  expectEqual(http.status, 200, "the transport returns the status");
  expectEqual(http.body.includes("\"objectType\":\"merchant\""), true, "the transport returns the raw body");

  globalThis.fetch = async () => new Response("error", { status: 500 });
  const serverError = await nmiSubmerchantFetchTransport(nmiMerchantsEndpointFor("production"), v4ApiKey, { company: "x" });
  expectEqual(serverError.status, 500, "a 5xx answer is returned, not thrown");
  expectEqual(parseNmiCreateMerchantAnswer(serverError.status, serverError.body).outcome, "unknown", "a 5xx answer is an unknown outcome");

  globalThis.fetch = async () => new Response("x".repeat(1_100_000), { status: 200 });
  await expectRejection(
    () => nmiSubmerchantFetchTransport(nmiMerchantsEndpointFor("sandbox"), v4ApiKey, { company: "x" }),
    "an oversized answer is refused",
  );

  globalThis.fetch = async () => new Response("{}", { status: 200 });
  await expectRejection(
    () => nmiSubmerchantFetchTransport("https://example.com/api/v4/merchants", v4ApiKey, { company: "x" }),
    "an undocumented endpoint is refused",
  );
  await expectRejection(
    () => nmiSubmerchantFetchTransport(nmiMerchantsEndpointFor("sandbox"), "  ", { company: "x" }),
    "a call without a v4 key is refused",
  );
} finally {
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: provisioning
 * --------------------------------------------------------------------------------------------- */

const provisionStore = new InMemoryNmiProvisionStore();
const provisionAudits: NmiProvisionAuditEntry[] = [];
const provisionCalls = { count: 0 };
const provisionOptions = {
  store: provisionStore,
  occurredAtEpochMs: 1_000,
  transport: transportOf({ status: 200, body: documentedCreateAnswer }, provisionCalls),
  recordAudit: (entry: NmiProvisionAuditEntry) => provisionAudits.push(entry),
};

const boarded = await provisionNmiSubmerchant(intentOf(), provisionOptions);
expectEqual(boarded.status, "provisioned", "the documented answer provisions the merchant");
expectEqual(provisionCalls.count, 1, "one call boards the merchant");
expectEqual(boarded.record?.providerSubmerchantId, merchantId, "the record keeps the gateway id");
expectEqual(boarded.record?.status, "pending", "a boarded merchant starts pending until a webhook verifies it");
expectEqual(boarded.record?.version, 1, "the record starts at version 1");
expectEqual(boarded.record?.attemptCount, 1, "the attempt is counted");
expectEqual(boarded.record?.mode, "test", "the record keeps its mode");
expectEqual(boarded.record?.idempotencyKey, "kyc-approval-0001", "the record keeps its approval key");
expectEqual(boarded.record?.masterAccountRef, "1", "the affiliate the gateway boarded under is recorded");
expectEqual(boarded.record?.lastProviderStatus, "pending", "the provider status is recorded");
expectEqual(boarded.update?.status, "pending", "the update the caller writes is pending");
expectEqual(boarded.update?.attempted, true, "the update records an attempt");
expectEqual(Object.hasOwn(boarded.update ?? {}, "chargesEnabled"), false, "provisioning never enables charges itself");
expectEqual(provisionAudits.length, 1, "one audit entry is written");
expectEqual(provisionAudits[0]?.action, "submerchant_provision.nmi_attempted", "the audit entry names the attempt");
expectEqual(provisionAudits[0]?.provider, "nmi", "the audit entry names the provider");
expectEqual(provisionAudits[0]?.providerSubmerchantId, merchantId, "the audit entry names the gateway id");
expectEqual(JSON.stringify(boarded).includes(v4ApiKey), false, "the provisioning outcome leaks no v4 key");
expectEqual(JSON.stringify(provisionAudits).includes(v4ApiKey), false, "the audit entry leaks no v4 key");

const again = await provisionNmiSubmerchant(intentOf(), provisionOptions);
expectEqual(again.status, "already_provisioned", "a redelivered approval answers with the existing account");
expectEqual(provisionCalls.count, 1, "a redelivered approval makes no second call");
expectEqual(again.record?.providerSubmerchantId, merchantId, "the existing record is returned");

const otherKey = await provisionNmiSubmerchant(intentOf({ idempotencyKey: "kyc-approval-0002" }), provisionOptions);
expectEqual(otherKey.status, "refused", "a second approval key cannot board the same merchant twice");
expectEqual(otherKey.reason.includes("approval key"), true, "the refusal names the approval key");
expectEqual(provisionCalls.count, 1, "the refused approval makes no call");

const otherMode = await provisionNmiSubmerchant(intentOf({ mode: "live" }), provisionOptions);
expectEqual(otherMode.status, "refused", "the same merchant cannot be boarded in another mode");

expectEqual((await provisionNmiSubmerchant(intentOf({ companyId: "company-2", v4ApiKey: " " }), provisionOptions)).status, "refused", "a call without a v4 key is refused");
expectEqual((await provisionNmiSubmerchant(intentOf({ companyId: "company-3", providerEnabled: false }), provisionOptions)).status, "refused", "a disabled provider is refused");
expectEqual((await provisionNmiSubmerchant(intentOf({ companyId: "company-4", idempotencyKey: "bad key!" }), provisionOptions)).status, "refused", "an invalid approval key is refused");
expectEqual((await provisionNmiSubmerchant(intentOf({ companyId: "not a uuid!" }), provisionOptions)).status, "refused", "an invalid company id is refused");
expectEqual(
  (await provisionNmiSubmerchant(intentOf({ companyId: "company-5", profile: { ...profile, company: "" } }), provisionOptions)).status,
  "refused",
  "an invalid profile is refused before any call",
);
expectEqual(provisionCalls.count, 1, "the refused attempts make no call");
expectEqual(provisionStore.findByCompany("company-5"), null, "a refused attempt writes no record");

const unknownStore = new InMemoryNmiProvisionStore();
const unknownOutcome = await provisionNmiSubmerchant(intentOf(), {
  store: unknownStore,
  occurredAtEpochMs: 1_001,
  transport: async () => {
    throw new Error(v4ApiKey);
  },
});
expectEqual(unknownOutcome.status, "unknown", "a transport failure is an unknown outcome");
expectEqual(unknownOutcome.reason.includes("reconcile"), true, "an unknown outcome asks for reconciliation");
expectEqual(unknownStore.findByCompany("company-1"), null, "an unknown outcome writes no record");
expectEqual(JSON.stringify(unknownOutcome).includes(v4ApiKey), false, "an unknown outcome leaks no v4 key");

const serverStore = new InMemoryNmiProvisionStore();
const serverOutcome = await provisionNmiSubmerchant(intentOf(), {
  store: serverStore,
  occurredAtEpochMs: 1_002,
  transport: async () => ({ status: 503, body: "" }),
});
expectEqual(serverOutcome.status, "unknown", "a 5xx answer is an unknown outcome");
expectEqual(serverStore.findByCompany("company-1"), null, "a 5xx answer writes no record");

const duplicateOutcome = await provisionNmiSubmerchant(intentOf(), {
  store: new InMemoryNmiProvisionStore(),
  occurredAtEpochMs: 1_003,
  transport: async () => ({ status: 409, body: "" }),
});
expectEqual(duplicateOutcome.status, "unknown", "a duplicate at the gateway is an unknown outcome");
expectEqual(duplicateOutcome.reason.includes("already exists"), true, "the duplicate outcome names the duplicate");

const credentialsOutcome = await provisionNmiSubmerchant(intentOf(), {
  store: new InMemoryNmiProvisionStore(),
  occurredAtEpochMs: 1_004,
  transport: async () => ({ status: 401, body: "" }),
});
expectEqual(credentialsOutcome.status, "refused", "a rejected v4 key refuses the attempt");
expectEqual(credentialsOutcome.reason.includes("v4 API key"), true, "the refusal names the key");

const actionStore = new InMemoryNmiProvisionStore();
const actionAudits: NmiProvisionAuditEntry[] = [];
const actionOutcome = await provisionNmiSubmerchant(intentOf(), {
  store: actionStore,
  occurredAtEpochMs: 1_005,
  transport: async () => ({ status: 422, body: JSON.stringify({ message: "company is required" }) }),
  recordAudit: (entry: NmiProvisionAuditEntry) => actionAudits.push(entry),
});
expectEqual(actionOutcome.status, "action_required", "a validation failure is an office action");
expectEqual(actionOutcome.record?.status, "action_required", "the record is parked in action required");
expectEqual(actionOutcome.record?.actionRequiredDetail, "company is required", "the provider detail is recorded");
expectEqual(actionOutcome.record?.providerSubmerchantId, null, "an unboarded merchant has no gateway id");
expectEqual(actionOutcome.update?.attempted, true, "the office action records the attempt");
expectEqual(actionAudits.length, 1, "the office action is audited");

const retried = await provisionNmiSubmerchant(intentOf(), {
  store: actionStore,
  occurredAtEpochMs: 1_006,
  transport: async () => ({ status: 200, body: documentedCreateAnswer }),
});
expectEqual(retried.status, "provisioned", "a corrected retry boards the merchant");
expectEqual(retried.record?.providerSubmerchantId, merchantId, "the retry records the gateway id");
expectEqual(retried.record?.attemptCount, 2, "the retry counts a second attempt");
expectEqual(retried.record?.version, 2, "the retry advances the version");
expectEqual(retried.record?.status, "pending", "the retried merchant is pending until verified");

const masterRefOutcome = await provisionNmiSubmerchant(intentOf({ companyId: "company-6" }), {
  store: new InMemoryNmiProvisionStore(),
  occurredAtEpochMs: 1_007,
  transport: async () => ({ status: 200, body: JSON.stringify({ objectType: "merchant", id: "2048", status: "pending" }) }),
});
expectEqual(masterRefOutcome.record?.masterAccountRef, "platform-affiliate-1", "the platform affiliate is used when the answer omits one");

/* ------------------------------------------------------------------------------------------------
 * Section 8: the provisioning store
 * --------------------------------------------------------------------------------------------- */

const storeRules = new InMemoryNmiProvisionStore();
const seedRecord: NmiProvisionRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "company-1",
  mode: "test",
  idempotencyKey: "kyc-approval-0001",
  providerSubmerchantId: null,
  status: "pending",
  masterAccountRef: null,
  attemptCount: 0,
  lastProviderStatus: null,
  lastAttemptOutcome: null,
  actionRequiredDetail: null,
  lastAttemptAtEpochMs: null,
  version: 1,
};
storeRules.insert(seedRecord);
expectEqual(storeRules.findById(seedRecord.id)?.companyId, "company-1", "a record is readable by id");
expectEqual(storeRules.findByCompany("company-1")?.id, seedRecord.id, "a record is readable by company");
expectEqual(storeRules.findByCompany("nobody"), null, "an unknown company has no record");
expectThrows(() => storeRules.insert({ ...seedRecord, id: "00000000-0000-4000-8000-000000000002" }), "a second record for one company is refused");
storeRules.insert({ ...seedRecord, id: "00000000-0000-4000-8000-000000000003", companyId: "company-9" });
expectThrows(
  () => storeRules.insert({ ...seedRecord, id: "00000000-0000-4000-8000-000000000003", companyId: "company-7" }),
  "a duplicate record id is refused",
);
expectThrows(() => storeRules.insert({ ...seedRecord, id: "00000000-0000-4000-8000-000000000004", companyId: "company-8", version: 2 }), "a record must start at version 1");

const advance = { ...seedRecord, providerSubmerchantId: merchantId, version: 2 };
expectEqual(storeRules.save(advance, 1), true, "a write from the stored version succeeds");
expectEqual(storeRules.findByProviderSubmerchantId(merchantId)?.id, seedRecord.id, "the gateway id index is updated");
expectEqual(storeRules.save({ ...advance, version: 3 }, 1), false, "a stale write is refused");
expectEqual(storeRules.save({ ...advance, providerSubmerchantId: "9999", version: 3 }, 2), false, "the gateway id never changes");
expectEqual(storeRules.save({ ...advance, idempotencyKey: "other", version: 3 }, 2), false, "the approval key never changes");
expectEqual(storeRules.save({ ...advance, mode: "live", version: 3 }, 2), false, "the mode never changes");
expectEqual(storeRules.save({ ...advance, version: 7 }, 2), false, "a version jump is refused");
expectEqual(storeRules.save({ ...advance, id: "00000000-0000-4000-8000-0000000000ff", version: 3 }, 2), false, "a write for an unknown id is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 9: the webhook signature
 * --------------------------------------------------------------------------------------------- */

const hexSignature = "a".repeat(64);
expectEqual(parseNmiWebhookSignature(`t=abc123,s=${hexSignature}`)?.nonce, "abc123", "the nonce is parsed");
expectEqual(parseNmiWebhookSignature(`t=abc123,s=${hexSignature}`)?.signature, hexSignature, "the signature is parsed");
expectEqual(parseNmiWebhookSignature(` t=abc123 , s=${hexSignature} `)?.nonce, "abc123", "surrounding spaces are tolerated");
expectEqual(parseNmiWebhookSignature(`t=abc123,s=${hexSignature},v=1`)?.nonce, "abc123", "an extra parameter is tolerated");
expectEqual(parseNmiWebhookSignature(`s=${hexSignature}`), null, "a header without a nonce is refused");
expectEqual(parseNmiWebhookSignature("t=abc123"), null, "a header without a signature is refused");
expectEqual(parseNmiWebhookSignature("garbage"), null, "an unparseable header is refused");
expectEqual(parseNmiWebhookSignature(`t=abc123,t=def456,s=${hexSignature}`), null, "a duplicated nonce is refused");
expectEqual(parseNmiWebhookSignature(`t=abc123,s=${"A".repeat(64)}`), null, "an uppercase signature is refused");
expectEqual(parseNmiWebhookSignature(`t=abc123,s=${"a".repeat(63)}`), null, "a short signature is refused");
expectEqual(parseNmiWebhookSignature(`t=${"x".repeat(129)},s=${hexSignature}`), null, "an over-long nonce is refused");
expectEqual(parseNmiWebhookSignature(`t=abc 123,s=${hexSignature}`), null, "a nonce with a space is refused");
expectEqual(parseNmiWebhookSignature(null), null, "a missing header is refused");
expectEqual(parseNmiWebhookSignature(""), null, "an empty header is refused");
expectEqual(parseNmiWebhookSignature(`t=abc123,s=${hexSignature},pad=${"x".repeat(600)}`), null, "an over-long header is refused");

const body = JSON.stringify(saleSuccessEvent());
const nonce = "9f8e7d6c5b4a";
const goodSignature = createHmac("sha256", signingKey).update(`${nonce}.${body}`, "utf8").digest("hex");
expectEqual(verifyNmiWebhookSignature(body, `t=${nonce},s=${goodSignature}`, signingKey), true, "the documented signature verifies");
expectEqual(verifyNmiWebhookSignature(body, `t=${nonce},s=${"0".repeat(64)}`, signingKey), false, "a wrong signature is refused");
expectEqual(verifyNmiWebhookSignature(`${body} `, `t=${nonce},s=${goodSignature}`, signingKey), false, "a tampered body is refused");
expectEqual(verifyNmiWebhookSignature(body, `t=000000000000,s=${goodSignature}`, signingKey), false, "the nonce is part of the signature");
expectEqual(verifyNmiWebhookSignature(body, `t=${nonce},s=${goodSignature}`, "another-key"), false, "another signing key is refused");
expectEqual(verifyNmiWebhookSignature(body, `t=${nonce},s=${goodSignature}`, ""), false, "an empty signing key is refused");
expectEqual(verifyNmiWebhookSignature("", `t=${nonce},s=${goodSignature}`, signingKey), false, "an empty body is refused");
expectEqual(verifyNmiWebhookSignature("x".repeat(1_048_577), `t=${nonce},s=${goodSignature}`, signingKey), false, "an oversized body is refused");
expectEqual(verifyNmiWebhookSignature(body, null, signingKey), false, "a delivery without a header is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 10: webhook ingestion
 * --------------------------------------------------------------------------------------------- */

const lookup = {
  findByProviderSubmerchantId: (id: string): { companyId: string } | null =>
    id === merchantId ? { companyId: "company-1" } : null,
};

const webhookAudits: NmiProvisionAuditEntry[] = [];
const eventStore = new InMemoryNmiWebhookEventStore();
const webhookOptions: NmiWebhookOptions = {
  signingKey,
  eventStore,
  lookup,
  occurredAtEpochMs: 2_000,
  recordAudit: (entry: NmiProvisionAuditEntry) => webhookAudits.push(entry),
};

const processed = receiveNmiWebhook(signedDeliveryOf(saleSuccessEvent()), webhookOptions);
expectEqual(processed.status, "processed", "a signed transaction success is processed");
expectEqual(processed.normalized?.eventType, "submerchant.verified", "a successful transaction verifies the sub-merchant");
expectEqual(processed.normalized?.companyId, "company-1", "the event is resolved to the platform company");
expectEqual(processed.normalized?.providerSubmerchantId, merchantId, "the event keeps the gateway merchant id");
expectEqual(processed.event?.status, "processed", "the stored event is processed");
expectEqual(processed.event?.signatureOk, true, "the stored event records the verified signature");
expectEqual(processed.event?.companyId, "company-1", "the stored event names its merchant");
expectEqual(processed.event?.processedAtEpochMs, 2_000, "the stored event records the processing instant");
expectEqual(processed.event?.payloadHash.length, 64, "the stored event keeps the payload hash, not the payload");
expectEqual(processed.providerEventType, "transaction.sale.success", "the provider event name is reported");
expectEqual(webhookAudits.length, 1, "a processed delivery is audited");
expectEqual(JSON.stringify(processed).includes(signingKey), false, "the delivery outcome leaks no signing key");
expectEqual(JSON.stringify(processed.event).includes("8584364761"), false, "the stored event keeps no payload content");

const duplicate = receiveNmiWebhook(signedDeliveryOf(saleSuccessEvent()), webhookOptions);
expectEqual(duplicate.status, "duplicate", "a redelivered event is a duplicate");
expectEqual(duplicate.event?.status, "processed", "the duplicate is answered with the stored event");
expectEqual(webhookAudits.length, 1, "a duplicate is not audited again");
expectEqual(eventStore.findByExternalEventId("test", "2aa1bb86-c790-4231-a46e-7cc544a8dc5c")?.status, "processed", "the first delivery stands");

const settlementEvent = {
  event_id: "11750910-bd03-4f9a-871a-786203df177f",
  event_type: "settlement.batch.complete",
  event_body: {
    batch_id: "12345678",
    count: 4,
    amount: "402.81",
    merchant: { id: merchantId, name: "Test Account" },
    processor: { id: "ccprocessor", name: "CC Processor", type: "cc" },
  },
};
const settlement = receiveNmiWebhook(signedDeliveryOf(settlementEvent), webhookOptions);
expectEqual(settlement.status, "processed", "a completed settlement batch is processed");
expectEqual(settlement.normalized?.eventType, "submerchant.verified", "a completed settlement verifies the sub-merchant");

const failureEvent = {
  event_id: "a4807d52-4e40-4e93-92e2-b6d2dad3ddd9",
  event_type: "transaction.sale.failure",
  event_body: { merchant: { id: merchantId }, features: { is_test_mode: true }, condition: "failed" },
};
const failure = receiveNmiWebhook(signedDeliveryOf(failureEvent), webhookOptions);
expectEqual(failure.status, "ignored", "a failed transaction is not provisioning evidence");
expectEqual(failure.normalized, null, "an ignored event normalises to nothing");
expectEqual(failure.event?.status, "ignored", "an ignored delivery is recorded");

const undocumentedEvent = {
  event_id: "0b7c6d55-1111-4222-8333-944455556666",
  event_type: "merchant.status.changed",
  event_body: { merchant: { id: merchantId } },
};
expectEqual(receiveNmiWebhook(signedDeliveryOf(undocumentedEvent), webhookOptions).status, "ignored", "an unmapped event type is ignored");

const otherMerchantEvent = saleSuccessEvent({ merchant: "999999" });
const unknownMerchant = receiveNmiWebhook(
  signedDeliveryOf({ ...otherMerchantEvent, event_id: "1c2d3e4f-1111-4222-8333-944455556666" }),
  webhookOptions,
);
expectEqual(unknownMerchant.status, "ignored", "an event about a merchant the platform never boarded is ignored");
expectEqual(unknownMerchant.event?.companyId, null, "an unmatched merchant leaves the company empty");

const modeMismatch = receiveNmiWebhook(
  signedDeliveryOf({ ...saleSuccessEvent(), event_id: "2c2d3e4f-1111-4222-8333-944455556666" }, "live"),
  webhookOptions,
);
expectEqual(modeMismatch.status, "ignored", "a sandbox event delivered to the live endpoint is ignored");
expectEqual(modeMismatch.reason.includes("test-mode"), true, "the mode refusal names the test-mode flag");

const noMerchantEvent = {
  event_id: "3c2d3e4f-1111-4222-8333-944455556666",
  event_type: "transaction.sale.success",
  event_body: { features: { is_test_mode: true } },
};
expectEqual(receiveNmiWebhook(signedDeliveryOf(noMerchantEvent), webhookOptions).status, "ignored", "an event without a merchant is ignored");

const badSignatureDelivery = {
  rawBody: JSON.stringify({ ...saleSuccessEvent(), event_id: "4c2d3e4f-1111-4222-8333-944455556666" }),
  signatureHeader: `t=${nonce},s=${"0".repeat(64)}`,
  mode: "test" as const,
};
const rejectedDelivery = receiveNmiWebhook(badSignatureDelivery, webhookOptions);
expectEqual(rejectedDelivery.status, "rejected", "a delivery that does not verify is rejected");
expectEqual(rejectedDelivery.event?.status, "rejected", "the rejected delivery is stored for the audit trail");
expectEqual(rejectedDelivery.event?.signatureOk, false, "the rejected delivery records the failed signature");
expectEqual(rejectedDelivery.normalized, null, "a rejected delivery normalises to nothing");
expectEqual(
  eventStore.findByExternalEventId("test", "4c2d3e4f-1111-4222-8333-944455556666")?.status,
  "rejected",
  "the rejected row is stored, never processed",
);

const replayOfRejected = receiveNmiWebhook(
  signedDeliveryOf({ ...saleSuccessEvent(), event_id: "4c2d3e4f-1111-4222-8333-944455556666" }),
  webhookOptions,
);
expectEqual(replayOfRejected.status, "duplicate", "a rejected event id cannot be replayed into a processed event");

const forgedKnownEvent = receiveNmiWebhook(
  { rawBody: JSON.stringify(saleSuccessEvent()), signatureHeader: `t=${nonce},s=${"1".repeat(64)}`, mode: "test" },
  webhookOptions,
);
expectEqual(forgedKnownEvent.status, "rejected", "a forged body naming a known event is rejected, not deduplicated");
expectEqual(eventStore.findByExternalEventId("test", "2aa1bb86-c790-4231-a46e-7cc544a8dc5c")?.status, "processed", "a forged body changes no stored outcome");

const tamperedDelivery = receiveNmiWebhook(
  { rawBody: `${JSON.stringify(saleSuccessEvent())} `, signatureHeader: `t=${nonce},s=${goodSignature}`, mode: "test" },
  webhookOptions,
);
expectEqual(tamperedDelivery.status, "rejected", "a tampered body fails verification");

const malformedSigned = receiveNmiWebhook(signedDeliveryOf("not json at all"), webhookOptions);
expectEqual(malformedSigned.status, "failed", "a signed but unreadable body is a processing failure");
expectEqual(malformedSigned.event, null, "an unreadable body stores no event");

const malformedUnsigned = receiveNmiWebhook(
  { rawBody: "not json at all", signatureHeader: null, mode: "test" },
  webhookOptions,
);
expectEqual(malformedUnsigned.status, "rejected", "an unreadable unsigned body is rejected");

expectEqual(
  receiveNmiWebhook(signedDeliveryOf({ event_type: "transaction.sale.success", event_body: {} }), webhookOptions).status,
  "failed",
  "an envelope without an event id is a failure",
);
expectEqual(
  receiveNmiWebhook(signedDeliveryOf({ event_id: "abc", event_type: "Sale Success!", event_body: {} }), webhookOptions).status,
  "failed",
  "an envelope with an invalid event type is a failure",
);
expectEqual(
  receiveNmiWebhook(signedDeliveryOf({ event_id: "5c2d3e4f-1111-4222-8333-944455556666", event_type: "transaction.sale.success", event_body: [] }), webhookOptions).status,
  "failed",
  "an envelope whose body is not an object is a failure",
);
expectEqual(
  receiveNmiWebhook(
    { rawBody: "x".repeat(1_048_577), signatureHeader: `t=${nonce},s=${goodSignature}`, mode: "test" },
    webhookOptions,
  ).status,
  "rejected",
  "an oversized delivery is refused",
);

const invalidModeOutcome = receiveNmiWebhook(
  { rawBody: body, signatureHeader: `t=${nonce},s=${goodSignature}`, mode: "sandbox" as unknown as NmiProvisionMode },
  webhookOptions,
);
expectEqual(invalidModeOutcome.status, "rejected", "an invalid endpoint mode is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 11: the provisioning event mapping and the webhook store
 * --------------------------------------------------------------------------------------------- */

for (const providerEventType of Object.keys(NMI_PROVISION_EVENT_TYPES)) {
  expect(NMI_DOCUMENTED_WEBHOOK_EVENTS.includes(providerEventType), `the mapping key ${providerEventType} is a documented event`);
  expectEqual(nmiProvisionEventOf(providerEventType), "submerchant.verified", `the mapping key ${providerEventType} verifies the sub-merchant`);
}
expectEqual(nmiProvisionEventOf("settlement.batch.failure"), null, "a failed settlement is not provisioning evidence");
expectEqual(nmiProvisionEventOf("chargeback.batch.complete"), null, "a chargeback batch is not provisioning evidence");
expectEqual(nmiProvisionEventOf("recurring.subscription.add"), null, "a recurring event is not provisioning evidence");
expectEqual(nmiProvisionEventOf("acu.summary.closedaccount"), null, "an ACU summary is not provisioning evidence");
expectEqual(nmiProvisionEventOf("transaction.check.status.settle"), null, "a check status event is not provisioning evidence");
expectEqual(Object.keys(NMI_PROVISION_EVENT_TYPES).length, 8, "the provisioning mapping covers the documented evidence");

const eventStoreRules = new InMemoryNmiWebhookEventStore();
const eventSeed = {
  id: "00000000-0000-4000-8000-0000000000aa",
  companyId: null,
  mode: "test" as const,
  externalEventId: "event-1",
  eventType: "transaction.sale.success",
  payloadHash: nmiWebhookPayloadHash("{}"),
  signatureOk: true,
  receivedAtEpochMs: 1,
  status: "pending" as const,
  processedAtEpochMs: null,
  failureDetail: null,
  version: 1,
};
eventStoreRules.insert(eventSeed);
expectEqual(eventStoreRules.findByExternalEventId("test", "event-1")?.id, eventSeed.id, "a delivery is readable by event id");
expectEqual(eventStoreRules.findByExternalEventId("live", "event-1"), null, "a delivery is scoped to its mode");
expectThrows(() => eventStoreRules.insert(eventSeed), "a duplicate delivery is refused");
const processedEvent = { ...eventSeed, companyId: "company-1", status: "processed" as const, processedAtEpochMs: 5, version: 2 };
expectEqual(eventStoreRules.save(processedEvent, 1), true, "a delivery moves forward to processed");
expectEqual(eventStoreRules.save(processedEvent, 1), false, "a stale delivery write is refused");
expectEqual(eventStoreRules.save({ ...processedEvent, status: "pending" as const, version: 3 }, 2), false, "a delivery never returns to pending");
expectEqual(eventStoreRules.save({ ...processedEvent, status: "ignored" as const, version: 3 }, 2), false, "a finished delivery keeps its outcome");
expectEqual(eventStoreRules.save({ ...processedEvent, eventType: "transaction.auth.success", version: 3 }, 2), false, "a delivery keeps its event type");
expectEqual(eventStoreRules.save({ ...processedEvent, payloadHash: "0".repeat(64), version: 3 }, 2), false, "a delivery keeps its payload hash");
expectEqual(eventStoreRules.save({ ...processedEvent, version: 9 }, 2), false, "a delivery version jump is refused");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments NMI sub-merchant gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments NMI sub-merchant gate passed: ${checks} checks (documented create merchant request, idempotent provisioning, signed envelope, replay defence, provisioning mapping)\n`,
);

/** Await a rejected promise and count it as a passed check. */
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
