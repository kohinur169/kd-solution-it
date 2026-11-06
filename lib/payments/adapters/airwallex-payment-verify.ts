// path: lib/payments/adapters/airwallex-payment-verify.ts

/**
 * The gate for STEP 168: taking a payment through Airwallex.
 *
 * A check script, not a test file. It builds a real configuration with STEP 166's code, a ready connected account
 * with STEP 167's record shape and STEP 165's body builder, drives a recording transport through the documented
 * answers, and fails naming every check that did not hold. No network call is made and no real credential exists.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  airwallexChargeReferenceIsUsable,
  airwallexChargeRequestId,
  airwallexClientSecretOf,
  airwallexFeeTextOf,
  airwallexIntentAmountOf,
  airwallexIntentRequestOf,
  airwallexPaymentFetchTransport,
  airwallexPaymentIntentIdOf,
  airwallexPaymentIntentPath,
  airwallexPaymentMessageOf,
  airwallexPaymentStatusOf,
  airwallexRequestIdIsDocumented,
  applyAirwallexPaymentIntentRead,
  createAirwallexCharge,
  InMemoryAirwallexPaymentAttemptStore,
  isAirwallexPaymentIntentId,
  isAirwallexPaymentPath,
  markAirwallexAttemptUnread,
  parseAirwallexPaymentIntentAnswer,
  parseAirwallexPaymentReadAnswer,
  readAirwallexPaymentIntent,
  validateAirwallexChargeRequest,
  AIRWALLEX_ATTEMPT_OUTCOMES,
  AIRWALLEX_CHARGE_REFERENCE_MAXIMUM_LENGTH,
  AIRWALLEX_CHARGE_REQUEST_ID_MAXIMUM_LENGTH,
  AIRWALLEX_CLIENT_SECRET_MAXIMUM_LENGTH,
  AIRWALLEX_PAYMENT_ALLOWED_PATH_PATTERNS,
  AIRWALLEX_PAYMENT_INTENT_CREATE_PATH,
  AIRWALLEX_PAYMENT_INTENT_ID_PATTERN,
  AIRWALLEX_PAYMENT_INTENT_PATH_PREFIX,
  AIRWALLEX_PAYMENT_INTENT_READ_PATH_PATTERN,
  AIRWALLEX_PAYMENT_TEXT_MAXIMUM_LENGTH,
  AIRWALLEX_PAYMENT_TIMEOUT_MS,
  type AirwallexChargeRequest,
  type AirwallexPaymentAttempt,
  type AirwallexPaymentAuditEntry,
  type AirwallexPaymentCall,
  type AirwallexPaymentTransport,
  type ReadAirwallexPaymentIntentResult,
} from "./airwallex-payment.ts";
import {
  activateAirwallexConfig,
  configureAirwallexKeys,
  InMemoryAirwallexConfigStore,
  InMemoryAirwallexTokenCache,
  testAirwallexConnection,
  AIRWALLEX_LOGIN_PATH,
} from "./airwallex-client.ts";
import type { AirwallexAccountProvision } from "./airwallex-accounts.ts";
import {
  AIRWALLEX_ENDPOINTS,
  AIRWALLEX_ON_BEHALF_OF_HEADER,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_REQUEST_ID_PATTERN,
  buildAirwallexPaymentIntentBody,
  type AirwallexPaymentIntentRequest,
} from "./airwallex.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

/** Render any value for a failure message, including the bigint amounts this file records. */
function asText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function expect(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) failures.push(description);
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${description} (expected ${asText(expected)}, received ${asText(actual)})`);
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

/* ---- fixtures ---- */

const NOW = 1_760_000_000_000;
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const accountId = "acct_A1b2C3d4E5f6G7h8I9j0";
const intentId = "int_KdPaymentIntent0001";
const otherIntentId = "int_KdPaymentIntent0002";
const clientSecret = "int_KdPaymentIntent0001_secret_AbCdEf0123456789";
const accessToken = "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MjQwMDAwMDB9.c2lnbmF0dXJlLXZhbHVl";
const clientId = "cid_AbCd1234EfGh5678";
const apiKey = "key_ZzYyXx9876WwVvUuTtSsRrQq";
const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const loginAnswer = JSON.stringify({ token: accessToken, expires_at: "2026-01-01T12:30:00+0000" });
const balancesAnswer = JSON.stringify([{ currency: "USD", available_amount: 1 }]);

const charge: AirwallexChargeRequest = {
  companyId,
  amountMinor: 1_000_000n,
  platformFeeMinor: 10_000n,
  currency: "usd",
  merchantOrderId: "INV-2026-0001",
  reference: "invoice-2026-0001",
  returnUrl: "https://pay.example.com/return",
  descriptor: "Tamarind Kitchen",
  metadata: { invoice_id: "INV-2026-0001" },
};

const intentAnswer = JSON.stringify({
  id: intentId,
  status: "REQUIRES_PAYMENT_METHOD",
  client_secret: clientSecret,
  amount: 100,
  currency: "USD",
});

const paidAnswer = JSON.stringify({ id: intentId, status: "SUCCEEDED", amount: 100, currency: "USD" });

/** A connected account that is ready: created, ACTIVE, read a moment ago. */
function activeProvision(overrides: Partial<AirwallexAccountProvision> = {}): AirwallexAccountProvision {
  return {
    id: "0a1b2c3d-0000-4000-8000-000000000001",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId,
    environment: "sandbox",
    kycSubmissionId: "kyc-submission-1",
    accountKind: "business",
    accountId,
    attemptStatus: "created",
    accountStatus: "ACTIVE",
    onboardingState: "ready",
    submittedAtEpochMs: NOW - 60_000,
    verificationCheckedAtEpochMs: NOW - 1_000,
    verificationCheckCount: 2,
    reason: null,
    requiresReconciliation: false,
    version: 4,
    createdAtEpochMs: NOW - 600_000,
    updatedAtEpochMs: NOW - 1_000,
    ...overrides,
  };
}

/** An active, proven Airwallex configuration, built with STEP 166's own functions. */
async function activeConfigStore(): Promise<{
  readonly configStore: InMemoryAirwallexConfigStore;
  readonly tokenCache: InMemoryAirwallexTokenCache;
}> {
  const configStore = new InMemoryAirwallexConfigStore();
  const tokenCache = new InMemoryAirwallexTokenCache();
  const configured = configureAirwallexKeys(
    { companyId, environment: "sandbox", clientId, apiKey, webhookSecret: null },
    { store: configStore, keyring, occurredAtEpochMs: NOW },
  );
  if (configured.status !== "configured") throw new Error("the fixture configuration failed");
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
  return { configStore, tokenCache };
}

async function optionsFor(
  answerFor: (call: AirwallexPaymentCall) => { readonly status: number; readonly body: string },
  audits: string[] = [],
  provision: AirwallexAccountProvision = activeProvision(),
): Promise<{
  readonly options: Parameters<typeof createAirwallexCharge>[1];
  readonly calls: AirwallexPaymentCall[];
  readonly attemptStore: InMemoryAirwallexPaymentAttemptStore;
  readonly loginCalls: string[];
}> {
  const company = await activeConfigStore();
  const calls: AirwallexPaymentCall[] = [];
  const transport: AirwallexPaymentTransport = async (call) => {
    calls.push(call);
    return answerFor(call);
  };
  const loginCalls: string[] = [];
  const attemptStore = new InMemoryAirwallexPaymentAttemptStore();
  return {
    options: {
      provision,
      configStore: company.configStore,
      keyring,
      tokenCache: company.tokenCache,
      attemptStore,
      occurredAtEpochMs: NOW,
      transport,
      loginTransport: async (call) => {
        loginCalls.push(call.path);
        return call.path === AIRWALLEX_LOGIN_PATH
          ? { status: 201, body: loginAnswer }
          : { status: 200, body: balancesAnswer };
      },
      recordAudit: (entry: AirwallexPaymentAuditEntry) => audits.push(`${entry.action}:${entry.outcome}`),
    },
    calls,
    attemptStore,
    loginCalls,
  };
}

const readResult = (
  overrides: Partial<Extract<ReadAirwallexPaymentIntentResult, { status: "read" }>> = {},
): Extract<ReadAirwallexPaymentIntentResult, { status: "read" }> => ({
  status: "read",
  paymentIntentId: intentId,
  providerStatus: "SUCCEEDED",
  outcome: "paid",
  amountText: "100.00",
  currency: "usd",
  clientSecret: null,
  ...overrides,
});

const expectedRequestId = airwallexChargeRequestId(charge);

/* ---- the documented surface ---- */

expectEqual(AIRWALLEX_PAYMENT_INTENT_CREATE_PATH, AIRWALLEX_ENDPOINTS["paymentIntentCreate"], "the create path is the record's own");
expectEqual(
  airwallexPaymentIntentPath(intentId),
  `${AIRWALLEX_PAYMENT_INTENT_PATH_PREFIX}${intentId}`,
  "the read path is the documented shape",
);
expect(AIRWALLEX_PAYMENT_INTENT_READ_PATH_PATTERN.test(airwallexPaymentIntentPath(intentId)), "the read path matches its pattern");
expectEqual(AIRWALLEX_PAYMENT_ALLOWED_PATH_PATTERNS.length, 2, "two paths may be called: create and read");
expect(Object.isFrozen(AIRWALLEX_PAYMENT_ALLOWED_PATH_PATTERNS), "the allowlist is frozen");
expect(isAirwallexPaymentPath(AIRWALLEX_PAYMENT_INTENT_CREATE_PATH), "create is allowlisted");
expect(isAirwallexPaymentPath(airwallexPaymentIntentPath(intentId)), "a read is allowlisted");
expect(isAirwallexPaymentPath(`/api/v1/pa/payment_intents/${intentId}/confirm`) === false, "confirm is not this STEP's path");
expect(isAirwallexPaymentPath(`/api/v1/pa/payment_intents/${intentId}/cancel`) === false, "cancel is not this STEP's path");
expect(isAirwallexPaymentPath("/api/v1/transfers/create") === false, "the transfer path belongs to STEP 169");
expect(isAirwallexPaymentPath(`${AIRWALLEX_PAYMENT_INTENT_CREATE_PATH}/`) === false, "a trailing slash is not the documented path");
expect(isAirwallexPaymentPath("/api/v1/pa/payment_intents/") === false, "the prefix alone names no intent");
expect(isAirwallexPaymentIntentId(intentId), "a plausible intent id is accepted");
expectEqual(isAirwallexPaymentIntentId(""), false, "an empty id is refused");
expectEqual(isAirwallexPaymentIntentId("short"), false, "a too-short id is refused");
expectEqual(isAirwallexPaymentIntentId(accountId), false, "a connected-account id is not a payment intent id");
expectEqual(isAirwallexPaymentIntentId("pi_StripeShaped0001"), true, "another provider's id is shape-compatible but never assumed");
expectThrows(() => airwallexPaymentIntentPath("short"), "a too-short id is refused when a path is built");
expectThrows(() => airwallexPaymentIntentPath(accountId), "an account id is refused when a path is built");
expectEqual(AIRWALLEX_PAYMENT_TIMEOUT_MS, 20_000, "the call timeout is bounded");
expectEqual(AIRWALLEX_PAYMENT_TEXT_MAXIMUM_LENGTH, 200, "the provider text is bounded");
expectEqual(AIRWALLEX_CLIENT_SECRET_MAXIMUM_LENGTH, 512, "the client secret is bounded before it is carried");
expectEqual(AIRWALLEX_CHARGE_REFERENCE_MAXIMUM_LENGTH, 120, "the reference is bounded");
expectEqual(AIRWALLEX_PAYMENT_INTENT_ID_PATTERN.source.includes("acct"), false, "no prefix is assumed for an intent id");
expectEqual(AIRWALLEX_ON_BEHALF_OF_HEADER, "x-on-behalf-of", "the documented acting-for header is used");

/* ---- the request and its body ---- */

expectEqual(validateAirwallexChargeRequest(charge), null, "a well formed charge is accepted");
expectEqual(validateAirwallexChargeRequest({ ...charge, platformFeeMinor: -1n }), "the platform fee cannot be negative", "a negative fee is refused");
expectEqual(
  validateAirwallexChargeRequest({ ...charge, platformFeeMinor: 1_000_000n }),
  "the platform fee must be smaller than the payment",
  "a fee equal to the payment is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, reference: "  " }),
  "a payment reference is required, because the request id derives from it",
  "a blank reference is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, reference: "r".repeat(121) }),
  "the payment reference is longer than 120 characters",
  "an over-long reference is refused",
);
expectEqual(validateAirwallexChargeRequest({ ...charge, amountMinor: 1n }), "the amount is not a whole number of the currency's minor unit", "a fraction of a minor unit is refused");
expectEqual(validateAirwallexChargeRequest({ ...charge, amountMinor: 0n }), "the amount must be greater than zero", "a zero amount is refused");
expectEqual(validateAirwallexChargeRequest({ ...charge, currency: "eur" }), "the currency is not supported by this adapter", "an unsupported currency is refused");
expectEqual(
  validateAirwallexChargeRequest({ ...charge, returnUrl: "http://pay.example.com/return" }),
  "the return URL must be an absolute HTTPS URL",
  "a plain-HTTP return URL is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, merchantOrderId: "  " }),
  "a merchant order id is required",
  "a blank merchant order id is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, merchantOrderId: "m".repeat(65) }),
  "the merchant order id is longer than 64 characters",
  "an over-long merchant order id is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, descriptor: "d".repeat(65) }),
  "the descriptor is longer than 64 characters",
  "an over-long descriptor is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, metadata: { "bad key!": "x" } }),
  "a metadata key must be 1 to 40 letters, digits or underscores",
  "a bad metadata key is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, metadata: { note: "v".repeat(501) } }),
  "a metadata value is too long",
  "an over-long metadata value is refused",
);
expectEqual(
  validateAirwallexChargeRequest({ ...charge, metadata: { note: "Bearer abcdefghijklmnop" } }),
  "a metadata value must not carry a credential or a client secret",
  "a credential in metadata is refused",
);

const intentRequest: AirwallexPaymentIntentRequest = airwallexIntentRequestOf(charge);
const body = buildAirwallexPaymentIntentBody(intentRequest);
expectEqual(body["amount"], 100, "the amount is sent in major units, as the page documents");
expectEqual(body["currency"], "USD", "the currency is upper-case");
expectEqual(body["merchant_order_id"], "INV-2026-0001", "the merchant order id is sent");
expectEqual(body["request_id"], intentRequest.requestId, "the derived request id is sent");
expectEqual(body["return_url"], "https://pay.example.com/return", "the return URL is sent when given");
expectEqual(asText(body["metadata"]), asText(charge.metadata), "the metadata is sent as given");
expectEqual(asText(body).includes("client_secret"), false, "the body carries no client secret");
expectEqual(asText(body).toLowerCase().includes("card"), false, "the body carries no card field");
expectEqual(asText(body).includes("fee"), false, "the body carries no fee field, because that page was never read");
expectEqual(asText(body).includes("token"), false, "the body carries no token");

const bodyWithoutOptionals = buildAirwallexPaymentIntentBody(
  airwallexIntentRequestOf({ ...charge, returnUrl: null, descriptor: null, metadata: {} }),
);
expectEqual(asText(bodyWithoutOptionals).includes("return_url"), false, "no return URL is sent when there is none");
expectEqual(asText(bodyWithoutOptionals).includes("metadata"), false, "no metadata block is sent when it is empty");

expectEqual(airwallexChargeRequestId(charge), expectedRequestId, "the request id is deterministic");
expect(airwallexRequestIdIsDocumented(expectedRequestId), "the derived request id matches the documented pattern");
expectEqual(AIRWALLEX_REQUEST_ID_PATTERN.test(expectedRequestId), true, "the derived request id passes STEP 165's pattern");
expect(expectedRequestId.length <= AIRWALLEX_CHARGE_REQUEST_ID_MAXIMUM_LENGTH, "the derived request id is inside the documented bound");
expect(airwallexChargeRequestId({ ...charge, reference: "invoice-2026-0002" }) !== expectedRequestId, "another reference is another request id");
expect(airwallexChargeRequestId({ ...charge, companyId: otherCompanyId }) !== expectedRequestId, "another company is another request id");
expectEqual(airwallexChargeReferenceIsUsable("invoice-2026-0001"), true, "a plain reference is usable");
expectEqual(airwallexChargeReferenceIsUsable("   "), false, "a blank reference is not usable");
expectEqual(airwallexChargeReferenceIsUsable("Bearer abcdefghijkl"), false, "a reference carrying a header is not usable");
expectEqual(airwallexFeeTextOf(10_000n, "usd"), "1.00", "the fee is shown in major units");
expectEqual(airwallexFeeTextOf(250n, "usd"), null, "a fee below the minor unit is not shown as an amount");

/* ---- reading answers ---- */

{
  const created = parseAirwallexPaymentIntentAnswer(201, intentAnswer);
  expectEqual(created.outcome, "created", "a 2XX with an id creates");
  if (created.outcome !== "created") throw new Error("unreachable");
  expectEqual(created.paymentIntentId, intentId, "the intent id is read");
  expectEqual(created.status, "REQUIRES_PAYMENT_METHOD", "the documented status is read");
  expectEqual(created.paymentOutcome, "requires_customer_action", "the status maps through STEP 165's table");
  expectEqual(created.clientSecret, clientSecret, "the client secret is carried to the caller once");
}
{
  const created = parseAirwallexPaymentIntentAnswer(200, paidAnswer);
  expect(created.outcome === "created" && created.paymentOutcome === "paid", "SUCCEEDED maps to paid");
  expect(created.outcome === "created" && created.clientSecret === null, "an answer without a secret carries none");
}
{
  const pending = parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId, status: "PENDING" }));
  expect(pending.outcome === "created" && pending.paymentOutcome === "pending", "PENDING maps to pending");
  const review = parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId, status: "PENDING_REVIEW" }));
  expect(review.outcome === "created" && review.paymentOutcome === "pending", "PENDING_REVIEW maps to pending");
  const capture = parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId, status: "REQUIRES_CAPTURE" }));
  expect(capture.outcome === "created" && capture.paymentOutcome === "pending", "REQUIRES_CAPTURE maps to pending");
  const action = parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId, status: "REQUIRES_CUSTOMER_ACTION" }));
  expect(action.outcome === "created" && action.paymentOutcome === "requires_customer_action", "REQUIRES_CUSTOMER_ACTION needs the customer");
  const cancelled = parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId, status: "CANCELLED" }));
  expect(cancelled.outcome === "created" && cancelled.paymentOutcome === "failed", "CANCELLED maps to failed");
}
expectEqual(
  parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId, status: "IN_REVIEW" })).outcome,
  "unknown",
  "an unrecorded status leaves the intent unread",
);
expectEqual(
  parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: intentId })).outcome,
  "unknown",
  "an answer with no status is unknown",
);
expectEqual(parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ status: "SUCCEEDED" })).outcome, "unknown", "an answer with no id is unknown");
expectEqual(parseAirwallexPaymentIntentAnswer(200, JSON.stringify({ id: accountId, status: "SUCCEEDED" })).outcome, "unknown", "an account id in the id field is not an intent");
expectEqual(parseAirwallexPaymentIntentAnswer(201, "not json").outcome, "unknown", "an unparsable 2XX is unknown");
expectEqual(parseAirwallexPaymentIntentAnswer(409, "{}").outcome, "duplicate", "a 409 means the original request exists");
const rejected = parseAirwallexPaymentIntentAnswer(400, JSON.stringify({ code: "invalid_argument", message: "amount is invalid" }));
expect(rejected.outcome === "rejected" && rejected.code === "invalid_argument", "the documented invalid_argument code is kept");
expect(rejected.outcome === "rejected" && rejected.detail === "amount is invalid", "the provider's message is kept");
expectEqual(parseAirwallexPaymentIntentAnswer(422, "{}").outcome, "rejected", "a 422 is a rejection");
expectEqual(parseAirwallexPaymentIntentAnswer(401, "{}").outcome, "failed", "a 401 is a failure, so nothing was created");
expectEqual(parseAirwallexPaymentIntentAnswer(403, "{}").outcome, "failed", "a 403 is a failure");
expectEqual(parseAirwallexPaymentIntentAnswer(404, "{}").outcome, "failed", "a 404 on create is a failure");
expectEqual(parseAirwallexPaymentIntentAnswer(302, "").outcome, "failed", "a redirect is a failure");
expectEqual(parseAirwallexPaymentIntentAnswer(429, "{}").outcome, "unknown", "a rate limit is unknown");
expectEqual(parseAirwallexPaymentIntentAnswer(500, "{}").outcome, "unknown", "a 5XX is unknown");
expectEqual(parseAirwallexPaymentIntentAnswer(408, "{}").outcome, "unknown", "a timeout status is unknown");

{
  const read = parseAirwallexPaymentReadAnswer(200, paidAnswer);
  expectEqual(read.outcome, "read", "a 2XX with a status reads");
  if (read.outcome !== "read") throw new Error("unreachable");
  expectEqual(read.paymentOutcome, "paid", "SUCCEEDED reads as paid");
  expectEqual(read.amountText, "100.00", "the amount is read as text from a number");
  expectEqual(read.currency, "usd", "the currency is normalised");
}
{
  const read = parseAirwallexPaymentReadAnswer(200, JSON.stringify({ id: intentId, status: "PENDING", amount: "9.99", currency: "USD" }));
  expect(read.outcome === "read" && read.amountText === "9.99", "a string amount is read as it stands");
  expect(read.outcome === "read" && read.paymentOutcome === "pending", "PENDING reads as pending");
}
expectEqual(
  parseAirwallexPaymentReadAnswer(200, JSON.stringify({ id: intentId, status: "WHAT" })).outcome,
  "unknown",
  "an unrecorded status is unread, never paid",
);
expectEqual(parseAirwallexPaymentReadAnswer(200, JSON.stringify({ status: "SUCCEEDED" })).outcome, "unknown", "a read with no id is unknown");
expectEqual(parseAirwallexPaymentReadAnswer(404, "{}").outcome, "not_found", "a 404 means the id is not at Airwallex");
expectEqual(parseAirwallexPaymentReadAnswer(400, "{}").outcome, "failed", "a 400 on a read is a failure");
expectEqual(parseAirwallexPaymentReadAnswer(401, "{}").outcome, "failed", "a 401 on a read is a failure");
expectEqual(parseAirwallexPaymentReadAnswer(429, "{}").outcome, "unknown", "a rate limit on a read is unknown");
expectEqual(parseAirwallexPaymentReadAnswer(503, "{}").outcome, "unknown", "a 5XX on a read is unknown");
expectEqual(parseAirwallexPaymentReadAnswer(302, "").outcome, "unknown", "a redirect on a read is unknown");
expectEqual(airwallexPaymentStatusOf(JSON.stringify({ status: "succeeded" })), "SUCCEEDED", "a lower-case status is normalised");
expectEqual(airwallexPaymentStatusOf(JSON.stringify({ status: "FAILED" })), null, "FAILED is not an Intent status STEP 165 records");
expectEqual(airwallexPaymentIntentIdOf(intentAnswer), intentId, "the id reader reads the documented id");
expectEqual(airwallexPaymentMessageOf(JSON.stringify({ message: "  bad  amount  " })), "bad amount", "the message is sanitised");
expectEqual(airwallexClientSecretOf(intentAnswer), clientSecret, "the secret reader reads the documented secret");
expectEqual(
  airwallexClientSecretOf(JSON.stringify({ client_secret: "s".repeat(AIRWALLEX_CLIENT_SECRET_MAXIMUM_LENGTH + 1) })),
  null,
  "an over-long secret is not carried",
);
expectEqual(airwallexIntentAmountOf(paidAnswer).amountText, "100.00", "the amount helper formats a number");
expectEqual(airwallexIntentAmountOf(JSON.stringify({})).amountText, null, "an amount that is absent is null");

/* ---- the transport refuses without calling ---- */

await expectRejects(
  () =>
    airwallexPaymentFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: "/api/v1/transfers/create",
      accessToken,
      apiVersion: "2026-05-29",
      onBehalfOf: accountId,
      body: "{}",
    }),
  "a path outside the allowlist is refused before any call",
);
await expectRejects(
  () =>
    airwallexPaymentFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_PAYMENT_INTENT_CREATE_PATH,
      accessToken: " ",
      apiVersion: "2026-05-29",
      onBehalfOf: accountId,
      body: "{}",
    }),
  "a call without a token is refused before any call",
);
await expectRejects(
  () =>
    airwallexPaymentFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_PAYMENT_INTENT_CREATE_PATH,
      accessToken,
      apiVersion: "",
      onBehalfOf: accountId,
      body: "{}",
    }),
  "a call without a version is refused before any call",
);
await expectRejects(
  () =>
    airwallexPaymentFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_PAYMENT_INTENT_CREATE_PATH,
      accessToken,
      apiVersion: "2026-05-29",
      onBehalfOf: "not-an-account",
      body: "{}",
    }),
  "an x-on-behalf-of that is not a connected account is refused before any call",
);
await expectRejects(
  () =>
    airwallexPaymentFetchTransport({
      method: "POST",
      environment: "sandbox",
      path: AIRWALLEX_PAYMENT_INTENT_CREATE_PATH,
      accessToken,
      apiVersion: "2026-05-29",
      onBehalfOf: accountId,
      body: null,
    }),
  "a POST without a body is refused before any call",
);
await expectRejects(
  () =>
    airwallexPaymentFetchTransport({
      method: "GET",
      environment: "sandbox",
      path: airwallexPaymentIntentPath(intentId),
      accessToken,
      apiVersion: "2026-05-29",
      onBehalfOf: accountId,
      body: "{}",
    }),
  "a read with a body is refused before any call",
);

/* ---- the store's invariants ---- */

function pendingAttempt(overrides: Partial<AirwallexPaymentAttempt> = {}): AirwallexPaymentAttempt {
  return {
    id: "0a1b2c3d-0000-4000-8000-000000000011",
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId,
    environment: "sandbox",
    requestId: expectedRequestId,
    amountMinor: 1_000_000n,
    platformFeeMinor: 10_000n,
    currency: "usd",
    connectedAccountId: accountId,
    paymentIntentId: null,
    providerStatus: null,
    attemptStatus: "pending",
    settlement: null,
    clientSecretIssued: false,
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
    ...overrides,
  };
}

{
  const store = new InMemoryAirwallexPaymentAttemptStore();
  const base = pendingAttempt();
  store.insert(base);
  expectThrows(() => store.insert(base), "the store refuses a duplicate id");
  expectThrows(
    () => store.insert(pendingAttempt({ id: "0a1b2c3d-0000-4000-8000-000000000012" })),
    "the store refuses a second attempt with one request id",
  );
  expectThrows(
    () => store.insert(pendingAttempt({ id: "0a1b2c3d-0000-4000-8000-000000000013", companyId: otherCompanyId, paymentIntentId: intentId })),
    "the store refuses a new row that already carries an intent id",
  );
  expectEqual(store.findByRequestId(companyId, expectedRequestId)?.id, base.id, "the row is found by request id");
  expectEqual(store.findByRequestId(otherCompanyId, expectedRequestId), null, "another company's request id is another attempt");
  expectEqual(store.save({ ...base, version: 2 }, 9), false, "a wrong expected version is refused");
  expectEqual(store.save({ ...base, version: 3 }, 1), false, "a version jump is refused");
  expectEqual(store.save({ ...base, companyId: otherCompanyId, version: 2 }, 1), false, "the company never changes");
  expectEqual(store.save({ ...base, environment: "live", version: 2 }, 1), false, "the mode never changes");
  expectEqual(store.save({ ...base, requestId: "other-request-id-0001", version: 2 }, 1), false, "the request id never changes");
  expectEqual(store.save({ ...base, amountMinor: 2_000_000n, version: 2 }, 1), false, "the amount never changes");
  expectEqual(store.save({ ...base, platformFeeMinor: 20_000n, version: 2 }, 1), false, "the fee never changes");
  expectEqual(store.save({ ...base, currency: "usd ", version: 2 }, 1), false, "the currency never changes");
  expectEqual(store.save({ ...base, connectedAccountId: otherIntentId, version: 2 }, 1), false, "the acting account never changes");
  expectEqual(store.save({ ...base, attemptStatus: "created", version: 2 }, 1), false, "created requires an intent id");
  expectEqual(
    store.save({ ...base, attemptStatus: "rejected", settlement: "failed", version: 2 }, 1),
    false,
    "a settlement only exists on a created row",
  );

  const created = { ...base, attemptStatus: "created" as const, paymentIntentId: intentId, providerStatus: "SUCCEEDED", settlement: "paid" as const };
  expectEqual(store.save({ ...created, version: 2 }, 1), true, "a created row with an intent id is stored");
  expectEqual(store.findByPaymentIntentId(companyId, intentId)?.id, base.id, "the row is found by intent id");
  expectEqual(store.findByPaymentIntentId(otherCompanyId, intentId), null, "the intent id is scoped to its company");
  expectEqual(store.save({ ...created, paymentIntentId: otherIntentId, version: 3 }, 2), false, "the intent id never changes");
  expectEqual(store.save({ ...created, attemptStatus: "pending", version: 3 }, 2), false, "a created row never leaves created");
}

/* ---- creating a payment ---- */

{
  const audits: string[] = [];
  const harness = await optionsFor(() => ({ status: 201, body: intentAnswer }), audits);
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "created", "a ready account creates a PaymentIntent");
  if (result.status !== "created") throw new Error(`unexpected: ${JSON.stringify(result)}`);
  expectEqual(result.clientSecret, clientSecret, "the client secret is returned to the caller once");
  expectEqual(result.attempt.paymentIntentId, intentId, "the intent id is recorded");
  expectEqual(result.attempt.attemptStatus, "created", "the attempt is created");
  expectEqual(result.attempt.providerStatus, "REQUIRES_PAYMENT_METHOD", "the documented status is recorded");
  expectEqual(result.attempt.settlement, null, "an intent that still needs a payment method is not settled");
  expectEqual(result.attempt.clientSecretIssued, true, "the record says a secret was issued");
  expectEqual(result.attempt.requestId, expectedRequestId, "the documented request id is recorded");
  expectEqual(result.attempt.amountMinor, 1_000_000n, "the amount is recorded in platform units");
  expectEqual(result.attempt.platformFeeMinor, 10_000n, "the fee is recorded for the ledger");
  expectEqual(result.attempt.currency, "usd", "the currency is normalised");
  expectEqual(result.attempt.connectedAccountId, accountId, "the acting account is recorded");
  expectEqual(result.attempt.providerKey, AIRWALLEX_PROVIDER_KEY, "the record says which provider owns the id");
  expectEqual(result.attempt.environment, "sandbox", "the mode comes from the active configuration");
  expectEqual(harness.calls.length, 1, "exactly one payment call is made");
  expectEqual(harness.calls[0]?.method, "POST", "the create is a POST");
  expectEqual(harness.calls[0]?.path, AIRWALLEX_PAYMENT_INTENT_CREATE_PATH, "the create path is the documented one");
  expectEqual(harness.calls[0]?.accessToken, accessToken, "the token STEP 166 issued is used");
  expectEqual(harness.calls[0]?.apiVersion, "2026-05-29", "the pinned version is sent");
  expectEqual(harness.calls[0]?.onBehalfOf, accountId, "the connected account is acted for");
  expectEqual(harness.loginCalls.length, 1, "one login obtains the token");
  expectEqual(audits.join(","), "airwallex_payment.created:requires_customer_action", "the create is audited with the mapped outcome");

  const stored = asText(harness.attemptStore.findByRequestId(companyId, expectedRequestId));
  expectEqual(stored.includes(clientSecret), false, "the record never carries the client secret");
  expectEqual(stored.includes(accessToken), false, "the record never carries the access token");

  const replay = await createAirwallexCharge(charge, harness.options);
  expectEqual(replay.status, "already_created", "a replay with the same reference answers already_created");
  expectEqual(replay.status === "already_created" && replay.requiresRead, true, "a replay asks for a read");
  expectEqual(harness.calls.length, 1, "a replay makes no second call");
}

{
  const harness = await optionsFor(() => ({ status: 200, body: paidAnswer }));
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "created", "the intent is created");
  expectEqual(result.status === "created" && result.attempt.settlement, "paid", "a SUCCEEDED intent settles paid");
  expectEqual(result.status === "created" && result.attempt.clientSecretIssued, false, "no secret was issued");
}

/* ---- creating: the refusals that write nothing ---- */

{
  const harness = await optionsFor(() => ({ status: 201, body: intentAnswer }));
  const notReady = await createAirwallexCharge(
    charge,
    { ...harness.options, provision: activeProvision({ accountStatus: "SUBMITTED", onboardingState: "waiting" }) },
  );
  expectEqual(notReady.status, "failed", "an account still under review takes no payment");
  expect(
    notReady.status === "failed" && notReady.reason.includes("submitted"),
    "the refusal names the account's state",
  );
  expectEqual(harness.calls.length, 0, "no payment call is made for an account that is not ready");

  const blocked = await createAirwallexCharge(
    charge,
    { ...harness.options, provision: activeProvision({ accountStatus: "ACTION_REQUIRED", onboardingState: "blocked" }) },
  );
  expectEqual(blocked.status, "failed", "a blocked account takes no payment");

  const otherCompany = await createAirwallexCharge(charge, {
    ...harness.options,
    provision: activeProvision({ companyId: otherCompanyId }),
  });
  expectEqual(otherCompany.status, "failed", "another company's connected account cannot be charged for this one");
  expect(
    otherCompany.status === "failed" && otherCompany.reason.includes("another company"),
    "the refusal names the ownership problem",
  );

  const pendingAccount = await createAirwallexCharge(charge, {
    ...harness.options,
    provision: activeProvision({ attemptStatus: "pending", accountId: null, accountStatus: null, onboardingState: null }),
  });
  expectEqual(pendingAccount.status, "failed", "an account that does not exist takes no payment");
  expectEqual(harness.calls.length, 0, "none of the readiness refusals reached the API");
  expectEqual(harness.attemptStore.findByRequestId(companyId, expectedRequestId), null, "none of them wrote an attempt");
}

{
  const harness = await optionsFor(() => ({ status: 201, body: intentAnswer }), [], activeProvision());
  const badAmount = await createAirwallexCharge({ ...charge, amountMinor: 1n }, harness.options);
  expectEqual(badAmount.status, "failed", "an amount that is not a whole minor unit is refused");
  const badFee = await createAirwallexCharge({ ...charge, platformFeeMinor: 2_000_000n }, harness.options);
  expectEqual(badFee.status, "failed", "a fee larger than the payment is refused");
  const badCurrency = await createAirwallexCharge({ ...charge, currency: "gbp" }, harness.options);
  expectEqual(badCurrency.status, "failed", "an unsupported currency is refused");
  const badReference = await createAirwallexCharge({ ...charge, reference: " " }, harness.options);
  expectEqual(badReference.status, "failed", "a blank reference is refused");
  expectEqual(harness.calls.length, 0, "no invalid request reached the API");
  expectEqual(harness.attemptStore.findByRequestId(companyId, expectedRequestId), null, "no invalid request wrote an attempt");
}

{
  // No active configuration and no token: nothing is attempted and nothing is written.
  const configStore = new InMemoryAirwallexConfigStore();
  configureAirwallexKeys(
    { companyId, environment: "sandbox", clientId, apiKey, webhookSecret: null },
    { store: configStore, keyring, occurredAtEpochMs: NOW },
  );
  const calls: AirwallexPaymentCall[] = [];
  const attemptStore = new InMemoryAirwallexPaymentAttemptStore();
  const result = await createAirwallexCharge(charge, {
    provision: activeProvision(),
    configStore,
    keyring,
    tokenCache: new InMemoryAirwallexTokenCache(),
    attemptStore,
    occurredAtEpochMs: NOW,
    transport: async (call) => {
      calls.push(call);
      return { status: 201, body: intentAnswer };
    },
  });
  expectEqual(result.status, "failed", "a company with no active key takes no payment");
  expect(result.status === "failed" && result.reason.includes("no active Airwallex key"), "the refusal names the key");
  expectEqual(calls.length, 0, "no payment call is made");
  expectEqual(attemptStore.findByRequestId(companyId, expectedRequestId), null, "no attempt is written");
}

{
  const harness = await optionsFor(() => ({ status: 201, body: intentAnswer }));
  const refused = await createAirwallexCharge(charge, {
    ...harness.options,
    loginTransport: async () => ({ status: 401, body: JSON.stringify({ code: "credentials_invalid" }) }),
  });
  expectEqual(refused.status, "failed", "a login that yields no token takes no payment");
  expectEqual(harness.calls.length, 0, "no payment call is made without a token");
  expectEqual(harness.attemptStore.findByRequestId(companyId, expectedRequestId), null, "no pending attempt is left behind");
}

/* ---- creating: the outcomes the API may answer ---- */

{
  const audits: string[] = [];
  const harness = await optionsFor(
    () => ({ status: 400, body: JSON.stringify({ code: "invalid_argument", message: "amount must be positive" }) }),
    audits,
  );
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "rejected", "a 400 rejects the attempt");
  if (result.status !== "rejected") throw new Error("unreachable");
  expectEqual(result.attempt.attemptStatus, "rejected", "the row records the rejection");
  expectEqual(result.attempt.paymentIntentId, null, "a rejected attempt carries no intent id");
  expectEqual(result.attempt.reason, "amount must be positive", "the provider's message is kept");
  expectEqual(audits.join(","), "airwallex_payment.rejected:invalid_argument", "the rejection is audited with its code");

  const again = await createAirwallexCharge(charge, harness.options);
  expectEqual(again.status, "failed", "a rejected attempt is final for that request id");
  expect(again.status === "failed" && again.reason.includes("new reference"), "the refusal says to use a new reference");
  expectEqual(harness.calls.length, 1, "a rejected attempt makes no second call");
}

{
  const audits: string[] = [];
  const harness = await optionsFor(() => ({ status: 409, body: JSON.stringify({ message: "duplicate request" }) }), audits);
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "unknown", "a 409 is not a rejection: it may have created an intent");
  if (result.status !== "unknown") throw new Error("unreachable");
  expectEqual(result.requiresReconciliation, true, "a duplicate asks for reconciliation");
  expectEqual(result.attempt.attemptStatus, "unknown", "the row records the duplicate as unknown");
  expectEqual(result.attempt.requiresReconciliation, true, "the row is flagged");
  expectEqual(audits.join(","), "airwallex_payment.duplicate:duplicate", "the duplicate is audited as itself");

  const again = await createAirwallexCharge(charge, harness.options);
  expectEqual(again.status, "in_flight", "a duplicate answers in_flight on a replay");
  expectEqual(harness.calls.length, 1, "no second call is made");
}

{
  const harness = await optionsFor(() => ({ status: 503, body: "{}" }));
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "unknown", "a 5XX leaves the outcome unknown");
  expectEqual(result.status === "unknown" && result.requiresReconciliation, true, "an unknown outcome asks for reconciliation");
}

{
  const harness = await optionsFor(() => {
    throw new Error("the network fell over");
  });
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "unknown", "a thrown transport leaves the outcome unknown");
  expect(result.status === "unknown" && result.reason.includes("could not be reached"), "the reason says the API was unreachable");
}

{
  const harness = await optionsFor(() => ({ status: 401, body: JSON.stringify({ message: "bad token" }) }));
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "failed", "a 401 fails outright");
  expectEqual(harness.attemptStore.findByRequestId(companyId, expectedRequestId)?.attemptStatus, "pending", "an outright refusal leaves the pending row");
}

{
  const harness = await optionsFor(() => ({ status: 201, body: intentAnswer }));
  harness.attemptStore.insert(pendingAttempt({ id: "0a1b2c3d-0000-4000-8000-0000000000aa" }));
  const result = await createAirwallexCharge(charge, harness.options);
  expectEqual(result.status, "failed", "an attempt already in flight is refused");
  expectEqual(harness.calls.length, 0, "no call is made while an attempt is pending");
}

/* ---- reading and settling ---- */

{
  const harness = await optionsFor(() => ({ status: 200, body: paidAnswer }));
  const created = await createAirwallexCharge(charge, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an intent");

  const read = await readAirwallexPaymentIntent(intentId, harness.options);
  expectEqual(read.status, "read", "an intent is read back");
  if (read.status !== "read") throw new Error("unreachable");
  expectEqual(read.outcome, "paid", "SUCCEEDED reads as paid");
  expectEqual(read.providerStatus, "SUCCEEDED", "the documented status is carried");
  expectEqual(read.amountText, "100.00", "the amount is carried");
  expectEqual(harness.calls[1]?.method, "GET", "the read is a GET");
  expectEqual(harness.calls[1]?.path, airwallexPaymentIntentPath(intentId), "the read path is the documented one");
  expectEqual(harness.calls[1]?.body, null, "a read carries no body");
  expectEqual(harness.calls[1]?.onBehalfOf, accountId, "the read acts for the connected account");
}

{
  const harness = await optionsFor(() => ({ status: 200, body: paidAnswer }));
  const created = await createAirwallexCharge(charge, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an intent");

  const audits: string[] = [];
  const applied = applyAirwallexPaymentIntentRead(created.attempt, readResult(), {
    occurredAtEpochMs: NOW + 1_000,
    attemptStore: harness.attemptStore,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });
  expectEqual(applied.status, "applied", "a matching read is applied");
  expectEqual(applied.status === "applied" && applied.settlement, "paid", "the payment settles paid");
  expectEqual(applied.status === "applied" && applied.attempt.providerStatus, "SUCCEEDED", "the documented status is recorded");
  expectEqual(applied.status === "applied" && applied.attempt.requiresReconciliation, false, "a matching read needs no reconciliation");
  expectEqual(audits.join(","), "airwallex_payment.settled:paid", "the settlement is audited");
  expectEqual(asText(applied).includes(clientSecret), false, "the applied result carries no client secret");
}

{
  const harness = await optionsFor(() => ({ status: 200, body: intentAnswer }));
  const created = await createAirwallexCharge(charge, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an intent");

  const audits: string[] = [];
  const mismatched = applyAirwallexPaymentIntentRead(created.attempt, readResult({ amountText: "99.99" }), {
    occurredAtEpochMs: NOW + 1_000,
    attemptStore: harness.attemptStore,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });
  expectEqual(mismatched.status, "applied", "a mismatched read is written, not ignored");
  expectEqual(mismatched.status === "applied" && mismatched.settlement, "failed", "an amount mismatch never settles paid");
  expectEqual(mismatched.status === "applied" && mismatched.attempt.requiresReconciliation, true, "a mismatch asks for reconciliation");
  expectEqual(audits.join(","), "airwallex_payment.settled:mismatch", "the mismatch is audited as itself");

  const afterMismatch = harness.attemptStore.findById(created.attempt.id);
  if (afterMismatch === null) throw new Error("the attempt vanished");
  const wrongCurrency = applyAirwallexPaymentIntentRead(afterMismatch, readResult({ currency: "eur" }), {
    occurredAtEpochMs: NOW + 2_000,
    attemptStore: harness.attemptStore,
  });
  expectEqual(wrongCurrency.status === "applied" && wrongCurrency.settlement, "failed", "a currency mismatch never settles paid");

  const afterCurrency = harness.attemptStore.findById(created.attempt.id);
  if (afterCurrency === null) throw new Error("the attempt vanished");
  const anotherIntent = applyAirwallexPaymentIntentRead(afterCurrency, readResult({ paymentIntentId: otherIntentId }), {
    occurredAtEpochMs: NOW + 3_000,
    attemptStore: harness.attemptStore,
  });
  expectEqual(anotherIntent.status, "failed", "a read of another intent is refused");
}

{
  const harness = await optionsFor((call) =>
    call.method === "GET" ? { status: 404, body: "{}" } : { status: 200, body: intentAnswer },
  );
  const created = await createAirwallexCharge(charge, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an intent");
  const missing = await readAirwallexPaymentIntent(intentId, harness.options);
  expectEqual(missing.status, "not_found", "a 404 on a read is not_found");
  const refused = await readAirwallexPaymentIntent(intentId, {
    ...harness.options,
    transport: async () => ({ status: 401, body: "{}" }),
  });
  expectEqual(refused.status, "failed", "a 401 on a read is a failure");
  const unread = await readAirwallexPaymentIntent(intentId, {
    ...harness.options,
    transport: async () => {
      throw new Error("unreachable");
    },
  });
  expectEqual(unread.status, "failed", "a thrown read is a failure");
  expect(unread.status === "failed" && unread.reason.includes("could not be reached"), "the reason says the API was unreachable");

  const badId = await readAirwallexPaymentIntent(accountId, harness.options);
  expectEqual(badId.status, "failed", "an account id is not read as an intent");
}

{
  const harness = await optionsFor(() => ({ status: 200, body: intentAnswer }));
  const created = await createAirwallexCharge(charge, harness.options);
  if (created.status !== "created") throw new Error("the fixture did not create an intent");
  const audits: string[] = [];
  const marked = markAirwallexAttemptUnread(created.attempt, "the read was unavailable: 503", {
    occurredAtEpochMs: NOW + 1_000,
    attemptStore: harness.attemptStore,
    recordAudit: (entry) => audits.push(`${entry.action}:${entry.outcome}`),
  });
  expectEqual(marked.requiresReconciliation, true, "an unread attempt is flagged");
  expectEqual(marked.providerStatus, "REQUIRES_PAYMENT_METHOD", "an unread attempt keeps the status it had");
  expectEqual(marked.settlement, null, "an unread attempt invents no settlement");
  expectEqual(audits.join(","), "airwallex_payment.read_failed:unread", "an unread attempt is audited");
}

/* ---- the outcome table ---- */

{
  expectEqual(AIRWALLEX_ATTEMPT_OUTCOMES.created.join(","), "created", "a created row never moves");
  expectEqual(AIRWALLEX_ATTEMPT_OUTCOMES.rejected.join(","), "rejected", "a rejected row is final");
  expect(AIRWALLEX_ATTEMPT_OUTCOMES.unknown.includes("created"), "an unknown row may settle as created");
  expect(AIRWALLEX_ATTEMPT_OUTCOMES.pending.includes("rejected"), "a pending row may be rejected");
  expect(Object.isFrozen(AIRWALLEX_ATTEMPT_OUTCOMES), "the outcome table is frozen");
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Airwallex payment gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Airwallex payment gate passed: ${checks} checks (a payment is attempted only for an ACTIVE connected account and only with a validated amount, currency, reference and fee, the documented body carries major units and a derived request_id and no card data, secret or fee, the client secret is handed out once and stored nowhere, a 409 is recorded as a duplicate rather than a rejection, and only a matching SUCCEEDED read settles paid while a mismatch never does)\n`,
);
