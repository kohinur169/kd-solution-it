// path: lib/payments/adapters/airwallex-accounts-verify.ts

/**
 * The gate for STEP 167: creating an Airwallex connected account for a KYC-approved company, submitting it for
 * verification, reading what Airwallex says about it, and turning that into readiness.
 *
 * A check script, not a test file. It seals a real configuration with STEP 166's code, drives a recording
 * transport through the documented answers, and fails naming every check that did not hold. No network call is
 * made and no real credential exists.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  airwallexAccountFetchTransport,
  airwallexAccountIdOf,
  airwallexAccountMessageOf,
  airwallexAccountPath,
  airwallexAccountReadinessOf,
  airwallexAccountStatusOf,
  airwallexAccountSubmitPath,
  isAirwallexAccountPath,
  parseAirwallexAccountCreateAnswer,
  parseAirwallexAccountStatusAnswer,
  provisionAirwallexAccount,
  InMemoryAirwallexAccountProvisionStore,
  submitAirwallexAccount,
  syncAirwallexAccountVerification,
  AIRWALLEX_ACCOUNT_ALLOWED_PATH_PATTERNS,
  AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES,
  AIRWALLEX_ACCOUNT_READ_PATH_PATTERN,
  AIRWALLEX_ACCOUNT_SUBMIT_PATH_PATTERN,
  AIRWALLEX_ACCOUNT_SUBMIT_SUFFIX,
  AIRWALLEX_ACCOUNT_TEXT_MAXIMUM_LENGTH,
  AIRWALLEX_ACCOUNT_TIMEOUT_MS,
  AIRWALLEX_ACCOUNTS_CREATE_PATH,
  AIRWALLEX_KYC_APPROVED_STATUS,
  AIRWALLEX_SUBMITTABLE_STATUSES,
  AIRWALLEX_VERIFICATION_STALE_AFTER_SECONDS,
  type AirwallexAccountAuditEntry,
  type AirwallexAccountCall,
  type AirwallexAccountProvision,
  type AirwallexAccountTransport,
  type ProvisionAirwallexAccountInput,
} from "./airwallex-accounts.ts";
import {
  activateAirwallexConfig,
  configureAirwallexKeys,
  InMemoryAirwallexConfigStore,
  InMemoryAirwallexTokenCache,
  testAirwallexConnection,
  AIRWALLEX_LOGIN_PATH,
} from "./airwallex-client.ts";
import {
  AIRWALLEX_ACCOUNT_STATUSES,
  AIRWALLEX_ENDPOINTS,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_DEFAULT_API_VERSION,
  buildAirwallexConnectedAccountBody,
  type AirwallexAccountRequest,
} from "./airwallex.ts";

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
  checks += 1;
  try {
    action();
  } catch {
    return;
  }
  failures.push(description);
}

async function expectRejects(action: () => Promise<unknown>, description: string): Promise<void> {
  checks += 1;
  try {
    await action();
  } catch {
    return;
  }
  failures.push(description);
}

function asText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

/* ---- fixtures ---- */

const NOW = 1_760_000_000_000;
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const accountId = "acct_A1b2C3d4E5f6G7h8I9j0";
const otherAccountId = "acct_Z9y8X7w6V5u4T3s2R1q0";
const accessToken = "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MjQwMDAwMDB9.c2lnbmF0dXJlLXZhbHVl";
const clientId = "cid_AbCd1234EfGh5678";
const apiKey = "key_ZzYyXx9876WwVvUuTtSsRrQq";
const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };

const loginAnswer = JSON.stringify({ token: accessToken, expires_at: "2026-01-01T12:30:00+0000" });
const balancesAnswer = JSON.stringify([{ currency: "USD", available_amount: 1 }]);

const individualRequest: AirwallexAccountRequest = {
  kind: "individual",
  email: "owner@example.com",
  firstName: "Ayesha",
  lastName: "Rahman",
  countryCode: "BD",
  agreedToDataUsage: true,
  agreedToTermsAndConditions: true,
};

const businessRequest: AirwallexAccountRequest = {
  kind: "business",
  email: "finance@example.com",
  businessName: "Kd Solution",
  countryCode: "BD",
  agreedToDataUsage: true,
  agreedToTermsAndConditions: true,
};

const kyc = { submissionId: "kyc-submission-1", companyId, status: AIRWALLEX_KYC_APPROVED_STATUS, decidedAtEpochMs: NOW };

const input: ProvisionAirwallexAccountInput = { companyId, request: individualRequest, kyc };

/** A recording login transport: STEP 166's token, from the documented login path. */
function loginTransport(): {
  readonly calls: string[];
  readonly transport: (call: { readonly path: string }) => Promise<{ status: number; body: string }>;
} {
  const calls: string[] = [];
  return {
    calls,
    transport: async (call) => {
      calls.push(call.path);
      return call.path === AIRWALLEX_LOGIN_PATH ? { status: 201, body: loginAnswer } : { status: 200, body: balancesAnswer };
    },
  };
}

/** A recording account transport: the answer the test wants, per call, plus everything the file sent. */
function accountTransport(
  answerFor: (call: AirwallexAccountCall) => { readonly status: number; readonly body: string },
): { readonly calls: AirwallexAccountCall[]; readonly transport: AirwallexAccountTransport } {
  const calls: AirwallexAccountCall[] = [];
  return {
    calls,
    transport: async (call) => {
      calls.push(call);
      return answerFor(call);
    },
  };
}

/** An active, proven Airwallex configuration for one company, built with STEP 166's own functions. */
async function activeCompany(targetCompanyId: string): Promise<{
  readonly configStore: InMemoryAirwallexConfigStore;
  readonly tokenCache: InMemoryAirwallexTokenCache;
  readonly configId: string;
}> {
  const configStore = new InMemoryAirwallexConfigStore();
  const tokenCache = new InMemoryAirwallexTokenCache();
  const configured = configureAirwallexKeys(
    { companyId: targetCompanyId, environment: "sandbox", clientId, apiKey, webhookSecret: null },
    { store: configStore, keyring, occurredAtEpochMs: NOW },
  );
  if (configured.status !== "configured") throw new Error("the fixture configuration failed");
  // The connection test is STEP 166's, so its transport answers the two paths that file owns.
  await testAirwallexConnection(configured.config.id, {
    store: configStore,
    keyring,
    occurredAtEpochMs: NOW,
    tokenCache,
    transport: async (call) =>
      call.path === AIRWALLEX_LOGIN_PATH ? { status: 201, body: loginAnswer } : { status: 200, body: balancesAnswer },
  });
  const activated = activateAirwallexConfig(configured.config.id, { store: configStore, occurredAtEpochMs: NOW });
  if (activated.status !== "activated") throw new Error("the fixture configuration was not activated");
  tokenCache.clear(configured.config.id);
  return { configStore, tokenCache, configId: configured.config.id };
}

/** Everything a call needs, for one company and one transport. */
async function optionsFor(
  targetCompanyId: string,
  answerFor: (call: AirwallexAccountCall) => { readonly status: number; readonly body: string },
  audits: string[] = [],
): Promise<{
  readonly options: Parameters<typeof provisionAirwallexAccount>[1];
  readonly calls: AirwallexAccountCall[];
  readonly provisionStore: InMemoryAirwallexAccountProvisionStore;
  readonly loginCalls: string[];
}> {
  const company = await activeCompany(targetCompanyId);
  const account = accountTransport(answerFor);
  const login = loginTransport();
  const provisionStore = new InMemoryAirwallexAccountProvisionStore();
  return {
    options: {
      configStore: company.configStore,
      provisionStore,
      keyring,
      tokenCache: company.tokenCache,
      occurredAtEpochMs: NOW,
      transport: account.transport,
      loginTransport: login.transport,
      recordAudit: (entry: AirwallexAccountAuditEntry) => audits.push(`${entry.action}:${entry.outcome}`),
    },
    calls: account.calls,
    provisionStore,
    loginCalls: login.calls,
  };
}

const createdAnswer = JSON.stringify({ id: accountId, status: "CREATED" });

/* ---- the documented surface ---- */

expectEqual(AIRWALLEX_ACCOUNTS_CREATE_PATH, AIRWALLEX_ENDPOINTS["accountsCreate"], "the create path is the record's own");
expectEqual(airwallexAccountPath(accountId), `/api/v1/accounts/${accountId}`, "the read path is the documented shape");
expectEqual(airwallexAccountSubmitPath(accountId), `/api/v1/accounts/${accountId}/submit`, "the submit path is the documented shape");
expectEqual(AIRWALLEX_ACCOUNT_SUBMIT_SUFFIX, "/submit", "the submit suffix is the documented one");
expect(AIRWALLEX_ACCOUNT_SUBMIT_PATH_PATTERN.test(airwallexAccountSubmitPath(accountId)), "the submit path matches its pattern");
expect(AIRWALLEX_ACCOUNT_READ_PATH_PATTERN.test(airwallexAccountPath(accountId)), "the read path matches its pattern");
expectEqual(AIRWALLEX_ACCOUNT_ALLOWED_PATH_PATTERNS.length, 3, "three paths may be called: create, read, submit");
expect(Object.isFrozen(AIRWALLEX_ACCOUNT_ALLOWED_PATH_PATTERNS), "the allowlist is frozen");
expect(isAirwallexAccountPath(AIRWALLEX_ACCOUNTS_CREATE_PATH), "create is allowlisted");
expect(isAirwallexAccountPath(airwallexAccountPath(accountId)), "a read is allowlisted");
expect(isAirwallexAccountPath(airwallexAccountSubmitPath(accountId)), "a submit is allowlisted");
expect(isAirwallexAccountPath("/api/v1/accounts/update") === false, "the update path is not allowlisted");
expect(isAirwallexAccountPath("/api/v1/authentication/login") === false, "the login path belongs to STEP 166");
expect(isAirwallexAccountPath("/api/v1/accounts/create/") === false, "a trailing slash is not the documented path");
expect(isAirwallexAccountPath("/api/v2/accounts/create") === false, "another version prefix is not allowlisted");
expect(isAirwallexAccountPath("/api/v1/accounts/short") === false, "a non-account id is not allowlisted");
expect(isAirwallexAccountPath(`${airwallexAccountPath(accountId)}/close`) === false, "a path beyond the id is not allowlisted");
expectThrows(() => airwallexAccountPath("acct_short"), "a short id is refused when a path is built");
expectThrows(() => airwallexAccountPath("cus_123456789"), "another provider's id is refused");
expectThrows(() => airwallexAccountSubmitPath(""), "an empty id is refused");
expectEqual(AIRWALLEX_ACCOUNT_TIMEOUT_MS, 20_000, "the account call timeout is bounded");
expectEqual(AIRWALLEX_ACCOUNT_TEXT_MAXIMUM_LENGTH, 200, "the provider text is bounded");
expectEqual(AIRWALLEX_KYC_APPROVED_STATUS, "approved", "only one KYC status authorizes an account");
expectEqual(AIRWALLEX_VERIFICATION_STALE_AFTER_SECONDS, 86_400, "a read is current for one day");
expect(Object.isFrozen(AIRWALLEX_SUBMITTABLE_STATUSES), "the submittable statuses are frozen");
expectEqual(AIRWALLEX_SUBMITTABLE_STATUSES.join(","), "CREATED,ACTION_REQUIRED", "only a created or RFI account is submitted");
expect(AIRWALLEX_ACCOUNT_STATUSES.includes("ACTIVE"), "the documented statuses include ACTIVE");

/* ---- reading answers ---- */

{
  const created = parseAirwallexAccountCreateAnswer(200, createdAnswer);
  expectEqual(created.outcome, "created", "a 2XX with an account id creates");
  expect(created.outcome === "created" && created.accountId === accountId, "the account id is read");
  expect(created.outcome === "created" && created.accountStatus === "CREATED", "the documented status is read");
}
{
  const created = parseAirwallexAccountCreateAnswer(201, JSON.stringify({ id: accountId }));
  expect(created.outcome === "created" && created.accountStatus === null, "a status the answer omits is null, not guessed");
}
{
  const unrecordedStatus = parseAirwallexAccountCreateAnswer(200, JSON.stringify({ id: accountId, status: "IN_REVIEW" }));
  expectEqual(unrecordedStatus.outcome, "created", "an unrecorded status still proves the id");
  expect(unrecordedStatus.outcome === "created" && unrecordedStatus.accountStatus === null, "an unrecorded status is not stored as documented");
}
expectEqual(
  parseAirwallexAccountCreateAnswer(200, JSON.stringify({ id: "acct_short" })).outcome,
  "unknown",
  "a 2XX naming an invalid id is unknown",
);
expectEqual(parseAirwallexAccountCreateAnswer(200, JSON.stringify({ status: "CREATED" })).outcome, "unknown", "a 2XX naming no id is unknown");
expectEqual(parseAirwallexAccountCreateAnswer(201, "not json").outcome, "unknown", "an unparsable 2XX is unknown");

const rejected = parseAirwallexAccountCreateAnswer(400, JSON.stringify({ code: "field_required", message: "primary_contact is required" }));
expectEqual(rejected.outcome, "rejected", "a 400 is a rejection");
expect(rejected.outcome === "rejected" && rejected.code === "field_required", "the documented field_required code is kept");
const invalidArgument = parseAirwallexAccountCreateAnswer(400, JSON.stringify({ code: "invalid_argument" }));
expect(
  invalidArgument.outcome === "rejected" && invalidArgument.code === "invalid_argument",
  "the documented invalid_argument code is kept",
);
expectEqual(parseAirwallexAccountCreateAnswer(409, "{}").outcome, "rejected", "a 409 is a rejection");
expectEqual(parseAirwallexAccountCreateAnswer(422, "{}").outcome, "rejected", "a 422 is a rejection");
expectEqual(parseAirwallexAccountCreateAnswer(401, "{}").outcome, "failed", "a 401 is a failure, so nothing was created");
expectEqual(parseAirwallexAccountCreateAnswer(403, "{}").outcome, "failed", "a 403 is a failure");
expectEqual(parseAirwallexAccountCreateAnswer(302, "").outcome, "failed", "a redirect is a failure");
expectEqual(parseAirwallexAccountCreateAnswer(429, "{}").outcome, "unknown", "a rate limit is unknown");
expectEqual(parseAirwallexAccountCreateAnswer(500, "{}").outcome, "unknown", "a 5XX is unknown");
expectEqual(parseAirwallexAccountCreateAnswer(408, "{}").outcome, "unknown", "a timeout status is unknown");

expectEqual(parseAirwallexAccountStatusAnswer(200, createdAnswer).outcome, "answered", "a 2XX with a documented status answers");
const answered = parseAirwallexAccountStatusAnswer(200, JSON.stringify({ status: "ACTIVE" }));
expect(answered.outcome === "answered" && answered.accountStatus === "ACTIVE", "the status is read");
expectEqual(parseAirwallexAccountStatusAnswer(200, JSON.stringify({ status: "IN_REVIEW" })).outcome, "unknown", "an unrecorded status is not stored");
expectEqual(parseAirwallexAccountStatusAnswer(200, "{}").outcome, "unknown", "a body with no status is unknown");
expectEqual(parseAirwallexAccountStatusAnswer(404, "{}").outcome, "not_found", "a 404 means the id is not at Airwallex");
expectEqual(parseAirwallexAccountStatusAnswer(400, "{}").outcome, "refused", "a 400 is a refusal");
expectEqual(parseAirwallexAccountStatusAnswer(401, "{}").outcome, "refused", "a 401 is a refusal");
expectEqual(parseAirwallexAccountStatusAnswer(403, "{}").outcome, "refused", "a 403 is a refusal");
expectEqual(parseAirwallexAccountStatusAnswer(429, "{}").outcome, "unknown", "a rate limit is unknown");
expectEqual(parseAirwallexAccountStatusAnswer(503, "{}").outcome, "unknown", "a 5XX is unknown");
expectEqual(parseAirwallexAccountStatusAnswer(302, "").outcome, "unknown", "a redirect is unknown");
expectEqual(airwallexAccountStatusOf(JSON.stringify({ status: "active" })), "ACTIVE", "a lower-case status is normalised");
expectEqual(airwallexAccountStatusOf(JSON.stringify({ status: "WHAT" })), null, "an unknown status reads null");
expectEqual(airwallexAccountIdOf(createdAnswer), accountId, "the id reader reads the documented id");
expectEqual(airwallexAccountIdOf(JSON.stringify({ id: "acct_1" })), null, "a too-short id is refused");
expectEqual(airwallexAccountMessageOf(JSON.stringify({ message: "  bad  request  " })), "bad request", "the message is sanitised");
expectEqual(airwallexAccountMessageOf("not json"), "", "an unparsable body has no message");
expect(asText(buildAirwallexConnectedAccountBody(individualRequest)).includes("account_details"), "the body builder carries account_details");
expect(asText(buildAirwallexConnectedAccountBody(businessRequest)).includes("business_details"), "a business body carries business_details");
expectEqual(
  asText(buildAirwallexConnectedAccountBody(businessRequest)).includes("legal_entity_type"),
  false,
  "the business body builder invents no legal entity type",
);

/* ---- the transport refuses without calling ---- */

await expectRejects(
  () =>
    airwallexAccountFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: "/api/v1/accounts/update",
      accessToken,
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
      body: "{}",
    }),
  "a path outside the allowlist is refused before any call",
);
await expectRejects(
  () =>
    airwallexAccountFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_ACCOUNTS_CREATE_PATH,
      accessToken: " ",
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
      body: "{}",
    }),
  "a call without a token is refused before any call",
);
await expectRejects(
  () =>
    airwallexAccountFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_ACCOUNTS_CREATE_PATH,
      accessToken,
      apiVersion: "",
      body: "{}",
    }),
  "a call without a version is refused before any call",
);
await expectRejects(
  () =>
    airwallexAccountFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_ACCOUNTS_CREATE_PATH,
      accessToken,
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
      body: null,
    }),
  "a POST without a body is refused before any call",
);
await expectRejects(
  () =>
    airwallexAccountFetchTransport({
      method: "GET",
      environment: "sandbox",
      path: airwallexAccountPath(accountId),
      accessToken,
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
      body: "{}",
    }),
  "a read with a body is refused before any call",
);

/* ---- the store's invariants ---- */

function pendingProvision(overrides: Partial<AirwallexAccountProvision> = {}): AirwallexAccountProvision {
  return {
    id: "0a1b2c3d-0000-4000-8000-000000000001",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId,
    environment: "sandbox",
    kycSubmissionId: "kyc-submission-1",
    accountKind: "individual",
    accountId: null,
    attemptStatus: "pending",
    accountStatus: null,
    onboardingState: null,
    submittedAtEpochMs: null,
    verificationCheckedAtEpochMs: null,
    verificationCheckCount: 0,
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
    ...overrides,
  };
}

{
  const store = new InMemoryAirwallexAccountProvisionStore();
  const base = pendingProvision();
  store.insert(base);
  expectThrows(() => store.insert(base), "the store refuses a duplicate id");
  expectThrows(
    () => store.insert(pendingProvision({ id: "0a1b2c3d-0000-4000-8000-000000000002" })),
    "the store refuses a second attempt for one company",
  );
  expectThrows(
    () => store.insert(pendingProvision({ id: "0a1b2c3d-0000-4000-8000-000000000003", companyId: otherCompanyId, accountId })),
    "the store refuses a new row that already carries an id",
  );
  expectThrows(
    () =>
      store.insert(
        pendingProvision({
          id: "0a1b2c3d-0000-4000-8000-000000000004",
          companyId: otherCompanyId,
          attemptStatus: "created",
          accountId,
        }),
      ),
    "the store refuses a row that starts created",
  );
  expectEqual(store.findByCompany(companyId)?.id, base.id, "the row is found by company");
  expectEqual(store.findByAccountId(accountId), null, "no row carries an id yet");
  expectEqual(store.save({ ...base, version: 2 }, 9), false, "a wrong expected version is refused");
  expectEqual(store.save({ ...base, version: 3 }, 1), false, "a version jump is refused");
  expectEqual(store.save({ ...base, companyId: otherCompanyId, version: 2 }, 1), false, "the company never changes");
  expectEqual(store.save({ ...base, environment: "live", version: 2 }, 1), false, "the mode never changes");
  expectEqual(store.save({ ...base, kycSubmissionId: "other", version: 2 }, 1), false, "the authorizing submission never changes");
  expectEqual(store.save({ ...base, accountKind: "business", version: 2 }, 1), false, "the account kind never changes");
  expectEqual(store.save({ ...base, providerKey: "stripe" as typeof AIRWALLEX_PROVIDER_KEY, version: 2 }, 1), false, "the provider never changes");
  expectEqual(store.save({ ...base, attemptStatus: "created", version: 2 }, 1), false, "created requires an account id");

  const created = { ...base, attemptStatus: "created" as const, accountId, accountStatus: "CREATED", onboardingState: "waiting" as const };
  expectEqual(store.save({ ...created, version: 2 }, 1), true, "a created row with an id is stored");
  expectEqual(store.findByAccountId(accountId)?.id, base.id, "the row is found by account id");
  expectEqual(store.save({ ...created, accountId: otherAccountId, version: 3 }, 2), false, "the account id never changes");
  expectEqual(store.save({ ...created, attemptStatus: "pending", version: 3 }, 2), false, "a created row never leaves created");
  expectEqual(store.save({ ...created, accountStatus: "IN_REVIEW", version: 3 }, 2), false, "an undocumented status is refused");
  expectEqual(
    store.save({ ...created, accountStatus: "ACTIVE", onboardingState: "waiting", version: 3 }, 2),
    false,
    "an onboarding state that contradicts the status is refused",
  );
  expectEqual(
    store.save({ ...created, submittedAtEpochMs: NOW + 1, version: 3 }, 2),
    true,
    "a submit time is recorded once",
  );
  expectEqual(
    store.save({ ...created, submittedAtEpochMs: NOW + 2, verificationCheckCount: 1, version: 4 }, 3),
    false,
    "a submit time never moves once written",
  );
  expectEqual(
    store.save({ ...created, submittedAtEpochMs: NOW + 1, verificationCheckCount: 1, version: 4 }, 3),
    true,
    "the check counter climbs",
  );
  expectEqual(
    store.save({ ...created, submittedAtEpochMs: NOW + 1, verificationCheckCount: 0, version: 5 }, 4),
    false,
    "the check counter never falls",
  );
}

/* ---- creating the account ---- */

{
  const audits: string[] = [];
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }), audits);
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "created", "an approved company with a valid request creates the account");
  if (result.status !== "created") throw new Error(`unexpected: ${JSON.stringify(result)}`);
  expectEqual(result.provision.accountId, accountId, "the id is recorded");
  expectEqual(result.provision.providerKey, AIRWALLEX_PROVIDER_KEY, "the record says which provider owns the id");
  expectEqual(result.provision.attemptStatus, "created", "the attempt is created");
  expectEqual(result.provision.accountStatus, "CREATED", "the documented status is recorded");
  expectEqual(result.provision.onboardingState, "waiting", "the status maps to waiting");
  expectEqual(result.provision.kycSubmissionId, kyc.submissionId, "the authorizing submission is recorded");
  expectEqual(result.provision.accountKind, "individual", "the account kind is recorded");
  expectEqual(result.provision.environment, "sandbox", "the mode comes from the active configuration");
  expectEqual(result.provision.version, 2, "the attempt advanced once");
  expectEqual(harness.calls.length, 1, "exactly one account call is made");
  expectEqual(harness.calls[0]?.method, "POST", "the create is a POST");
  expectEqual(harness.calls[0]?.path, AIRWALLEX_ACCOUNTS_CREATE_PATH, "the create path is the documented one");
  expectEqual(harness.calls[0]?.accessToken, accessToken, "the token STEP 166 issued is sent");
  expectEqual(harness.calls[0]?.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the pinned version is sent");
  expectEqual(harness.calls[0]?.body === null, false, "the create carries a body");
  expectEqual(harness.loginCalls.length, 1, "one login is made to obtain the token");
  expectEqual(harness.loginCalls[0], AIRWALLEX_LOGIN_PATH, "the login is STEP 166's documented path");
  expectEqual(audits.join(","), "connected_account.created:CREATED", "one audit entry names the documented status");

  const row = harness.provisionStore.findByCompany(companyId);
  expectEqual(row?.accountId, accountId, "the store holds the id");
  expect(asText(row).includes(accessToken) === false, "the record never carries the token");
  expectEqual(row?.requiresReconciliation, false, "a created account needs no reconciliation");

  const replay = await provisionAirwallexAccount(input, harness.options);
  expectEqual(replay.status, "already_created", "a replay answers already_created");
  expectEqual(harness.calls.length, 1, "a replay makes no second call");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const result = await provisionAirwallexAccount({ ...input, request: businessRequest }, harness.options);
  expectEqual(result.status, "created", "a business request creates an account");
  if (result.status !== "created") throw new Error("unreachable");
  expectEqual(result.provision.accountKind, "business", "the business kind is recorded");

  const body = JSON.parse(harness.calls[0]?.body ?? "{}") as Record<string, unknown>;
  const details = body["account_details"] as Record<string, unknown>;
  expectEqual(Object.keys(details).join(","), "business_details", "a business body carries only business_details");
  expectEqual(
    asText(details).includes("legal_entity_type"),
    false,
    "a business body carries no legal entity type, because the business enum was never observed",
  );
  const agreements = body["customer_agreements"] as Record<string, unknown>;
  expectEqual(agreements["agreed_to_data_usage"], true, "the data-usage agreement is sent as true");
  expectEqual(agreements["agreed_to_terms_and_conditions"], true, "the terms agreement is sent as true");
  expectEqual((body["primary_contact"] as Record<string, unknown>)["email"], businessRequest.email, "the primary contact is sent");
  expectEqual(asText(body).includes("card"), false, "no card field is sent");
  expectEqual(asText(body).includes("ssn"), false, "no tax identifier is sent");
  expectEqual(asText(body).includes("date_of_birth"), false, "no date of birth is sent");
  expectEqual(asText(body).includes("iban"), false, "no bank account is sent");
  expectEqual(asText(body).includes(clientId), false, "no credential is sent in the body");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const result = await provisionAirwallexAccount({ ...input, request: individualRequest }, harness.options);
  expectEqual(result.status, "created", "an individual request creates an account");
  const body = JSON.parse(harness.calls[0]?.body ?? "{}") as Record<string, unknown>;
  const details = body["account_details"] as Record<string, unknown>;
  expectEqual(details["legal_entity_type"], "INDIVIDUAL", "an individual body carries the observed legal entity type");
  expectEqual(
    (details["individual_details"] as Record<string, unknown>)["first_name"],
    individualRequest.kind === "individual" ? individualRequest.firstName : "",
    "the first name is sent",
  );
}

/* ---- creating: the refusals that write nothing ---- */

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const notApproved = await provisionAirwallexAccount(
    { ...input, kyc: { ...kyc, status: "pending" } },
    harness.options,
  );
  expectEqual(notApproved.status, "failed", "a KYC review that is not approved creates nothing");
  expect(
    notApproved.status === "failed" && notApproved.reason.includes("not approved"),
    "the refusal says the review is not approved",
  );
  expectEqual(harness.calls.length, 0, "no call is made without an approval");
  expectEqual(harness.provisionStore.findByCompany(companyId), null, "no row is written without an approval");

  const otherCompany = await provisionAirwallexAccount(
    { ...input, kyc: { ...kyc, companyId: otherCompanyId } },
    harness.options,
  );
  expectEqual(otherCompany.status, "failed", "an approval belonging to another company creates nothing");
  expect(
    otherCompany.status === "failed" && otherCompany.reason.includes("another company"),
    "the refusal names the ownership problem",
  );

  const noSubmission = await provisionAirwallexAccount({ ...input, kyc: { ...kyc, submissionId: "  " } }, harness.options);
  expectEqual(noSubmission.status, "failed", "an approval naming no submission creates nothing");

  const badEmail = await provisionAirwallexAccount(
    { ...input, request: { ...individualRequest, email: "not-an-email" } },
    harness.options,
  );
  expectEqual(badEmail.status, "failed", "an invalid request creates nothing");
  const badCountry = await provisionAirwallexAccount(
    { ...input, request: { ...individualRequest, countryCode: "bd" } },
    harness.options,
  );
  expectEqual(badCountry.status, "failed", "a lower-case country code creates nothing");
  const noAgreement = await provisionAirwallexAccount(
    { ...input, request: { ...individualRequest, agreedToTermsAndConditions: false } },
    harness.options,
  );
  expectEqual(noAgreement.status, "failed", "a missing agreement creates nothing");
  expect(
    noAgreement.status === "failed" && noAgreement.reason.includes("agreement"),
    "the refusal names the agreement",
  );
  const noName = await provisionAirwallexAccount(
    { ...input, request: { ...individualRequest, lastName: " " } },
    harness.options,
  );
  expectEqual(noName.status, "failed", "a nameless individual creates nothing");
  const shortBusiness = await provisionAirwallexAccount(
    { ...input, request: { ...businessRequest, businessName: "K" } },
    harness.options,
  );
  expectEqual(shortBusiness.status, "failed", "an unnamed business creates nothing");
  expectEqual(harness.calls.length, 0, "none of the invalid requests reached the API");
  expectEqual(harness.provisionStore.findByCompany(companyId), null, "none of them wrote a row");
}

{
  // No active configuration: a company with a pending key only.
  const configStore = new InMemoryAirwallexConfigStore();
  configureAirwallexKeys(
    { companyId, environment: "sandbox", clientId, apiKey, webhookSecret: null },
    { store: configStore, keyring, occurredAtEpochMs: NOW },
  );
  const account = accountTransport(() => ({ status: 200, body: createdAnswer }));
  const login = loginTransport();
  const provisionStore = new InMemoryAirwallexAccountProvisionStore();
  const result = await provisionAirwallexAccount(input, {
    configStore,
    provisionStore,
    keyring,
    tokenCache: new InMemoryAirwallexTokenCache(),
    occurredAtEpochMs: NOW,
    transport: account.transport,
    loginTransport: login.transport,
  });
  expectEqual(result.status, "failed", "a company with no active key creates no account");
  expect(result.status === "failed" && result.reason.includes("no active Airwallex key"), "the refusal names the key");
  expectEqual(account.calls.length, 0, "no account call is made");
  expectEqual(provisionStore.findByCompany(companyId), null, "no row is written");
}

{
  // The token cannot be obtained, so nothing is attempted and nothing is written.
  const company = await activeCompany(companyId);
  const account = accountTransport(() => ({ status: 200, body: createdAnswer }));
  const provisionStore = new InMemoryAirwallexAccountProvisionStore();
  const result = await provisionAirwallexAccount(input, {
    configStore: company.configStore,
    provisionStore,
    keyring,
    tokenCache: company.tokenCache,
    occurredAtEpochMs: NOW,
    transport: account.transport,
    loginTransport: async () => ({ status: 401, body: JSON.stringify({ code: "credentials_invalid" }) }),
  });
  expectEqual(result.status, "failed", "a login that yields no token creates no account");
  expectEqual(account.calls.length, 0, "no account call is made without a token");
  expectEqual(provisionStore.findByCompany(companyId), null, "no pending row is left behind");
}

/* ---- creating: the outcomes the API may answer ---- */

{
  const harness = await optionsFor(companyId, () => ({ status: 400, body: JSON.stringify({ code: "field_required", message: "missing field" }) }));
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "rejected", "a 400 rejects the attempt");
  if (result.status !== "rejected") throw new Error("unreachable");
  expectEqual(result.provision.attemptStatus, "rejected", "the row records the rejection");
  expectEqual(result.provision.accountId, null, "a rejected attempt carries no id");
  expectEqual(result.provision.reason, "missing field", "the provider's message is kept");

  const retried = await provisionAirwallexAccount(input, {
    ...harness.options,
    transport: accountTransport(() => ({ status: 200, body: createdAnswer })).transport,
  });
  expectEqual(retried.status, "created", "a rejected attempt may be reopened, because nothing was created");
  if (retried.status !== "created") throw new Error("unreachable");
  expectEqual(retried.provision.accountId, accountId, "the reopened attempt records the id");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 401, body: JSON.stringify({ message: "bad token" }) }));
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "failed", "a 401 fails outright");
  const row = harness.provisionStore.findByCompany(companyId);
  expectEqual(row?.attemptStatus, "pending", "an outright refusal leaves the pending row as it was");
  expectEqual(row?.accountId, null, "an outright refusal records no id");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 503, body: "{}" }));
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "unknown", "a 5XX leaves the outcome unknown");
  if (result.status !== "unknown") throw new Error("unreachable");
  expectEqual(result.requiresReconciliation, true, "an unknown outcome asks for reconciliation");
  expectEqual(result.provision.attemptStatus, "unknown", "the row records the unknown outcome");
  expectEqual(result.provision.requiresReconciliation, true, "the row is flagged");

  const again = await provisionAirwallexAccount(input, harness.options);
  expectEqual(again.status, "in_flight", "a second attempt answers in_flight");
  expectEqual(harness.calls.length, 1, "no second account call is made");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: JSON.stringify({ status: "CREATED" }) }));
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "unknown", "a 2XX naming no id is unknown");
  expectEqual(harness.provisionStore.findByCompany(companyId)?.attemptStatus, "unknown", "the row is honest about it");
}

{
  const harness = await optionsFor(companyId, () => {
    throw new Error("the network fell over");
  });
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "unknown", "a thrown transport leaves the outcome unknown");
  if (result.status !== "unknown") throw new Error("unreachable");
  expect(result.reason.includes("could not be reached"), "the reason says the API was unreachable");
}

{
  // A pending row that already exists answers in_flight rather than creating a second account.
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  harness.provisionStore.insert(pendingProvision({ id: "0a1b2c3d-0000-4000-8000-0000000000aa" }));
  const result = await provisionAirwallexAccount(input, harness.options);
  expectEqual(result.status, "failed", "an attempt already in flight is refused");
  expectEqual(harness.calls.length, 0, "no call is made while an attempt is in flight");
}

/* ---- submitting ---- */

{
  const audits: string[] = [];
  const harness = await optionsFor(
    companyId,
    (call) =>
      call.method === "POST" && call.path === AIRWALLEX_ACCOUNTS_CREATE_PATH
        ? { status: 200, body: createdAnswer }
        : { status: 200, body: JSON.stringify({ id: accountId, status: "SUBMITTED" }) },
    audits,
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");

  const submitted = await submitAirwallexAccount(created.provision.id, harness.options);
  expectEqual(submitted.status, "submitted", "a CREATED account is submitted");
  if (submitted.status !== "submitted") throw new Error("unreachable");
  expectEqual(submitted.accountStatus, "SUBMITTED", "the answered status is recorded");
  expectEqual(submitted.onboardingState, "waiting", "SUBMITTED maps to waiting");
  expectEqual(submitted.provision.submittedAtEpochMs, NOW, "the submit time is recorded");
  expectEqual(harness.calls[1]?.method, "POST", "the submit is a POST");
  expectEqual(harness.calls[1]?.path, airwallexAccountSubmitPath(accountId), "the submit path is the documented one");
  expectEqual(harness.calls[1]?.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the pin is sent");
  expectEqual(audits.join(","), "connected_account.created:CREATED,connected_account.submitted:SUBMITTED", "the submit is audited");

  const again = await submitAirwallexAccount(created.provision.id, harness.options);
  expectEqual(again.status, "failed", "a SUBMITTED account is not submitted again");
  expect(again.status === "failed" && again.reason.includes("is not submitted again"), "the refusal says why");
  expectEqual(harness.calls.length, 2, "no third call is made");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  expectEqual(created.provision.submittedAtEpochMs, null, "a created account has not been submitted");

  const refused = await submitAirwallexAccount(created.provision.id, {
    ...harness.options,
    transport: accountTransport(() => ({ status: 400, body: JSON.stringify({ code: "field_required", message: "documents are required" }) })).transport,
  });
  expectEqual(refused.status, "refused", "a 400 refuses the submission");
  expect(refused.status === "refused" && refused.reason.includes("documents"), "the provider's message is kept");
  expectEqual(
    harness.provisionStore.findById(created.provision.id)?.submittedAtEpochMs,
    null,
    "a refused submission records no submit time",
  );
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const missing = await submitAirwallexAccount(created.provision.id, {
    ...harness.options,
    transport: accountTransport(() => ({ status: 404, body: "{}" })).transport,
  });
  expectEqual(missing.status, "not_found", "a 404 on submit is not_found");
  expectEqual(missing.status === "not_found" && missing.provision.requiresReconciliation, true, "the row asks for reconciliation");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const unknown = await submitAirwallexAccount(created.provision.id, {
    ...harness.options,
    transport: accountTransport(() => ({ status: 500, body: "{}" })).transport,
  });
  expectEqual(unknown.status, "unknown", "a 5XX on submit is unknown");
  expectEqual(unknown.status === "unknown" && unknown.requiresReconciliation, true, "an unknown submit asks for reconciliation");
}

{
  // An account whose status was never read cannot be submitted: there is nothing to justify the call.
  const harness = await optionsFor(companyId, () => ({ status: 200, body: JSON.stringify({ id: accountId }) }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  expectEqual(created.provision.accountStatus, null, "the answer named no status");
  const submitted = await submitAirwallexAccount(created.provision.id, harness.options);
  expectEqual(submitted.status, "failed", "an account without a read status is not submitted");
  expectEqual(harness.calls.length, 1, "no submit call is made");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const nothing = await submitAirwallexAccount("0a1b2c3d-0000-4000-8000-0000000000bb", harness.options);
  expectEqual(nothing.status, "failed", "an unknown attempt id is refused");
  expectEqual(harness.calls.length, 0, "no call is made for an unknown attempt");
}

/* ---- syncing the verification ---- */

{
  const audits: string[] = [];
  const harness = await optionsFor(
    companyId,
    (call) =>
      call.method === "POST"
        ? { status: 200, body: createdAnswer }
        : { status: 200, body: JSON.stringify({ id: accountId, status: "ACTIVE" }) },
    audits,
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");

  const synced = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(synced.status, "synced", "an ACTIVE answer syncs");
  if (synced.status !== "synced") throw new Error("unreachable");
  expectEqual(synced.accountStatus, "ACTIVE", "the status is recorded");
  expectEqual(synced.onboardingState, "ready", "ACTIVE maps to ready");
  expectEqual(synced.changed, true, "the status changed from CREATED");
  expectEqual(synced.provision.verificationCheckedAtEpochMs, NOW, "the read time is recorded");
  expectEqual(synced.provision.verificationCheckCount, 1, "one check is counted");
  expectEqual(harness.calls[1]?.method, "GET", "the sync is a GET");
  expectEqual(harness.calls[1]?.path, airwallexAccountPath(accountId), "the read path is the documented one");
  expectEqual(harness.calls[1]?.body, null, "a read carries no body");
  expectEqual(audits.length, 2, "the sync is audited");
  expectEqual(audits[1], "connected_account.verification_synced:ACTIVE", "the audit names the status");

  const second = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(second.status, "synced", "a second read syncs too");
  expectEqual(second.status === "synced" && second.changed, false, "an unchanged status reports no change");
  expectEqual(second.status === "synced" && second.provision.verificationCheckCount, 2, "the counter climbs");
}

{
  const harness = await optionsFor(companyId, (call) =>
    call.method === "POST" ? { status: 200, body: createdAnswer } : { status: 200, body: JSON.stringify({ status: "ACTION_REQUIRED" }) },
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const synced = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(synced.status === "synced" && synced.onboardingState, "blocked", "ACTION_REQUIRED maps to blocked");
  expectEqual(synced.status === "synced" && synced.provision.accountStatus, "ACTION_REQUIRED", "the status is recorded");
}

{
  const harness = await optionsFor(companyId, (call) =>
    call.method === "POST" ? { status: 200, body: createdAnswer } : { status: 200, body: JSON.stringify({ status: "SUSPENDED" }) },
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const synced = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(synced.status === "synced" && synced.onboardingState, "blocked", "SUSPENDED maps to blocked");
}

{
  const harness = await optionsFor(companyId, (call) =>
    call.method === "POST" ? { status: 200, body: createdAnswer } : { status: 404, body: "{}" },
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const missing = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(missing.status, "not_found", "a 404 on a read is not_found");
  expectEqual(missing.status === "not_found" && missing.provision.requiresReconciliation, true, "the row is flagged");
  expectEqual(
    missing.status === "not_found" && missing.provision.accountStatus,
    "CREATED",
    "a 404 does not invent a new status",
  );
}

{
  const harness = await optionsFor(companyId, (call) =>
    call.method === "POST" ? { status: 200, body: createdAnswer } : { status: 401, body: "{}" },
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const before = harness.provisionStore.findById(created.provision.id);
  const refused = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(refused.status, "refused", "a 401 on a read refuses the sync");
  const after = harness.provisionStore.findById(created.provision.id);
  expectEqual(after?.version, before?.version, "a refused read writes nothing");
  expectEqual(after?.verificationCheckCount, 0, "a refused read counts no check");
}

{
  const harness = await optionsFor(companyId, (call) =>
    call.method === "POST" ? { status: 200, body: createdAnswer } : { status: 200, body: JSON.stringify({ status: "IN_REVIEW" }) },
  );
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const unknown = await syncAirwallexAccountVerification(created.provision.id, harness.options);
  expectEqual(unknown.status, "unknown", "an unrecorded status is unknown, not stored");
  expectEqual(unknown.status === "unknown" && unknown.provision.requiresReconciliation, true, "the row is flagged");
  expectEqual(unknown.status === "unknown" && unknown.provision.accountStatus, "CREATED", "the recorded status is unchanged");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  const unknown = await syncAirwallexAccountVerification(created.provision.id, {
    ...harness.options,
    transport: accountTransport(() => {
      throw new Error("unreachable");
    }).transport,
  });
  expectEqual(unknown.status, "unknown", "a thrown read is unknown");
  expect(unknown.status === "unknown" && unknown.reason.includes("could not be reached"), "the reason is honest");
}

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  harness.provisionStore.insert(pendingProvision({ id: "0a1b2c3d-0000-4000-8000-0000000000cc" }));
  const result = await syncAirwallexAccountVerification("0a1b2c3d-0000-4000-8000-0000000000cc", harness.options);
  expectEqual(result.status, "failed", "a pending attempt has nothing to read");
  expectEqual(harness.calls.length, 0, "no read is made for a pending attempt");
  const unknownId = await syncAirwallexAccountVerification("0a1b2c3d-0000-4000-8000-0000000000dd", harness.options);
  expectEqual(unknownId.status, "failed", "an unknown attempt id is refused");
}

/* ---- what the record means ---- */

{
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");

  const fresh = airwallexAccountReadinessOf(created.provision, NOW);
  expectEqual(fresh.state, "waiting", "a CREATED account is waiting");
  expectEqual(fresh.canAcceptPayments, false, "a CREATED account cannot take payments");
  expectEqual(fresh.canReceivePayouts, false, "a CREATED account cannot receive payouts");
  expectEqual(fresh.onboardingComplete, false, "a CREATED account is not onboarded");
  expectEqual(fresh.accountId, accountId, "readiness names the account");
  expectEqual(fresh.blockingReason, "the account exists but has not been submitted for verification", "the reason is the mapping's");
  expectEqual(fresh.verificationStale, true, "a never-read account is stale");

  const active = airwallexAccountReadinessOf(
    { ...created.provision, accountStatus: "ACTIVE", onboardingState: "ready", verificationCheckedAtEpochMs: NOW },
    NOW,
  );
  expectEqual(active.state, "ready", "an ACTIVE account is ready");
  expectEqual(active.canAcceptPayments, true, "an ACTIVE account can take payments");
  expectEqual(active.canReceivePayouts, true, "an ACTIVE account can receive payouts");
  expectEqual(active.onboardingComplete, true, "an ACTIVE account is onboarded");
  expectEqual(active.blockingReason, null, "nothing blocks an ACTIVE account");
  expectEqual(active.verificationStale, false, "a read taken now is current");

  const stale = airwallexAccountReadinessOf(
    { ...created.provision, accountStatus: "ACTIVE", onboardingState: "ready", verificationCheckedAtEpochMs: NOW },
    NOW + AIRWALLEX_VERIFICATION_STALE_AFTER_SECONDS * 1_000 + 1,
  );
  expectEqual(stale.verificationStale, true, "a read older than a day is stale");
  expectEqual(stale.canAcceptPayments, true, "staleness does not block an active account");

  const blocked = airwallexAccountReadinessOf(
    { ...created.provision, accountStatus: "ACTION_REQUIRED", onboardingState: "blocked" },
    NOW,
  );
  expectEqual(blocked.state, "blocked", "ACTION_REQUIRED is blocked");
  expect(blocked.blockingReason !== null && blocked.blockingReason.includes("request for information"), "the reason names the RFI");
  expectEqual(blocked.canAcceptPayments, false, "a blocked account cannot take payments");

  const suspended = airwallexAccountReadinessOf(
    { ...created.provision, accountStatus: "SUSPENDED", onboardingState: "blocked" },
    NOW,
  );
  expectEqual(suspended.state, "blocked", "SUSPENDED is blocked");
  expectEqual(suspended.canReceivePayouts, false, "a suspended account receives no payout");

  const unread = airwallexAccountReadinessOf({ ...created.provision, accountStatus: null, onboardingState: null }, NOW);
  expectEqual(unread.state, "waiting", "an unread account is waiting");
  expectEqual(unread.blockingReason, "the account's status has not been read yet", "the reason says it was never read");

  const rejected = airwallexAccountReadinessOf(
    { ...created.provision, attemptStatus: "rejected", accountId: null, accountStatus: null, onboardingState: null },
    NOW,
  );
  expectEqual(rejected.blockingReason, "Airwallex refused the account request", "a rejected attempt says so");
  expectEqual(rejected.accountId, null, "a rejected attempt names no account");

  const unknown = airwallexAccountReadinessOf(
    { ...created.provision, attemptStatus: "unknown", accountId: null, accountStatus: null, onboardingState: null },
    NOW,
  );
  expect(unknown.blockingReason !== null && unknown.blockingReason.includes("reconciliation"), "an unknown attempt asks for reconciliation");

  const pendingRow = airwallexAccountReadinessOf(
    { ...created.provision, attemptStatus: "pending", accountId: null, accountStatus: null, onboardingState: null },
    NOW,
  );
  expectEqual(pendingRow.blockingReason, "the connected account has not been created", "a pending attempt says so");
}

/* ---- the outcome table ---- */

{
  expectEqual(AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES.created.join(","), "created", "a created row never moves");
  expectEqual(AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES.rejected.join(","), "rejected,pending", "a rejected row may be reopened");
  expect(AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES.unknown.includes("created"), "an unknown row may settle as created");
  expect(AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES.pending.includes("rejected"), "a pending row may be rejected");
  expect(Object.isFrozen(AIRWALLEX_ACCOUNT_ATTEMPT_OUTCOMES), "the outcome table is frozen");
}

/* ---- the account id collision ---- */

{
  // Airwallex and Stripe both use acct_, so the store answers only its own rows and the record says whose id it is.
  const harness = await optionsFor(companyId, () => ({ status: 200, body: createdAnswer }));
  const created = await provisionAirwallexAccount(input, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an account");
  expectEqual(harness.provisionStore.findByAccountId(accountId)?.providerKey, AIRWALLEX_PROVIDER_KEY, "the row names Airwallex");
  expectEqual(harness.provisionStore.findByAccountId("acct_StripeShapedId123"), null, "a foreign acct_ id finds no row");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Airwallex connected-account gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Airwallex connected-account gate passed: ${checks} checks (an approved company creates exactly one account with both agreement flags and no identity secret in the body, a replay and an unknown outcome never create a second one, only a CREATED or ACTION_REQUIRED account is submitted, every documented status is read and mapped while an unrecorded one is refused, a refused read writes nothing and a missing or unsettled one asks for reconciliation, and readiness follows ACTIVE alone with staleness reported rather than used to block)\n`,
);
