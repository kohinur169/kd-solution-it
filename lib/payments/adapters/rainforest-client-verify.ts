// path: lib/payments/adapters/rainforest-client-verify.ts

/**
 * The gate for STEP 158: Rainforest encrypted key configuration, connection test and key rotation.
 *
 * A check script, not a test file: it exercises the service with a recording API transport and with
 * keyrings built for the run, then fails and names every check that did not hold. No network call is
 * made and no real credential is used.
 */

import process from "node:process";
import { isSecretEnvelope, openSecret, sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  activateRainforestConfig,
  configureRainforestKeys,
  InMemoryRainforestConfigStore,
  maskRainforestCredential,
  parseRainforestKeyListAnswer,
  RAINFOREST_API_KEY_PATTERN,
  RAINFOREST_API_KEYS_PATH,
  RAINFOREST_API_VERSION,
  RAINFOREST_COMPANY_ID_PATTERN,
  RAINFOREST_PRODUCTION_API_KEY_PREFIX,
  RAINFOREST_SANDBOX_API_KEY_PREFIX,
  rainforestApiKeyScope,
  rainforestConfigIsSealed,
  rainforestFetchApiTransport,
  rainforestKeyListEndpointFor,
  rainforestKeyViewOf,
  retireRainforestConfig,
  testRainforestConnection,
  validateRainforestCredentials,
  type ConfigureRainforestKeysInput,
  type RainforestApiTransport,
  type RainforestConfigStore,
  type RainforestKeyAuditEntry,
} from "./rainforest-client.ts";
import {
  RAINFOREST_API_VERSION as DOCUMENTED_API_VERSION,
  RAINFOREST_PRODUCTION_API_BASE,
  RAINFOREST_SANDBOX_API_BASE,
  RAINFOREST_SANDBOX_KEY_PREFIX,
  RAINFOREST_PRODUCTION_KEY_PREFIX,
} from "./rainforest.ts";

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
const rotatedKeyring: EncryptionKeyring = {
  primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") },
  previous: [{ id: "k1", secret: Buffer.alloc(32, 7).toString("base64") }],
};
const foreignKeyring: EncryptionKeyring = {
  primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") },
};

const companyId = "018f2b8a-0000-4000-8000-00000000b001";
const otherCompanyId = "018f2b8a-0000-4000-8000-00000000b002";
const sandboxKey = "sbx_apikey_GATEWAYSANDBOX0001ABCDEF";
const productionKey = "apikey_GATEWAYPRODUCTION0002ABCDEF";

function inputOf(overrides: Partial<ConfigureRainforestKeysInput> = {}): ConfigureRainforestKeysInput {
  return {
    companyId,
    environment: "sandbox",
    apiKey: sandboxKey,
    ...overrides,
  };
}

function connectionOptions(
  store: RainforestConfigStore,
  audits: RainforestKeyAuditEntry[],
  transport?: RainforestApiTransport,
) {
  return {
    store,
    keyring,
    occurredAtEpochMs: 2_000,
    recordAudit: (entry: RainforestKeyAuditEntry) => audits.push(entry),
    ...(transport === undefined ? {} : { transport }),
  };
}

/** A transport that answers one fixed status and body and records what it was asked. */
function recordingTransport(status: number, body: string) {
  const calls: { endpoint: string; apiKey: string }[] = [];
  const transport: RainforestApiTransport = async (endpoint, apiKey) => {
    calls.push({ endpoint, apiKey });
    return { status, body };
  };
  return { transport, calls };
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the endpoint, the scopes and the prefixes
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_API_KEYS_PATH, "/v1/api_keys", "the documented key list path is recorded");
expectEqual(
  rainforestKeyListEndpointFor("sandbox"),
  `${RAINFOREST_SANDBOX_API_BASE}/v1/api_keys`,
  "the sandbox test endpoint is the documented base plus path",
);
expectEqual(
  rainforestKeyListEndpointFor("production"),
  `${RAINFOREST_PRODUCTION_API_BASE}/v1/api_keys`,
  "the production test endpoint is the documented base plus path",
);
expectEqual(rainforestApiKeyScope("company-1"), "gateway:company-1:rainforest:api_key", "the sealing scope names company, provider and credential");
expect(rainforestApiKeyScope("company-1").includes("rainforest"), "the scope names the provider");
expectEqual(RAINFOREST_SANDBOX_API_KEY_PREFIX, RAINFOREST_SANDBOX_KEY_PREFIX, "the sandbox prefix is the documented one");
expectEqual(RAINFOREST_PRODUCTION_API_KEY_PREFIX, RAINFOREST_PRODUCTION_KEY_PREFIX, "the production prefix is the documented one");
expectEqual(RAINFOREST_API_VERSION, DOCUMENTED_API_VERSION, "the test sends the API version STEP 157 recorded");
expectEqual(RAINFOREST_API_VERSION, "2024-10-16", "the documented version is the current one");
expect(RAINFOREST_COMPANY_ID_PATTERN.test(companyId), "the fixture company id is valid");
expect(RAINFOREST_API_KEY_PATTERN.test(sandboxKey), "the sandbox fixture key carries the documented shape");
expect(RAINFOREST_API_KEY_PATTERN.test(productionKey), "the production fixture key carries the documented shape");

/* ------------------------------------------------------------------------------------------------
 * Section 2: validation refuses before anything is sealed
 * --------------------------------------------------------------------------------------------- */

expectEqual(validateRainforestCredentials(inputOf()), null, "a documented sandbox key is valid");
expectEqual(validateRainforestCredentials(inputOf({ environment: "production", apiKey: productionKey })), null, "a documented production key is valid");
expectEqual(
  validateRainforestCredentials(inputOf({ companyId: "" })),
  "the company id is invalid",
  "an empty company id is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ companyId: "<script>" })),
  "the company id is invalid",
  "a markup company id is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ environment: "staging" as unknown as "sandbox" })),
  "the environment must be sandbox or production",
  "an unknown environment is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ apiKey: "not-a-key" })),
  "the API key must carry the documented apikey_ or sbx_apikey_ prefix and at least 16 characters after it",
  "a key without a documented prefix is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ apiKey: "sbx_apikey_short" })),
  "the API key must carry the documented apikey_ or sbx_apikey_ prefix and at least 16 characters after it",
  "a key shorter than the documented shape is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ apiKey: `${sandboxKey}\n` })),
  "the API key must carry the documented apikey_ or sbx_apikey_ prefix and at least 16 characters after it",
  "a key with a newline is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ apiKey: `sbx_apikey_${"a".repeat(300)}` })),
  "the API key must carry the documented apikey_ or sbx_apikey_ prefix and at least 16 characters after it",
  "an over-long key is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ apiKey: productionKey })),
  "the API key is a production key, but the configuration names the sandbox environment",
  "a production key in a sandbox configuration is refused",
);
expectEqual(
  validateRainforestCredentials(inputOf({ environment: "production", apiKey: sandboxKey })),
  "the API key is a sandbox key, but the configuration names the production environment",
  "a sandbox key in a production configuration is refused",
);

const refusalStore = new InMemoryRainforestConfigStore();
const refusalAudits: RainforestKeyAuditEntry[] = [];
const refused = configureRainforestKeys(inputOf({ apiKey: productionKey }), {
  store: refusalStore,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => refusalAudits.push(entry),
});
expectEqual(refused.status, "failed", "an invalid input is refused by the service");
if (refused.status === "failed") {
  expectEqual(
    refused.reason,
    "the API key is a production key, but the configuration names the sandbox environment",
    "the service refusal names the environment mismatch",
  );
}
expectEqual(refusalStore.findByCompany(companyId).length, 0, "a refused input stores nothing");
expectEqual(refusalAudits.length, 0, "a refused input audits nothing");

/* ------------------------------------------------------------------------------------------------
 * Section 3: sealing, the scope binding and the keyring rotation
 * --------------------------------------------------------------------------------------------- */

const sealStore = new InMemoryRainforestConfigStore();
const sealAudits: RainforestKeyAuditEntry[] = [];
const sealed = configureRainforestKeys(inputOf(), {
  store: sealStore,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => sealAudits.push(entry),
});
expectEqual(sealed.status, "configured", "a valid key is configured");
const sealedId = sealed.status === "configured" ? sealed.config.id : "";

if (sealed.status === "configured") {
  const config = sealed.config;
  expect(/^kd1\./u.test(config.apiKeySealed), "the key is sealed in the platform envelope format");
  expect(isSecretEnvelope(config.apiKeySealed), "the sealed value is a platform secret envelope");
  expect(config.apiKeySealed.includes(sandboxKey) === false, "the envelope does not carry the plaintext key");
  expect(rainforestConfigIsSealed(config), "the configuration reports its key as sealed");
  expectEqual(config.status, "pending_activation", "a new key waits for its connection test");
  expectEqual(config.version, 1, "a new key starts at version 1");
  expectEqual(config.environment, "sandbox", "the configuration names its environment");
  expectEqual(config.apiKeyPrefix, "sbx_apikey_", "the configuration records the documented prefix");
  expectEqual(config.lastTest, null, "a new key has no test");
  expectEqual(config.companyId, companyId, "the configuration is bound to its company");
  expectEqual(sealed.view.apiKeyMasked.endsWith(sandboxKey.slice(-4)), true, "the configured view is masked to the last four characters");
  expectEqual(sealed.view.apiKeyPrefix, "sbx_apikey_", "the configured view shows the prefix, not the key");
}
expectEqual(sealAudits.length, 1, "configuring writes one audit entry");
expectEqual(sealAudits[0]?.action, "provider_key.configured", "the audit entry names the action");
expectEqual(sealAudits[0]?.providerKey, "rainforest", "the audit entry names the provider");
expectEqual(sealAudits[0]?.outcome, "pending_activation", "the audit entry reports the pending status");
expectEqual(sealAudits[0]?.occurredAtEpochMs, 1_000, "the audit entry carries the instant");
expect(JSON.stringify(sealAudits).includes(sandboxKey) === false, "the audit entry carries no key");

const stored = sealStore.findById(sealedId);
if (stored !== null) {
  expectEqual(
    openSecret(keyring, stored.apiKeySealed, { purpose: "secret", scope: rainforestApiKeyScope(companyId) }),
    sandboxKey,
    "the sealed key opens under its own scope",
  );
  expectThrows(
    () => openSecret(foreignKeyring, stored.apiKeySealed, { purpose: "secret", scope: rainforestApiKeyScope(companyId) }),
    "a foreign keyring cannot open the sealed key",
  );
  expectThrows(
    () => openSecret(keyring, stored.apiKeySealed, { purpose: "secret", scope: rainforestApiKeyScope(otherCompanyId) }),
    "another company's scope cannot open the sealed key",
  );
  expectThrows(
    () => openSecret(keyring, stored.apiKeySealed, { purpose: "secret", scope: "gateway:company:payoneer:client_secret" }),
    "another provider's scope cannot open the sealed key",
  );
  expectEqual(
    openSecret(rotatedKeyring, stored.apiKeySealed, { purpose: "secret", scope: rainforestApiKeyScope(companyId) }),
    sandboxKey,
    "a rotated keyring still opens what the previous key wrote",
  );
  expectThrows(
    () => openSecret(rotatedKeyring, sealSecret(keyring, sandboxKey, { purpose: "secret", scope: rainforestApiKeyScope(companyId) }), {
      purpose: "secret",
      scope: "gateway:other:rainforest:api_key",
    }),
    "a fresh envelope does not open under a foreign scope",
  );
}

const secondPending = configureRainforestKeys(inputOf({ apiKey: "sbx_apikey_SECONDPENDING0003ABCDEF" }), {
  store: sealStore,
  keyring,
  occurredAtEpochMs: 1_500,
});
expectEqual(secondPending.status, "failed", "a second key waiting for its test is refused");
if (secondPending.status === "failed") {
  expectEqual(secondPending.reason, "this company already has a key waiting for its connection test", "the refusal names the waiting key");
}

const weakKeyring: EncryptionKeyring = { primary: { id: "k1", secret: "" } };
const unsealed = configureRainforestKeys(inputOf({ companyId: otherCompanyId }), {
  store: new InMemoryRainforestConfigStore(),
  keyring: weakKeyring,
  occurredAtEpochMs: 1_600,
});
expectEqual(unsealed.status, "failed", "an unusable keyring refuses the configuration");
if (unsealed.status === "failed") {
  expectEqual(unsealed.reason, "the encryption keyring cannot seal a credential", "the reason names the keyring, never the key");
  expect(unsealed.reason.includes(sandboxKey) === false, "the keyring refusal carries no key");
}

/* ------------------------------------------------------------------------------------------------
 * Section 4: the masked view
 * --------------------------------------------------------------------------------------------- */

expectEqual(maskRainforestCredential(sandboxKey), `${"*".repeat(12)}${sandboxKey.slice(-4)}`, "the mask keeps the last four characters and caps the stars");
expectEqual(maskRainforestCredential("abcdefghijklmnopqrst"), `${"*".repeat(12)}qrst`, "a long value keeps only its last four");
expectEqual(maskRainforestCredential("abcd"), "****", "a four character value is hidden entirely");
expectEqual(maskRainforestCredential("ab"), "**", "a short value is hidden entirely");
expectEqual(maskRainforestCredential(""), "*", "an empty value still masks to one character");
expectEqual(maskRainforestCredential("  spaced-value  "), `${"*".repeat(8)}alue`, "surrounding whitespace is ignored");

const storedForView = sealStore.findById(sealedId);
if (storedForView !== null) {
  const shown = rainforestKeyViewOf(storedForView, keyring);
  expectEqual(shown.status, "shown", "the stored key has a masked view");
  if (shown.status === "shown") {
    expectEqual(shown.view.apiKeyMasked, `${"*".repeat(12)}${sandboxKey.slice(-4)}`, "the view masks the key");
    expect(shown.view.apiKeyMasked.includes(sandboxKey) === false, "the view carries no plaintext key");
    expectEqual(shown.view.status, "pending_activation", "the view reports the status");
    expectEqual(shown.view.lastTestOutcome, null, "the view reports no test yet");
    expectEqual(shown.view.environment, "sandbox", "the view reports the environment");
  }
  const unreadable = rainforestKeyViewOf(storedForView, foreignKeyring);
  expectEqual(unreadable.status, "failed", "a keyring that cannot open the key yields no view");
  if (unreadable.status === "failed") {
    expectEqual(unreadable.reason, "the sealed credentials cannot be opened with this keyring", "the unreadable view says why");
  }
}

/* ------------------------------------------------------------------------------------------------
 * Section 5: the store's invariants
 * --------------------------------------------------------------------------------------------- */

const invariantStore = new InMemoryRainforestConfigStore();
const firstConfig = configureRainforestKeys(inputOf(), { store: invariantStore, keyring, occurredAtEpochMs: 1_000 });
const firstId = firstConfig.status === "configured" ? firstConfig.config.id : "";
const firstStored = invariantStore.findById(firstId);
expect(firstStored !== null, "the store holds the configured key");

if (firstStored !== null) {
  expectThrows(() => invariantStore.insert(firstStored), "a duplicate configuration id is refused");
  expectThrows(() => invariantStore.insert({ ...firstStored, id: "00000000-0000-4000-8000-0000000000ff" }), "a second pending key for a company is refused");
  expectThrows(
    () => invariantStore.insert({ ...firstStored, id: "00000000-0000-4000-8000-0000000000fe", status: "active", version: 1 }),
    "a key cannot be inserted as active",
  );
  expectThrows(
    () => invariantStore.insert({ ...firstStored, id: "00000000-0000-4000-8000-0000000000fd", version: 2 }),
    "a key cannot be inserted past version 1",
  );

  expectEqual(invariantStore.save({ ...firstStored, version: 3 }, 1), false, "a version jump is refused");
  expectEqual(invariantStore.save({ ...firstStored, version: 2 }, 9), false, "a stale expected version is refused");
  expectEqual(
    invariantStore.save({ ...firstStored, version: 2, apiKeySealed: "kd1.k1.a.b.c" }, 1),
    false,
    "a sealed key cannot be replaced on an existing row",
  );
  expectEqual(
    invariantStore.save({ ...firstStored, version: 2, companyId: otherCompanyId }, 1),
    false,
    "a configuration cannot change company",
  );
  expectEqual(
    invariantStore.save({ ...firstStored, version: 2, environment: "production" }, 1),
    false,
    "a configuration cannot change environment",
  );
  expectEqual(
    invariantStore.save({ ...firstStored, version: 2, status: "active", lastTest: null }, 1),
    false,
    "the store refuses activation without a passing test",
  );
  expectEqual(
    invariantStore.save(
      { ...firstStored, version: 2, status: "active", lastTest: { outcome: "rejected", testedAtEpochMs: 1_100, environment: "sandbox" } },
      1,
    ),
    false,
    "the store refuses activation after a rejected test",
  );
  expectEqual(
    invariantStore.save(
      { ...firstStored, version: 2, status: "active", lastTest: { outcome: "connected", testedAtEpochMs: 1_100, environment: "sandbox" } },
      1,
    ),
    true,
    "the store accepts activation after a connected test",
  );
  const activatedRecord = invariantStore.findById(firstId);
  expectEqual(activatedRecord?.status, "active", "the activated row is active");
  expectEqual(invariantStore.findActiveByCompany(companyId)?.id, firstId, "the active key is found by company");
  expectEqual(invariantStore.findPendingByCompany(companyId), null, "the activated key is no longer pending");
  if (activatedRecord !== null) {
    expectEqual(invariantStore.save({ ...activatedRecord, version: activatedRecord.version + 1 }, activatedRecord.version - 1), false, "an out-of-order write is refused");
  }
}

/* ------------------------------------------------------------------------------------------------
 * Section 6: the transport's request shape
 * --------------------------------------------------------------------------------------------- */

const originalFetch = globalThis.fetch;
try {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(JSON.stringify({ status: "OK", data: [{ api_key_id: "key_1" }] }), { status: 200 });
  };

  const sandboxAnswer = await rainforestFetchApiTransport(rainforestKeyListEndpointFor("sandbox"), sandboxKey);
  expectEqual(seenUrl, "https://api.sandbox.rainforestpay.com/v1/api_keys", "the transport calls the documented sandbox endpoint");
  expectEqual(seenInit?.method, "GET", "the transport reads, it does not write");
  expectEqual(seenInit?.redirect, "error", "the transport refuses redirects");
  const headers = (seenInit?.headers ?? {}) as Readonly<Record<string, string>>;
  expectEqual(headers["Authorization"], `Bearer ${sandboxKey}`, "the transport sends the key as a bearer credential");
  expectEqual(headers["Rainforest-Api-Version"], "2024-10-16", "the transport sends the documented version header explicitly");
  expectEqual(headers["Accept"], "application/json", "the transport asks for JSON");
  expectEqual(headers["Content-Type"], undefined, "a read sends no content type");
  expectEqual(sandboxAnswer.status, 200, "the transport returns the status");
  expect(sandboxAnswer.body.includes("api_key_id"), "the transport returns the raw body");

  globalThis.fetch = async () => new Response("", { status: 401 });
  const refusedAnswer = await rainforestFetchApiTransport(rainforestKeyListEndpointFor("production"), productionKey);
  expectEqual(refusedAnswer.status, 401, "a 401 answer is returned, not thrown");

  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200 });
  await expectRejection(
    () => rainforestFetchApiTransport(rainforestKeyListEndpointFor("sandbox"), sandboxKey),
    "an oversized answer is refused",
  );

  await expectRejection(
    () => rainforestFetchApiTransport("https://api.evil.example/v1/api_keys", sandboxKey),
    "an undocumented host is refused",
  );
  await expectRejection(
    () => rainforestFetchApiTransport("https://api.sandbox.rainforestpay.com/v1/payins", sandboxKey),
    "an undocumented path is refused",
  );
  await expectRejection(
    () => rainforestFetchApiTransport(rainforestKeyListEndpointFor("sandbox"), ""),
    "a read without a key is refused",
  );
  await expectRejection(
    () => rainforestFetchApiTransport(rainforestKeyListEndpointFor("sandbox"), "   "),
    "a read with a blank key is refused",
  );
} finally {
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: what a key-list answer means
 * --------------------------------------------------------------------------------------------- */

const listAnswer = parseRainforestKeyListAnswer(200, JSON.stringify({ status: "OK", data: [{}, {}, {}] }));
expectEqual(listAnswer.outcome, "connected", "a 200 with the documented envelope is a pass");
if (listAnswer.outcome === "connected") {
  expectEqual(listAnswer.keysVisible, 3, "the answer's key count is reported without the keys");
}
const bareList = parseRainforestKeyListAnswer(200, JSON.stringify([{}, {}]));
expectEqual(bareList.outcome, "connected", "a 200 with a bare list is a pass");
if (bareList.outcome === "connected") expectEqual(bareList.keysVisible, 2, "a bare list is counted");
const objectList = parseRainforestKeyListAnswer(200, JSON.stringify({ status: "OK", data: { keys: [] } }));
if (objectList.outcome === "connected") expectEqual(objectList.keysVisible, null, "a non-list data field reports no count");

expectEqual(parseRainforestKeyListAnswer(200, "").outcome, "failed", "a 200 with an empty body proves nothing");
expectEqual(parseRainforestKeyListAnswer(200, "not json").outcome, "failed", "a 200 with an unparseable body proves nothing");
expectEqual(parseRainforestKeyListAnswer(200, "null").outcome, "failed", "a 200 carrying null proves nothing");
expectEqual(parseRainforestKeyListAnswer(200, "42").outcome, "failed", "a 200 carrying a scalar proves nothing");

const rejectedAnswer = parseRainforestKeyListAnswer(401, JSON.stringify({ errors: [{ message: "Invalid API key" }] }));
expectEqual(rejectedAnswer.outcome, "rejected", "a 401 rejects the key");
if (rejectedAnswer.outcome === "rejected") {
  expectEqual(rejectedAnswer.detail, "Invalid API key", "the provider's message is carried");
}
const refusedEmpty = parseRainforestKeyListAnswer(401, "");
if (refusedEmpty.outcome === "rejected") {
  expectEqual(refusedEmpty.detail, "the API rejected the API key", "a 401 without a body still says the key was rejected");
}
const forbiddenAnswer = parseRainforestKeyListAnswer(403, JSON.stringify({ message: "<b>Forbidden</b> scope" }));
if (forbiddenAnswer.outcome === "rejected") {
  expectEqual(forbiddenAnswer.detail, "bForbidden/b scope", "the carried message is sanitised");
}
expectEqual(parseRainforestKeyListAnswer(401, JSON.stringify({ errors: ["plain error"] })).outcome, "rejected", "a plain error list is read");
const plainError = parseRainforestKeyListAnswer(401, JSON.stringify({ errors: ["plain error"] }));
if (plainError.outcome === "rejected") expectEqual(plainError.detail, "plain error", "the plain error is the reason");

expectEqual(parseRainforestKeyListAnswer(400, JSON.stringify({ message: "Unsupported API version" })).outcome, "failed", "a 400 proves nothing about the key");
const badRequest = parseRainforestKeyListAnswer(400, "");
if (badRequest.outcome === "failed") {
  expect(badRequest.detail.includes("API version"), "a bodyless 400 mentions the documented version cause");
}
expectEqual(parseRainforestKeyListAnswer(404, "").outcome, "failed", "a 404 proves nothing about the key");
expectEqual(parseRainforestKeyListAnswer(409, "").outcome, "failed", "a 409 proves nothing about the key");
expectEqual(parseRainforestKeyListAnswer(415, "").outcome, "failed", "an unsupported media type proves nothing about the key");
expectEqual(parseRainforestKeyListAnswer(422, "").outcome, "failed", "a 422 proves nothing about the key");
expectEqual(parseRainforestKeyListAnswer(302, "").outcome, "failed", "a redirect proves nothing");
expectEqual(parseRainforestKeyListAnswer(408, "").outcome, "unreachable", "a timeout status is unreachable");
expectEqual(parseRainforestKeyListAnswer(425, "").outcome, "unreachable", "a too-early status is unreachable");
expectEqual(parseRainforestKeyListAnswer(429, "").outcome, "unreachable", "rate limiting is unreachable");
expectEqual(parseRainforestKeyListAnswer(500, "").outcome, "unreachable", "a 500 is unreachable");
expectEqual(parseRainforestKeyListAnswer(503, "").outcome, "unreachable", "a 503 is unreachable");

/* ------------------------------------------------------------------------------------------------
 * Section 8: the connection test records what it proved
 * --------------------------------------------------------------------------------------------- */

const testStore = new InMemoryRainforestConfigStore();
const testAudits: RainforestKeyAuditEntry[] = [];
const configuredForTest = configureRainforestKeys(inputOf(), {
  store: testStore,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => testAudits.push(entry),
});
const testId = configuredForTest.status === "configured" ? configuredForTest.config.id : "";

const missing = await testRainforestConnection("00000000-0000-4000-8000-0000000000aa", connectionOptions(testStore, testAudits));
expectEqual(missing.outcome, "invalid_configuration", "an unknown id is not a test");
expectEqual(missing.configId, null, "an unknown id has no configuration");
expectEqual(missing.version, null, "an unknown id has no version");
expect(missing.apiKeyAccepted === false, "an unknown id accepts no key");

const okTransport = recordingTransport(200, JSON.stringify({ status: "OK", data: [{}, {}] }));
const connected = await testRainforestConnection(testId, connectionOptions(testStore, testAudits, okTransport.transport));
expectEqual(connected.outcome, "connected", "a 200 read connects");
expectEqual(connected.apiKeyAccepted, true, "a 200 read accepts the key");
expectEqual(connected.environmentVerified, true, "a 200 read proves the key belongs to this environment");
expectEqual(connected.apiVersionSent, "2024-10-16", "the result reports the version it sent");
expectEqual(connected.keysVisible, 2, "the result reports the key count");
expectEqual(connected.environment, "sandbox", "the result reports the environment");
expectEqual(connected.version, 2, "recording the test advances the version");
expectEqual(okTransport.calls.length, 1, "the test makes exactly one call");
expectEqual(okTransport.calls[0]?.endpoint, "https://api.sandbox.rainforestpay.com/v1/api_keys", "the test calls the documented endpoint");
expectEqual(okTransport.calls[0]?.apiKey, sandboxKey, "the test opens the sealed key for the call");
const testedRecord = testStore.findById(testId);
expectEqual(testedRecord?.lastTest?.outcome, "connected", "the test is recorded on the configuration");
expectEqual(testedRecord?.lastTest?.environment, "sandbox", "the recorded test names its environment");
expectEqual(testedRecord?.lastTest?.testedAtEpochMs, 2_000, "the recorded test carries its instant");
expectEqual(testedRecord?.version, 2, "the recorded test is a version-guarded write");
const testedAudit = testAudits.filter((entry) => entry.action === "provider_key.tested");
expectEqual(testedAudit.length, 1, "the test writes one audit entry");
expectEqual(testedAudit[0]?.outcome, "connected", "the audit entry reports the outcome");
expect(JSON.stringify(connected).includes(sandboxKey) === false, "the test result carries no key");
expect(JSON.stringify(testAudits).includes(sandboxKey) === false, "the test audit carries no key");
expect(JSON.stringify(testStore.findById(testId)).includes(sandboxKey) === false, "the stored record carries no plaintext key");

const rejectingStore = new InMemoryRainforestConfigStore();
const rejectingAudits: RainforestKeyAuditEntry[] = [];
const configuredForRejection = configureRainforestKeys(inputOf(), {
  store: rejectingStore,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => rejectingAudits.push(entry),
});
const rejectingId = configuredForRejection.status === "configured" ? configuredForRejection.config.id : "";

const rejectedTransport = recordingTransport(401, JSON.stringify({ errors: [{ message: "Invalid API key" }] }));
const rejected = await testRainforestConnection(rejectingId, connectionOptions(rejectingStore, rejectingAudits, rejectedTransport.transport));
expectEqual(rejected.outcome, "rejected", "a 401 rejects the key");
expectEqual(rejected.apiKeyAccepted, false, "a rejected key is not accepted");
expectEqual(rejected.environmentVerified, false, "a rejected key proves no environment");
expectEqual(rejected.keysVisible, null, "a rejected read reports no count");
if (rejected.outcome === "rejected") {
  expectEqual(rejected.reason, "Invalid API key", "the refusal carries the provider's message");
}
expectEqual(rejectingStore.findById(rejectingId)?.lastTest?.outcome, "rejected", "a rejected test is recorded too");

const throwingTransport: RainforestApiTransport = async () => {
  throw new Error(`the transport failed with ${sandboxKey}`);
};
const unreachable = await testRainforestConnection(rejectingId, connectionOptions(rejectingStore, rejectingAudits, throwingTransport));
expectEqual(unreachable.outcome, "unreachable", "a thrown transport is unreachable");
if (unreachable.outcome === "unreachable") {
  expectEqual(unreachable.reason, "the API could not be reached", "the reason does not repeat the thrown text");
  expect(unreachable.reason.includes(sandboxKey) === false, "the reason leaks no key");
}

const failingTransport = recordingTransport(200, "");
const failedTest = await testRainforestConnection(rejectingId, connectionOptions(rejectingStore, rejectingAudits, failingTransport.transport));
expectEqual(failedTest.outcome, "failed", "a 200 without a body is a failed test, not a pass");

const unreadableStore = new InMemoryRainforestConfigStore();
const unreadableConfigured = configureRainforestKeys(inputOf({ companyId: otherCompanyId }), {
  store: unreadableStore,
  keyring,
  occurredAtEpochMs: 1_000,
});
const unreadableId = unreadableConfigured.status === "configured" ? unreadableConfigured.config.id : "";
const unreadable = await testRainforestConnection(unreadableId, {
  ...connectionOptions(unreadableStore, [], recordingTransport(200, "{}").transport),
  keyring: foreignKeyring,
});
expectEqual(unreadable.outcome, "invalid_configuration", "a keyring that cannot open the key cannot test it");
if (unreadable.outcome === "invalid_configuration") {
  expectEqual(unreadable.reason, "the sealed credentials cannot be opened with this keyring", "the unreadable test says why");
}

/* ------------------------------------------------------------------------------------------------
 * Section 9: activation refuses an unproven key
 * --------------------------------------------------------------------------------------------- */

const activationStore = new InMemoryRainforestConfigStore();
const activationAudits: RainforestKeyAuditEntry[] = [];
const activationConfigured = configureRainforestKeys(inputOf(), {
  store: activationStore,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => activationAudits.push(entry),
});
const activationId = activationConfigured.status === "configured" ? activationConfigured.config.id : "";

const unknownActivation = activateRainforestConfig("00000000-0000-4000-8000-0000000000bb", {
  store: activationStore,
  occurredAtEpochMs: 1_500,
});
expectEqual(unknownActivation.status, "failed", "an unknown id cannot be activated");
if (unknownActivation.status === "failed") {
  expectEqual(unknownActivation.reason, "no Rainforest key configuration holds that id", "the refusal names the missing configuration");
}

const untested = activateRainforestConfig(activationId, {
  store: activationStore,
  occurredAtEpochMs: 1_500,
  recordAudit: (entry) => activationAudits.push(entry),
});
expectEqual(untested.status, "failed", "a key that was never tested cannot be activated");
if (untested.status === "failed") {
  expectEqual(untested.reason, "the connection test has not been run for this key", "the refusal names the missing test");
}
expectEqual(activationStore.findActiveByCompany(companyId), null, "the untested key is not active");

await testRainforestConnection(activationId, {
  store: activationStore,
  keyring,
  occurredAtEpochMs: 1_750,
  transport: recordingTransport(403, "").transport,
});
const afterFailure = activateRainforestConfig(activationId, { store: activationStore, occurredAtEpochMs: 1_800 });
expectEqual(afterFailure.status, "failed", "a key whose test failed cannot be activated");
if (afterFailure.status === "failed") {
  expectEqual(afterFailure.reason, "the last connection test did not pass, so this key cannot be activated", "the refusal names the failed test");
}

await testRainforestConnection(activationId, {
  store: activationStore,
  keyring,
  occurredAtEpochMs: 1_900,
  transport: recordingTransport(200, JSON.stringify({ data: [] })).transport,
});
const activation = activateRainforestConfig(activationId, {
  store: activationStore,
  occurredAtEpochMs: 2_100,
  recordAudit: (entry) => activationAudits.push(entry),
});
expectEqual(activation.status, "activated", "a key whose test passed is activated");
if (activation.status === "activated") {
  expectEqual(activation.config.status, "active", "the activated key is active");
  expectEqual(activation.supersededConfigId, null, "the first activation supersedes nothing");
}
expectEqual(activationStore.findActiveByCompany(companyId)?.id, activationId, "the activated key is the active one");
const activationAudit = activationAudits.filter((entry) => entry.action === "provider_key.activated");
expectEqual(activationAudit.length, 1, "activation writes one audit entry");
expectEqual(activationAudit[0]?.configId, activationId, "the audit entry names the activated key");

const activateAgain = activateRainforestConfig(activationId, { store: activationStore, occurredAtEpochMs: 2_200 });
expectEqual(activateAgain.status, "failed", "an active key cannot be activated again");
if (activateAgain.status === "failed") {
  expectEqual(activateAgain.reason, "the configuration is already active", "the refusal says the key is active");
}

/* ---- a test that ran against another environment never authorizes this one ---- */

const mismatchCompanyId = "018f2b8a-0000-4000-8000-00000000b003";
const mismatchStore = new InMemoryRainforestConfigStore();
mismatchStore.insert({
  id: "00000000-0000-4000-8000-0000000000cc",
  companyId: mismatchCompanyId,
  environment: "sandbox",
  apiKeySealed: sealSecret(keyring, sandboxKey, {
    purpose: "secret",
    scope: rainforestApiKeyScope(mismatchCompanyId),
  }),
  apiKeyPrefix: "sbx_apikey_",
  status: "pending_activation",
  version: 1,
  lastTest: { outcome: "connected", testedAtEpochMs: 1_100, environment: "production" },
  createdAtEpochMs: 1_000,
  updatedAtEpochMs: 1_100,
});
const mismatch = activateRainforestConfig("00000000-0000-4000-8000-0000000000cc", {
  store: mismatchStore,
  occurredAtEpochMs: 1_200,
});
expectEqual(mismatch.status, "failed", "a test from another environment cannot authorize this one");
if (mismatch.status === "failed") {
  expectEqual(mismatch.reason, "the connection test ran against another environment", "the refusal names the environment mismatch");
}
expectEqual(mismatchStore.findActiveByCompany(mismatchCompanyId), null, "the mismatched key is not active");

/* ------------------------------------------------------------------------------------------------
 * Section 10: the rotation procedure
 * --------------------------------------------------------------------------------------------- */

const rotationStore = new InMemoryRainforestConfigStore();
const rotationAudits: RainforestKeyAuditEntry[] = [];

const rotationFirst = configureRainforestKeys(inputOf({ companyId: otherCompanyId }), {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 3_000,
  recordAudit: (entry) => rotationAudits.push(entry),
});
const rotationFirstId = rotationFirst.status === "configured" ? rotationFirst.config.id : "";
await testRainforestConnection(rotationFirstId, {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 3_100,
  recordAudit: (entry) => rotationAudits.push(entry),
  transport: recordingTransport(200, JSON.stringify({ data: [] })).transport,
});
const firstActivated = activateRainforestConfig(rotationFirstId, {
  store: rotationStore,
  occurredAtEpochMs: 3_200,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(firstActivated.status, "activated", "the first key of the rotation becomes active");

const rotationSecond = configureRainforestKeys(inputOf({ companyId: otherCompanyId, apiKey: "sbx_apikey_REPLACEMENT0004ABCDEFGH" }), {
  store: rotationStore,
  keyring: rotatedKeyring,
  occurredAtEpochMs: 3_300,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(rotationSecond.status, "configured", "a replacement key can be added while the old one serves traffic");
const rotationSecondId = rotationSecond.status === "configured" ? rotationSecond.config.id : "";
expectEqual(rotationStore.findActiveByCompany(otherCompanyId)?.id, rotationFirstId, "adding the replacement leaves the old key active");

await testRainforestConnection(rotationSecondId, {
  store: rotationStore,
  keyring: rotatedKeyring,
  occurredAtEpochMs: 3_400,
  recordAudit: (entry) => rotationAudits.push(entry),
  transport: recordingTransport(200, JSON.stringify({ data: [] })).transport,
});
const secondActivated = activateRainforestConfig(rotationSecondId, {
  store: rotationStore,
  occurredAtEpochMs: 3_500,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(secondActivated.status, "activated", "the replacement key is activated after its test");
if (secondActivated.status === "activated") {
  expectEqual(secondActivated.supersededConfigId, rotationFirstId, "the activation names the superseded key");
}
expectEqual(rotationStore.findActiveByCompany(otherCompanyId)?.id, rotationSecondId, "the replacement is now the active key");
expectEqual(rotationStore.findById(rotationFirstId)?.status, "superseded", "the old key is superseded, not deleted");
const rotatedAudit = rotationAudits.filter((entry) => entry.action === "provider_key.rotated");
expectEqual(rotatedAudit.length, 1, "the switch writes one rotation audit entry");
expectEqual(rotatedAudit[0]?.configId, rotationFirstId, "the rotation audit entry names the superseded key");

const supersededRecord = rotationStore.findById(rotationFirstId);
if (supersededRecord !== null) {
  const supersededView = rainforestKeyViewOf(supersededRecord, keyring);
  expectEqual(supersededView.status, "shown", "the superseded key stays readable through the rotation window");
  if (supersededView.status === "shown") {
    expect(supersededView.view.apiKeyMasked.includes(sandboxKey) === false, "the superseded view carries no plaintext key");
  }
}

const reactivateSuperseded = activateRainforestConfig(rotationFirstId, { store: rotationStore, occurredAtEpochMs: 3_600 });
expectEqual(reactivateSuperseded.status, "failed", "a superseded key cannot be activated again");
if (reactivateSuperseded.status === "failed") {
  expectEqual(
    reactivateSuperseded.reason,
    "a superseded configuration cannot be activated again; add a new key instead",
    "the refusal explains the superseded key",
  );
}

const retireActive = retireRainforestConfig(rotationSecondId, { store: rotationStore, occurredAtEpochMs: 3_700 });
expectEqual(retireActive.status, "failed", "the active key cannot be retired");
if (retireActive.status === "failed") {
  expectEqual(retireActive.reason, "the active key cannot be retired; activate its replacement first", "the refusal explains the active key");
}

const retired = retireRainforestConfig(rotationFirstId, {
  store: rotationStore,
  occurredAtEpochMs: 3_800,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(retired.status, "retired", "the superseded key is retired once the switch is done");
if (retired.status === "retired") {
  expectEqual(retired.config.status, "retired", "the retired key reports its status");
}
const retireAudit = rotationAudits.filter((entry) => entry.action === "provider_key.retired");
expectEqual(retireAudit.length, 1, "retirement writes one audit entry");
expectEqual(rotationStore.findActiveByCompany(otherCompanyId)?.id, rotationSecondId, "retiring the old key leaves the replacement active");

const retireAgain = retireRainforestConfig(rotationFirstId, { store: rotationStore, occurredAtEpochMs: 3_900 });
expectEqual(retireAgain.status, "failed", "a retired key cannot be retired twice");
if (retireAgain.status === "failed") {
  expectEqual(retireAgain.reason, "the configuration is already retired", "the refusal says the key is retired");
}

const retiredTest = await testRainforestConnection(rotationFirstId, {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 4_000,
});
expectEqual(retiredTest.outcome, "invalid_configuration", "a retired key cannot be tested");
if (retiredTest.outcome === "invalid_configuration") {
  expectEqual(retiredTest.reason, "the configuration is retired and can no longer be tested", "the refusal says the key is retired");
}

/* ---- an aborted rotation is cancelled by retiring the pending key ---- */

const abortedThird = configureRainforestKeys(inputOf({ companyId: otherCompanyId, apiKey: "sbx_apikey_ABORTED0005ABCDEFGHIJ" }), {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 4_100,
});
const abortedThirdId = abortedThird.status === "configured" ? abortedThird.config.id : "";
const cancelled = retireRainforestConfig(abortedThirdId, { store: rotationStore, occurredAtEpochMs: 4_200 });
expectEqual(cancelled.status, "retired", "an untested pending key can be retired to cancel a rotation");
expectEqual(rotationStore.findActiveByCompany(otherCompanyId)?.id, rotationSecondId, "cancelling a pending key leaves the active key untouched");
expectEqual(rotationStore.findPendingByCompany(otherCompanyId), null, "no pending key is left behind");

expect(JSON.stringify(rotationAudits).includes(sandboxKey) === false, "no rotation audit entry carries a key");
expect(JSON.stringify(rotationAudits).includes("REPLACEMENT0004ABCDEFGH") === false, "no rotation audit entry carries the replacement key");

/* ------------------------------------------------------------------------------------------------
 * Section 11: the sealed-shape check
 * --------------------------------------------------------------------------------------------- */

const shapeStore = new InMemoryRainforestConfigStore();
const shapeConfigured = configureRainforestKeys(inputOf(), { store: shapeStore, keyring, occurredAtEpochMs: 5_000 });
if (shapeConfigured.status === "configured") {
  expect(rainforestConfigIsSealed(shapeConfigured.config), "a configured record reports a sealed key");
  expect(
    rainforestConfigIsSealed({ ...shapeConfigured.config, apiKeySealed: sandboxKey }) === false,
    "a plaintext key does not pass for a sealed one",
  );
  expect(
    rainforestConfigIsSealed({ ...shapeConfigured.config, apiKeySealed: "kd1.k1.a.b" }) === false,
    "a truncated envelope does not pass for a sealed one",
  );
  expect(
    rainforestConfigIsSealed({ ...shapeConfigured.config, apiKeySealed: "" }) === false,
    "an empty envelope does not pass for a sealed one",
  );
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Rainforest client gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Rainforest client gate passed: ${checks} checks (sealed keys bound to company and provider, a bearer read against the documented API with the version header, the outcome table, activation gated on a passing test, and a rotation that keeps the old key readable until it is retired)\n`,
);
