// path: lib/payments/adapters/airwallex-client-verify.ts

/**
 * The gate for STEP 166: the sealed Airwallex credentials, the documented two-call connection test, and the
 * transitions that let a screen enable the provider only on a test it passed.
 *
 * A check script, not a test file. It seals fixtures with a keyring built here, drives a recording transport
 * through the documented answers, and fails naming every check that did not hold. No network call is made and no
 * real credential exists.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  activateAirwallexConfig,
  airwallexAccessTokenFor,
  airwallexApiKeyScope,
  airwallexBaseUrlFor,
  airwallexClientCodeOf,
  airwallexClientEndpoint,
  airwallexClientIdScope,
  airwallexClientMessageOf,
  airwallexKeyViewOf,
  airwallexTokenIsUsable,
  airwallexWebhookSecretScope,
  configureAirwallexKeys,
  InMemoryAirwallexConfigStore,
  InMemoryAirwallexTokenCache,
  maskAirwallexCredential,
  parseAirwallexBalancesAnswer,
  parseAirwallexLoginAnswer,
  probeAirwallexApiVersions,
  retireAirwallexConfig,
  rotateAirwallexWebhookSecret,
  testAirwallexConnection,
  validateAirwallexKeyInput,
  AIRWALLEX_ANSWER_MAXIMUM_BYTES,
  AIRWALLEX_BASE_URLS,
  AIRWALLEX_CLIENT_ALLOWED_PATHS,
  AIRWALLEX_CLIENT_TEXT_MAXIMUM_LENGTH,
  AIRWALLEX_CLIENT_TIMEOUT_MS,
  AIRWALLEX_COMPANY_ID_PATTERN,
  AIRWALLEX_CONNECTION_PATH,
  AIRWALLEX_LOGIN_PATH,
  AIRWALLEX_MAXIMUM_VERSION_PROBES,
  AIRWALLEX_TOKEN_CACHE_BUDGET_SECONDS,
  AIRWALLEX_VERSION_CANDIDATES,
  AIRWALLEX_WEBHOOK_SECRET_MAXIMUM_LENGTH,
  airwallexFetchTransport,
  type AirwallexClientCall,
  type AirwallexClientTransport,
  type ConfigureAirwallexKeysInput,
} from "./airwallex-client.ts";
import {
  AIRWALLEX_API_KEY_HEADER,
  AIRWALLEX_API_VERSION_HEADER,
  AIRWALLEX_CLIENT_ID_HEADER,
  AIRWALLEX_DEFAULT_API_VERSION,
  AIRWALLEX_OBSERVED_API_VERSIONS,
  AIRWALLEX_PRODUCTION_BASE,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_SANDBOX_BASE,
  AIRWALLEX_TOKEN_LIFETIME_SECONDS,
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

const fixture = (prefix: string, body: string): string => `${prefix}_${body}`;
const clientId = fixture("cid", "AbCd1234EfGh5678");
const apiKey = fixture("key", "ZzYyXx9876WwVvUuTtSsRrQq");
const secondApiKey = fixture("key", "SecondKeyValue9876543210Ab");
const webhookSecret = fixture("whsec", "airwallexwebhooksecretvalue");
const secondWebhookSecret = fixture("whsec", "secondairwallexwebhooksecret");
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const NOW = 1_760_000_000_000;
const accessToken = "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MjQwMDAwMDB9.c2lnbmF0dXJlLXZhbHVl";
const tokenExpiryIso = "2026-01-01T12:30:00+0000";
const tokenExpiryMs = Date.UTC(2026, 0, 1, 12, 30, 0);

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const foreignKeyring: EncryptionKeyring = { primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") } };

const input: ConfigureAirwallexKeysInput = {
  companyId,
  environment: "sandbox",
  clientId,
  apiKey,
  webhookSecret,
};

const loginAnswer = JSON.stringify({ token: accessToken, expires_at: tokenExpiryIso });
const balancesAnswer = JSON.stringify([
  { currency: "USD", available_amount: 100, pending_amount: 0 },
  { currency: "AUD", available_amount: 20, pending_amount: 1 },
]);

function transportReturning(
  answerFor: (call: AirwallexClientCall) => { readonly status: number; readonly body: string },
): { readonly calls: AirwallexClientCall[]; readonly transport: AirwallexClientTransport } {
  const calls: AirwallexClientCall[] = [];
  const transport: AirwallexClientTransport = async (call) => {
    calls.push(call);
    return answerFor(call);
  };
  return { calls, transport };
}

/** The documented happy path: a token from the login, a list from the authenticated read. */
function happyTransport(): { readonly calls: AirwallexClientCall[]; readonly transport: AirwallexClientTransport } {
  return transportReturning((call) =>
    call.path === AIRWALLEX_LOGIN_PATH ? { status: 201, body: loginAnswer } : { status: 200, body: balancesAnswer },
  );
}

function configuredStore(overrides: Partial<ConfigureAirwallexKeysInput> = {}): {
  readonly store: InMemoryAirwallexConfigStore;
  readonly configId: string;
} {
  const store = new InMemoryAirwallexConfigStore();
  const result = configureAirwallexKeys({ ...input, ...overrides }, { store, keyring, occurredAtEpochMs: NOW });
  if (result.status !== "configured") throw new Error(`the fixture configuration failed: ${result.reason}`);
  return { store, configId: result.config.id };
}

/* ---- the documented surface ---- */

expectEqual(AIRWALLEX_BASE_URLS["sandbox"], AIRWALLEX_SANDBOX_BASE, "the sandbox base is the documented host");
expectEqual(AIRWALLEX_BASE_URLS["live"], AIRWALLEX_PRODUCTION_BASE, "the live base is the documented host");
expect(Object.isFrozen(AIRWALLEX_BASE_URLS), "the base-URL table is frozen");
expectEqual(airwallexBaseUrlFor("sandbox"), AIRWALLEX_SANDBOX_BASE, "the sandbox mode maps to its host");
expectEqual(airwallexBaseUrlFor("live"), AIRWALLEX_PRODUCTION_BASE, "the live mode maps to its host");
expectEqual(
  airwallexClientEndpoint("sandbox", AIRWALLEX_LOGIN_PATH),
  `${AIRWALLEX_SANDBOX_BASE}${AIRWALLEX_LOGIN_PATH}`,
  "the login endpoint is built from the documented host and path",
);
expectEqual(AIRWALLEX_LOGIN_PATH, "/api/v1/authentication/login", "the documented login path is kept");
expectEqual(AIRWALLEX_CONNECTION_PATH, "/api/v1/balances/current", "the documented balances path is kept");
expectEqual(AIRWALLEX_CLIENT_ALLOWED_PATHS.length, 2, "the allowlist is exactly the two documented paths");
expect(AIRWALLEX_CLIENT_ALLOWED_PATHS.includes(AIRWALLEX_LOGIN_PATH), "the login path is allowlisted");
expect(AIRWALLEX_CLIENT_ALLOWED_PATHS.includes(AIRWALLEX_CONNECTION_PATH), "the balances path is allowlisted");
expect(Object.isFrozen(AIRWALLEX_CLIENT_ALLOWED_PATHS), "the allowlist is frozen");
expectEqual(AIRWALLEX_CLIENT_TIMEOUT_MS, 15_000, "the call timeout is bounded");
expectEqual(AIRWALLEX_ANSWER_MAXIMUM_BYTES, 65_536, "the answer size is bounded");
expectEqual(AIRWALLEX_CLIENT_TEXT_MAXIMUM_LENGTH, 200, "the provider text is bounded");
expectEqual(AIRWALLEX_PROVIDER_KEY, "airwallex", "the provider key is the registry key");
expectEqual(AIRWALLEX_TOKEN_CACHE_BUDGET_SECONDS, AIRWALLEX_TOKEN_LIFETIME_SECONDS, "the token budget is the documented lifetime");
expectEqual(AIRWALLEX_TOKEN_CACHE_BUDGET_SECONDS, 1_800, "the documented lifetime is thirty minutes");
expect(AIRWALLEX_COMPANY_ID_PATTERN.test(companyId), "a company id is accepted");
expect(AIRWALLEX_COMPANY_ID_PATTERN.test("bad id") === false, "a company id with a space is refused");

/* ---- the sealed scopes ---- */

expectEqual(airwallexClientIdScope(companyId), `airwallex:client-id:${companyId}`, "the client id scope is named");
expectEqual(airwallexApiKeyScope(companyId), `airwallex:api-key:${companyId}`, "the API key scope is named");
expectEqual(
  airwallexWebhookSecretScope(companyId),
  `airwallex:webhook-secret:${companyId}`,
  "the webhook secret scope is named",
);
expect(airwallexClientIdScope(companyId) !== airwallexApiKeyScope(companyId), "the two credentials use different scopes");
expect(airwallexApiKeyScope(companyId) !== airwallexWebhookSecretScope(companyId), "the webhook secret uses its own scope");
expect(
  airwallexApiKeyScope(companyId) !== airwallexApiKeyScope(otherCompanyId),
  "the same field of two companies uses different scopes",
);

/* ---- validation ---- */

expectEqual(validateAirwallexKeyInput(input), null, "a well formed input is accepted");
expectEqual(
  validateAirwallexKeyInput({ ...input, companyId: "" }),
  "the company id is invalid",
  "an empty company id is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, environment: "demo" as unknown as "sandbox" }),
  "the environment must be sandbox or live",
  "an unrecorded environment is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, clientId: "short" }),
  "the client id must be 8 to 128 characters",
  "a short client id is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, apiKey: "short" }),
  "the API key must be 16 to 256 characters",
  "a short API key is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, apiKey: accessToken }),
  "the API key looks like an access token or a pasted header; store the key, not the token",
  "an access token pasted as the API key is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, clientId: "Bearer abcdefghijklmnop" }),
  "the client id looks like a token or a pasted header, not a client id",
  "a pasted bearer header is refused as a client id",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, clientId: "x-api-key: abcdefghijkl" }),
  "the client id looks like a token or a pasted header, not a client id",
  "a pasted key header is refused as a client id",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, clientId: apiKey, apiKey }),
  "the client id and the API key cannot be the same value",
  "the same value in both fields is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, clientId: `${clientId} extra` }),
  "the client id must be 8 to 128 letters, digits, dashes or underscores",
  "a client id with a space is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, apiVersion: "v1" }),
  "the API version must be a date such as 2026-05-29",
  "a non-date version is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, webhookSecret: "short" }),
  "the webhook secret is too short to be usable",
  "a short webhook secret is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, webhookSecret: `${webhookSecret} with space` }),
  "the webhook secret must not contain whitespace",
  "a webhook secret with whitespace is refused",
);
expectEqual(
  validateAirwallexKeyInput({ ...input, webhookSecret: "w".repeat(AIRWALLEX_WEBHOOK_SECRET_MAXIMUM_LENGTH + 1) }),
  "the webhook secret is too long",
  "an over-long webhook secret is refused",
);
expectEqual(validateAirwallexKeyInput({ ...input, webhookSecret: null }), null, "a configuration without a webhook secret is valid");
expectEqual(
  validateAirwallexKeyInput({ ...input, apiVersion: "2026-08-21" }),
  null,
  "the other recorded version is a valid pin",
);

/* ---- configuring ---- */

{
  const store = new InMemoryAirwallexConfigStore();
  const audits: string[] = [];
  const result = configureAirwallexKeys(input, {
    store,
    keyring,
    occurredAtEpochMs: NOW,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}:${entry.providerKey}`),
  });
  expectEqual(result.status, "configured", "a valid input configures");
  if (result.status !== "configured") throw new Error("unreachable");

  expectEqual(result.config.status, "pending_activation", "a new configuration waits for its test");
  expectEqual(result.config.version, 1, "a new configuration starts at version 1");
  expectEqual(result.config.environment, "sandbox", "the mode is stored");
  expectEqual(result.config.baseUrl, AIRWALLEX_SANDBOX_BASE, "the documented host is stored with the configuration");
  expectEqual(result.config.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the default pin is stored");
  expectEqual(result.config.lastTest, null, "a new configuration has no test");
  expect(result.config.clientIdSealed !== clientId, "the client id is not stored in clear");
  expect(result.config.apiKeySealed !== apiKey, "the API key is not stored in clear");
  expect(result.config.webhookSecretSealed !== webhookSecret, "the webhook secret is not stored in clear");
  expect(result.config.webhookSecretSealed !== null, "the webhook secret is stored as an envelope");
  expect(result.config.clientIdSealed.length > 20, "the client id is an envelope, not a hash of one character");
  expect(asText(result.config).includes(apiKey) === false, "the stored record never carries the API key");
  expect(asText(result.config).includes(clientId) === false, "the stored record never carries the client id");
  expect(asText(result.config).includes(webhookSecret) === false, "the stored record never carries the webhook secret");
  expect(store.findById(result.config.id) !== null, "the configuration is inserted");
  expectEqual(store.findPendingByCompany(companyId)?.id, result.config.id, "the store holds it as pending");
  expectEqual(store.findActiveByCompany(companyId), null, "a pending configuration is not active");

  expectEqual(result.view.clientIdMasked.includes(clientId), false, "the view never shows the full client id");
  expect(result.view.clientIdMasked.endsWith(clientId.slice(-4)), "the view shows the client id's last four characters");
  expect(result.view.apiKeyMasked.endsWith(apiKey.slice(-4)), "the view shows the API key's last four characters");
  expect(result.view.apiKeyMasked.startsWith("****"), "the view hides the body of the API key");
  expect(result.view.webhookSecretMasked !== null, "the view reports that a webhook secret is stored");
  expect(
    result.view.webhookSecretMasked !== null && result.view.webhookSecretMasked.endsWith(webhookSecret.slice(-4)),
    "the view shows the webhook secret's last four characters",
  );
  expectEqual(result.view.updatedAtEpochMs, NOW, "the view carries the last updated time");
  expectEqual(result.view.lastTestedAtEpochMs, null, "an untested configuration shows no test time");
  expectEqual(result.view.status, "pending_activation", "the view names the status");
  expectEqual(audits.join(","), "provider_key.configured:pending_activation:airwallex", "configuring writes one audit entry");
}

{
  const { store } = configuredStore();
  const second = configureAirwallexKeys(input, { store, keyring, occurredAtEpochMs: NOW + 1_000 });
  expectEqual(second.status, "failed", "a second configuration while one is pending is refused");
  expect(
    second.status === "failed" && second.reason.includes("already has a key waiting"),
    "the refusal names the waiting configuration",
  );
  expectEqual(store.findByCompany(companyId).length, 1, "the refused configuration is not stored");
}

{
  const store = new InMemoryAirwallexConfigStore();
  const invalid = configureAirwallexKeys({ ...input, apiKey: "short" }, { store, keyring, occurredAtEpochMs: NOW });
  expectEqual(invalid.status, "failed", "an invalid input configures nothing");
  expectEqual(store.findByCompany(companyId).length, 0, "an invalid input seals nothing");
}

{
  const store = new InMemoryAirwallexConfigStore();
  const result = configureAirwallexKeys(input, { store, keyring: foreignKeyring, occurredAtEpochMs: NOW });
  expectEqual(result.status, "configured", "a keyring with other material still seals");
  if (result.status !== "configured") throw new Error("unreachable");
  const opened = airwallexKeyViewOf(result.config, keyring);
  expectEqual(opened.status, "failed", "a configuration sealed with another keyring cannot be opened");
  expect(opened.status === "failed" && opened.reason.includes("cannot be opened"), "the refusal names the envelopes");
}

{
  const store = new InMemoryAirwallexConfigStore();
  const withoutSecret = configureAirwallexKeys(
    { ...input, webhookSecret: null },
    { store, keyring, occurredAtEpochMs: NOW },
  );
  expectEqual(withoutSecret.status, "configured", "a configuration without a webhook secret is allowed");
  if (withoutSecret.status !== "configured") throw new Error("unreachable");
  expectEqual(withoutSecret.config.webhookSecretSealed, null, "no envelope is written without a secret");
  expectEqual(withoutSecret.view.webhookSecretMasked, null, "the view says no secret is stored");
}

/* ---- the masked view ---- */

expectEqual(maskAirwallexCredential("abcd"), "****", "a short value is hidden entirely");
expectEqual(maskAirwallexCredential("abcdefgh"), "********", "an eight-character value is hidden entirely");
expectEqual(maskAirwallexCredential("abcdefghi"), "************fghi", "a longer value keeps only its last four");
expectEqual(maskAirwallexCredential("abcdefghij").length, 16, "the mask is a fixed twelve plus four");
expectEqual(maskAirwallexCredential("  abcd  "), "****", "the mask trims before deciding");
expectEqual(maskAirwallexCredential("abcdefghij").includes("abcdef"), false, "the mask carries no part but the last four");

{
  const { store, configId } = configuredStore();
  const config = store.findById(configId);
  if (config === null) throw new Error("the fixture configuration is missing");
  const shown = airwallexKeyViewOf(config, keyring);
  expectEqual(shown.status, "shown", "a stored configuration shows a masked view");
  if (shown.status !== "shown") throw new Error("unreachable");
  expect(asText(shown.view).includes(apiKey) === false, "the view never carries the API key");
  expect(asText(shown.view).includes(clientId) === false, "the view never carries the client id");
  expect(asText(shown.view).includes(webhookSecret) === false, "the view never carries the webhook secret");
  expectEqual(shown.view.baseUrl, AIRWALLEX_SANDBOX_BASE, "the view names the host");
  expectEqual(shown.view.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the view names the pin");
  expectEqual(shown.view.status, "pending_activation", "the view names the status");
  expectEqual(shown.view.lastTestOutcome, null, "an untested configuration has no outcome");
  expectEqual(shown.view.companyId, companyId, "the view names the company");
}

/* ---- reading the login answer ---- */

{
  const verdict = parseAirwallexLoginAnswer(201, loginAnswer);
  expectEqual(verdict.outcome, "token_issued", "a documented 201 is a token");
  if (verdict.outcome !== "token_issued") throw new Error("unreachable");
  expectEqual(verdict.token, accessToken, "the token is read");
  expectEqual(verdict.expiresAtEpochMs, tokenExpiryMs, "the documented expires_at is read exactly");
}
expectEqual(
  parseAirwallexLoginAnswer(201, JSON.stringify({ expires_at: tokenExpiryIso })).outcome,
  "unknown",
  "a 201 without a token is unknown",
);
expectEqual(
  parseAirwallexLoginAnswer(201, JSON.stringify({ token: accessToken })).outcome,
  "unknown",
  "a 201 without an expiry is unknown",
);
expectEqual(
  parseAirwallexLoginAnswer(201, JSON.stringify({ token: accessToken, expires_at: "soon" })).outcome,
  "unknown",
  "an unreadable expiry is unknown",
);
expectEqual(parseAirwallexLoginAnswer(201, "not json").outcome, "unknown", "an unparsable 201 is unknown");
expectEqual(parseAirwallexLoginAnswer(201, "").outcome, "unknown", "an empty 201 is unknown");

const invalidCredentials = parseAirwallexLoginAnswer(
  401,
  JSON.stringify({ code: "credentials_invalid", message: "Invalid credentials" }),
);
expectEqual(invalidCredentials.outcome, "credentials_rejected", "a 401 is a credential rejection");
expect(
  invalidCredentials.outcome === "credentials_rejected" && invalidCredentials.code === "credentials_invalid",
  "the documented credentials_invalid code is kept",
);
expect(
  invalidCredentials.outcome === "credentials_rejected" && invalidCredentials.detail === "Invalid credentials",
  "the provider's own message is kept",
);
const expiredCredentials = parseAirwallexLoginAnswer(401, JSON.stringify({ code: "credentials_expired" }));
expect(
  expiredCredentials.outcome === "credentials_rejected" && expiredCredentials.code === "credentials_expired",
  "the documented credentials_expired code is kept",
);
expectEqual(parseAirwallexLoginAnswer(403, "{}").outcome, "not_permitted", "a 403 is not permitted");
expectEqual(parseAirwallexLoginAnswer(400, JSON.stringify({ message: "malformed" })).outcome, "rejected", "a 400 is a rejection");
expectEqual(
  parseAirwallexLoginAnswer(400, JSON.stringify({ code: "incorrect_version", message: "wrong version" })).outcome,
  "version_rejected",
  "the documented incorrect_version code is a version rejection",
);
expectEqual(
  parseAirwallexLoginAnswer(400, JSON.stringify({ code: "request.api_version_unsupported" })).outcome,
  "version_rejected",
  "the unsupported-version code is a version rejection",
);
expectEqual(parseAirwallexLoginAnswer(429, "{}").outcome, "unknown", "a rate limit is unknown");
expectEqual(parseAirwallexLoginAnswer(500, "{}").outcome, "unknown", "a server error is unknown");
expectEqual(parseAirwallexLoginAnswer(408, "{}").outcome, "unknown", "a timeout status is unknown");
expectEqual(parseAirwallexLoginAnswer(302, "").outcome, "unknown", "a redirect proves nothing");
expectEqual(parseAirwallexLoginAnswer(204, "").outcome, "unknown", "a 204 with no token is unknown");
expectEqual(parseAirwallexLoginAnswer(418, "{}").outcome, "rejected", "another 4XX is a rejection");
expectEqual(airwallexClientMessageOf(JSON.parse('{"message":"  bad  key  "}')), "bad key", "the message reader sanitises");
expectEqual(airwallexClientMessageOf(null), "", "the message reader returns empty for nothing");
expectEqual(airwallexClientMessageOf([]), "", "the message reader returns empty for a list");
expectEqual(
  airwallexClientCodeOf(JSON.parse('{"code":"credentials_invalid"}')),
  "credentials_invalid",
  "the code reader reads a code",
);
expectEqual(airwallexClientCodeOf(JSON.parse('{"error_code":"incorrect_version"}')), "incorrect_version", "the code reader reads error_code");
expectEqual(airwallexClientCodeOf(JSON.parse('{"code":"BAD CODE"}')), null, "the code reader refuses a non-code");
expectEqual(airwallexClientCodeOf(null), null, "the code reader returns null for nothing");

/* ---- reading the balances answer ---- */

const accepted = parseAirwallexBalancesAnswer(200, balancesAnswer);
expectEqual(accepted.outcome, "accepted", "a documented list is accepted");
expect(accepted.outcome === "accepted" && accepted.balanceCount === 2, "the balance count is recorded");
const acceptedItems = parseAirwallexBalancesAnswer(200, JSON.stringify({ items: [{ currency: "USD" }] }));
expect(acceptedItems.outcome === "accepted" && acceptedItems.balanceCount === 1, "an items envelope is counted");
const acceptedObject = parseAirwallexBalancesAnswer(200, JSON.stringify({ currency: "USD", available_amount: 1 }));
expect(acceptedObject.outcome === "accepted" && acceptedObject.balanceCount === 1, "a single balance object is accepted");
const emptyList = parseAirwallexBalancesAnswer(200, "[]");
expect(emptyList.outcome === "accepted" && emptyList.balanceCount === 0, "an empty list is still a proven read");
expectEqual(parseAirwallexBalancesAnswer(200, "{}").outcome, "unknown", "an empty object proves nothing");
expectEqual(parseAirwallexBalancesAnswer(200, "not json").outcome, "unknown", "an unparsable 200 is unknown");
expectEqual(parseAirwallexBalancesAnswer(401, "{}").outcome, "token_rejected", "a 401 on the read is a token rejection");
expectEqual(parseAirwallexBalancesAnswer(403, "{}").outcome, "not_permitted", "a 403 on the read is not permitted");
expectEqual(parseAirwallexBalancesAnswer(400, "{}").outcome, "rejected", "a 400 on the read is a rejection");
expectEqual(
  parseAirwallexBalancesAnswer(400, JSON.stringify({ code: "incorrect_version" })).outcome,
  "version_rejected",
  "a version code on the read is a version rejection",
);
expectEqual(parseAirwallexBalancesAnswer(500, "{}").outcome, "unknown", "a 5XX on the read is unknown");
expectEqual(parseAirwallexBalancesAnswer(302, "").outcome, "unknown", "a redirect on the read is unknown");

/* ---- the transport refuses without calling ---- */

await expectRejects(
  () =>
    airwallexFetchTransport({
      method: "GET",
      environment: "sandbox",
      path: "/api/v1/accounts/create",
      clientId: null,
      apiKey: null,
      accessToken: accessToken,
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
    }),
  "a path outside the allowlist is refused before any call",
);
await expectRejects(
  () =>
    airwallexFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_LOGIN_PATH,
      clientId: null,
      apiKey: null,
      accessToken: null,
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
    }),
  "a login without a client id and an API key is refused before any call",
);
await expectRejects(
  () =>
    airwallexFetchTransport({
      method: "GET",
      environment: "sandbox",
      path: AIRWALLEX_CONNECTION_PATH,
      clientId: null,
      apiKey: null,
      accessToken: " ",
      apiVersion: AIRWALLEX_DEFAULT_API_VERSION,
    }),
  "an authenticated read without a token is refused before any call",
);
await expectRejects(
  () =>
    airwallexFetchTransport({
      method: "GET",
      environment: "sandbox",
      path: AIRWALLEX_CONNECTION_PATH,
      clientId: null,
      apiKey: null,
      accessToken: accessToken,
      apiVersion: "",
    }),
  "a call without a version is refused before any call",
);
expectEqual(AIRWALLEX_CLIENT_ID_HEADER, "x-client-id", "the login sends the documented client id header");
expectEqual(AIRWALLEX_API_KEY_HEADER, "x-api-key", "the login sends the documented API key header");
expectEqual(AIRWALLEX_API_VERSION_HEADER, "x-api-version", "the read sends the documented version header");

/* ---- the connection test: the documented proof ---- */

{
  const { store, configId } = configuredStore();
  const { calls, transport } = happyTransport();
  const audits: string[] = [];
  const cache = new InMemoryAirwallexTokenCache();
  const result = await testAirwallexConnection(configId, {
    store,
    keyring,
    occurredAtEpochMs: NOW,
    transport,
    tokenCache: cache,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });

  expectEqual(result.outcome, "connected", "the documented two calls prove the configuration");
  expectEqual(result.tokenIssued, true, "the login issued a token");
  expectEqual(result.tokenProven, true, "the authenticated read proved the token");
  expectEqual(result.balancesVisible, 2, "the read's balance count is recorded");
  expectEqual(result.baseUrlUsed, AIRWALLEX_SANDBOX_BASE, "the result names the host it proved");
  expectEqual(result.apiVersionSent, AIRWALLEX_DEFAULT_API_VERSION, "the result names the version it sent");
  expectEqual(result.environment, "sandbox", "the result names the mode");
  expectEqual(result.webhookSecretConfigured, true, "the result reports that a webhook secret exists");
  expectEqual(result.version, 2, "the result names the record's new version");
  expectEqual(calls.length, 2, "exactly the two documented calls are made");
  expectEqual(calls[0]?.path, AIRWALLEX_LOGIN_PATH, "the first call is the login");
  expectEqual(calls[0]?.method, "POST", "the login is a POST");
  expectEqual(calls[0]?.clientId, clientId, "the login sends the client id");
  expectEqual(calls[0]?.apiKey, apiKey, "the login sends the API key");
  expectEqual(calls[0]?.accessToken, null, "the login sends no bearer token");
  expectEqual(calls[1]?.path, AIRWALLEX_CONNECTION_PATH, "the second call is the authenticated read");
  expectEqual(calls[1]?.method, "GET", "the read is a GET");
  expectEqual(calls[1]?.accessToken, accessToken, "the read sends the token the login issued");
  expectEqual(calls[1]?.clientId, null, "the read sends no client id");
  expectEqual(calls[1]?.apiKey, null, "the read sends no API key");
  expectEqual(calls[1]?.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the read sends the pin");
  expect(asText(result).includes(accessToken) === false, "the result never carries the token");
  expect(asText(result).includes(apiKey) === false, "the result never carries the API key");
  expect(asText(result).includes("USD") === false, "the result never carries a balance");
  expectEqual(audits.join(","), "provider_key.tested:connected", "the test writes one audit entry");
  expectEqual(store.findById(configId)?.lastTest?.outcome, "connected", "the outcome is written to the record");
  expectEqual(store.findById(configId)?.lastTest?.tokenProven, true, "the record knows the token was proven");
  expectEqual(store.findById(configId)?.lastTest?.apiVersionSent, AIRWALLEX_DEFAULT_API_VERSION, "the record names the version tested");
  expectEqual(store.findById(configId)?.lastTest?.baseUrlUsed, AIRWALLEX_SANDBOX_BASE, "the record names the host tested");
  expectEqual(store.findById(configId)?.lastTest?.testedAtEpochMs, NOW, "the record names the time tested");
  expectEqual(store.findById(configId)?.version, 2, "the record's version advanced");
  expectEqual(store.findById(configId)?.status, "pending_activation", "a test never activates by itself");
  expect(cache.get(configId) !== null, "the token is cached in memory for the next call");
  expect(asText(cache.get(configId)).includes(accessToken), "the cache holds the token, which is its only job");
  expect(
    asText(store.findById(configId)).includes(accessToken) === false,
    "the stored record never carries the token",
  );

  const tested = store.findById(configId);
  expect(tested !== null, "the tested configuration is still stored");
  if (tested === null) throw new Error("unreachable");
  const shown = airwallexKeyViewOf(tested, keyring);
  expect(shown.status === "shown" && shown.view.lastTestOutcome === "connected", "the view reports the outcome");
  expect(shown.status === "shown" && shown.view.lastTestedAtEpochMs === NOW, "the view reports when it was tested");
  expect(shown.status === "shown" && shown.view.updatedAtEpochMs === NOW, "the view reports when it last changed");

  const activation = activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW + 1_000 });
  expectEqual(activation.status, "activated", "a proven configuration can be enabled");
}

/* ---- the connection test: the failures ---- */

{
  const { store, configId } = configuredStore();
  const { calls, transport } = transportReturning(() => ({
    status: 401,
    body: JSON.stringify({ code: "credentials_invalid", message: "Invalid credentials" }),
  }));
  const cache = new InMemoryAirwallexTokenCache();
  const result = await testAirwallexConnection(configId, {
    store,
    keyring,
    occurredAtEpochMs: NOW,
    transport,
    tokenCache: cache,
  });
  expectEqual(result.outcome, "credentials_rejected", "a rejected login is a credential rejection");
  expectEqual(result.tokenIssued, false, "no token was issued");
  expectEqual(result.tokenProven, false, "nothing was proven");
  expectEqual(result.balancesVisible, null, "no balance was read");
  expectEqual(calls.length, 1, "no authenticated read is attempted after a rejected login");
  expectEqual(cache.get(configId), null, "nothing is cached after a rejected login");
  expectEqual(store.findById(configId)?.lastTest?.outcome, "credentials_rejected", "the failure is recorded");
}

{
  const { store, configId } = configuredStore();
  const { transport } = transportReturning(() => ({
    status: 401,
    body: JSON.stringify({ code: "credentials_expired", message: "The key has expired" }),
  }));
  const result = await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  expectEqual(result.outcome, "credentials_rejected", "an expired key is a credential rejection");
  expect(result.reason.includes("expired"), "the reason says the key is expired");
}

{
  const { store, configId } = configuredStore();
  const cache = new InMemoryAirwallexTokenCache();
  const { calls, transport } = transportReturning((call) =>
    call.path === AIRWALLEX_LOGIN_PATH
      ? { status: 201, body: loginAnswer }
      : { status: 401, body: JSON.stringify({ message: "token expired" }) },
  );
  const result = await testAirwallexConnection(configId, {
    store,
    keyring,
    occurredAtEpochMs: NOW,
    transport,
    tokenCache: cache,
  });
  expectEqual(result.outcome, "credentials_rejected", "a token refused by the read is not a success");
  expectEqual(result.tokenIssued, true, "a token was issued but not proven");
  expectEqual(result.tokenProven, false, "an unproven token is not a proof");
  expectEqual(result.balancesVisible, null, "an unproven token read no balance");
  expectEqual(calls.length, 2, "the read was attempted");
  expectEqual(cache.get(configId), null, "an unproven token is not kept");
  const blocked = activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW + 1_000 });
  expectEqual(blocked.status, "failed", "an unproven token never enables the provider");
}

{
  const { store, configId } = configuredStore();
  const { transport } = transportReturning((call) => {
    if (call.path === AIRWALLEX_LOGIN_PATH) return { status: 201, body: loginAnswer };
    throw new Error("the network fell over");
  });
  const result = await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  expectEqual(result.outcome, "unknown", "a read that throws is unknown, not connected");
  expectEqual(result.tokenIssued, true, "the login did answer a token");
  expectEqual(result.tokenProven, false, "an unknown read proves nothing");
}

{
  const { store, configId } = configuredStore();
  const { transport } = transportReturning(() => ({
    status: 400,
    body: JSON.stringify({ code: "incorrect_version", message: "The version is incorrect for endpoint." }),
  }));
  const result = await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  expectEqual(result.outcome, "version_rejected", "a version refusal is its own outcome");
  expect(
    result.reason.includes(AIRWALLEX_DEFAULT_API_VERSION) && result.reason.includes("2026-08-21"),
    "the refusal names the pinned version and the recorded candidates",
  );
  expect(AIRWALLEX_VERSION_CANDIDATES[0] === AIRWALLEX_DEFAULT_API_VERSION, "the pinned version is tried first");
  expect(AIRWALLEX_VERSION_CANDIDATES.includes("2026-08-21"), "the disputed version is a candidate");
  expect(AIRWALLEX_VERSION_CANDIDATES.length <= AIRWALLEX_MAXIMUM_VERSION_PROBES, "the default candidates fit the bound");
}

{
  const { store, configId } = configuredStore();
  const { transport } = transportReturning(() => {
    throw new Error("unreachable");
  });
  const result = await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  expectEqual(result.outcome, "unknown", "a login that throws is unknown");
  expectEqual(result.reason.includes("could not be reached"), true, "the reason says the API was unreachable");
  expectEqual(store.findById(configId)?.lastTest?.outcome, "unknown", "an unreachable API is recorded honestly");
}

{
  const { store } = configuredStore();
  const { calls, transport } = happyTransport();
  const missing = await testAirwallexConnection("0a1b2c3d-0000-4000-8000-000000000099", {
    store,
    keyring,
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(missing.outcome, "invalid_configuration", "an unknown id is an invalid configuration");
  expectEqual(missing.configId, null, "an unknown id names no configuration");
  expectEqual(missing.version, null, "an unknown id has no version");
  expectEqual(missing.environment, null, "an unknown id has no mode");
  expectEqual(calls.length, 0, "an unknown id makes no call");
}

{
  const { store, configId } = configuredStore();
  const { calls, transport } = happyTransport();
  const wrongKeyring = await testAirwallexConnection(configId, {
    store,
    keyring: foreignKeyring,
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(wrongKeyring.outcome, "invalid_configuration", "a keyring that cannot open the credentials tests nothing");
  expectEqual(wrongKeyring.reason.includes("cannot be opened"), true, "the refusal names the sealed credentials");
  expectEqual(calls.length, 0, "an unopenable configuration makes no call");
}

{
  const { store, configId } = configuredStore();
  retireAirwallexConfig(configId, { store, occurredAtEpochMs: NOW });
  const { calls, transport } = happyTransport();
  const retired = await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  expectEqual(retired.outcome, "invalid_configuration", "a retired configuration cannot be tested");
  expectEqual(calls.length, 0, "a retired configuration makes no call");
}

/* ---- the version probe ---- */

{
  const { store, configId } = configuredStore();
  const { calls, transport } = transportReturning((call) =>
    call.apiVersion === "2026-08-21"
      ? { status: 201, body: loginAnswer }
      : { status: 400, body: JSON.stringify({ code: "incorrect_version" }) },
  );
  const probe = await probeAirwallexApiVersions(configId, { store, keyring, transport });
  expect(!("status" in probe), "a probe answers with its findings");
  if ("status" in probe) throw new Error("unreachable");
  expectEqual(probe.pinnedApiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the probe reports the pin it did not change");
  expectEqual(probe.acceptedApiVersion, "2026-08-21", "the accepted candidate is reported");
  expectEqual(probe.probes.length, AIRWALLEX_VERSION_CANDIDATES.length, "each recorded candidate is tried once");
  expectEqual(probe.probes[0]?.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the pin is probed first");
  expectEqual(probe.probes[0]?.outcome, "version_rejected", "the first candidate's refusal is recorded");
  expectEqual(calls.length, AIRWALLEX_VERSION_CANDIDATES.length, "the probe makes one login call per candidate");
  expectEqual(store.findById(configId)?.apiVersion, AIRWALLEX_DEFAULT_API_VERSION, "the probe never rewrites the pin");
  expectEqual(store.findById(configId)?.version, 1, "the probe never writes to the record");
}

{
  const { store, configId } = configuredStore();
  const { transport } = happyTransport();
  const tooMany = await probeAirwallexApiVersions(configId, {
    store,
    keyring,
    transport,
    candidates: [...AIRWALLEX_OBSERVED_API_VERSIONS],
  });
  expect("status" in tooMany && tooMany.status === "failed", "more candidates than the bound are refused");
  expectEqual(AIRWALLEX_MAXIMUM_VERSION_PROBES, 3, "the probe is bounded");

  const unrecorded = await probeAirwallexApiVersions(configId, { store, keyring, transport, candidates: ["2099-01-01"] });
  expect("status" in unrecorded && unrecorded.reason.includes("not a recorded API version"), "an unrecorded version is refused");
  expect(AIRWALLEX_OBSERVED_API_VERSIONS.includes("2026-08-21"), "the disputed version is one of the recorded versions");
  expect(AIRWALLEX_OBSERVED_API_VERSIONS.includes(AIRWALLEX_DEFAULT_API_VERSION), "the pin is one of the recorded versions");

  const empty = await probeAirwallexApiVersions(configId, { store, keyring, transport, candidates: [] });
  expect("status" in empty && empty.status === "failed", "an empty candidate list is refused");

  const missing = await probeAirwallexApiVersions("0a1b2c3d-0000-4000-8000-000000000097", {
    store,
    keyring,
    transport,
  });
  expect("status" in missing && missing.status === "failed", "an unknown configuration is refused");
}

/* ---- activation ---- */

{
  const { store, configId } = configuredStore();
  const untested = activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW });
  expectEqual(untested.status, "failed", "an untested configuration cannot be enabled");
  expect(
    untested.status === "failed" && untested.reason.includes("not been tested"),
    "the refusal says the configuration was never tested",
  );
  expectEqual(store.findById(configId)?.status, "pending_activation", "the refusal changed nothing");
}

{
  const { store, configId } = configuredStore();
  const { transport } = transportReturning(() => ({ status: 401, body: JSON.stringify({ code: "credentials_invalid" }) }));
  await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  const failedTest = activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW });
  expectEqual(failedTest.status, "failed", "a failed test blocks activation");
  expect(
    failedTest.status === "failed" && failedTest.reason.includes("credentials_rejected"),
    "the refusal names the failed outcome",
  );
}

{
  const { store, configId } = configuredStore();
  const { transport } = happyTransport();
  await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  const audits: string[] = [];
  const activated = activateAirwallexConfig(configId, {
    store,
    occurredAtEpochMs: NOW + 1_000,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });
  expectEqual(activated.status, "activated", "a tested configuration is enabled");
  expect(activated.status === "activated" && activated.config.status === "active", "the configuration is active");
  expect(activated.status === "activated" && activated.supersededConfigId === null, "there was nothing to supersede");
  expectEqual(audits.join(","), "provider_key.activated:active", "activation writes one audit entry");
  expectEqual(store.findActiveByCompany(companyId)?.id, configId, "the configuration is the active one");

  const again = activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW + 2_000 });
  expectEqual(again.status, "failed", "an active configuration is not activated twice");
  expect(again.status === "failed" && again.reason.includes("already active"), "the refusal says it is active");
}

{
  const store = new InMemoryAirwallexConfigStore();
  const first = configureAirwallexKeys(input, { store, keyring, occurredAtEpochMs: NOW });
  if (first.status !== "configured") throw new Error("the fixture configuration failed");
  const { transport } = happyTransport();
  await testAirwallexConnection(first.config.id, { store, keyring, occurredAtEpochMs: NOW, transport });
  expectEqual(
    activateAirwallexConfig(first.config.id, { store, occurredAtEpochMs: NOW }).status,
    "activated",
    "the first configuration is enabled",
  );

  const rotated = configureAirwallexKeys(
    { ...input, apiKey: secondApiKey },
    { store, keyring, occurredAtEpochMs: NOW + 10_000 },
  );
  if (rotated.status !== "configured") throw new Error("the rotated configuration failed");
  await testAirwallexConnection(rotated.config.id, { store, keyring, occurredAtEpochMs: NOW + 11_000, transport });
  const activatedSecond = activateAirwallexConfig(rotated.config.id, { store, occurredAtEpochMs: NOW + 12_000 });
  expectEqual(activatedSecond.status, "activated", "the new configuration is enabled");
  expect(
    activatedSecond.status === "activated" && activatedSecond.supersededConfigId === first.config.id,
    "the previous configuration is superseded in the same call",
  );
  expectEqual(store.findById(first.config.id)?.status, "superseded", "the previous configuration is superseded");
  expectEqual(store.findById(rotated.config.id)?.status, "active", "the new configuration is active");
  expectEqual(store.findActiveByCompany(companyId)?.id, rotated.config.id, "exactly one configuration is active");
  expectEqual(store.findByCompany(companyId).filter((config) => config.status === "active").length, 1, "never two active");
  expectEqual(
    activateAirwallexConfig(first.config.id, { store, occurredAtEpochMs: NOW + 13_000 }).status,
    "failed",
    "a superseded configuration cannot come back",
  );
}

/* ---- retirement ---- */

{
  const { store, configId } = configuredStore();
  const { transport } = happyTransport();
  await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport });
  activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW });
  const audits: string[] = [];
  const retired = retireAirwallexConfig(configId, {
    store,
    occurredAtEpochMs: NOW + 1_000,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });
  expectEqual(retired.status, "retired", "an active configuration is retired");
  expectEqual(store.findActiveByCompany(companyId), null, "a retired configuration is no longer active");
  expectEqual(audits.join(","), "provider_key.retired:retired", "retiring writes one audit entry");
  expectEqual(
    retireAirwallexConfig(configId, { store, occurredAtEpochMs: NOW + 2_000 }).status,
    "failed",
    "a retired configuration is not retired twice",
  );
  expectEqual(
    activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW + 3_000 }).status,
    "failed",
    "a retired configuration cannot be enabled",
  );
  expectEqual(
    store.findById(configId)?.status,
    "retired",
    "the retired configuration keeps the sealed credentials, now unusable",
  );
  expect(store.findById(configId)?.clientIdSealed !== null, "a retired configuration keeps its envelopes for the audit trail");
}

/* ---- the webhook signing secret ---- */

{
  const { store, configId } = configuredStore();
  const same = rotateAirwallexWebhookSecret(configId, { store, keyring, webhookSecret, occurredAtEpochMs: NOW });
  expectEqual(same.status, "failed", "rotating to the stored value is refused");
  expect(same.status === "failed" && same.reason === "the webhook secret is unchanged", "the refusal says nothing changed");

  const audits: string[] = [];
  const rotated = rotateAirwallexWebhookSecret(configId, {
    store,
    keyring,
    webhookSecret: secondWebhookSecret,
    occurredAtEpochMs: NOW + 1_000,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });
  expectEqual(rotated.status, "rotated", "a new webhook secret is stored");
  expectEqual(audits.join(","), "provider_webhook_secret.rotated:rotated", "the rotation is audited");
  expectEqual(rotated.status === "rotated" && rotated.config.version, 2, "the rotation advances the record's version");
  const config = store.findById(configId);
  if (config === null) throw new Error("the configuration vanished");
  const shown = airwallexKeyViewOf(config, keyring);
  expect(shown.status === "shown" && shown.view.webhookSecretMasked !== null, "the rotated secret is masked in the view");
  expect(
    shown.status === "shown" && shown.view.webhookSecretMasked?.endsWith(secondWebhookSecret.slice(-4)) === true,
    "the view shows the new secret's last four characters",
  );
  expect(asText(config).includes(secondWebhookSecret) === false, "the record never carries the new secret in clear");
  expect(asText(config).includes(webhookSecret) === false, "the record never carries the old secret in clear");

  expectEqual(
    rotateAirwallexWebhookSecret(configId, { store, keyring, webhookSecret: "short", occurredAtEpochMs: NOW + 2_000 }).status,
    "failed",
    "a short webhook secret is refused",
  );
  expectEqual(
    rotateAirwallexWebhookSecret(configId, {
      store,
      keyring,
      webhookSecret: `${secondWebhookSecret} x`,
      occurredAtEpochMs: NOW + 3_000,
    }).status,
    "failed",
    "a webhook secret with whitespace is refused",
  );
  expectEqual(
    rotateAirwallexWebhookSecret(configId, {
      store,
      keyring: foreignKeyring,
      webhookSecret: fixture("whsec", "thirdairwallexwebhooksecret"),
      occurredAtEpochMs: NOW + 4_000,
    }).status,
    "failed",
    "a keyring that cannot open the stored secret cannot rotate it",
  );
  expectEqual(
    rotateAirwallexWebhookSecret("0a1b2c3d-0000-4000-8000-000000000096", {
      store,
      keyring,
      webhookSecret: secondWebhookSecret,
      occurredAtEpochMs: NOW,
    }).status,
    "failed",
    "an unknown configuration cannot rotate a secret",
  );
}

{
  const store = new InMemoryAirwallexConfigStore();
  const withoutSecret = configureAirwallexKeys({ ...input, webhookSecret: null }, { store, keyring, occurredAtEpochMs: NOW });
  if (withoutSecret.status !== "configured") throw new Error("the fixture configuration failed");
  const audits: string[] = [];
  const first = rotateAirwallexWebhookSecret(withoutSecret.config.id, {
    store,
    keyring,
    webhookSecret,
    occurredAtEpochMs: NOW + 1_000,
    recordAudit: (entry) => audits.push(entry.outcome),
  });
  expectEqual(first.status, "rotated", "a configuration without a secret can receive one");
  expectEqual(audits.join(","), "configured", "the first secret is recorded as configured, not rotated");
}

/* ---- the token cache ---- */

{
  const cache = new InMemoryAirwallexTokenCache();
  cache.set("config-1", { token: accessToken, expiresAtEpochMs: NOW + 600_000 });
  expect(cache.get("config-1") !== null, "a cached token is returned");
  expectEqual(airwallexTokenIsUsable({ token: accessToken, expiresAtEpochMs: NOW + 600_000 }, NOW), true, "a fresh token is usable");
  expectEqual(
    airwallexTokenIsUsable({ token: accessToken, expiresAtEpochMs: NOW + 30_000 }, NOW),
    false,
    "a token inside the refresh skew is not usable",
  );
  expectEqual(
    airwallexTokenIsUsable({ token: accessToken, expiresAtEpochMs: NOW + 61_000 }, NOW),
    true,
    "a token just outside the skew is usable",
  );
  cache.clear("config-1");
  expectEqual(cache.get("config-1"), null, "clearing removes the token");
  expectEqual(cache.get("never-set"), null, "an unset token is null");
  expectThrows(() => cache.set("config-1", { token: " ", expiresAtEpochMs: NOW }), "an empty token cannot be cached");
  expectThrows(
    () => cache.set("config-1", { token: accessToken, expiresAtEpochMs: Number.NaN }),
    "a token without an expiry cannot be cached",
  );
}

/* ---- the token a later STEP uses ---- */

{
  const { store, configId } = configuredStore();
  const { transport } = happyTransport();
  const cache = new InMemoryAirwallexTokenCache();
  const audits: string[] = [];

  const pending = await airwallexAccessTokenFor(configId, {
    store,
    keyring,
    tokenCache: cache,
    nowEpochMs: NOW,
    transport,
  });
  expectEqual(pending.status, "failed", "a pending configuration cannot obtain a token");
  expect(pending.status === "failed" && pending.reason.includes("only an active configuration"), "the refusal says why");

  await testAirwallexConnection(configId, { store, keyring, occurredAtEpochMs: NOW, transport, tokenCache: cache });
  activateAirwallexConfig(configId, { store, occurredAtEpochMs: NOW, recordAudit: (entry) => audits.push(entry.action) });
  cache.clear(configId);

  const issued = await airwallexAccessTokenFor(configId, {
    store,
    keyring,
    tokenCache: cache,
    nowEpochMs: NOW + 1_000,
    transport,
  });
  expectEqual(issued.status, "token", "an active configuration obtains a token");
  expect(issued.status === "token" && issued.fromCache === false, "the first token comes from the API");
  expect(issued.status === "token" && issued.token === accessToken, "the documented token is returned");
  expect(issued.status === "token" && issued.expiresAtEpochMs === tokenExpiryMs, "the token's expiry is carried");

  const reused = await airwallexAccessTokenFor(configId, {
    store,
    keyring,
    tokenCache: cache,
    nowEpochMs: NOW + 2_000,
    transport,
  });
  expect(reused.status === "token" && reused.fromCache === true, "a usable token is reused instead of logging in again");

  const expired = await airwallexAccessTokenFor(configId, {
    store,
    keyring,
    tokenCache: cache,
    nowEpochMs: tokenExpiryMs + 1_000,
    transport,
  });
  expect(expired.status === "token" && expired.fromCache === false, "an expired token is replaced by a fresh login");

  const refused = await airwallexAccessTokenFor(configId, {
    store,
    keyring,
    tokenCache: new InMemoryAirwallexTokenCache(),
    nowEpochMs: NOW,
    transport: transportReturning(() => ({ status: 401, body: JSON.stringify({ code: "credentials_invalid" }) }))
      .transport,
  });
  expectEqual(refused.status, "failed", "a rejected login yields no token");

  const missing = await airwallexAccessTokenFor("0a1b2c3d-0000-4000-8000-000000000098", {
    store,
    keyring,
    tokenCache: cache,
    nowEpochMs: NOW,
    transport,
  });
  expectEqual(missing.status, "failed", "an unknown configuration obtains no token");
  expectEqual(
    asText(store.findByCompany(companyId)).includes(accessToken),
    false,
    "no stored record ever carries the token",
  );
  expect(asText(audits).includes(accessToken) === false, "no audit entry ever carries the token");
}

/* ---- the store's invariants ---- */

{
  const store = new InMemoryAirwallexConfigStore();
  const first = configureAirwallexKeys(input, { store, keyring, occurredAtEpochMs: NOW });
  if (first.status !== "configured") throw new Error("the fixture configuration failed");
  const config = first.config;
  expectThrows(() => store.insert(config), "the store refuses a duplicate id");
  expectThrows(
    () => store.insert({ ...config, id: "0a1b2c3d-0000-4000-8000-000000000095" }),
    "the store refuses a second pending configuration for one company",
  );
  expectThrows(
    () => store.insert({ ...config, id: "0a1b2c3d-0000-4000-8000-000000000094", status: "active" }),
    "the store refuses a configuration that starts active",
  );
  expectThrows(
    () => store.insert({ ...config, id: "0a1b2c3d-0000-4000-8000-000000000093", version: 2 }),
    "the store refuses a configuration that does not start at version 1",
  );
  expectEqual(store.save({ ...config, version: 2 }, 7), false, "a wrong expected version is refused");
  expectEqual(store.save({ ...config, version: 5 }, 1), false, "a jump in version is refused");
  expectEqual(store.save({ ...config, companyId: otherCompanyId, version: 2 }, 1), false, "the company never changes");
  expectEqual(store.save({ ...config, environment: "live", version: 2 }, 1), false, "the mode never changes");
  expectEqual(store.save({ ...config, clientIdSealed: `${config.clientIdSealed}x`, version: 2 }, 1), false, "the sealed client id never changes");
  expectEqual(store.save({ ...config, apiKeySealed: `${config.apiKeySealed}x`, version: 2 }, 1), false, "the sealed API key never changes");
  expectEqual(store.save({ ...config, apiVersion: "2024-02-22", version: 2 }, 1), false, "the pinned version never changes in place");
  expectEqual(store.save({ ...config, baseUrl: AIRWALLEX_PRODUCTION_BASE, version: 2 }, 1), false, "the host never changes in place");

  const tested = {
    ...config,
    lastTest: {
      outcome: "connected" as const,
      testedAtEpochMs: NOW,
      environment: "sandbox" as const,
      apiVersionSent: config.apiVersion,
      baseUrlUsed: config.baseUrl,
      tokenProven: true,
    },
  };
  expectEqual(store.save({ ...tested, version: 2 }, 1), true, "a recorded test is saved");
  expectEqual(store.save({ ...tested, status: "active", version: 3 }, 2), true, "a proven test enables the configuration");
  expectEqual(store.save({ ...tested, status: "active", version: 3 }, 2), false, "a stale version is refused");
  expectEqual(store.save({ ...tested, status: "pending_activation", version: 4 }, 3), false, "an active configuration cannot step back to pending");
}

{
  const store = new InMemoryAirwallexConfigStore();
  const result = configureAirwallexKeys(input, { store, keyring, occurredAtEpochMs: NOW });
  if (result.status !== "configured") throw new Error("the fixture configuration failed");
  const config = result.config;

  const unproven = {
    ...config,
    lastTest: {
      outcome: "connected" as const,
      testedAtEpochMs: NOW,
      environment: "sandbox" as const,
      apiVersionSent: config.apiVersion,
      baseUrlUsed: config.baseUrl,
      tokenProven: false,
    },
  };
  expectEqual(store.save({ ...unproven, version: 2 }, 1), true, "an unproven test is recorded");
  expectEqual(store.save({ ...unproven, status: "active", version: 3 }, 2), false, "an unproven test never enables the configuration");

  const wrongVersion = {
    ...config,
    lastTest: {
      outcome: "connected" as const,
      testedAtEpochMs: NOW,
      environment: "sandbox" as const,
      apiVersionSent: "2024-02-22",
      baseUrlUsed: config.baseUrl,
      tokenProven: true,
    },
  };
  expectEqual(store.save({ ...wrongVersion, version: 3 }, 2), true, "a test on another version is recorded");
  expectEqual(
    store.save({ ...wrongVersion, status: "active", version: 4 }, 3),
    false,
    "a test on another version never enables the configuration",
  );

  const wrongHost = {
    ...config,
    lastTest: {
      outcome: "connected" as const,
      testedAtEpochMs: NOW,
      environment: "sandbox" as const,
      apiVersionSent: config.apiVersion,
      baseUrlUsed: AIRWALLEX_PRODUCTION_BASE,
      tokenProven: true,
    },
  };
  expectEqual(store.save({ ...wrongHost, version: 4 }, 3), true, "a test on another host is recorded");
  expectEqual(store.save({ ...wrongHost, status: "active", version: 5 }, 4), false, "a test on another host never enables the configuration");

  const nullTest = { ...config, lastTest: null };
  expectEqual(store.save({ ...nullTest, status: "active", version: 5 }, 4), false, "no recorded test never enables the configuration");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Airwallex key gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Airwallex key gate passed: ${checks} checks (both credentials sealed under their own scopes and never shown in clear, the documented login answered 201 with a token and then proven by an authenticated balance read, the mode proved by the documented host because no key prefix exists, the version question answered by a bounded probe that never rewrites the pin, activation refused unless the recorded test proved the token on this version and this host, and a webhook secret that rotates behind the same seal)\n`,
);
