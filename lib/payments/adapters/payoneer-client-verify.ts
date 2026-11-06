// path: lib/payments/adapters/payoneer-client-verify.ts

/**
 * The gate for STEP 155: Payoneer encrypted key configuration, connection test and key rotation.
 *
 * A check script, not a test file: it exercises the service with a recording token transport and with
 * keyrings built for the run, then fails and names every check that did not hold. No network call is
 * made and no real credential is used.
 */

import process from "node:process";
import { isSecretEnvelope, sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  activatePayoneerConfig,
  configurePayoneerKeys,
  InMemoryPayoneerConfigStore,
  maskPayoneerCredential,
  PAYONEER_CLIENT_ID_PATTERN,
  PAYONEER_CLIENT_SECRET_PATTERN,
  PAYONEER_COMPANY_ID_PATTERN,
  PAYONEER_PROGRAM_ID_PATTERN,
  payoneerClientIdScope,
  payoneerClientSecretScope,
  payoneerConfigIsSealed,
  payoneerFetchTokenTransport,
  payoneerKeyViewOf,
  payoneerTokenEndpointFor,
  parsePayoneerTokenAnswer,
  retirePayoneerConfig,
  testPayoneerConnection,
  validatePayoneerCredentials,
  type ConfigurePayoneerKeysInput,
  type PayoneerConfigStore,
  type PayoneerKeyAuditEntry,
  type PayoneerKeyConfig,
  type PayoneerTokenTransport,
} from "./payoneer-client.ts";

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

const companyId = "018f2b8a-0000-4000-8000-00000000a001";
const clientId = "client-id-A1B2C3D4E5F6";
const clientSecret = "secret-A1B2C3D4E5F6G7H8I9J0-KLMN";
const programId = "program_100200300";

function inputOf(overrides: Partial<ConfigurePayoneerKeysInput> = {}): ConfigurePayoneerKeysInput {
  return {
    companyId,
    environment: "sandbox",
    clientId,
    clientSecret,
    programId,
    ...overrides,
  };
}

function connectionOptions(store: PayoneerConfigStore, audits: PayoneerKeyAuditEntry[], transport?: PayoneerTokenTransport) {
  return {
    store,
    keyring,
    occurredAtEpochMs: 2_000,
    recordAudit: (entry: PayoneerKeyAuditEntry) => audits.push(entry),
    ...(transport === undefined ? {} : { transport }),
  };
}

const successTransport = (
  calls: { count: number },
  answer: { readonly status: number; readonly body: string } = { status: 200, body: JSON.stringify({ access_token: "token_ABCDEFGH12345678" }) },
): PayoneerTokenTransport => {
  return async (endpoint, id, secret) => {
    calls.count += 1;
    expectEqual(endpoint, payoneerTokenEndpointFor("sandbox"), "the sandbox grant posts to the documented sandbox auth host");
    expectEqual(id, clientId, "the grant sends the stored client id");
    expectEqual(secret, clientSecret, "the grant sends the stored client secret");
    return answer;
  };
};

/* ------------------------------------------------------------------------------------------------
 * Section 1: endpoints, scopes, patterns and masking
 * --------------------------------------------------------------------------------------------- */

expectEqual(payoneerTokenEndpointFor("sandbox"), "https://login.sandbox.payoneer.com/oauth2/token", "the sandbox token endpoint is documented");
expectEqual(payoneerTokenEndpointFor("production"), "https://login.payoneer.com/oauth2/token", "the production token endpoint is documented");

const idScope = payoneerClientIdScope(companyId);
const secretScope = payoneerClientSecretScope(companyId);
expect(idScope.includes(companyId), "the client id scope names the company");
expect(secretScope.includes(companyId), "the client secret scope names the company");
expect(idScope.includes("payoneer") && secretScope.includes("payoneer"), "both scopes name the provider");
expect(idScope !== secretScope, "the two credentials seal under different scopes");
expect(idScope.length <= 200, "the scope fits the encryption module's limit");
expect(payoneerClientIdScope("another-company") !== idScope, "another company seals under another scope");
expect(Object.isFrozen(keyring.primary) === false, "the keyring is the caller's value");

expectEqual(maskPayoneerCredential("abcdefghijkl"), "********ijkl", "a long credential shows only its last four characters");
expectEqual(maskPayoneerCredential("abcd"), "****", "a four character credential is hidden entirely");
expectEqual(maskPayoneerCredential("ab"), "**", "a short credential is hidden entirely");
expectEqual(maskPayoneerCredential("  "), "*", "a blank credential still shows a mask");
expect(maskPayoneerCredential(clientSecret).includes(clientSecret) === false, "the mask never shows the whole credential");
expectEqual(maskPayoneerCredential("x".repeat(40)).length, 16, "a very long credential is capped in the mask");

expect(PAYONEER_COMPANY_ID_PATTERN.test(companyId), "a uuid shaped company id is accepted");
expect(PAYONEER_COMPANY_ID_PATTERN.test("bad company id") === false, "a company id with a space is refused");
expect(PAYONEER_CLIENT_ID_PATTERN.test(clientId), "a readable client id is accepted");
expect(PAYONEER_CLIENT_ID_PATTERN.test("short") === false, "a short client id is refused");
expect(PAYONEER_CLIENT_ID_PATTERN.test("client id with space") === false, "a client id with a space is refused");
expect(PAYONEER_CLIENT_SECRET_PATTERN.test(clientSecret), "a readable client secret is accepted");
expect(PAYONEER_CLIENT_SECRET_PATTERN.test("short-secret") === false, "a short client secret is refused");
expect(PAYONEER_CLIENT_SECRET_PATTERN.test("secret with spaces here") === false, "a client secret with spaces is refused");
expect(PAYONEER_CLIENT_SECRET_PATTERN.test(`secret"quoted"longenoughvalue`) === false, "a client secret with quotes is refused");
expect(PAYONEER_PROGRAM_ID_PATTERN.test(programId), "a program id is accepted");
expect(PAYONEER_PROGRAM_ID_PATTERN.test("program id") === false, "a program id with a space is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 2: validation
 * --------------------------------------------------------------------------------------------- */

expectEqual(validatePayoneerCredentials(inputOf()), null, "the documented credential shape is valid");
expectEqual(validatePayoneerCredentials(inputOf({ companyId: "bad id" })), "the company id is invalid", "an invalid company is refused");
expectEqual(
  validatePayoneerCredentials(inputOf({ environment: "staging" as unknown as "sandbox" })),
  "the environment must be sandbox or production",
  "an unknown environment is refused",
);
expectEqual(
  validatePayoneerCredentials(inputOf({ clientId: "short" })),
  "the client id must be 8 to 128 characters of letters, digits, dot, dash or underscore",
  "a short client id is refused",
);
expectEqual(
  validatePayoneerCredentials(inputOf({ clientSecret: "short" })),
  "the client secret must be at least 16 characters and carry no spaces or quotation marks",
  "a short client secret is refused",
);
expectEqual(
  validatePayoneerCredentials(inputOf({ clientSecret: "secret with a space inside" })),
  "the client secret must be at least 16 characters and carry no spaces or quotation marks",
  "a client secret with a space is refused",
);
expectEqual(
  validatePayoneerCredentials(inputOf({ programId: "program id" })),
  "the program id must be 1 to 64 characters of letters, digits, dash or underscore",
  "an invalid program id is refused",
);
expectEqual(
  validatePayoneerCredentials(inputOf({ clientSecret: clientId })),
  "the client id and the client secret cannot be the same value",
  "using the id as the secret is refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 3: configuration seals the credentials
 * --------------------------------------------------------------------------------------------- */

const store = new InMemoryPayoneerConfigStore();
const audits: PayoneerKeyAuditEntry[] = [];
const configured = configurePayoneerKeys(inputOf(), {
  store,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => audits.push(entry),
});

expectEqual(configured.status, "configured", "a valid configuration is stored");
let firstConfigId = "";
if (configured.status === "configured") {
  const config = configured.config;
  firstConfigId = config.id;
  expectEqual(config.status, "pending_activation", "a new key waits for its connection test");
  expectEqual(config.version, 1, "a new key starts at version 1");
  expectEqual(config.environment, "sandbox", "the key keeps its environment");
  expectEqual(config.programId, programId, "the program id is stored");
  expectEqual(config.companyId, companyId, "the key belongs to the company");
  expectEqual(config.lastTest, null, "a new key has no test");
  expectEqual(config.createdAtEpochMs, 1_000, "the key records its creation instant");
  expect(isSecretEnvelope(config.clientIdSealed), "the client id is sealed");
  expect(isSecretEnvelope(config.clientSecretSealed), "the client secret is sealed");
  expect(payoneerConfigIsSealed(config), "the stored pair is a sealed pair");
  expect(config.clientIdSealed.startsWith("kd1."), "the envelope names this platform's format");
  expect(config.clientSecretSealed.includes(clientSecret) === false, "the envelope does not carry the plaintext secret");
  expect(config.clientIdSealed.includes(clientId) === false, "the envelope does not carry the plaintext id");
  expectEqual(configured.view.clientIdMasked.endsWith(clientId.slice(-4)), true, "the view masks the client id to its last four characters");
  expectEqual(configured.view.clientIdMasked.length, 16, "the masked client id is the mask and four characters");
  expectEqual(configured.view.clientSecretMasked.endsWith(clientSecret.slice(-4)), true, "the view shows the secret's last four characters");
  expectEqual(configured.view.clientSecretMasked.includes(clientSecret), false, "the view never shows the whole secret");
  expectEqual(configured.view.lastTestOutcome, null, "the view has no test yet");
  expectEqual(store.findById(config.id)?.id, config.id, "the key is stored");
  expectEqual(store.findPendingByCompany(companyId)?.id, config.id, "the key is the pending one");
  expectEqual(store.findActiveByCompany(companyId), null, "the key is not active before its test");
}
expectEqual(audits.length, 1, "configuring writes one audit entry");
expectEqual(audits[0]?.action, "provider_key.configured", "the audit entry names the configuration");
expectEqual(audits[0]?.configId, firstConfigId, "the audit entry names the key");
expectEqual(audits[0]?.environment, "sandbox", "the audit entry names the environment");
expect(JSON.stringify(audits).includes(clientSecret) === false, "the audit trail carries no secret");
expect(JSON.stringify(configured).includes(clientSecret) === false, "the configuring result carries no secret");
expect(JSON.stringify(configured).includes(clientId) === false, "the configuring result carries no client id");

const secondPending = configurePayoneerKeys(inputOf({ clientId: "client-id-Z9Y8X7W6V5U4" }), { store, keyring, occurredAtEpochMs: 1_001 });
expectEqual(secondPending.status, "failed", "a second key cannot wait for a test at the same time");
if (secondPending.status === "failed") {
  expectEqual(secondPending.reason, "this company already has a key waiting for its connection test", "the refusal names the pending key");
}

const invalidStore = new InMemoryPayoneerConfigStore();
expectEqual(
  configurePayoneerKeys(inputOf({ clientId: "short" }), { store: invalidStore, keyring, occurredAtEpochMs: 1_002 }).status,
  "failed",
  "an invalid client id is refused before anything is sealed",
);
expectEqual(
  configurePayoneerKeys(inputOf({ clientSecret: "short" }), { store: invalidStore, keyring, occurredAtEpochMs: 1_003 }).status,
  "failed",
  "an invalid client secret is refused before anything is sealed",
);
expectEqual(invalidStore.findByCompany(companyId).length, 0, "a refused configuration writes no key");

const badKeyring = configurePayoneerKeys(inputOf(), {
  store: new InMemoryPayoneerConfigStore(),
  keyring: { primary: { id: "k1", secret: Buffer.alloc(16, 1).toString("base64") } },
  occurredAtEpochMs: 1_004,
});
expectEqual(badKeyring.status, "failed", "a keyring whose key is not 32 bytes cannot seal");
if (badKeyring.status === "failed") {
  expectEqual(badKeyring.reason, "the encryption keyring cannot seal a credential", "the refusal names the keyring, not the key");
}

/* ---- the masked view of a stored key ---- */

const storedView = payoneerKeyViewOf(store.findById(firstConfigId) as PayoneerKeyConfig, keyring);
expectEqual(storedView.status, "shown", "the stored key can be shown masked");
if (storedView.status === "shown") {
  expectEqual(storedView.view.clientSecretMasked.endsWith(clientSecret.slice(-4)), true, "the stored view shows the secret's last four characters");
  expectEqual(storedView.view.status, "pending_activation", "the stored view names the status");
  expectEqual(storedView.view.programId, programId, "the stored view names the program");
}
const foreignView = payoneerKeyViewOf(store.findById(firstConfigId) as PayoneerKeyConfig, foreignKeyring);
expectEqual(foreignView.status, "failed", "another keyring cannot open the sealed credentials");
const otherCompanyConfig: PayoneerKeyConfig = {
  ...(store.findById(firstConfigId) as PayoneerKeyConfig),
  companyId: "018f2b8a-0000-4000-8000-00000000a002",
};
expectEqual(payoneerKeyViewOf(otherCompanyConfig, keyring).status, "failed", "a key moved to another company cannot be opened");

/* ------------------------------------------------------------------------------------------------
 * Section 4: the connection test
 * --------------------------------------------------------------------------------------------- */

const callCount = { count: 0 };
const connected = await testPayoneerConnection(firstConfigId, connectionOptions(store, audits, successTransport(callCount)));
expectEqual(callCount.count, 1, "the connection test makes one grant");
expectEqual(connected.outcome, "connected", "a token proves the credentials");
expectEqual(connected.tokenObtained, true, "the test reports that it obtained a token");
expectEqual(connected.programVerified, false, "the test never pretends to have proven the program");
expectEqual(connected.configId, firstConfigId, "the test names its key");
expectEqual(connected.environment, "sandbox", "the test names its environment");
expectEqual(connected.version, 2, "the test advances the key's version");
expect(connected.reason.includes("token"), "the connected reason names the token");
expect(JSON.stringify(connected).includes("token_ABCDEFGH12345678") === false, "the test result never carries the token");
expect(JSON.stringify(connected).includes(clientSecret) === false, "the test result never carries the secret");
expectEqual(store.findById(firstConfigId)?.lastTest?.outcome, "connected", "the passing test is recorded on the key");
expectEqual(store.findById(firstConfigId)?.lastTest?.environment, "sandbox", "the recorded test names its environment");
expectEqual(store.findById(firstConfigId)?.lastTest?.testedAtEpochMs, 2_000, "the recorded test carries its instant");
expectEqual(audits.at(-1)?.action, "provider_key.tested", "the test is audited");
expectEqual(audits.at(-1)?.outcome, "connected", "the audit entry records the outcome");
expect(JSON.stringify(audits).includes("token_ABCDEFGH12345678") === false, "the audit trail never carries the token");

const rejectedStore = new InMemoryPayoneerConfigStore();
const rejectedAudits: PayoneerKeyAuditEntry[] = [];
const rejectedConfig = configurePayoneerKeys(inputOf(), { store: rejectedStore, keyring, occurredAtEpochMs: 1_000 });
expectEqual(rejectedConfig.status, "configured", "a key is configured for the rejected case");
const rejectedId = rejectedConfig.status === "configured" ? rejectedConfig.config.id : "";

const rejectedTest = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, rejectedAudits, async () => ({
    status: 400,
    body: JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed" }),
  })),
);
expectEqual(rejectedTest.outcome, "rejected", "invalid_client is a rejected credential");
expectEqual(rejectedTest.tokenObtained, false, "a rejected credential obtains no token");
if (rejectedTest.outcome === "rejected") {
  expect(rejectedTest.reason.includes("Client authentication failed"), "the provider message is carried, sanitised");
}
expectEqual(rejectedStore.findById(rejectedId)?.lastTest?.outcome, "rejected", "a rejected test is recorded on the key");

const unauthorised = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 401, body: "" })),
);
expectEqual(unauthorised.outcome, "rejected", "401 is a rejected credential");

const forbidden = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 403, body: "{}" })),
);
expectEqual(forbidden.outcome, "rejected", "403 is a rejected credential");

const throttled = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 429, body: "" })),
);
expectEqual(throttled.outcome, "unreachable", "429 is not a judgement on the credentials");
expectEqual(throttled.tokenObtained, false, "an unreachable host obtains no token");

const serverError = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 503, body: "" })),
);
expectEqual(serverError.outcome, "unreachable", "503 is unreachable");

const timedOut = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 408, body: "" })),
);
expectEqual(timedOut.outcome, "unreachable", "408 is unreachable");

const thrown = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => {
    throw new Error(clientSecret);
  }),
);
expectEqual(thrown.outcome, "unreachable", "a transport failure is unreachable, never a wrong credential");
expect(JSON.stringify(thrown).includes(clientSecret) === false, "a thrown transport error never leaks the secret");

const emptyAnswer = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 200, body: "" })),
);
expectEqual(emptyAnswer.outcome, "failed", "an empty 200 proves nothing");
const arrayAnswer = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 200, body: "[]" })),
);
expectEqual(arrayAnswer.outcome, "failed", "an array answer proves nothing");
const shapelessToken = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 200, body: JSON.stringify({ access_token: "  " }) })),
);
expectEqual(shapelessToken.outcome, "failed", "a blank token proves nothing");
const alternativeToken = await testPayoneerConnection(
  rejectedId,
  connectionOptions(rejectedStore, [], async () => ({ status: 200, body: JSON.stringify({ token: "token_ZZZZZZZZ99999999" }) })),
);
expectEqual(alternativeToken.outcome, "connected", "the documented token field alias is accepted");

const unknownTest = await testPayoneerConnection("00000000-0000-4000-8000-0000000000ff", connectionOptions(rejectedStore, []));
expectEqual(unknownTest.outcome, "invalid_configuration", "an unknown key cannot be tested");
expectEqual(unknownTest.configId, null, "an unknown key has no id to report");

const productionStore = new InMemoryPayoneerConfigStore();
const productionKeys = configurePayoneerKeys(inputOf({ environment: "production" }), {
  store: productionStore,
  keyring,
  occurredAtEpochMs: 1_100,
});
const productionId = productionKeys.status === "configured" ? productionKeys.config.id : "";
const productionCalls = { count: 0 };
const productionTest = await testPayoneerConnection(productionId, {
  store: productionStore,
  keyring,
  occurredAtEpochMs: 1_101,
  transport: async (endpoint) => {
    productionCalls.count += 1;
    expectEqual(endpoint, "https://login.payoneer.com/oauth2/token", "a production key tests against the production host");
    return { status: 200, body: JSON.stringify({ access_token: "token_PRODUCTION1234567" }) };
  },
});
expectEqual(productionTest.outcome, "connected", "a production key tests against its own environment");
expectEqual(productionCalls.count, 1, "the production test makes one grant");

/* ---- the token answer parser on its own ---- */

expectEqual(parsePayoneerTokenAnswer(200, JSON.stringify({ access_token: "token_1234567890" })).outcome, "connected", "a token answer is connected");
expectEqual(parsePayoneerTokenAnswer(201, JSON.stringify({ access_token: "token_1234567890" })).outcome, "connected", "a 2xx token answer is connected");
expectEqual(parsePayoneerTokenAnswer(204, "").outcome, "failed", "a 204 carries no token");
expectEqual(parsePayoneerTokenAnswer(400, "{}").outcome, "rejected", "400 is rejected even without a message");
expectEqual(parsePayoneerTokenAnswer(302, "").outcome, "rejected", "a redirect is never a token");

/* ------------------------------------------------------------------------------------------------
 * Section 5: the transport
 * --------------------------------------------------------------------------------------------- */

const originalFetch = globalThis.fetch;
try {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(JSON.stringify({ access_token: "token_FROMFETCH12345678" }), { status: 200 });
  };
  const answer = await payoneerFetchTokenTransport(payoneerTokenEndpointFor("sandbox"), clientId, clientSecret);
  expectEqual(seenUrl, "https://login.sandbox.payoneer.com/oauth2/token", "the transport posts to the documented token endpoint");
  expectEqual(seenInit?.method, "POST", "the transport posts");
  expectEqual(seenInit?.redirect, "error", "the transport refuses redirects");
  expectEqual(JSON.stringify(seenInit?.headers).includes("application/x-www-form-urlencoded"), true, "the transport sends a form body");
  const body = String(seenInit?.body);
  expect(body.includes("grant_type=client_credentials"), "the grant names the client credentials grant");
  expect(body.includes(`client_id=${encodeURIComponent(clientId)}`), "the grant sends the client id");
  expect(body.includes(`client_secret=${encodeURIComponent(clientSecret)}`), "the grant sends the client secret");
  expectEqual(answer.status, 200, "the transport returns the status");
  expect(answer.body.includes("access_token"), "the transport returns the raw body");

  globalThis.fetch = async () => new Response("", { status: 401 });
  const refused = await payoneerFetchTokenTransport(payoneerTokenEndpointFor("production"), clientId, clientSecret);
  expectEqual(refused.status, 401, "a 401 answer is returned, not thrown");

  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200 });
  await expectRejection(
    () => payoneerFetchTokenTransport(payoneerTokenEndpointFor("sandbox"), clientId, clientSecret),
    "an oversized token answer is refused",
  );

  await expectRejection(
    () => payoneerFetchTokenTransport("https://login.evil.example/oauth2/token", clientId, clientSecret),
    "an undocumented auth host is refused",
  );
  await expectRejection(
    () => payoneerFetchTokenTransport(payoneerTokenEndpointFor("sandbox"), "", clientSecret),
    "a grant without a client id is refused",
  );
  await expectRejection(
    () => payoneerFetchTokenTransport(payoneerTokenEndpointFor("sandbox"), clientId, " "),
    "a grant without a client secret is refused",
  );
} finally {
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------------------------------------
 * Section 6: activation refuses an unproven key
 * --------------------------------------------------------------------------------------------- */

const activationStore = new InMemoryPayoneerConfigStore();
const activationAudits: PayoneerKeyAuditEntry[] = [];
const activationKeys = configurePayoneerKeys(inputOf(), {
  store: activationStore,
  keyring,
  occurredAtEpochMs: 1_000,
  recordAudit: (entry) => activationAudits.push(entry),
});
const activationId = activationKeys.status === "configured" ? activationKeys.config.id : "";

const untested = activatePayoneerConfig(activationId, {
  store: activationStore,
  occurredAtEpochMs: 1_500,
  recordAudit: (entry) => activationAudits.push(entry),
});
expectEqual(untested.status, "failed", "a key that was never tested cannot be activated");
if (untested.status === "failed") {
  expectEqual(untested.reason, "the connection test has not been run for this key", "the refusal names the missing test");
}
expectEqual(activationStore.findActiveByCompany(companyId), null, "the untested key is not active");

const failedTestStore = new InMemoryPayoneerConfigStore();
const failedTestKeys = configurePayoneerKeys(inputOf(), { store: failedTestStore, keyring, occurredAtEpochMs: 1_000 });
const failedTestId = failedTestKeys.status === "configured" ? failedTestKeys.config.id : "";
await testPayoneerConnection(
  failedTestId,
  connectionOptions(failedTestStore, [], async () => ({ status: 401, body: "" })),
);
const activationAfterFailure = activatePayoneerConfig(failedTestId, { store: failedTestStore, occurredAtEpochMs: 1_600 });
expectEqual(activationAfterFailure.status, "failed", "a key whose test failed cannot be activated");
if (activationAfterFailure.status === "failed") {
  expectEqual(
    activationAfterFailure.reason,
    "the last connection test did not pass, so this key cannot be activated",
    "the refusal names the failed test",
  );
}

const connectedAgain = await testPayoneerConnection(activationId, connectionOptions(activationStore, activationAudits, successTransport({ count: 0 })));
expectEqual(connectedAgain.outcome, "connected", "the key is proven before activation");
const activated = activatePayoneerConfig(activationId, {
  store: activationStore,
  occurredAtEpochMs: 1_700,
  recordAudit: (entry) => activationAudits.push(entry),
});
expectEqual(activated.status, "activated", "a proven key activates");
if (activated.status === "activated") {
  expectEqual(activated.config.status, "active", "the key becomes active");
  expectEqual(activated.config.version, 3, "activation advances the version");
  expectEqual(activated.supersededConfigId, null, "the first key supersedes nothing");
}
expectEqual(activationStore.findActiveByCompany(companyId)?.id, activationId, "the proven key is the active one");
expectEqual(activationStore.findPendingByCompany(companyId), null, "the key no longer waits for a test");
expectEqual(activationAudits.filter((entry) => entry.action === "provider_key.activated").length, 1, "activation is audited once");
expect(
  activationAudits.some((entry) => entry.action === "provider_key.rotated") === false,
  "the first activation rotates nothing",
);
expect(JSON.stringify(activationAudits).includes(clientSecret) === false, "no audit entry carries the secret");

const activatedTwice = activatePayoneerConfig(activationId, { store: activationStore, occurredAtEpochMs: 1_800 });
expectEqual(activatedTwice.status, "failed", "an active key cannot be activated again");

const retiredFirst = retirePayoneerConfig(activationId, { store: activationStore, occurredAtEpochMs: 1_900 });
expectEqual(retiredFirst.status, "failed", "the active key cannot be retired");
if (retiredFirst.status === "failed") {
  expectEqual(retiredFirst.reason, "the active key cannot be retired; activate its replacement first", "the refusal explains the order");
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: the rotation procedure, in the documented order
 * --------------------------------------------------------------------------------------------- */

const rotationStore = new InMemoryPayoneerConfigStore();
const rotationAudits: PayoneerKeyAuditEntry[] = [];
const oldKey = configurePayoneerKeys(inputOf(), {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 10_000,
  recordAudit: (entry) => rotationAudits.push(entry),
});
const oldKeyId = oldKey.status === "configured" ? oldKey.config.id : "";
await testPayoneerConnection(oldKeyId, connectionOptions(rotationStore, rotationAudits, successTransport({ count: 0 })));
activatePayoneerConfig(oldKeyId, {
  store: rotationStore,
  occurredAtEpochMs: 10_100,
  recordAudit: (entry) => rotationAudits.push(entry),
});

const newKey = configurePayoneerKeys(inputOf({ clientId: "client-id-NEWKEY12345", clientSecret: "secret-NEWKEY-1234567890" }), {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 10_200,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(newKey.status, "configured", "a replacement key is added while the old one stays active");
const newKeyId = newKey.status === "configured" ? newKey.config.id : "";

const newKeyTest = await testPayoneerConnection(newKeyId, {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 10_300,
  recordAudit: (entry) => rotationAudits.push(entry),
  transport: async () => ({ status: 200, body: JSON.stringify({ access_token: "token_NEWKEY123456789" }) }),
});
expectEqual(newKeyTest.outcome, "connected", "the replacement key is proven");
expectEqual(rotationStore.findActiveByCompany(companyId)?.id, oldKeyId, "the old key is still active before the switch");

const rotated = activatePayoneerConfig(newKeyId, {
  store: rotationStore,
  occurredAtEpochMs: 10_400,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(rotated.status, "activated", "the proven replacement activates");
if (rotated.status === "activated") {
  expectEqual(rotated.supersededConfigId, oldKeyId, "the old key is named as superseded");
}
expectEqual(rotationStore.findActiveByCompany(companyId)?.id, newKeyId, "the replacement is now the active key");
expectEqual(rotationStore.findById(oldKeyId)?.status, "superseded", "the old key is superseded, still readable");
expectEqual(rotationAudits.filter((entry) => entry.action === "provider_key.rotated").length, 1, "the rotation is audited once");
expect(
  rotationAudits.some((entry) => entry.action === "provider_key.rotated" && entry.configId === oldKeyId),
  "the rotation audit entry names the superseded key",
);

const oldKeyStillReadable = payoneerKeyViewOf(rotationStore.findById(oldKeyId) as PayoneerKeyConfig, keyring);
expectEqual(oldKeyStillReadable.status, "shown", "the superseded key is still readable during the rotation window");

const reactivateOld = activatePayoneerConfig(oldKeyId, { store: rotationStore, occurredAtEpochMs: 10_500 });
expectEqual(reactivateOld.status, "failed", "a superseded key cannot be activated again");

const removedOldKey = retirePayoneerConfig(oldKeyId, {
  store: rotationStore,
  occurredAtEpochMs: 10_600,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(removedOldKey.status, "retired", "the old key is removed after the switch");
if (removedOldKey.status === "retired") {
  expectEqual(removedOldKey.config.status, "retired", "the removed key is retired");
}
expectEqual(rotationAudits.filter((entry) => entry.action === "provider_key.retired").length, 1, "the removal is audited");
expectEqual(rotationStore.findByCompany(companyId).length, 2, "both keys are kept as history");
expectEqual(rotationStore.findById(oldKeyId)?.status, "retired", "the history shows the old key retired");
expectEqual(rotationStore.findById(newKeyId)?.status, "active", "the history shows the new key active");

const retiredTest = await testPayoneerConnection(oldKeyId, connectionOptions(rotationStore, []));
expectEqual(retiredTest.outcome, "invalid_configuration", "a retired key cannot be tested");

const retireAgain = retirePayoneerConfig(oldKeyId, { store: rotationStore, occurredAtEpochMs: 10_700 });
expectEqual(retireAgain.status, "failed", "a retired key cannot be retired twice");

const cancelPending = configurePayoneerKeys(inputOf({ clientId: "client-id-CANCEL123456" }), {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: 10_800,
});
const cancelId = cancelPending.status === "configured" ? cancelPending.config.id : "";
expectEqual(cancelPending.status, "configured", "a pending key can be added for cancellation");
expectEqual(retirePayoneerConfig(cancelId, { store: rotationStore, occurredAtEpochMs: 10_900 }).status, "retired", "an unproven key can be cancelled");
expectEqual(rotationStore.findActiveByCompany(companyId)?.id, newKeyId, "cancelling a pending key leaves the active key alone");

/* ------------------------------------------------------------------------------------------------
 * Section 8: a test that ran against another environment cannot authorize activation
 * --------------------------------------------------------------------------------------------- */

const mismatchedStore = new InMemoryPayoneerConfigStore();
const mismatchedCompany = "018f2b8a-0000-4000-8000-00000000a003";
const mismatchedConfig: PayoneerKeyConfig = {
  id: "00000000-0000-4000-8000-0000000000cc",
  companyId: mismatchedCompany,
  environment: "production",
  clientIdSealed: sealSecret(keyring, clientId, { purpose: "secret", scope: payoneerClientIdScope(mismatchedCompany) }),
  clientSecretSealed: sealSecret(keyring, clientSecret, { purpose: "secret", scope: payoneerClientSecretScope(mismatchedCompany) }),
  programId,
  status: "pending_activation",
  version: 1,
  lastTest: { outcome: "connected", testedAtEpochMs: 1, environment: "sandbox" },
  createdAtEpochMs: 1,
  updatedAtEpochMs: 1,
};
mismatchedStore.insert(mismatchedConfig);
const mismatchedActivation = activatePayoneerConfig(mismatchedConfig.id, { store: mismatchedStore, occurredAtEpochMs: 2 });
expectEqual(mismatchedActivation.status, "failed", "a sandbox test cannot authorize a production key");
if (mismatchedActivation.status === "failed") {
  expectEqual(mismatchedActivation.reason, "the connection test ran against another environment", "the refusal names the environment mismatch");
}

/* ------------------------------------------------------------------------------------------------
 * Section 9: the store's own rules
 * --------------------------------------------------------------------------------------------- */

const storeRules = new InMemoryPayoneerConfigStore();
const seed = rotationStore.findById(newKeyId) as PayoneerKeyConfig;
const storeSeed: PayoneerKeyConfig = {
  ...seed,
  id: "00000000-0000-4000-8000-0000000000dd",
  companyId: "018f2b8a-0000-4000-8000-00000000a004",
  status: "pending_activation",
  version: 1,
  lastTest: null,
};
storeRules.insert(storeSeed);
expectThrows(() => storeRules.insert(storeSeed), "a duplicate configuration id is refused");
expectThrows(
  () => storeRules.insert({ ...storeSeed, id: "00000000-0000-4000-8000-0000000000de", version: 3 }),
  "a configuration must start at version 1",
);
expectThrows(
  () => storeRules.insert({ ...storeSeed, id: "00000000-0000-4000-8000-0000000000df" }),
  "a second pending key for one company is refused",
);
expectThrows(
  () => storeRules.insert({ ...storeSeed, id: "00000000-0000-4000-8000-0000000000e1", companyId: "018f2b8a-0000-4000-8000-00000000a005", status: "active" }),
  "a key may not be inserted as active",
);
expectEqual(storeRules.save({ ...storeSeed, version: 2, status: "active" }, 1), false, "insert-time status rules apply to saves too");
expectEqual(storeRules.save({ ...storeSeed, version: 3 }, 1), false, "a version jump is refused");
expectEqual(storeRules.save({ ...storeSeed, version: 2, companyId: "018f2b8a-0000-4000-8000-00000000a006" }, 1), false, "a key never changes company");
expectEqual(
  storeRules.save({ ...storeSeed, version: 2, clientSecretSealed: sealSecret(keyring, "another-secret-123456", { purpose: "secret", scope: payoneerClientSecretScope(storeSeed.companyId) }) }, 1),
  false,
  "a sealed credential never changes on an existing key",
);
expectEqual(storeRules.save({ ...storeSeed, version: 2, lastTest: { outcome: "connected", testedAtEpochMs: 5, environment: "sandbox" } }, 1), true, "a test is written with the version guard");
expectEqual(storeRules.save({ ...storeSeed, version: 3, lastTest: { outcome: "rejected", testedAtEpochMs: 6, environment: "sandbox" } }, 1), false, "a stale write is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 10: key rotation of the keyring itself
 * --------------------------------------------------------------------------------------------- */

const sealedUnderOld = store.findById(firstConfigId) as PayoneerKeyConfig;
const viewUnderRotated = payoneerKeyViewOf(sealedUnderOld, rotatedKeyring);
expectEqual(viewUnderRotated.status, "shown", "a keyring that keeps the old key opens an old envelope");
const testUnderRotated = await testPayoneerConnection(
  firstConfigId,
  { store, keyring: rotatedKeyring, occurredAtEpochMs: 3_000, transport: successTransport({ count: 0 }) },
);
expectEqual(testUnderRotated.outcome, "connected", "a rotated keyring still reads the credential it inherited");
const sealedUnderNew = sealSecret(rotatedKeyring, clientSecret, {
  purpose: "secret",
  scope: payoneerClientSecretScope(companyId),
});
const openUnderOld = (() => {
  try {
    const probe = configurePayoneerKeys(inputOf({ clientId: "client-id-PROBE1234567", clientSecret: "secret-PROBE-1234567890" }), {
      store: new InMemoryPayoneerConfigStore(),
      keyring: rotatedKeyring,
      occurredAtEpochMs: 3_100,
    });
    if (probe.status !== "configured") return "probe failed";
    return payoneerKeyViewOf(probe.config, keyring).status;
  } catch {
    return "threw";
  }
})();
expect(openUnderOld !== "shown", "a keyring without the new key cannot open what the new key wrote");
expect(sealedUnderNew.startsWith("kd1.k2."), "an envelope names the key that wrote it");

/* ---- the sealed-pair check ---- */

expect(payoneerConfigIsSealed(sealedUnderOld), "a stored pair passes the sealed check");
expect(
  payoneerConfigIsSealed({ ...sealedUnderOld, clientSecretSealed: "plaintext-secret-value" }) === false,
  "a plaintext credential never passes the sealed check",
);

/* ---- nothing anywhere carries a credential ---- */

const everything = JSON.stringify({
  configured,
  storedView,
  connected,
  rejectedTest,
  activated,
  rotated,
  rotationAudits,
  storeState: rotationStore.findByCompany(companyId),
});
expect(everything.includes(clientSecret) === false, "no outcome, audit entry or stored row carries the secret");
expect(everything.includes(clientId) === false, "no outcome, audit entry or stored row carries the client id");
expect(everything.includes("token_") === false, "no outcome, audit entry or stored row carries a token");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Payoneer key gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Payoneer key gate passed: ${checks} checks (sealed credentials with a bound scope, masked views, the documented token grant, activation only after a passing test, and the full rotation procedure)\n`,
);
