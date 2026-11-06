// path: lib/payments/adapters/rainforest-payment-verify.ts

/**
 * The gate for STEP 159: Rainforest payment acceptance.
 *
 * A check script, not a test file: it exercises the payin config, the component session, the component
 * contract and the payin read with recording transports and keyrings built for the run, then fails and
 * names every check that did not hold. No network call is made, no real credential is used and no card
 * or bank account number exists anywhere in this file or in the code under test.
 */

import process from "node:process";
import { openSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  activateRainforestConfig,
  configureRainforestKeys,
  InMemoryRainforestConfigStore,
  rainforestApiKeyScope,
  testRainforestConnection,
  type RainforestConfigStore,
} from "./rainforest-client.ts";
import {
  RAINFOREST_API_VERSION,
  RAINFOREST_API_VERSION_HEADER,
  RAINFOREST_PAYIN_STATUSES,
  RAINFOREST_PRODUCTION_API_BASE,
  RAINFOREST_SANDBOX_API_BASE,
} from "./rainforest.ts";
import {
  buildRainforestPayinConfigBody,
  buildRainforestSessionBody,
  createRainforestPayinConfig,
  createRainforestSession,
  InMemoryRainforestPayinConfigStore,
  isRainforestRefusalCode,
  RAINFOREST_COMPONENT_CSP_HOSTS,
  RAINFOREST_COMPONENT_SCRIPT_URLS,
  RAINFOREST_COMPONENT_TAG,
  RAINFOREST_PAYIN_CONFIG_ID_PATTERN,
  RAINFOREST_PAYIN_CONFIG_ID_PREFIXES,
  RAINFOREST_PAYIN_CONFIGS_PATH,
  RAINFOREST_PAYIN_ID_PATTERN,
  RAINFOREST_PAYIN_ID_PREFIXES,
  RAINFOREST_PAYIN_PATH_TEMPLATE,
  RAINFOREST_PAYMENT_COMPONENT_PERMISSION,
  RAINFOREST_REFUSAL_CODES,
  RAINFOREST_SESSION_DEFAULT_TTL_SECONDS,
  RAINFOREST_SESSION_KEY_PATTERN,
  RAINFOREST_SESSION_KEY_PREFIX,
  RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS,
  RAINFOREST_SESSION_PURPOSES,
  RAINFOREST_MERCHANT_ONBOARDING_PERMISSION,
  rainforestSessionPermissionOf,
  RAINFOREST_SESSIONS_PATH,
  RAINFOREST_MAXIMUM_AMOUNT_MINOR,
  rainforestComponentScriptUrlFor,
  rainforestFetchPaymentTransport,
  rainforestPayinConfigEndpointFor,
  rainforestPayinEndpointFor,
  rainforestPaymentComponentFor,
  rainforestSessionEndpointFor,
  readRainforestPayin,
  SUBMISSION_OUTCOMES,
  validateRainforestPayinConfigInput,
  validateRainforestSessionInput,
  type RainforestPayinConfigInput,
  type RainforestPayinConfigStore,
  type RainforestPayinConfigSubmission,
  type RainforestPaymentAuditEntry,
  type RainforestPaymentTransport,
  type RainforestSessionInput,
} from "./rainforest-payment.ts";

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

const companyId = "018f2b8a-0000-4000-8000-00000000c001";
const otherCompanyId = "018f2b8a-0000-4000-8000-00000000c002";
const sandboxKey = "sbx_apikey_GATEPAYMENTSANDBOX0001ABCDEF";
const productionKey = "apikey_GATEPAYMENTPRODUCTION0002ABCDEF";
const merchantId = "sbx_mid_2DrDPKzdQypRudLd8DhQKZX27dA";
const productionMerchantId = "mid_2DrDPKzdQypRudLd8DhQKZX27dA";
const payinConfigId = "sbx_cfg_2DrDPKzdQypRudLd8DhQKZX27dA";
const productionPayinConfigId = "cfg_2DrDPKzdQypRudLd8DhQKZX27dA";
const payinId = "sbx_pyi_2DrDPKzdQypRudLd8DhQKZX27dA";
const sessionKey = "sessionkey_9c1f4a7b2e5d8c3a6f9b4e7d2a5c8f1b";
const sessionId = "sbx_ses_2DrDPKzdQypRudLd8DhQKZX27dA";
const idempotencyKey = "payinconfig-018f2b8a-0001";

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

/** A payment transport that answers one fixed status and body and records what it was asked. */
function paymentTransport(status: number, body: string) {
  const calls: { endpoint: string; method: string; apiKey: string; body: string | null }[] = [];
  const transport: RainforestPaymentTransport = async (endpoint, method, apiKey, requestBody) => {
    calls.push({ endpoint, method, apiKey, body: requestBody });
    return { status, body };
  };
  return { transport, calls };
}

/** A payment transport that throws, as an unreachable API does. */
const throwingTransport: RainforestPaymentTransport = async () => {
  throw new Error("network down");
};

/** The options of one call: a store's configuration, the keyring, the instant, and an audit sink. */
function paymentOptions(
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

function configInput(overrides: Partial<RainforestPayinConfigInput> = {}): RainforestPayinConfigInput {
  return {
    companyId,
    merchantId,
    amountMinor: 12_500n,
    currency: "USD",
    idempotencyKey,
    ...overrides,
  };
}

function sessionInput(overrides: Partial<RainforestSessionInput> = {}): RainforestSessionInput {
  return { companyId, merchantId, ...overrides };
}

function json(payload: unknown): string {
  return JSON.stringify(payload);
}

/** A JSON dump that survives bigint fields, for the leak checks. */
function dump(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? entry.toString() : entry));
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the documented endpoints, prefixes, limits and component facts
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_PAYIN_CONFIGS_PATH, "/v1/payin_configs", "the documented payin config path is recorded");
expectEqual(RAINFOREST_SESSIONS_PATH, "/v1/sessions", "the documented session path is recorded");
expectEqual(RAINFOREST_PAYIN_PATH_TEMPLATE, "/v1/payins/{payin_id}", "the documented payin read path is recorded");
expectEqual(RAINFOREST_SESSION_KEY_PREFIX, "sessionkey_", "the documented session key prefix is recorded");
expectEqual(RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS, 86_400, "the documented 24 hour session maximum is recorded");
expect(RAINFOREST_SESSION_DEFAULT_TTL_SECONDS < 86_400, "the default lifetime is under the documented maximum");
expectEqual(RAINFOREST_PAYMENT_COMPONENT_PERMISSION, "group#payment_component", "the documented component group is used");
expectEqual(RAINFOREST_COMPONENT_TAG, "rainforest-payment", "the documented component element name is recorded");
expectEqual(
  RAINFOREST_COMPONENT_SCRIPT_URLS["sandbox"],
  "https://static.rainforestpay.com/sandbox.payment.js",
  "the documented sandbox bundle is recorded",
);
expectEqual(
  RAINFOREST_COMPONENT_SCRIPT_URLS["production"],
  "https://static.rainforestpay.com/payment.js",
  "the documented production bundle is recorded",
);
expectEqual(rainforestComponentScriptUrlFor("sandbox"), RAINFOREST_COMPONENT_SCRIPT_URLS["sandbox"], "the bundle follows the environment");
expectEqual(rainforestComponentScriptUrlFor("production"), RAINFOREST_COMPONENT_SCRIPT_URLS["production"], "the production bundle follows the environment");
expect(RAINFOREST_COMPONENT_CSP_HOSTS.includes("*.rainforestpay.com"), "the documented CSP host is recorded");
expectEqual(RAINFOREST_PAYIN_CONFIG_ID_PREFIXES.length, 2, "the two documented config id prefixes are recorded");
expect(RAINFOREST_PAYIN_CONFIG_ID_PREFIXES.includes("sbx_cfg_"), "the sandbox config prefix is recorded");
expect(RAINFOREST_PAYIN_CONFIG_ID_PREFIXES.includes("cfg_"), "the production config prefix is recorded");
expect(RAINFOREST_PAYIN_ID_PREFIXES.includes("sbx_pyi_"), "the sandbox payin prefix is recorded");
expect(RAINFOREST_PAYIN_ID_PREFIXES.includes("pyi_"), "the production payin prefix is recorded");
expectEqual(RAINFOREST_PAYIN_CONFIG_ID_PATTERN.test(payinConfigId), true, "a sandbox config id is accepted");
expectEqual(RAINFOREST_PAYIN_CONFIG_ID_PATTERN.test(productionPayinConfigId), true, "a production config id is accepted");
expectEqual(RAINFOREST_PAYIN_CONFIG_ID_PATTERN.test("sbx_pmc_2DrDPKzdQypRudLd8DhQKZX27dA"), false, "a payment method config id is not a payin config id");
expectEqual(RAINFOREST_PAYIN_ID_PATTERN.test(payinId), true, "a sandbox payin id is accepted");
expectEqual(RAINFOREST_PAYIN_ID_PATTERN.test(payinConfigId), false, "a config id is not a payin id");
expectEqual(RAINFOREST_SESSION_KEY_PATTERN.test(sessionKey), true, "a documented session key shape is accepted");
expectEqual(RAINFOREST_SESSION_KEY_PATTERN.test("apikey_9c1f4a7b2e5d8c3a6f9b4e7d2a5c8f1b"), false, "an API key is not a session key");

expectEqual(
  rainforestPayinConfigEndpointFor("sandbox"),
  `${RAINFOREST_SANDBOX_API_BASE}/v1/payin_configs`,
  "the sandbox config endpoint is the documented one",
);
expectEqual(
  rainforestPayinConfigEndpointFor("production"),
  `${RAINFOREST_PRODUCTION_API_BASE}/v1/payin_configs`,
  "the production config endpoint is the documented one",
);
expectEqual(rainforestSessionEndpointFor("sandbox"), `${RAINFOREST_SANDBOX_API_BASE}/v1/sessions`, "the sandbox session endpoint is documented");
expectEqual(rainforestSessionEndpointFor("production"), `${RAINFOREST_PRODUCTION_API_BASE}/v1/sessions`, "the production session endpoint is documented");
expectEqual(rainforestPayinEndpointFor("sandbox", payinId), `${RAINFOREST_SANDBOX_API_BASE}/v1/payins/${payinId}`, "the payin read endpoint is documented");
expectEqual(rainforestPayinEndpointFor("production", payinId), `${RAINFOREST_PRODUCTION_API_BASE}/v1/payins/${payinId}`, "the production payin read endpoint follows the environment");
expectEqual(rainforestPayinEndpointFor("sandbox", "pyi_../../admin"), null, "an unusable payin id yields no endpoint");
expectEqual(rainforestPayinEndpointFor("sandbox", "not-a-payin"), null, "a payin id of the wrong shape yields no endpoint");

/* ------------------------------------------------------------------------------------------------
 * Section 2: the documented refusal vocabulary
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_REFUSAL_CODES.length, 23, "the documented refusal table is recorded in full");
expect(RAINFOREST_REFUSAL_CODES.includes("INSUFFICIENT_FUNDS"), "the insufficient funds code is recorded");
expect(RAINFOREST_REFUSAL_CODES.includes("RETRY_WITH_THREEDS"), "the three-domain-secure retry code is recorded");
expect(RAINFOREST_REFUSAL_CODES.includes("UNSUPPORTED_ACCOUNT_TYPE"), "the unsupported ACH account type code is recorded");
expectEqual(new Set(RAINFOREST_REFUSAL_CODES).size, RAINFOREST_REFUSAL_CODES.length, "the refusal table carries no duplicates");
for (const code of RAINFOREST_REFUSAL_CODES) {
  expectEqual(code, code.toUpperCase(), `the refusal code ${code} is upper case as documented`);
}
expectEqual(isRainforestRefusalCode("DO_NOT_HONOR"), true, "a documented code is known");
expectEqual(isRainforestRefusalCode("A_CODE_RAINFOREST_HAS_NOT_PUBLISHED"), false, "an unpublished code is not claimed as known");

/* ------------------------------------------------------------------------------------------------
 * Section 3: validating a payin config input
 * --------------------------------------------------------------------------------------------- */

expectEqual(validateRainforestPayinConfigInput(configInput()), null, "a complete input is valid");
expectEqual(
  validateRainforestPayinConfigInput(configInput({ merchantId: "mid_AB" })),
  "the merchant id must carry the documented mid_ or sbx_mid_ prefix",
  "a merchant id of the wrong shape is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ merchantId: productionMerchantId })),
  null,
  "a production merchant id is accepted",
);
expectEqual(validateRainforestPayinConfigInput(configInput({ companyId: " " })), "the company id is required", "a blank company is refused");
expectEqual(validateRainforestPayinConfigInput(configInput({ amountMinor: 0n })), "the amount must be positive", "a zero amount is refused");
expectEqual(validateRainforestPayinConfigInput(configInput({ amountMinor: -1n })), "the amount must be positive", "a negative amount is refused");
expectEqual(validateRainforestPayinConfigInput(configInput({ amountMinor: 1n })), null, "the documented minimum amount of one minor unit is accepted");
expectEqual(
  validateRainforestPayinConfigInput(configInput({ amountMinor: 1_000_000_000_000_000_000n })),
  "the amount exceeds the platform's money maximum",
  "an amount above the platform maximum is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ amountMinor: RAINFOREST_MAXIMUM_AMOUNT_MINOR })),
  null,
  "the largest safe provider integer is accepted",
);
expectEqual(validateRainforestPayinConfigInput(configInput({ currency: "EUR" })), "the currency must be USD", "another currency is refused");
expectEqual(
  validateRainforestPayinConfigInput(configInput({ idempotencyKey: "short" })),
  "the idempotency key must be 8 to 128 characters of letters, digits, dot, colon, dash or underscore",
  "a short idempotency key is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ idempotencyKey: `k${"a".repeat(130)}` })),
  "the idempotency key must be 8 to 128 characters of letters, digits, dot, colon, dash or underscore",
  "an over-long idempotency key is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ idempotencyKey: "key with spaces" })),
  "the idempotency key must be 8 to 128 characters of letters, digits, dot, colon, dash or underscore",
  "an idempotency key with spaces is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ billingContact: {} })),
  "a billing contact that is sent must carry at least one field",
  "an empty billing contact is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ billingContact: { name: "   " } })),
  "a billing contact that is sent must carry at least one field",
  "a billing contact of blanks is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ billingContact: { email: "not-an-email" } })),
  "the billing contact email is invalid",
  "an invalid billing contact email is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ billingContact: { postalCode: "!!" } })),
  "the billing contact postal code is invalid",
  "an invalid billing contact postal code is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ billingContact: { country: "USA" } })),
  "the billing contact country must be a two letter code",
  "a three letter country is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ billingContact: { name: "Ada Lovelace", postalCode: "30301", country: "US" } })),
  null,
  "a valid billing contact is accepted",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ amountSplits: [{ type: "PLATFORM", amountMinor: 0n }] })),
  "an amount split must be a positive amount",
  "a zero amount split is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ amountSplits: [{ type: "PLATFORM", amountMinor: 12_501n }] })),
  "an amount split cannot exceed the payin amount",
  "a split larger than the payin is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ amountSplits: [{ type: "PLATFORM", amountMinor: 100n, merchantId }] })),
  "a PLATFORM split names no merchant",
  "a platform split that names a merchant is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ amountSplits: [{ type: "MERCHANT", amountMinor: 100n }] })),
  "a MERCHANT split must name a valid merchant id",
  "a merchant split without a merchant is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(
    configInput({
      amountSplits: [
        { type: "MERCHANT", amountMinor: 100n, merchantId },
        { type: "MERCHANT", amountMinor: 100n, merchantId },
      ],
    }),
  ),
  "each MERCHANT split must name a unique merchant",
  "two splits for the same merchant are refused",
);
expectEqual(
  validateRainforestPayinConfigInput(
    configInput({
      amountSplits: [
        { type: "PLATFORM", amountMinor: 100n },
        { type: "PLATFORM", amountMinor: 100n },
      ],
    }),
  ),
  "at most one PLATFORM split is permitted",
  "two platform splits are refused",
);
expectEqual(
  validateRainforestPayinConfigInput(
    configInput({
      amountSplits: [
        { type: "PLATFORM", amountMinor: 7_000n },
        { type: "MERCHANT", amountMinor: 7_000n, merchantId },
      ],
    }),
  ),
  "the amount splits cannot add up to more than the payin amount",
  "splits that add up past the payin are refused",
);
expectEqual(
  validateRainforestPayinConfigInput(
    configInput({ amountSplits: [{ type: "PLATFORM", amountMinor: 250n }, { type: "MERCHANT", amountMinor: 12_250n, merchantId }] }),
  ),
  null,
  "documented splits that add up to the payin are accepted",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ metadata: { "order_id": "KD-1001" } })),
  null,
  "short metadata is accepted",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ metadata: { "bad key": "x" } })),
  "a metadata key is invalid",
  "a metadata key with a space is refused",
);
expectEqual(
  validateRainforestPayinConfigInput(configInput({ metadata: { order_id: "x".repeat(201) } })),
  "a metadata value is too long",
  "an over-long metadata value is refused",
);
const manyMetadata: Record<string, string> = {};
for (let index = 0; index < 21; index += 1) manyMetadata[`k${index}`] = "v";
expectEqual(
  validateRainforestPayinConfigInput(configInput({ metadata: manyMetadata })),
  "the metadata carries too many keys",
  "too many metadata entries are refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 4: the documented payin config body
 * --------------------------------------------------------------------------------------------- */

const minimalBody = buildRainforestPayinConfigBody(configInput());
expectEqual(minimalBody["merchant_id"], merchantId, "the body names the merchant");
expectEqual(minimalBody["idempotency_key"], idempotencyKey, "the body carries the idempotency key");
expectEqual(minimalBody["amount"], 12_500, "the body carries the amount in minor units");
expectEqual(minimalBody["currency_code"], "USD", "the body carries the documented currency field");
expectEqual(Object.keys(minimalBody).length, 4, "a minimal body carries only the documented required fields");
expect(minimalBody["billing_contact"] === undefined, "a minimal body pre-fills no billing contact");
expect(minimalBody["amount_splits"] === undefined, "a minimal body carries no amount splits");
expect(minimalBody["metadata"] === undefined, "a minimal body carries no metadata");
for (const forbidden of ["card", "card_number", "pan", "cvv", "account_number", "routing_number", "iban", "payment_method"]) {
  expect(Object.prototype.hasOwnProperty.call(minimalBody, forbidden) === false, `the body carries no ${forbidden} field`);
}
expectEqual(json(minimalBody).includes("4111"), false, "the body carries no card number");

const fullBody = buildRainforestPayinConfigBody(
  configInput({
    billingContact: { name: "Ada Lovelace", postalCode: "30301", country: "US", state: "GA", email: "ada@example.com", phone: "+1 404 555 0100" },
    amountSplits: [{ type: "PLATFORM", amountMinor: 250n }, { type: "MERCHANT", amountMinor: 12_250n, merchantId }],
    metadata: { order_id: "KD-1001" },
  }),
);
const sentContact = fullBody["billing_contact"] as Record<string, string>;
expectEqual(sentContact["name"], "Ada Lovelace", "the billing contact name is pre-filled under the documented key");
expectEqual(sentContact["postal_code"], "30301", "the billing contact postal code uses the documented key");
expectEqual(sentContact["country"], "US", "the billing contact country is pre-filled");
expectEqual(sentContact["state"], "GA", "the billing contact state is pre-filled");
expectEqual(sentContact["email"], "ada@example.com", "the billing contact email is pre-filled");
expectEqual(sentContact["phone"], "+1 404 555 0100", "the billing contact phone is pre-filled");
const sentSplits = fullBody["amount_splits"] as Array<Record<string, unknown>>;
expectEqual(sentSplits.length, 2, "both documented splits are sent");
expectEqual(sentSplits[0]?.["type"], "PLATFORM", "the platform split keeps its documented type");
expectEqual(sentSplits[0]?.["amount"], 250, "the platform split carries its amount in minor units");
expectEqual(sentSplits[0]?.["currency_code"], "USD", "the platform split carries the currency");
expectEqual(sentSplits[0]?.["merchant_id"], undefined, "the platform split names no merchant");
expectEqual(sentSplits[1]?.["merchant_id"], merchantId, "the merchant split names its merchant");
expectEqual((fullBody["metadata"] as Record<string, string>)["order_id"], "KD-1001", "the metadata is sent as documented");
expectEqual(
  json(buildRainforestPayinConfigBody(configInput({ billingContact: { postalCode: "30301" } }))).includes('"name"'),
  false,
  "a billing contact with one field sends one field",
);

/* ------------------------------------------------------------------------------------------------
 * Section 5: the transport
 * --------------------------------------------------------------------------------------------- */

const realFetch = globalThis.fetch;
const fetchCalls: { url: string; method: string; headers: Record<string, string>; body: string | null }[] = [];
let fetchAnswer = { status: 200, body: json({ data: { payin_config_id: payinConfigId } }), oversized: false };

globalThis.fetch = (async (url: string, init: RequestInit) => {
  const headers = (init.headers ?? {}) as Record<string, string>;
  fetchCalls.push({
    url,
    method: init.method ?? "GET",
    headers,
    body: typeof init.body === "string" ? init.body : null,
  });
  expectEqual(init.redirect, "error", "every API call refuses redirects");
  return {
    status: fetchAnswer.status,
    text: async () => (fetchAnswer.oversized ? "x".repeat(65_537) : fetchAnswer.body),
  } as unknown as Response;
}) as unknown as typeof fetch;

const configEndpoint = rainforestPayinConfigEndpointFor("sandbox");
const posted = await rainforestFetchPaymentTransport(configEndpoint, "POST", sandboxKey, json({ amount: 1 }));
expectEqual(posted.status, 200, "the transport answers with the status it received");
expectEqual(fetchCalls.length, 1, "one call reaches fetch");
expectEqual(fetchCalls[0]?.url, configEndpoint, "the call goes to the documented endpoint");
expectEqual(fetchCalls[0]?.method, "POST", "the config call posts");
expectEqual(fetchCalls[0]?.headers["Authorization"], `Bearer ${sandboxKey}`, "the call carries the bearer credential");
expectEqual(fetchCalls[0]?.headers[RAINFOREST_API_VERSION_HEADER], RAINFOREST_API_VERSION, "the call carries the documented version header");
expectEqual(fetchCalls[0]?.headers["Content-Type"], "application/json", "a post carries a JSON content type");
expectEqual(fetchCalls[0]?.headers["Accept"], "application/json", "the call asks for JSON");

await rainforestFetchPaymentTransport(`${RAINFOREST_SANDBOX_API_BASE}/v1/payins/${payinId}`, "GET", sandboxKey, null);
expectEqual(fetchCalls[1]?.method, "GET", "the payin read gets");
expectEqual(fetchCalls[1]?.body, null, "a get carries no body");
expectEqual(fetchCalls[1]?.headers["Content-Type"], undefined, "a get carries no content type");

await expectRejection(
  async () => rainforestFetchPaymentTransport("https://api.example.com/v1/payin_configs", "POST", sandboxKey, "{}"),
  "a foreign host is refused",
);
await expectRejection(
  async () => rainforestFetchPaymentTransport(`${RAINFOREST_SANDBOX_API_BASE}/v1/refunds`, "POST", sandboxKey, "{}"),
  "an undocumented endpoint is refused",
);
await expectRejection(
  async () => rainforestFetchPaymentTransport(`${RAINFOREST_SANDBOX_API_BASE}/v1/payins/../../v1/api_keys`, "GET", sandboxKey, null),
  "a traversed path is refused",
);
await expectRejection(
  async () => rainforestFetchPaymentTransport("https://api.rainforestpay.com/v1/payin_configs", "POST", "", "{}"),
  "a call without a key is refused",
);
await expectRejection(
  async () => rainforestFetchPaymentTransport(configEndpoint, "POST", sandboxKey, null),
  "a post without a body is refused",
);
await expectRejection(
  async () => rainforestFetchPaymentTransport(configEndpoint, "GET", sandboxKey, "{}"),
  "a get with a body is refused",
);
expectEqual(fetchCalls.length, 2, "no refused call reached fetch");

fetchAnswer = { status: 200, body: "", oversized: true };
await expectRejection(
  async () => rainforestFetchPaymentTransport(configEndpoint, "POST", sandboxKey, "{}"),
  "an oversized answer is refused",
);
fetchAnswer = { status: 200, body: json({ data: { payin_config_id: payinConfigId } }), oversized: false };
globalThis.fetch = realFetch;

/* ------------------------------------------------------------------------------------------------
 * Section 6: creating a payin config
 * --------------------------------------------------------------------------------------------- */

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const recorded = paymentTransport(200, json({ status: "SUCCESS", data: { payin_config_id: payinConfigId } }));
  const submissionStore = new InMemoryRainforestPayinConfigStore();
  const created = await createRainforestPayinConfig(
    configInput(),
    submissionStore,
    paymentOptions(configStore, audits, recorded.transport),
  );

  expectEqual(created.status, "created", "a 2XX naming a config id creates the config");
  if (created.status === "created") {
    expectEqual(created.payinConfigId, payinConfigId, "the created result carries the provider id");
    expectEqual(created.submission.outcome, "created", "the submission records the creation");
    expectEqual(created.submission.version, 2, "the submission advanced one version");
    expectEqual(created.submission.requiresReconciliation, false, "a creation needs no reconciliation");
  }
  expectEqual(recorded.calls.length, 1, "one call creates one config");
  expectEqual(recorded.calls[0]?.endpoint, `${RAINFOREST_SANDBOX_API_BASE}/v1/payin_configs`, "the config call uses the documented endpoint");
  expectEqual(recorded.calls[0]?.method, "POST", "the config call posts");
  expectEqual(recorded.calls[0]?.apiKey, sandboxKey, "the config call opens the active key");
  expectEqual(submissionStore.findByIdempotencyKey(companyId, idempotencyKey)?.providerConfigId, payinConfigId, "the store holds the provider id");

  const sent = JSON.parse(recorded.calls[0]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(sent["merchant_id"], merchantId, "the created config names the merchant");
  expectEqual(sent["amount"], 12_500, "the created config carries the amount in minor units");
  expectEqual(sent["idempotency_key"], idempotencyKey, "the created config carries the idempotency key");

  const configAudits = audits.filter((entry) => entry.action === "payin.rainforest_config_created");
  expectEqual(configAudits.length, 1, "a creation writes one audit entry");
  expectEqual(configAudits[0]?.providerObjectId, payinConfigId, "the audit entry names the created config");
  expectEqual(configAudits[0]?.companyId, companyId, "the audit entry names the company");
  expectEqual(configAudits[0]?.outcome, "created", "the audit entry records the outcome");

  const replayed = await createRainforestPayinConfig(
    configInput(),
    submissionStore,
    paymentOptions(configStore, audits, recorded.transport),
  );
  expectEqual(replayed.status, "replayed", "a replay of the same key answers from the store");
  if (replayed.status === "replayed") expectEqual(replayed.payinConfigId, payinConfigId, "the replay answers the same config id");
  expectEqual(recorded.calls.length, 1, "a replay makes no second provider call");
  expectEqual(submissionStore.findByIdempotencyKey(companyId, idempotencyKey)?.version, 2, "a replay writes nothing");

  const mismatched = await createRainforestPayinConfig(
    configInput({ amountMinor: 13_000n }),
    submissionStore,
    paymentOptions(configStore, audits, recorded.transport),
  );
  expectEqual(mismatched.status, "rejected", "the same key with another amount is refused");
  if (mismatched.status === "rejected") {
    expectEqual(
      mismatched.reason,
      "the idempotency key was already used with another amount, merchant or currency",
      "the refusal explains the mismatched key",
    );
  }
  expectEqual(recorded.calls.length, 1, "a mismatched replay makes no provider call");

  const otherMerchant = await createRainforestPayinConfig(
    configInput({ merchantId: "sbx_mid_AnotherMerchant000000000001" }),
    submissionStore,
    paymentOptions(configStore, audits, recorded.transport),
  );
  expectEqual(otherMerchant.status, "rejected", "the same key with another merchant is refused");
  expectEqual(recorded.calls.length, 1, "the merchant mismatch makes no provider call");
}

/* ---- an in-flight attempt is never sent twice ---- */

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const recorded = paymentTransport(200, json({ data: { payin_config_id: payinConfigId } }));
  const submissionStore = new InMemoryRainforestPayinConfigStore();
  submissionStore.insert({
    id: "00000000-0000-4000-8000-00000000aa01",
    companyId,
    idempotencyKey,
    merchantId,
    amountMinor: 12_500n,
    currency: "USD",
    providerConfigId: null,
    outcome: "pending",
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: 4_000,
    updatedAtEpochMs: 4_000,
  });
  const inFlight = await createRainforestPayinConfig(
    configInput(),
    submissionStore,
    paymentOptions(configStore, audits, recorded.transport),
  );
  expectEqual(inFlight.status, "unknown", "an in-flight key answers unknown");
  if (inFlight.status === "unknown") {
    expectEqual(inFlight.requiresReconciliation, true, "an in-flight key needs reconciling");
    expectEqual(inFlight.reason, "the same payin config is already in flight; it is not sent twice", "the reason says it was not resent");
  }
  expectEqual(recorded.calls.length, 0, "an in-flight key makes no provider call");
  expectEqual(audits.length, 0, "an in-flight key writes no audit entry");
}

/* ---- the failure table ---- */

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];

  async function attempt(status: number, body: string, transport?: RainforestPaymentTransport) {
    const store = new InMemoryRainforestPayinConfigStore();
    const result = await createRainforestPayinConfig(
      configInput(),
      store,
      paymentOptions(configStore, audits, transport ?? paymentTransport(status, body).transport),
    );
    return { result, submission: store.findByIdempotencyKey(companyId, idempotencyKey) };
  }

  const validationAnswer = await attempt(
    400,
    json({ status: "ERROR", data: null, errors: [{ field: "amount", code: "RequestBody", message: "Amount is invalid" }] }),
  );
  expectEqual(validationAnswer.result.status, "rejected", "a 400 is a rejection");
  if (validationAnswer.result.status === "rejected") {
    expectEqual(validationAnswer.result.reason, "amount: Amount is invalid", "the rejection carries the documented field and message");
  }
  expectEqual(validationAnswer.submission?.outcome, "rejected", "the store records the rejection");
  expectEqual(validationAnswer.submission?.requiresReconciliation, false, "a rejection needs no reconciliation");

  const conflict = await attempt(409, json({ errors: [{ message: "The idempotency key was already used" }] }));
  expectEqual(conflict.result.status, "rejected", "a 409 is a rejection");
  if (conflict.result.status === "rejected") {
    expectEqual(conflict.result.reason, "The idempotency key was already used", "the 409 message is carried");
  }

  const sanitised = await attempt(422, json({ errors: [{ message: "<script>bad</script>input" }] }));
  expectEqual(sanitised.result.status, "rejected", "a 422 is a rejection");
  if (sanitised.result.status === "rejected") {
    expectEqual(sanitised.result.reason, "scriptbad/scriptinput", "the provider message is sanitised of markup");
  }

  const silentRefusal = await attempt(422, "");
  expectEqual(silentRefusal.result.status, "rejected", "a 422 without a message is still a rejection");
  if (silentRefusal.result.status === "rejected") {
    expectEqual(silentRefusal.result.reason, "the API refused the payin config with status 422", "the fallback reason names the status");
  }

  const unauthorised = await attempt(401, json({ errors: [{ message: "Invalid API key" }] }));
  expectEqual(unauthorised.result.status, "failed", "a 401 fails the call");
  if (unauthorised.result.status === "failed") {
    expectEqual(unauthorised.result.reason, "the API rejected the credential", "the 401 reason names the credential");
    expect(unauthorised.result.reason.includes(sandboxKey) === false, "the 401 reason carries no key");
  }
  expectEqual(unauthorised.submission?.outcome, "rejected", "a 401 is recorded as no creation");

  const forbidden = await attempt(403, json({}));
  expectEqual(forbidden.result.status, "failed", "a 403 fails the call");

  for (const status of [404, 405, 415, 302]) {
    const refused = await attempt(status, json({ errors: [{ message: "no route" }] }));
    expectEqual(refused.result.status, "failed", `a ${status} proves no config was created`);
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
    expectEqual(unknown.submission?.outcome, "unknown", `a ${status} is stored as unknown`);
    expectEqual(unknown.submission?.requiresReconciliation, true, `a ${status} marks the submission for reconciliation`);
  }

  const thrown = await attempt(200, "", throwingTransport);
  expectEqual(thrown.result.status, "unknown", "an unreachable API leaves the creation unknown");
  if (thrown.result.status === "unknown") {
    expectEqual(thrown.result.reason, "the API could not be reached, so the config may exist", "the unreachable reason says the config may exist");
  }
  expectEqual(thrown.submission?.outcome, "unknown", "an unreachable API stores an unknown submission");

  const noData = await attempt(200, json({ status: "SUCCESS" }));
  expectEqual(noData.result.status, "unknown", "a 2XX without data leaves the creation unknown");
  if (noData.result.status === "unknown") {
    expectEqual(noData.result.reason, "the answer named no usable payin config id", "the reason names the missing id");
  }

  const wrongId = await attempt(200, json({ data: { payin_config_id: "pmc_2DrDPKzdQypRudLd8DhQKZX27dA" } }));
  expectEqual(wrongId.result.status, "unknown", "a 2XX naming another object type leaves the creation unknown");

  const unreadable = await attempt(200, "not json");
  expectEqual(unreadable.result.status, "unknown", "an unreadable answer leaves the creation unknown");

  const auditOutcomes = audits.filter((entry) => entry.action === "payin.rainforest_config_created");
  expect(auditOutcomes.length >= 15, "every settled attempt writes an audit entry");
  expect(auditOutcomes.every((entry) => entry.providerKey === "rainforest"), "every config audit entry names the provider");
}

/* ---- no active key, and a key this keyring cannot open ---- */

{
  const emptyStore = new InMemoryRainforestConfigStore();
  const noKey = await createRainforestPayinConfig(configInput(), new InMemoryRainforestPayinConfigStore(), {
    configStore: emptyStore,
    keyring,
    occurredAtEpochMs: 5_000,
  });
  expectEqual(noKey.status, "failed", "a company without an active key cannot create a config");
  if (noKey.status === "failed") {
    expectEqual(noKey.reason, "no active Rainforest key configuration exists for this company", "the refusal names the missing configuration");
  }

  const configStore = await activeStoreFor(otherCompanyId);
  const unreadable = await createRainforestPayinConfig(
    configInput({ companyId: otherCompanyId }),
    new InMemoryRainforestPayinConfigStore(),
    paymentOptions(configStore, [], paymentTransport(200, json({})).transport, foreignKeyring),
  );
  expectEqual(unreadable.status, "failed", "a key this keyring cannot open creates no config");
  if (unreadable.status === "failed") {
    expectEqual(unreadable.reason, "the sealed credentials cannot be opened with this keyring", "the unreadable key says why");
  }
}

/* ---- an input the adapter refuses never reaches the provider ---- */

{
  const configStore = await activeStoreFor(companyId);
  const recorded = paymentTransport(200, json({ data: { payin_config_id: payinConfigId } }));
  const store = new InMemoryRainforestPayinConfigStore();
  const invalid = await createRainforestPayinConfig(
    configInput({ amountMinor: 0n }),
    store,
    paymentOptions(configStore, [], recorded.transport),
  );
  expectEqual(invalid.status, "failed", "an invalid input fails before the call");
  if (invalid.status === "failed") expectEqual(invalid.reason, "the amount must be positive", "the refusal is the validation reason");
  expectEqual(recorded.calls.length, 0, "an invalid input makes no provider call");
  expectEqual(store.findByIdempotencyKey(companyId, idempotencyKey), null, "an invalid input stores nothing");
}

/* ---- the store's invariants ---- */

{
  const store = new InMemoryRainforestPayinConfigStore();
  const base: RainforestPayinConfigSubmission = {
    id: "00000000-0000-4000-8000-00000000bb01",
    companyId,
    idempotencyKey,
    merchantId,
    amountMinor: 12_500n,
    currency: "USD",
    providerConfigId: null,
    outcome: "pending",
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000,
  };
  store.insert(base);
  expectEqual(store.findById(base.id)?.idempotencyKey, idempotencyKey, "the store reads back what it wrote");
  let threw = false;
  try {
    store.insert({ ...base, id: "00000000-0000-4000-8000-00000000bb02" });
  } catch {
    threw = true;
  }
  expectEqual(threw, true, "a second row for the same company and key is refused");

  threw = false;
  try {
    store.insert({ ...base, id: "00000000-0000-4000-8000-00000000bb03", idempotencyKey: "another-key-0001", outcome: "created", providerConfigId: payinConfigId });
  } catch {
    threw = true;
  }
  expectEqual(threw, true, "a new row cannot start outside pending");

  const created = { ...base, outcome: "created" as const, providerConfigId: payinConfigId, version: 2 };
  expectEqual(store.save(created, 1), true, "a pending row advances to created");
  expectEqual(store.save({ ...created, outcome: "unknown", version: 3 }, 2), false, "a created row cannot leave its final state");
  expectEqual(store.save({ ...created, version: 3 }, 1), false, "a stale version writes nothing");
  expectEqual(store.save({ ...created, amountMinor: 99_999n, version: 3 }, 2), false, "the amount is immutable");
  expectEqual(store.save({ ...created, merchantId: "sbx_mid_OtherMerchant000000000002", version: 3 }, 2), false, "the merchant is immutable");
  expectEqual(store.save({ ...created, idempotencyKey: "another-key-0002", version: 3 }, 2), false, "the idempotency key is immutable");

  const unknownRow = { ...base, id: "00000000-0000-4000-8000-00000000bb04", idempotencyKey: "unknown-row-0001", outcome: "unknown" as const, reason: "no answer", requiresReconciliation: true };
  store.insert({ ...unknownRow, outcome: "pending", requiresReconciliation: false });
  expectEqual(store.save({ ...unknownRow, version: 2 }, 1), true, "a pending row advances to unknown");
  expectEqual(store.save({ ...created, id: unknownRow.id, idempotencyKey: unknownRow.idempotencyKey, version: 3 }, 2), true, "an unknown row advances to created");
  expectEqual(
    store.save({ ...created, id: unknownRow.id, idempotencyKey: unknownRow.idempotencyKey, outcome: "unknown", version: 4 }, 3),
    false,
    "a row that resolved to created cannot return to unknown",
  );

  const noConfigId = { ...base, id: "00000000-0000-4000-8000-00000000bb05", idempotencyKey: "no-config-id-001", outcome: "created" as const, version: 2 };
  store.insert({ ...noConfigId, outcome: "pending", version: 1 });
  expectEqual(store.save(noConfigId, 1), false, "a created row must carry a provider config id");

  expectEqual(SUBMISSION_OUTCOMES["pending"].length, 4, "a pending row may reach every settled outcome");
  expectEqual(SUBMISSION_OUTCOMES["created"].length, 1, "a created row is final");
  expectEqual(SUBMISSION_OUTCOMES["rejected"].length, 1, "a rejected row is final");
  expectEqual(SUBMISSION_OUTCOMES["unknown"].includes("created"), true, "an unknown row may resolve to created");
  expectEqual(SUBMISSION_OUTCOMES["unknown"].includes("pending"), false, "an unknown row never returns to pending");
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: the component session
 * --------------------------------------------------------------------------------------------- */

expectEqual(validateRainforestSessionInput(sessionInput()), null, "a session for a merchant is valid");
expectEqual(validateRainforestSessionInput(sessionInput({ companyId: "" })), "the company id is required", "a blank company is refused");
expectEqual(
  validateRainforestSessionInput(sessionInput({ merchantId: "mid_AB" })),
  "the merchant id must carry the documented mid_ or sbx_mid_ prefix",
  "a malformed merchant is refused",
);
expectEqual(validateRainforestSessionInput(sessionInput({ ttlSeconds: 59 })), "the session lifetime must be at least 60 seconds", "a lifetime under a minute is refused");
expectEqual(
  validateRainforestSessionInput(sessionInput({ ttlSeconds: RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS + 1 })),
  "the session lifetime cannot exceed the documented 24 hours",
  "a lifetime past the documented maximum is refused",
);
expectEqual(validateRainforestSessionInput(sessionInput({ ttlSeconds: RAINFOREST_SESSION_MAXIMUM_TTL_SECONDS })), null, "the documented maximum lifetime is accepted");
expectEqual(validateRainforestSessionInput(sessionInput({ ttlSeconds: 1.5 })), "the session lifetime must be a whole number of seconds", "a fractional lifetime is refused");

const sessionBody = buildRainforestSessionBody(sessionInput());
expectEqual(sessionBody["ttl"], RAINFOREST_SESSION_DEFAULT_TTL_SECONDS, "the default lifetime is sent");
const statements = sessionBody["statements"] as Array<Record<string, unknown>>;
expectEqual(statements.length, 1, "one statement is sent");
expectEqual((statements[0]?.["permissions"] as string[])[0], "group#payment_component", "the statement grants the documented component group");
expectEqual((statements[0]?.["permissions"] as string[]).length, 1, "the statement grants nothing else");
const constraints = statements[0]?.["constraints"] as Record<string, Record<string, string>>;
expectEqual(constraints["merchant"]?.["merchant_id"], merchantId, "the statement is constrained to the merchant");
expectEqual(json(sessionBody).includes("group#all"), false, "a browser credential never asks for group#all");
expectEqual(buildRainforestSessionBody(sessionInput({ ttlSeconds: 900 }))["ttl"], 900, "a custom lifetime is sent");
expectEqual(RAINFOREST_SESSION_PURPOSES.length, 2, "a session may be created for one of two documented component purposes");
expectEqual(rainforestSessionPermissionOf("payment"), "group#payment_component", "a payment session asks for the payment group");
expectEqual(rainforestSessionPermissionOf("onboarding"), RAINFOREST_MERCHANT_ONBOARDING_PERMISSION, "an onboarding session asks for the onboarding group");
expectEqual(json(sessionBody).includes("merchant_onboarding_component"), false, "a payment session never asks for the onboarding group");
const onboardingSession = buildRainforestSessionBody(sessionInput({ purpose: "onboarding" }));
expectEqual(
  ((onboardingSession["statements"] as Array<Record<string, unknown>>)[0]?.["permissions"] as string[])[0],
  "group#merchant_onboarding_component",
  "an onboarding session body carries the onboarding group",
);
expectEqual(json(onboardingSession).includes("group#payment_component"), false, "an onboarding session never asks for the payment group");

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const recorded = paymentTransport(
    200,
    json({ data: { session_id: sessionId, session_key: sessionKey, expires_at: "2099-01-01T12:00:00Z" } }),
  );
  const created = await createRainforestSession(sessionInput(), paymentOptions(configStore, audits, recorded.transport));
  expectEqual(created.status, "created", "a 2XX naming a session key creates the session");
  if (created.status === "created") {
    expectEqual(created.sessionKey, sessionKey, "the session key is returned to the caller");
    expectEqual(created.sessionId, sessionId, "the session id is carried");
    expectEqual(created.expiresAtEpochMs, Date.parse("2099-01-01T12:00:00Z"), "the provider expiry is used when it parses");
  }
  expectEqual(recorded.calls.length, 1, "one call creates one session");
  expectEqual(recorded.calls[0]?.endpoint, `${RAINFOREST_SANDBOX_API_BASE}/v1/sessions`, "the session call uses the documented endpoint");
  const sentSession = JSON.parse(recorded.calls[0]?.body ?? "{}") as Record<string, unknown>;
  expectEqual(sentSession["ttl"], RAINFOREST_SESSION_DEFAULT_TTL_SECONDS, "the session call carries the lifetime");
  const sentStatement = (sentSession["statements"] as Array<Record<string, unknown>>)[0];
  expectEqual((sentStatement?.["permissions"] as string[])[0], "group#payment_component", "the session call asks for the component group only");
  expectEqual(
    ((sentStatement?.["constraints"] as Record<string, Record<string, string>>)["merchant"] ?? {})["merchant_id"],
    merchantId,
    "the session call is constrained to the merchant",
  );

  const sessionAudits = audits.filter((entry) => entry.action === "payin.rainforest_session_created");
  expectEqual(sessionAudits.length, 1, "a session writes one audit entry");
  expectEqual(sessionAudits[0]?.providerObjectId, sessionId, "the audit entry names the session, not the key");
  expectEqual(dump(sessionAudits).includes(sessionKey), false, "no audit entry carries the session key");
  expectEqual(dump(sessionAudits).includes(sandboxKey), false, "no audit entry carries the API key");
}

{
  const configStore = await activeStoreFor(companyId);
  const noExpiry = paymentTransport(200, json({ data: { session_id: sessionId, session_key: sessionKey } }));
  const created = await createRainforestSession(sessionInput({ ttlSeconds: 900 }), paymentOptions(configStore, [], noExpiry.transport));
  expectEqual(created.status, "created", "a session without an expiry is still created");
  if (created.status === "created") {
    expectEqual(created.expiresAtEpochMs, 5_000 + 900_000, "a missing expiry falls back to the requested lifetime");
    expectEqual(created.sessionId, sessionId, "the session id is carried without an expiry");
  }

  const garbageExpiry = paymentTransport(200, json({ data: { session_key: sessionKey, expires_at: "soon" } }));
  const fellBack = await createRainforestSession(sessionInput({ ttlSeconds: 600 }), paymentOptions(configStore, [], garbageExpiry.transport));
  if (fellBack.status === "created") {
    expectEqual(fellBack.expiresAtEpochMs, 5_000 + 600_000, "an unparseable expiry falls back to the requested lifetime");
    expectEqual(fellBack.sessionId, null, "a body without a session id carries none");
  } else {
    expectEqual(fellBack.status, "created", "an unparseable expiry does not fail the session");
  }

  const noKey = paymentTransport(200, json({ data: { session_id: sessionId } }));
  const missing = await createRainforestSession(sessionInput(), paymentOptions(configStore, [], noKey.transport));
  expectEqual(missing.status, "failed", "a 2XX without a session key fails");
  if (missing.status === "failed") expectEqual(missing.reason, "the answer carries no usable session key", "the reason names the missing key");

  const wrongKey = paymentTransport(200, json({ data: { session_key: "apikey_9c1f4a7b2e5d8c3a6f9b4e7d2a5c8f1b" } }));
  const malformed = await createRainforestSession(sessionInput(), paymentOptions(configStore, [], wrongKey.transport));
  expectEqual(malformed.status, "failed", "a session key of the wrong shape fails");

  const refused = paymentTransport(400, json({ errors: [{ field: "ttl", message: "ttl is invalid" }] }));
  const rejected = await createRainforestSession(sessionInput(), paymentOptions(configStore, [], refused.transport));
  expectEqual(rejected.status, "rejected", "a 400 rejects the session request");
  if (rejected.status === "rejected") expectEqual(rejected.reason, "ttl: ttl is invalid", "the rejection carries the provider message");

  const rejectedSilent = paymentTransport(422, "");
  const silent = await createRainforestSession(sessionInput(), paymentOptions(configStore, [], rejectedSilent.transport));
  expectEqual(silent.status, "rejected", "a 422 rejects the session request");
  if (silent.status === "rejected") expectEqual(silent.reason, "the API refused the session request", "the fallback reason is stable");

  for (const status of [401, 403, 404, 500, 503]) {
    const failed = await createRainforestSession(sessionInput(), paymentOptions(configStore, [], paymentTransport(status, "").transport));
    expectEqual(failed.status, "failed", `a ${status} fails the session request`);
    if (failed.status === "failed") {
      expectEqual(failed.reason, `the API refused the session request with status ${status}`, `the ${status} reason names the status`);
    }
  }

  const thrown = await createRainforestSession(sessionInput(), paymentOptions(configStore, [], throwingTransport));
  expectEqual(thrown.status, "failed", "an unreachable API fails the session request");
  if (thrown.status === "failed") expectEqual(thrown.reason, "the API could not be reached, so no session was created", "the unreachable reason is stable");

  const invalid = await createRainforestSession(sessionInput({ ttlSeconds: 0 }), paymentOptions(configStore, [], paymentTransport(200, "{}").transport));
  expectEqual(invalid.status, "failed", "an invalid session input fails before the call");
  if (invalid.status === "failed") expectEqual(invalid.reason, "the session lifetime must be at least 60 seconds", "the refusal is the validation reason");
}

/* ------------------------------------------------------------------------------------------------
 * Section 8: reading a payin
 * --------------------------------------------------------------------------------------------- */

/** One payin read against a fresh answer. */
async function readWith(status: number, body: string) {
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const recorded = paymentTransport(status, body);
  const result = await readRainforestPayin(
    { companyId, payinId, expectedAmountMinor: 12_500n, expectedCurrency: "USD" },
    paymentOptions(configStore, audits, recorded.transport),
  );
  return { result, calls: recorded.calls, audits };
}

/** A documented payin body. */
function payinBody(overrides: Record<string, unknown> = {}): string {
  return json({
    status: "SUCCESS",
    data: {
      payin_id: payinId,
      payin_config_id: payinConfigId,
      merchant_id: merchantId,
      amount: 12_500,
      currency_code: "USD",
      status: "SUCCEEDED",
      method_type: "CARD",
      ...overrides,
    },
  });
}

{
  const succeeded = await readWith(200, payinBody());
  expectEqual(succeeded.result.status, "succeeded", "the documented success status is the only success");
  if (succeeded.result.status === "succeeded") {
    expectEqual(succeeded.result.amountMinor, 12_500n, "the success carries the settled amount");
    expectEqual(succeeded.result.currency, "USD", "the success carries the currency");
    expectEqual(succeeded.result.methodType, "CARD", "the success carries the method type");
  }
  expectEqual(succeeded.calls.length, 1, "a read makes one call");
  expectEqual(succeeded.calls[0]?.method, "GET", "the read is a get");
  expectEqual(succeeded.calls[0]?.endpoint, `${RAINFOREST_SANDBOX_API_BASE}/v1/payins/${payinId}`, "the read uses the documented payin endpoint");
  const readAudits = succeeded.audits.filter((entry) => entry.action === "payin.rainforest_status_read");
  expectEqual(readAudits.length, 1, "a read writes one audit entry");
  expectEqual(readAudits[0]?.providerObjectId, payinId, "the read audit names the payin");
  expectEqual(dump(succeeded.audits).includes(sandboxKey), false, "no read audit carries the API key");

  for (const status of ["CREATED", "PRESENTING", "AUTHORIZED", "PROCESSING", "IN_REVIEW"]) {
    const pending = await readWith(200, payinBody({ status }));
    expectEqual(pending.result.status, "pending", `a ${status} payin is pending, never a success`);
    if (pending.result.status === "pending") {
      expectEqual(pending.result.payinStatus, status, `the pending read keeps the ${status} status`);
      expectEqual(pending.result.amountMinor, 12_500n, "the pending read carries the amount");
    }
  }

  const failed = await readWith(
    200,
    payinBody({ status: "FAILED", refusal_code: "INSUFFICIENT_FUNDS", refusal_desc: "There are not enough funds on the card" }),
  );
  expectEqual(failed.result.status, "failed", "the documented failure status is a failure");
  if (failed.result.status === "failed") {
    expectEqual(failed.result.refusalCode, "INSUFFICIENT_FUNDS", "the documented refusal code is carried");
    expectEqual(failed.result.refusalCodeKnown, true, "a documented refusal code is known");
    expectEqual(failed.result.refusalDescription, "There are not enough funds on the card", "the documented refusal description is carried");
  }

  const detailed = await readWith(
    200,
    payinBody({ status: "FAILED", refusal_code: "DO_NOT_HONOR", refusal_desc: "short", detailed_refusal_desc: "The issuer refused the payment" }),
  );
  if (detailed.result.status === "failed") {
    expectEqual(detailed.result.refusalDescription, "The issuer refused the payment", "the detailed description is preferred");
  } else {
    expectEqual(detailed.result.status, "failed", "a documented failure is a failure");
  }

  const novel = await readWith(200, payinBody({ status: "FAILED", refusal_code: "A_NEW_CODE", refusal_desc: "Something new" }));
  if (novel.result.status === "failed") {
    expectEqual(novel.result.refusalCode, "A_NEW_CODE", "an unpublished code is carried as text");
    expectEqual(novel.result.refusalCodeKnown, false, "an unpublished code is not claimed as known");
  } else {
    expectEqual(novel.result.status, "failed", "a failure with an unpublished code is still a failure");
  }

  const markup = await readWith(200, payinBody({ status: "FAILED", refusal_code: "DECLINED", refusal_desc: "<b>Declined</b>" }));
  if (markup.result.status === "failed") {
    expectEqual(markup.result.refusalDescription, "bDeclined/b", "the refusal description is sanitised");
  } else {
    expectEqual(markup.result.status, "failed", "a decline is a failure");
  }

  const noRefusal = await readWith(200, payinBody({ status: "RETURNED" }));
  if (noRefusal.result.status === "failed") {
    expectEqual(noRefusal.result.refusalCode, null, "a failure without a code carries none");
    expectEqual(noRefusal.result.refusalCodeKnown, false, "a missing code is not known");
    expectEqual(noRefusal.result.refusalDescription, null, "a failure without a description carries none");
  } else {
    expectEqual(noRefusal.result.status, "failed", "a returned ACH payin is a failure");
  }

  for (const status of ["FAILED", "RETURNED", "CANCELED"]) {
    const terminal = await readWith(200, payinBody({ status }));
    expectEqual(terminal.result.status, "failed", `a ${status} payin is a failure`);
  }
}

/* ---- the reads that must never become a success or a failure ---- */

{
  const amountMismatch = await readWith(200, payinBody({ amount: 12_499 }));
  expectEqual(amountMismatch.result.status, "unknown", "another settled amount is never a success");
  if (amountMismatch.result.status === "unknown") {
    expectEqual(amountMismatch.result.requiresReconciliation, true, "an amount mismatch needs reconciling");
    expectEqual(amountMismatch.result.reason, "the payin settled another amount than the platform asked for", "the reason names the amount");
  }

  const currencyMismatch = await readWith(200, payinBody({ currency_code: "EUR" }));
  expectEqual(currencyMismatch.result.status, "unknown", "another currency is never a success");
  if (currencyMismatch.result.status === "unknown") {
    expectEqual(currencyMismatch.result.reason, "the payin settled another currency than the platform asked for", "the reason names the currency");
  }

  const noAmount = await readWith(200, payinBody({ amount: undefined }));
  expectEqual(noAmount.result.status, "unknown", "a payin without an amount is unknown");
  if (noAmount.result.status === "unknown") {
    expectEqual(noAmount.result.reason, "the payin carries no readable amount", "the reason names the missing amount");
  }

  const undocumented = await readWith(200, payinBody({ status: "SETTLED" }));
  expectEqual(undocumented.result.status, "unknown", "an undocumented status is unknown");
  if (undocumented.result.status === "unknown") {
    expect(undocumented.result.reason.includes("undocumented status"), "the reason names the undocumented status");
    expect(undocumented.result.reason.includes("SETTLED"), "the reason quotes the status");
  }

  const noStatus = await readWith(200, payinBody({ status: undefined }));
  expectEqual(noStatus.result.status, "unknown", "a payin without a status is unknown");
  if (noStatus.result.status === "unknown") {
    expectEqual(noStatus.result.reason, "the payin carries no status", "the reason names the missing status");
  }

  const noData = await readWith(200, json({ status: "SUCCESS" }));
  expectEqual(noData.result.status, "unknown", "an answer without a payin is unknown");
  if (noData.result.status === "unknown") {
    expectEqual(noData.result.reason, "the answer carries no readable payin", "the reason names the missing payin");
  }

  const emptyBody = await readWith(200, "");
  expectEqual(emptyBody.result.status, "unknown", "an empty answer is unknown");

  const notFound = await readWith(404, json({ errors: [{ message: "Payin not found" }] }));
  expectEqual(notFound.result.status, "unknown", "a 404 is never evidence that no money moved");
  if (notFound.result.status === "unknown") {
    expectEqual(notFound.result.requiresReconciliation, true, "a 404 needs reconciling");
    expect(notFound.result.reason.includes("404"), "the 404 reason names the status");
    expect(notFound.result.reason.includes("Payin not found"), "the 404 reason carries the provider message");
  }

  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    const refused = await readWith(status, json({ errors: [{ message: "no answer" }] }));
    expectEqual(refused.result.status, "unknown", `a ${status} on a read is unknown`);
    if (refused.result.status === "unknown") {
      expectEqual(refused.result.requiresReconciliation, true, `a ${status} read needs reconciling`);
      expect(refused.result.reason.includes(`${status}`), `the ${status} read reason names the status`);
    }
  }

  const configStore = await activeStoreFor(companyId);
  const unreachable = await readRainforestPayin(
    { companyId, payinId, expectedAmountMinor: 12_500n, expectedCurrency: "USD" },
    paymentOptions(configStore, [], throwingTransport),
  );
  expectEqual(unreachable.status, "unknown", "an unreachable API is unknown");
  if (unreachable.status === "unknown") {
    expectEqual(unreachable.reason, "the API could not be reached", "the unreachable reason is stable");
  }

  const malformedId = await readRainforestPayin(
    { companyId, payinId: "pyi_../../admin", expectedAmountMinor: 12_500n, expectedCurrency: "USD" },
    paymentOptions(configStore, []),
  );
  expectEqual(malformedId.status, "unknown", "a payin id of the wrong shape is unknown");
  if (malformedId.status === "unknown") {
    expectEqual(malformedId.reason, "the payin id does not carry the documented pyi or sbx_pyi prefix", "the reason names the id shape");
  }

  const noExpectedAmount = await readRainforestPayin(
    { companyId, payinId, expectedAmountMinor: 0n, expectedCurrency: "USD" },
    paymentOptions(configStore, []),
  );
  expectEqual(noExpectedAmount.status, "unknown", "a read without an expected amount is unknown");
  if (noExpectedAmount.status === "unknown") {
    expectEqual(noExpectedAmount.reason, "the expected amount must be positive to compare a payin against it", "the reason names the expectation");
  }

  const noKey = await readRainforestPayin(
    { companyId: otherCompanyId, payinId, expectedAmountMinor: 12_500n, expectedCurrency: "USD" },
    { configStore: new InMemoryRainforestConfigStore(), keyring, occurredAtEpochMs: 5_000 },
  );
  expectEqual(noKey.status, "unknown", "a company without an active key reads nothing");
  if (noKey.status === "unknown") {
    expectEqual(noKey.reason, "no active Rainforest key configuration exists for this company", "the read reason names the missing configuration");
  }

  const unreadable = await readRainforestPayin(
    { companyId: otherCompanyId, payinId, expectedAmountMinor: 12_500n, expectedCurrency: "USD" },
    paymentOptions(await activeStoreFor(otherCompanyId), [], paymentTransport(200, payinBody()).transport, foreignKeyring),
  );
  expectEqual(unreadable.status, "unknown", "a key this keyring cannot open reads nothing");
  if (unreadable.status === "unknown") {
    expectEqual(unreadable.reason, "the sealed credentials cannot be opened with this keyring", "the unreadable read says why");
  }
}

/* ---- a production configuration reads the production endpoint ---- */

{
  const configStore = await activeStoreFor(companyId, "production");
  const recorded = paymentTransport(200, json({ data: { status: "SUCCEEDED", amount: 12_500, currency_code: "USD", method_type: "ACH" } }));
  const read = await readRainforestPayin(
    { companyId, payinId: "pyi_2DrDPKzdQypRudLd8DhQKZX27dA", expectedAmountMinor: 12_500n, expectedCurrency: "USD" },
    paymentOptions(configStore, [], recorded.transport),
  );
  expectEqual(read.status, "succeeded", "a production payin read succeeds");
  expectEqual(recorded.calls[0]?.endpoint, `${RAINFOREST_PRODUCTION_API_BASE}/v1/payins/pyi_2DrDPKzdQypRudLd8DhQKZX27dA`, "the production read uses the production base");
  expectEqual(recorded.calls[0]?.apiKey, productionKey, "the production read opens the production key");
  if (read.status === "succeeded") expectEqual(read.methodType, "ACH", "the method type is carried");
}

/* ------------------------------------------------------------------------------------------------
 * Section 9: the component contract
 * --------------------------------------------------------------------------------------------- */

{
  const sandbox = rainforestPaymentComponentFor("sandbox", sessionKey, payinConfigId);
  expect(sandbox !== null, "a documented session key and config id yield a component");
  if (sandbox !== null) {
    expectEqual(sandbox.tag, "rainforest-payment", "the component is the documented element");
    expectEqual(sandbox.scriptUrl, "https://static.rainforestpay.com/sandbox.payment.js", "the sandbox component loads the sandbox bundle");
    expectEqual(sandbox.attributes["session-key"], sessionKey, "the component carries the session key attribute");
    expectEqual(sandbox.attributes["payin-config-id"], payinConfigId, "the component carries the payin config attribute");
    expectEqual(dump(sandbox).includes(sandboxKey), false, "the component contract carries no API key");
  }

  const production = rainforestPaymentComponentFor("production", sessionKey, productionPayinConfigId);
  expect(production !== null, "a production component is built");
  if (production !== null) {
    expectEqual(production.scriptUrl, "https://static.rainforestpay.com/payment.js", "the production component loads the production bundle");
    expectEqual(production.attributes["payin-config-id"], productionPayinConfigId, "the production component carries the production config");
  }

  expectEqual(rainforestPaymentComponentFor("sandbox", "not-a-session-key", payinConfigId), null, "a session key of the wrong shape yields no component");
  expectEqual(rainforestPaymentComponentFor("sandbox", sessionKey, "pmc_2DrDPKzdQypRudLd8DhQKZX27dA"), null, "a config id of the wrong type yields no component");
  expectEqual(rainforestPaymentComponentFor("sandbox", "", ""), null, "empty values yield no component");
}

/* ------------------------------------------------------------------------------------------------
 * Section 10: the security sweep
 * --------------------------------------------------------------------------------------------- */

{
  const configStore = await activeStoreFor(companyId);
  const audits: RainforestPaymentAuditEntry[] = [];
  const submissionStore: RainforestPayinConfigStore = new InMemoryRainforestPayinConfigStore();
  const routed: RainforestPaymentTransport = async (endpoint, method) => {
    if (endpoint.endsWith("/v1/sessions")) {
      return { status: 200, body: json({ data: { session_key: sessionKey, session_id: sessionId } }) };
    }
    if (method === "GET") return { status: 200, body: payinBody() };
    return { status: 200, body: json({ data: { payin_config_id: payinConfigId } }) };
  };
  const options = paymentOptions(configStore, audits, routed);
  await createRainforestPayinConfig(configInput(), submissionStore, options);
  await createRainforestSession(sessionInput(), options);
  await readRainforestPayin({ companyId, payinId, expectedAmountMinor: 12_500n, expectedCurrency: "USD" }, options);

  const auditDump = dump(audits);
  expect(auditDump.includes(sandboxKey) === false, "the audit trail carries no API key");
  expect(auditDump.includes(sessionKey) === false, "the audit trail carries no session key");
  expect(auditDump.includes("4111") === false, "the audit trail carries no card number");
  const actions = new Set(audits.map((entry) => entry.action));
  expect(actions.has("payin.rainforest_config_created"), "the audit trail records the config creation");
  expect(actions.has("payin.rainforest_session_created"), "the audit trail records the session");
  expect(actions.has("payin.rainforest_status_read"), "the audit trail records the read");

  const stored = submissionStore.findByIdempotencyKey(companyId, idempotencyKey);
  expect(stored !== null, "the submission is stored");
  const storedDump = dump(stored);
  expect(storedDump.includes(sandboxKey) === false, "the stored submission carries no API key");
  expect(storedDump.includes(sessionKey) === false, "the stored submission carries no session key");
  expect(storedDump.includes("4111") === false, "the stored submission carries no card number");
  expectEqual(dump(configStore.findActiveByCompany(companyId)).includes(sandboxKey), false, "the stored configuration carries no plaintext key");
  expectEqual(
    openSecret(keyring, configStore.findActiveByCompany(companyId)?.apiKeySealed ?? "", {
      purpose: "secret",
      scope: rainforestApiKeyScope(companyId),
    }),
    sandboxKey,
    "the active key stays sealed until a call opens it",
  );
}

/* ---- the constants this file depends on are frozen ---- */

expect(Object.isFrozen(RAINFOREST_REFUSAL_CODES), "the refusal vocabulary is frozen");
expect(Object.isFrozen(RAINFOREST_COMPONENT_SCRIPT_URLS), "the bundle table is frozen");
expect(Object.isFrozen(RAINFOREST_COMPONENT_CSP_HOSTS), "the CSP hosts are frozen");
expect(Object.isFrozen(RAINFOREST_PAYIN_CONFIG_ID_PREFIXES), "the config prefixes are frozen");
expect(Object.isFrozen(RAINFOREST_PAYIN_ID_PREFIXES), "the payin prefixes are frozen");
expect(Object.isFrozen(SUBMISSION_OUTCOMES), "the outcome table is frozen");
expect(Object.isFrozen(SUBMISSION_OUTCOMES["pending"]), "the outcome lists are frozen");
expect(RAINFOREST_PAYIN_STATUSES.includes("SUCCEEDED"), "the recorded payin status vocabulary still holds the success status");
expect(RAINFOREST_API_VERSION.length > 0, "the documented API version is recorded");

/* ---- the verdict ---- */

const label =
  "payments Rainforest payment gate passed: " +
  `${checks} checks (a payin config body of documented fields only, an idempotent creation that never sends twice, ` +
  "a component session scoped to one merchant and one permission group, a component contract with no API key, " +
  "and a payin read whose only success is the documented SUCCEEDED status at the amount and currency the platform asked for)";

if (failures.length > 0) {
  process.stderr.write(`payments Rainforest payment gate failed: ${failures.length} of ${checks} checks\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`${label}\n`);
