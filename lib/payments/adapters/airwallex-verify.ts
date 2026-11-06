// path: lib/payments/adapters/airwallex-verify.ts

/**
 * The gate for STEP 165: the Airwallex documentation record and the sandbox notes.
 *
 * A check script, not a test file. It proves that every documented fact this record claims is the one the
 * pages state, that the host guards refuse the lookalikes, that the money conversion is exact, that the
 * status vocabularies map the way the pages require, and that the record cannot claim more than its evidence.
 * No network call is made and no credential exists.
 */

import { createHmac } from "node:crypto";
import process from "node:process";
import {
  airwallexAccountIdCollidesWithStripe,
  airwallexAmountFromPlatformMinor,
  airwallexEnvironmentOfBase,
  airwallexIntentHasFailureStatus,
  airwallexOnboardingStateOf,
  airwallexPaymentAttemptOutcomeOf,
  airwallexPaymentOutcomeOf,
  airwallexPlatformMinorFromAmount,
  airwallexRequestIdFor,
  airwallexSignaturePayload,
  airwallexTimestampMs,
  airwallexTokenExpiryMs,
  airwallexTokenNeedsRefresh,
  airwallexTransferCanStillFail,
  airwallexTransferOutcomeOf,
  buildAirwallexConnectedAccountBody,
  buildAirwallexPaymentIntentBody,
  calculateAirwallexStatus,
  carriesAirwallexKeyShapedText,
  InMemoryAirwallexVerificationStore,
  isAirwallexAccountId,
  isAirwallexApiBase,
  isAirwallexApiVersion,
  isAirwallexDocumentationUrl,
  isAirwallexEventName,
  parseAirwallexEvent,
  recordAirwallexVerification,
  sanitizeAirwallexText,
  validateAirwallexAccountRequest,
  validateAirwallexCredentials,
  validateAirwallexPaymentIntentRequest,
  verifyAirwallexWebhookSignature,
  AIRWALLEX_ACCOUNT_ID_PATTERN,
  AIRWALLEX_ACCOUNT_STATUSES,
  AIRWALLEX_API_KEY_PATTERN,
  AIRWALLEX_API_PREFIX,
  AIRWALLEX_API_VERSION_HEADER,
  AIRWALLEX_API_VERSION_PATTERN,
  AIRWALLEX_CAPABILITY_MATRIX,
  AIRWALLEX_CLIENT_ID_PATTERN,
  AIRWALLEX_CLIENT_ID_HEADER,
  AIRWALLEX_API_KEY_HEADER,
  AIRWALLEX_COUNTRY_CODE_PATTERN,
  AIRWALLEX_CURRENCY_MINOR_UNITS,
  AIRWALLEX_DEFAULT_API_VERSION,
  AIRWALLEX_DOCUMENTATION_HOSTS,
  AIRWALLEX_DOCUMENTATION_SOURCES,
  AIRWALLEX_ENDPOINTS,
  AIRWALLEX_EVENT_FIELDS,
  AIRWALLEX_EVENT_ID_PATTERN,
  AIRWALLEX_EVENT_NAMES,
  AIRWALLEX_MAXIMUM_AMOUNT,
  AIRWALLEX_OBSERVED_API_VERSIONS,
  AIRWALLEX_OBSERVED_LEGAL_ENTITY_TYPES,
  AIRWALLEX_ON_BEHALF_OF_HEADER,
  AIRWALLEX_OPEN_QUESTIONS,
  AIRWALLEX_PAYMENT_ATTEMPT_STATUSES,
  AIRWALLEX_PAYMENT_INTENT_STATUSES,
  AIRWALLEX_PRODUCTION_BASE,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_PROVIDER_NAME,
  AIRWALLEX_RECORDED_RULES,
  AIRWALLEX_REFERENCE_HOSTS,
  AIRWALLEX_REFUSED_HOSTS,
  AIRWALLEX_REQUIRED_STEP_IDS,
  AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH,
  AIRWALLEX_REQUEST_ID_PATTERN,
  AIRWALLEX_SANDBOX_BASE,
  AIRWALLEX_SANDBOX_CYCLE,
  AIRWALLEX_SANDBOX_LIMITS,
  AIRWALLEX_SESSION_CHECKS,
  AIRWALLEX_SESSION_STATUS,
  AIRWALLEX_SIGNATURE_HEADER,
  AIRWALLEX_TIMESTAMP_HEADER,
  AIRWALLEX_TOKEN_LIFETIME_SECONDS,
  AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS,
  AIRWALLEX_TRANSFER_STATUSES,
  AIRWALLEX_TRANSFER_TERMINAL_STATUSES,
  AIRWALLEX_WEBHOOK_SIGNATURE_SCHEME,
  AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS,
  type AirwallexAccountRequest,
  type AirwallexPaymentIntentRequest,
  type AirwallexStepResult,
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
const clientId = fixture("cid", "AbCd1234EfGh5678");
const apiKey = fixture("key", "ZzYyXx9876WwVvUuTtSsRrQq");
const webhookSecret = fixture("whsec", "airwallexwebhooksecretvalue");
const NOW = 1_760_000_000_000;

const individualAccount: AirwallexAccountRequest = {
  kind: "individual",
  email: "rob.stark@north.example",
  firstName: "Rob",
  lastName: "Stark",
  countryCode: "AU",
  agreedToDataUsage: true,
  agreedToTermsAndConditions: true,
};

const businessAccount: AirwallexAccountRequest = {
  kind: "business",
  email: "billing@kohinur.example",
  businessName: "Kohinur Digital Ltd",
  countryCode: "AU",
  agreedToDataUsage: true,
  agreedToTermsAndConditions: true,
};

const intentRequest: AirwallexPaymentIntentRequest = {
  amountMinor: 99_900n,
  currency: "usd",
  merchantOrderId: "INV-1001",
  requestId: airwallexRequestIdFor("9b2d3e4f-0000-4000-8000-000000000001", "INV-1001"),
  returnUrl: "https://portal.kohinur.example/pay/1001",
  descriptor: "Kohinur invoice 1001",
  metadata: { invoice_id: "INV-1001" },
};

/** The documented scheme, computed here with the same primitives a receiver uses. */
const sign = (timestamp: string, body: string, secret: string): string =>
  createHmac("sha256", secret).update(airwallexSignaturePayload(timestamp, body), "utf8").digest("hex");

/* ---- identity and hosts ---- */

expectEqual(AIRWALLEX_PROVIDER_KEY, "airwallex", "the provider key is the registry key");
expectEqual(AIRWALLEX_PROVIDER_NAME, "Airwallex", "the provider name is the documented brand");
expectEqual(AIRWALLEX_PRODUCTION_BASE, "https://api.airwallex.com", "the documented production host is kept");
expectEqual(AIRWALLEX_SANDBOX_BASE, "https://api.sandbox.airwallex.com", "the documented sandbox host is kept");
expectEqual(AIRWALLEX_API_PREFIX, "/api/v1", "the documented URL prefix is kept");
expectEqual(airwallexEnvironmentOfBase("https://api.airwallex.com"), "live", "the production host is live");
expectEqual(airwallexEnvironmentOfBase("https://api.sandbox.airwallex.com"), "sandbox", "the sandbox host is sandbox");
expectEqual(airwallexEnvironmentOfBase("https://api.sandbox.airwallex.com/"), "sandbox", "a trailing slash does not change the mode");
expectEqual(airwallexEnvironmentOfBase("https://api-demo.airwallex.com"), null, "the community demo host is refused");
expectEqual(airwallexEnvironmentOfBase("https://api.airwallex.com.evil.example"), null, "a lookalike host is refused");
expectEqual(airwallexEnvironmentOfBase("http://api.airwallex.com"), null, "plain HTTP is refused");
expectEqual(airwallexEnvironmentOfBase(""), null, "an empty base is refused");
expect(isAirwallexApiBase(AIRWALLEX_PRODUCTION_BASE), "the production host is an API base");
expect(isAirwallexApiBase(AIRWALLEX_SANDBOX_BASE), "the sandbox host is an API base");
expect(isAirwallexApiBase("https://api-demo.airwallex.com") === false, "the community demo host is not an API base");
expect(AIRWALLEX_REFUSED_HOSTS.includes("api-demo.airwallex.com"), "the demo host is recorded as refused");
expect(AIRWALLEX_REFUSED_HOSTS.includes("docs.airwallex.com"), "the guessed documentation host is recorded as refused");

/* ---- documentation sources ---- */

expectEqual(AIRWALLEX_DOCUMENTATION_HOSTS.join(","), "www.airwallex.com", "the documentation lives on one host");
expectEqual(AIRWALLEX_REFERENCE_HOSTS.join(","), "github.com", "the version list lives on the specification host");
expect(Object.isFrozen(AIRWALLEX_DOCUMENTATION_SOURCES), "the sources are frozen");
expect(AIRWALLEX_DOCUMENTATION_SOURCES.length >= 10, "at least ten pages were read");
for (const source of AIRWALLEX_DOCUMENTATION_SOURCES) {
  expect(isAirwallexDocumentationUrl(source.url), `the source ${source.topic} is on a recorded host`);
  expectEqual(source.status, "reviewed", `the source ${source.topic} is marked reviewed`);
  expect(source.recorded.trim().length > 20, `the source ${source.topic} records what it settled`);
  expect(
    AIRWALLEX_DOCUMENTATION_HOSTS.includes(source.host) || AIRWALLEX_REFERENCE_HOSTS.includes(source.host),
    `the source ${source.topic} names a recorded host`,
  );
}
expect(isAirwallexDocumentationUrl("https://www.airwallex.com/docs/api/introduction"), "a documentation URL is accepted");
expect(isAirwallexDocumentationUrl("https://github.com/airwallex/airwallex-openapi"), "the specification URL is accepted");
expect(isAirwallexDocumentationUrl("http://www.airwallex.com/docs") === false, "plain HTTP documentation is refused");
expect(isAirwallexDocumentationUrl("https://api-demo.airwallex.com/docs") === false, "the demo host is refused as a source");
expect(isAirwallexDocumentationUrl("https://docs.airwallex.com/anything") === false, "the guessed host is refused as a source");
expect(isAirwallexDocumentationUrl("https://www.airwallex.com.evil.example/docs") === false, "a lookalike is refused as a source");
expect(isAirwallexDocumentationUrl("not a url") === false, "an unparsable URL is refused");

/* ---- the endpoint map ---- */

const endpointNames = Object.keys(AIRWALLEX_ENDPOINTS);
expect(Object.isFrozen(AIRWALLEX_ENDPOINTS), "the endpoint map is frozen");
expect(endpointNames.length >= 12, "every endpoint this platform needs is recorded");
for (const name of endpointNames) {
  const path = AIRWALLEX_ENDPOINTS[name] ?? "";
  expect(path.startsWith(AIRWALLEX_API_PREFIX), `the endpoint ${name} sits under the documented prefix`);
}
expectEqual(AIRWALLEX_ENDPOINTS["login"], "/api/v1/authentication/login", "the documented login path is kept");
expectEqual(AIRWALLEX_ENDPOINTS["accountsCreate"], "/api/v1/accounts/create", "the documented account create path is kept");
expectEqual(AIRWALLEX_ENDPOINTS["accountsSubmit"], "/api/v1/accounts/{id}/submit", "the documented submit path is kept");
expectEqual(
  AIRWALLEX_ENDPOINTS["paymentIntentCreate"],
  "/api/v1/pa/payment_intents/create",
  "the documented PaymentIntent create path is kept",
);
expectEqual(AIRWALLEX_ENDPOINTS["paymentIntentRetrieve"], "/api/v1/pa/payment_intents/{id}", "the documented retrieve path is kept");
expectEqual(AIRWALLEX_ENDPOINTS["transferCreate"], "/api/v1/transfers/create", "the documented transfer path is kept");
expectEqual(AIRWALLEX_ENDPOINTS["transferRetrieve"], "/api/v1/transfers/{id}", "the documented transfer read path is kept");

/* ---- recorded rules ---- */

expect(Object.isFrozen(AIRWALLEX_RECORDED_RULES), "the rules are frozen");
expect(AIRWALLEX_RECORDED_RULES.length >= 15, "the record carries every rule the pages produced");
const ruleIds = AIRWALLEX_RECORDED_RULES.map((rule) => rule.id);
expectEqual(new Set(ruleIds).size, ruleIds.length, "no rule id repeats");
for (const rule of AIRWALLEX_RECORDED_RULES) {
  expect(rule.rule.trim().length > 10, `the rule ${rule.id} states a rule`);
  expect(rule.reason.trim().length > 20, `the rule ${rule.id} states why`);
  expect(isAirwallexDocumentationUrl(rule.source), `the rule ${rule.id} names a recorded source`);
}
for (const id of ["token_reuse", "version_pinned", "amount_major_units", "request_id_is_the_key", "client_secret_handling", "webhook_verify_first", "sandbox_gap", "account_id_not_unique_across_providers"]) {
  expect(ruleIds.includes(id), `the ${id} rule is recorded`);
}

/* ---- open questions ---- */

expect(Object.isFrozen(AIRWALLEX_OPEN_QUESTIONS), "the open questions are frozen");
expect(AIRWALLEX_OPEN_QUESTIONS.length >= 6, "every unsettled point is recorded");
const questionIds = AIRWALLEX_OPEN_QUESTIONS.map((question) => question.id);
expectEqual(new Set(questionIds).size, questionIds.length, "no open question id repeats");
for (const question of AIRWALLEX_OPEN_QUESTIONS) {
  expect(question.question.trim().length > 10, `the question ${question.id} is stated`);
  expect(question.why.trim().length > 30, `the question ${question.id} says why it is open`);
}
for (const id of ["credentials_have_no_prefix", "version_default", "webhook_tolerance", "connected_accounts_in_sandbox", "account_event_names", "fee_handling_for_platforms"]) {
  expect(questionIds.includes(id), `the ${id} question is recorded`);
}

/* ---- credentials ---- */

expectEqual(
  validateAirwallexCredentials({ clientId, apiKey, baseUrl: AIRWALLEX_SANDBOX_BASE, apiVersion: "2026-05-29" }),
  null,
  "a well formed credential set is accepted",
);
expectEqual(
  validateAirwallexCredentials({ clientId: "short", apiKey, baseUrl: AIRWALLEX_SANDBOX_BASE, apiVersion: "2026-05-29" }),
  "the client id must be 8 to 128 letters, digits, dashes or underscores",
  "a short client id is refused",
);
expectEqual(
  validateAirwallexCredentials({ clientId: `${clientId} extra`, apiKey, baseUrl: AIRWALLEX_SANDBOX_BASE, apiVersion: "2026-05-29" }),
  "the client id must be 8 to 128 letters, digits, dashes or underscores",
  "a client id with a space is refused",
);
expectEqual(
  validateAirwallexCredentials({ clientId, apiKey: "too-short", baseUrl: AIRWALLEX_SANDBOX_BASE, apiVersion: "2026-05-29" }),
  "the API key must be 16 to 256 letters, digits, dashes or underscores",
  "a short API key is refused",
);
expectEqual(
  validateAirwallexCredentials({ clientId, apiKey, baseUrl: "https://api-demo.airwallex.com", apiVersion: "2026-05-29" }),
  "the base URL must be one of the two documented API hosts",
  "an undocumented base URL is refused",
);
expectEqual(
  validateAirwallexCredentials({ clientId, apiKey, baseUrl: AIRWALLEX_SANDBOX_BASE, apiVersion: "v1" }),
  "the API version must be a date such as 2026-05-29",
  "a non-date version is refused",
);
expect(AIRWALLEX_CLIENT_ID_PATTERN.test(clientId), "the client id pattern accepts a documented-shaped id");
expect(AIRWALLEX_API_KEY_PATTERN.test(apiKey), "the API key pattern accepts a documented-shaped key");
expect(AIRWALLEX_CLIENT_ID_PATTERN.test("a".repeat(200)) === false, "an over-long client id is refused");
expect(
  carriesAirwallexKeyShapedText("eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MjQwMDAwMDB9.c2lnbmF0dXJlLXZhbHVl"),
  "a JWT is recognised as a token rather than a stored credential",
);
expect(carriesAirwallexKeyShapedText("x-api-key: abcdefghijklmnop"), "a pasted header is recognised");
expect(carriesAirwallexKeyShapedText("Bearer abcdefghijklmnop"), "a pasted bearer value is recognised");
expect(carriesAirwallexKeyShapedText("client_secret_123") === true, "a client secret is recognised");
expect(carriesAirwallexKeyShapedText(clientId) === false, "a plain client id is not key-shaped");
expect(carriesAirwallexKeyShapedText("Kohinur Digital Ltd") === false, "a business name is not key-shaped");
expectEqual(AIRWALLEX_CLIENT_ID_HEADER, "x-client-id", "the documented client-id header is kept");
expectEqual(AIRWALLEX_API_KEY_HEADER, "x-api-key", "the documented api-key header is kept");
expectEqual(AIRWALLEX_API_VERSION_HEADER, "x-api-version", "the documented version header is kept");
expectEqual(AIRWALLEX_TIMESTAMP_HEADER, "x-timestamp", "the documented timestamp header is kept");
expectEqual(AIRWALLEX_SIGNATURE_HEADER, "x-signature", "the documented signature header is kept");
expectEqual(AIRWALLEX_ON_BEHALF_OF_HEADER, "x-on-behalf-of", "the documented on-behalf-of header is kept");

/* ---- versions ---- */

expect(isAirwallexApiVersion("2026-05-29"), "a date version is accepted");
expect(isAirwallexApiVersion(" 2026-05-29 "), "a padded date version is accepted");
expect(isAirwallexApiVersion("2026-5-9") === false, "an unpadded version is refused");
expect(isAirwallexApiVersion("v1") === false, "the URL prefix is not a version");
expect(AIRWALLEX_API_VERSION_PATTERN.test("2025-06-30"), "the transfers version is a valid date");
expect(Object.isFrozen(AIRWALLEX_OBSERVED_API_VERSIONS), "the observed versions are frozen");
expect(AIRWALLEX_OBSERVED_API_VERSIONS.includes("2026-08-21"), "the specification's example version is recorded");
expect(AIRWALLEX_OBSERVED_API_VERSIONS.includes("2024-09-27"), "the transfers rename version is recorded");
expect(AIRWALLEX_OBSERVED_API_VERSIONS.includes("2025-06-30"), "the transfer-status version is recorded");
expect(isAirwallexApiVersion(AIRWALLEX_DEFAULT_API_VERSION), "the default version is a date");
expect(AIRWALLEX_OBSERVED_API_VERSIONS.includes(AIRWALLEX_DEFAULT_API_VERSION), "the default is one of the observed versions");
for (const version of AIRWALLEX_OBSERVED_API_VERSIONS) {
  expect(isAirwallexApiVersion(version), `the observed version ${version} is a date`);
}

/* ---- tokens ---- */

expectEqual(AIRWALLEX_TOKEN_LIFETIME_SECONDS, 1_800, "the documented token lifetimeis thirty minutes");
expectEqual(AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS, 60, "the refresh skew is one minute");
const documentedExpiry = "2021-06-18T16:30:00+0000";
const expiryMs = airwallexTokenExpiryMs(documentedExpiry);
expectEqual(expiryMs, Date.UTC(2021, 5, 18, 16, 30, 0), "the documented expires_at format is read exactly");
expectEqual(airwallexTokenExpiryMs("2021-06-18T16:30:00Z") !== null, true, "a Z-suffixed expiry is read");
expectEqual(airwallexTokenExpiryMs("not a date"), null, "an unreadable expiry is refused");
expectEqual(airwallexTokenExpiryMs(""), null, "an empty expiry is refused");
expectEqual(airwallexTokenExpiryMs("16:30:00"), null, "a time without a date is refused");
const expiry = Date.UTC(2026, 0, 1, 12, 0, 0);
const expiryIso = "2026-01-01T12:00:00+0000";
expectEqual(airwallexTokenNeedsRefresh(expiryIso, expiry - 30_000), true, "a token inside the skew is refreshed early");
expectEqual(airwallexTokenNeedsRefresh(expiryIso, expiry - 120_000), false, "a token well inside its life is reused");
expectEqual(airwallexTokenNeedsRefresh(expiryIso, expiry + 1_000), true, "an expired token is refreshed");
expectEqual(airwallexTokenNeedsRefresh("nonsense", expiry), true, "an unreadable expiry forces a refresh");

/* ---- money: major units ---- */

expectEqual(AIRWALLEX_CURRENCY_MINOR_UNITS["usd"], 2, "USD counts two decimal places");
expect(Object.isFrozen(AIRWALLEX_CURRENCY_MINOR_UNITS), "the currency table is frozen");
const oneHundred = airwallexAmountFromPlatformMinor(1_000_000n, "usd");
expect(oneHundred.ok === true && oneHundred.amountText === "100.00", "one hundred units render as 100.00");
expect(oneHundred.ok === true && oneHundred.amount === 100, "one hundred units are the number 100, not 10000");
const nineNinetyNine = airwallexAmountFromPlatformMinor(99_900n, "usd");
expect(nineNinetyNine.ok === true && nineNinetyNine.amountText === "9.99", "9.99 USD renders as 9.99, not 999 cents");
expect(nineNinetyNine.ok === true && nineNinetyNine.amount === 9.99, "the amount is a major-unit number");
const oneCent = airwallexAmountFromPlatformMinor(100n, "usd");
expect(oneCent.ok === true && oneCent.amountText === "0.01", "one cent renders as 0.01");
const oneUnit = airwallexAmountFromPlatformMinor(10_000n, "usd");
expect(oneUnit.ok === true && oneUnit.amountText === "1.00", "one unit renders as 1.00");
expect(oneUnit.ok === true && oneUnit.amountText !== "100.00", "the conversion never multiplies by a hundred");
const subCent = airwallexAmountFromPlatformMinor(50n, "usd");
expect(subCent.ok === false, "a fraction of a minor unit is refused");
expect(
  subCent.ok === false && subCent.reason === "the amount is not a whole number of the currency's minor unit",
  "the refusal says why the amount is unusable",
);
const zeroAmount = airwallexAmountFromPlatformMinor(0n, "usd");
expect(zeroAmount.ok === false && zeroAmount.reason === "the amount must be greater than zero", "a zero amount is refused");
expect(airwallexAmountFromPlatformMinor(-100n, "usd").ok === false, "a negative amount is refused");
const unsupportedCurrency = airwallexAmountFromPlatformMinor(100n, "eur");
expect(unsupportedCurrency.ok === false && unsupportedCurrency.reason.includes("not supported"), "an unsupported currency is refused");
const tooLarge = airwallexAmountFromPlatformMinor(BigInt(AIRWALLEX_MAXIMUM_AMOUNT + 1) * 10_000n, "usd");
expect(tooLarge.ok === false && tooLarge.reason === "the amount is too large", "an over-large amount is refused");
expectEqual(airwallexPlatformMinorFromAmount("9.99", "usd"), 99_900n, "a major-unit string reads back exactly");
expectEqual(airwallexPlatformMinorFromAmount(9.99, "usd"), 99_900n, "a major-unit number reads back exactly");
expectEqual(airwallexPlatformMinorFromAmount("0.01", "usd"), 100n, "one cent reads back to one hundred ten-thousandths");
expectEqual(airwallexPlatformMinorFromAmount("100", "usd"), 1_000_000n, "a whole number reads back");
expectEqual(airwallexPlatformMinorFromAmount("9.999", "usd"), null, "a third decimal is refused");
expectEqual(airwallexPlatformMinorFromAmount("1e3", "usd"), null, "an exponent is refused");
expectEqual(airwallexPlatformMinorFromAmount("-1.00", "usd"), null, "a negative string is refused");
expectEqual(airwallexPlatformMinorFromAmount("9.99", "eur"), null, "an unsupported currency reads back to null");

/* ---- payment statuses ---- */

expect(Object.isFrozen(AIRWALLEX_PAYMENT_INTENT_STATUSES), "the intent statuses are frozen");
expectEqual(AIRWALLEX_PAYMENT_INTENT_STATUSES.length, 7, "the six documented statuses are all recorded");
for (const status of ["REQUIRES_PAYMENT_METHOD", "REQUIRES_CUSTOMER_ACTION", "REQUIRES_CAPTURE", "PENDING", "PENDING_REVIEW", "SUCCEEDED", "CANCELLED"]) {
  expect(AIRWALLEX_PAYMENT_INTENT_STATUSES.includes(status), `the documented status ${status} is recorded`);
}
expectEqual(airwallexPaymentOutcomeOf("SUCCEEDED"), "paid", "SUCCEEDED is the only paid status");
expectEqual(airwallexPaymentOutcomeOf(" succeeded "), "paid", "the status is read case-insensitively and trimmed");
expectEqual(airwallexPaymentOutcomeOf("PENDING"), "pending", "PENDING is money in flight");
expectEqual(airwallexPaymentOutcomeOf("PENDING_REVIEW"), "pending", "PENDING_REVIEW is money in flight");
expectEqual(airwallexPaymentOutcomeOf("REQUIRES_CAPTURE"), "pending", "REQUIRES_CAPTURE is authorized but not captured");
expectEqual(airwallexPaymentOutcomeOf("REQUIRES_CUSTOMER_ACTION"), "requires_customer_action", "3DS needs the customer");
expectEqual(airwallexPaymentOutcomeOf("REQUIRES_PAYMENT_METHOD"), "requires_customer_action", "a failed attempt needs the customer");
expectEqual(airwallexPaymentOutcomeOf("CANCELLED"), "failed", "CANCELLED is not paid");
expectEqual(airwallexPaymentOutcomeOf("FAILED"), "unknown", "FAILED is not an Intent status, so it maps to unknown");
expect(airwallexIntentHasFailureStatus("FAILED"), "the record knows FAILED is the status Airwallex does not use");
expect(airwallexIntentHasFailureStatus("CANCELLED") === false, "CANCELLED is not a failure status");
expectEqual(airwallexPaymentOutcomeOf("something_new"), "unknown", "an unrecorded status is unknown");
expect(Object.isFrozen(AIRWALLEX_PAYMENT_ATTEMPT_STATUSES), "the attempt statuses are frozen");
for (const status of ["CANCELLED", "FAILED", "SETTLED", "PAID"]) {
  expect(AIRWALLEX_PAYMENT_ATTEMPT_STATUSES.includes(status), `the documented attempt status ${status} is recorded`);
}
expectEqual(airwallexPaymentAttemptOutcomeOf("PAID"), "paid", "a PAID attempt is paid");
expectEqual(airwallexPaymentAttemptOutcomeOf("SETTLED"), "paid", "a SETTLED attempt is paid");
expectEqual(airwallexPaymentAttemptOutcomeOf("FAILED"), "failed", "a FAILED attempt failed");
expectEqual(airwallexPaymentAttemptOutcomeOf("CANCELLED"), "failed", "a CANCELLED attempt is not paid");
expectEqual(airwallexPaymentAttemptOutcomeOf("WHATEVER"), "unknown", "an unrecorded attempt status is unknown");

/* ---- transfer statuses and finality ---- */

expect(Object.isFrozen(AIRWALLEX_TRANSFER_STATUSES), "the transfer statuses are frozen");
expectEqual(AIRWALLEX_TRANSFER_STATUSES.length, 11, "every documented transfer status is recorded");
for (const status of AIRWALLEX_TRANSFER_STATUSES) {
  expect(airwallexTransferOutcomeOf(status).outcome !== "unknown", `the transfer status ${status} maps to an outcome`);
}
const paidTransfer = airwallexTransferOutcomeOf("PAID");
expectEqual(paidTransfer.outcome, "paid", "PAID is a paid transfer");
expectEqual(paidTransfer.provisional, true, "PAID is provisional, because it may still fail");
expectEqual(airwallexTransferCanStillFail("PAID"), true, "a PAID transfer is watched for a late failure");
expectEqual(airwallexTransferCanStillFail("SENT"), false, "a SENT transfer is not yet paid at all");
expectEqual(airwallexTransferOutcomeOf("SENT").outcome, "in_flight", "SENT is on its way");
expectEqual(airwallexTransferOutcomeOf("OVERDUE").outcome, "in_flight", "OVERDUE is a funding problem, not a failure");
expectEqual(airwallexTransferOutcomeOf("IN_APPROVAL").outcome, "in_flight", "an approval is in flight");
expectEqual(airwallexTransferOutcomeOf("FAILED").outcome, "failed", "FAILED is a failure");
expectEqual(airwallexTransferOutcomeOf("CANCELLED").outcome, "cancelled", "CANCELLED is final and returned");
expectEqual(airwallexTransferOutcomeOf("WHATEVER").outcome, "unknown", "an unrecorded transfer status is unknown");
expect(AIRWALLEX_TRANSFER_TERMINAL_STATUSES.includes("CANCELLED"), "CANCELLED is the recorded terminal status");
expect(AIRWALLEX_TRANSFER_TERMINAL_STATUSES.includes("PAID") === false, "PAID is not recorded as terminal");

/* ---- connected accounts ---- */

expect(isAirwallexAccountId("acct_44ymLf86OR2pMWjCRLGWSw"), "the documented account id is accepted");
expect(isAirwallexAccountId("acct_abc") === false, "a too-short account id is refused");
expect(isAirwallexAccountId("cus_44ymLf86OR2pMWjCRLGWSw") === false, "another provider's prefix is refused");
expect(airwallexAccountIdCollidesWithStripe("acct_44ymLf86OR2pMWjCRLGWSw"), "the acct_ prefix collides with Stripe's");
expect(airwallexAccountIdCollidesWithStripe("cus_1") === false, "a customer id does not collide");
expect(AIRWALLEX_ACCOUNT_ID_PATTERN.test("acct_44ymLf86OR2pMWjCRLGWSw"), "the account pattern matches the documented id");
expectEqual(AIRWALLEX_ACCOUNT_STATUSES.length, 5, "the five documented account statuses are recorded");
expect(Object.isFrozen(AIRWALLEX_ACCOUNT_STATUSES), "the account statuses are frozen");
expectEqual(airwallexOnboardingStateOf("ACTIVE").state, "ready", "an active account is ready");
expectEqual(airwallexOnboardingStateOf("SUBMITTED").state, "waiting", "a submitted account is waiting");
expectEqual(airwallexOnboardingStateOf("CREATED").state, "waiting", "a created account is not submitted yet");
expectEqual(airwallexOnboardingStateOf("ACTION_REQUIRED").state, "blocked", "an RFI blocks the account");
expectEqual(airwallexOnboardingStateOf("SUSPENDED").state, "blocked", "a suspended account is blocked");
expect(airwallexOnboardingStateOf("ACTION_REQUIRED").reason.includes("request for information"), "the RFI reason says what is due");
expectEqual(airwallexOnboardingStateOf("WHATEVER").state, "blocked", "an unrecorded status blocks rather than passes");
expectEqual(airwallexOnboardingStateOf(null).state, "blocked", "no status means blocked");
expectEqual(AIRWALLEX_OBSERVED_LEGAL_ENTITY_TYPES.join(","), "INDIVIDUAL", "only the observed entity type is recorded");
expect(AIRWALLEX_COUNTRY_CODE_PATTERN.test("AU"), "an upper-case country code is accepted");
expect(AIRWALLEX_COUNTRY_CODE_PATTERN.test("au") === false, "a lower-case country code is refused");

expectEqual(validateAirwallexAccountRequest(individualAccount), null, "a well formed individual request is accepted");
expectEqual(validateAirwallexAccountRequest(businessAccount), null, "a well formed business request is accepted");
expectEqual(validateAirwallexAccountRequest({ ...individualAccount, email: "nope" }), "a primary contact email is required", "an invalid email is refused");
expectEqual(
  validateAirwallexAccountRequest({ ...individualAccount, countryCode: "au" }),
  "the country code must be two upper-case letters",
  "a lower-case country code is refused",
);
expectEqual(
  validateAirwallexAccountRequest({ ...individualAccount, agreedToTermsAndConditions: false }),
  "both agreement flags must be true, because Airwallex requires the platform to accept them on the account's behalf",
  "a missing agreement is refused",
);
expectEqual(
  validateAirwallexAccountRequest({ ...individualAccount, agreedToDataUsage: false }),
  "both agreement flags must be true, because Airwallex requires the platform to accept them on the account's behalf",
  "a missing data-usage agreement is refused",
);
expectEqual(
  validateAirwallexAccountRequest({ ...individualAccount, firstName: " " }),
  "an individual account names a first and a last name",
  "an empty first name is refused",
);
expectEqual(
  validateAirwallexAccountRequest({ ...businessAccount, businessName: "x" }),
  "a business account names its business name",
  "a one-character business name is refused",
);

const individualBody = buildAirwallexConnectedAccountBody(individualAccount);
const individualDetails = individualBody["account_details"] as Record<string, unknown>;
expectEqual(individualDetails["legal_entity_type"], "INDIVIDUAL", "an individual body carries the observed entity type");
expect((individualDetails["individual_details"] as Record<string, unknown>)["first_name"] === "Rob", "the individual details carry the name");
const agreements = individualBody["customer_agreements"] as Record<string, unknown>;
expectEqual(agreements["agreed_to_data_usage"], true, "the data-usage agreement is sent as true");
expectEqual(agreements["agreed_to_terms_and_conditions"], true, "the terms agreement is sent as true");
expectEqual((individualBody["primary_contact"] as Record<string, unknown>)["email"], "rob.stark@north.example", "the primary contact carries the email");

const businessBody = buildAirwallexConnectedAccountBody(businessAccount);
const businessDetails = businessBody["account_details"] as Record<string, unknown>;
expect(Object.keys(businessDetails).includes("legal_entity_type") === false, "a business body sends no unobserved entity type");
const businessInner = businessDetails["business_details"] as Record<string, unknown>;
expectEqual(businessInner["business_name"], "Kohinur Digital Ltd", "the business details carry the business name");
expectEqual((businessInner["registration_address"] as Record<string, unknown>)["country_code"], "AU", "the business details carry the country");
expect(JSON.stringify(businessBody).includes("card") === false, "an account body carries no card field");

/* ---- the PaymentIntent request ---- */

expectEqual(validateAirwallexPaymentIntentRequest(intentRequest), null, "a well formed create request is accepted");
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, requestId: "short" }),
  "the request id must be 8 to 64 characters of letters, digits, dot, colon, dash or underscore",
  "a short request id is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, requestId: "a".repeat(65) }),
  "the request id must be 8 to 64 characters of letters, digits, dot, colon, dash or underscore",
  "an over-long request id is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, merchantOrderId: "  " }),
  "a merchant order id is required",
  "a blank merchant order id is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, merchantOrderId: "a".repeat(65) }),
  "the merchant order id is longer than 64 characters",
  "an over-long merchant order id is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, returnUrl: "http://portal.example/pay" }),
  "the return URL must be an absolute HTTPS URL",
  "a plain-HTTP return URL is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, descriptor: "d".repeat(65) }),
  "the descriptor is longer than 64 characters",
  "an over-long descriptor is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, metadata: { "not allowed": "x" } }),
  "a metadata key must be 1 to 40 letters, digits or underscores",
  "a metadata key with a space is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, metadata: { invoice_id: "x".repeat(501) } }),
  "a metadata value is too long",
  "an over-long metadata value is refused",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, amountMinor: 0n }),
  "the amount must be greater than zero",
  "a zero amount is refused before the call",
);
expectEqual(
  validateAirwallexPaymentIntentRequest({ ...intentRequest, metadata: { invoice_id: "Bearer abcdefghijklmnop" } }),
  "a metadata value must not carry a credential or a client secret",
  "a bearer token in metadata is refused",
);
expectEqual(AIRWALLEX_REQUEST_ID_MAXIMUM_LENGTH, 64, "the documented request id bound is kept");
expect(AIRWALLEX_REQUEST_ID_PATTERN.test(intentRequest.requestId), "the derived request id matches the documented shape");

const intentBody = buildAirwallexPaymentIntentBody(intentRequest);
expectEqual(intentBody["amount"], 9.99, "the body carries the amount in major units");
expectEqual(intentBody["currency"], "USD", "the body carries the upper-case currency");
expectEqual(intentBody["merchant_order_id"], "INV-1001", "the body carries the merchant order id");
expectEqual(intentBody["request_id"], intentRequest.requestId, "the body carries the documented idempotency key");
expectEqual(intentBody["return_url"], "https://portal.kohinur.example/pay/1001", "the body carries the return URL");
expect((intentBody["metadata"] as Record<string, string>)["invoice_id"] === "INV-1001", "the body carries metadata");
expect(Object.keys(intentBody).includes("card") === false, "the body carries no card field");
expect(Object.keys(intentBody).includes("client_secret") === false, "the body never carries a client secret");
expectEqual(buildAirwallexPaymentIntentBody({ ...intentRequest, returnUrl: null, metadata: {} })["return_url"], undefined, "no return URL is sent when none is given");
const bareBody = buildAirwallexPaymentIntentBody({ ...intentRequest, returnUrl: null, descriptor: null, metadata: {} });
expect(Object.keys(bareBody).includes("metadata") === false, "no metadata object is sent when there is none");
expect(Object.keys(bareBody).includes("descriptor") === false, "no descriptor is sent when there is none");

const derivedId = airwallexRequestIdFor("9b2d3e4f-0000-4000-8000-000000000001", "INV-1001");
expectEqual(derivedId, airwallexRequestIdFor("9b2d3e4f-0000-4000-8000-000000000001", "INV-1001"), "the derived request id is deterministic");
expect(derivedId !== airwallexRequestIdFor("9b2d3e4f-0000-4000-8000-000000000001", "INV-1002"), "a different reference derives a different id");
expectEqual(derivedId.length, 43, "the derived request id fits inside both documented bounds");
expect(derivedId.startsWith("kd-"), "the derived request id is recognisably this platform's");

/* ---- webhook signatures ---- */

const eventBody = JSON.stringify({
  id: "evt_100_2019102201540902013102020043_8321220011893766",
  name: "payment_intent.succeeded",
  account_id: "19621303213",
  data: { object: { id: "int_hkdmr1ak1n1", object: "payment_intent", status: "SUCCEEDED", amount: 9.99, currency: "USD" } },
  created_at: "2019-10-22T01:54:09+0000",
  version: "2024-02-22",
});
const timestamp = String(NOW);
expect(AIRWALLEX_WEBHOOK_SIGNATURE_SCHEME.includes("x-timestamp"), "the recorded scheme names the timestamp");
expectEqual(AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS, 300, "the platform's chosen tolerance is 300 seconds");
expectEqual(airwallexSignaturePayload("123", "{}"), "123{}", "the signed value is the timestamp then the body");
expectEqual(airwallexTimestampMs(String(NOW)), NOW, "a millisecond timestamp is read as milliseconds");
expectEqual(airwallexTimestampMs(String(Math.floor(NOW / 1_000))), Math.floor(NOW / 1_000) * 1_000, "a second timestamp is read as seconds");
expectEqual(airwallexTimestampMs("abc"), null, "a non-numeric timestamp is refused");
expectEqual(airwallexTimestampMs("123"), null, "a three-digit timestamp is refused");

const validSignature = sign(timestamp, eventBody, webhookSecret);
const accepted = verifyAirwallexWebhookSignature(eventBody, { timestamp, signature: validSignature }, {
  secret: webhookSecret,
  nowEpochMs: NOW,
});
expect(accepted.ok === true, "a correctly signed delivery is accepted");
expect(accepted.ok === true && accepted.timestampMs === NOW, "the accepted delivery reports its timestamp");

const tampered = `${eventBody} `;
expectEqual(
  verifyAirwallexWebhookSignature(tampered, { timestamp, signature: validSignature }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "a body altered after signing is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(
    eventBody,
    { timestamp, signature: sign(timestamp, eventBody, fixture("whsec", "anothersecretvalue12345")) },
    { secret: webhookSecret, nowEpochMs: NOW },
  ).ok,
  false,
  "a delivery signed with another secret is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(
    eventBody,
    { timestamp, signature: sign(timestamp, eventBody, webhookSecret) },
    { secret: webhookSecret, nowEpochMs: NOW + 301_000 },
  ).ok,
  false,
  "a delivery older than the tolerance is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(
    eventBody,
    { timestamp, signature: sign(timestamp, eventBody, webhookSecret) },
    { secret: webhookSecret, nowEpochMs: NOW + 299_000 },
  ).ok,
  true,
  "a delivery inside the tolerance is accepted",
);
expectEqual(
  verifyAirwallexWebhookSignature(eventBody, { timestamp: null, signature: validSignature }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "a delivery with no timestamp is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(eventBody, { timestamp, signature: null }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "a delivery with no signature is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(eventBody, { timestamp: "not-a-time", signature: validSignature }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "a malformed timestamp is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(eventBody, { timestamp, signature: validSignature.toUpperCase() }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "an upper-case hex signature is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(eventBody, { timestamp, signature: validSignature.slice(0, 32) }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "a truncated signature is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature("", { timestamp, signature: validSignature }, { secret: webhookSecret, nowEpochMs: NOW }).ok,
  false,
  "an empty body is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(eventBody, { timestamp, signature: validSignature }, { secret: "", nowEpochMs: NOW }).ok,
  false,
  "a missing secret is refused",
);
expectEqual(
  verifyAirwallexWebhookSignature(
    eventBody,
    { timestamp, signature: validSignature },
    { secret: webhookSecret, nowEpochMs: NOW, toleranceSeconds: 0 },
  ).ok,
  false,
  "a zero tolerance is refused rather than disabling the check",
);
expectEqual(
  verifyAirwallexWebhookSignature(
    eventBody,
    { timestamp, signature: validSignature },
    { secret: webhookSecret, nowEpochMs: NOW, maximumBodyBytes: 10 },
  ).ok,
  false,
  "an oversized delivery is refused",
);
const refusal = verifyAirwallexWebhookSignature(eventBody, { timestamp, signature: validSignature.slice(0, 32) }, {
  secret: webhookSecret,
  nowEpochMs: NOW,
});
expect(refusal.ok === false && refusal.reason.length > 0, "a refusal carries a reason");
expect(refusal.ok === false && refusal.reason.includes(webhookSecret) === false, "a refusal never carries the secret");
expect(refusal.ok === false && refusal.reason.includes(validSignature) === false, "a refusal never carries the signature");

/* ---- events ---- */

expect(Object.isFrozen(AIRWALLEX_EVENT_NAMES), "the event names are frozen");
expect(Object.isFrozen(AIRWALLEX_EVENT_FIELDS), "the event fields are frozen");
expectEqual(AIRWALLEX_EVENT_FIELDS.join(","), "id,name,account_id,org_id,data,created_at,version", "the documented event fields are kept");
expect(Object.keys(AIRWALLEX_EVENT_NAMES).includes("account") === false, "no account event name is invented");
expect(AIRWALLEX_EVENT_NAMES["paymentIntent"]?.length === 10, "the ten documented payment intent events are recorded");
expect(AIRWALLEX_EVENT_NAMES["paymentAttempt"]?.length === 3, "the documented attempt events are recorded");
expect(AIRWALLEX_EVENT_NAMES["transfer"]?.length === 11, "the documented transfer events are recorded");
expect(isAirwallexEventName("payment_intent.succeeded"), "a documented payment event is recognised");
expect(isAirwallexEventName("payment_intent.payment_failed"), "the failure event is recognised");
expect(isAirwallexEventName("payment_attempt.authorization_failed"), "the attempt failure event is recognised");
expect(isAirwallexEventName("payout.transfer.paid"), "the paid transfer event is recognised");
expect(isAirwallexEventName("payment_intent.whatever") === false, "an unrecorded event name is refused");
expect(isAirwallexEventName("") === false, "an empty event name is refused");

const parsedEvent = parseAirwallexEvent(eventBody);
expect(parsedEvent !== null, "a documented envelope is parsed");
expectEqual(parsedEvent?.eventId, "evt_100_2019102201540902013102020043_8321220011893766", "the event id is read");
expectEqual(parsedEvent?.name, "payment_intent.succeeded", "the event name is read");
expectEqual(parsedEvent?.accountId, "19621303213", "the account id is read");
expectEqual(parsedEvent?.objectId, "int_hkdmr1ak1n1", "the object id under data.object is read");
expectEqual(parsedEvent?.objectStatus, "SUCCEEDED", "the object status is read");
expectEqual(parsedEvent?.version, "2024-02-22", "the subscription version is read");
expectEqual(parsedEvent?.createdAt, "2019-10-22T01:54:09+0000", "the created time is read");
expectEqual(parseAirwallexEvent("not json"), null, "an unparsable body is refused");
expectEqual(parseAirwallexEvent("[]"), null, "an array is not an envelope");
expectEqual(parseAirwallexEvent(JSON.stringify({ name: "payment_intent.succeeded", data: { object: { id: "x" } } })), null, "an envelope with no id is refused");
expectEqual(parseAirwallexEvent(JSON.stringify({ id: "evt_1234567890", data: { object: { id: "x" } } })), null, "an envelope with no name is refused");
expectEqual(parseAirwallexEvent(JSON.stringify({ id: "evt_ab", name: "payment_intent.succeeded", data: { object: { id: "x" } } })), null, "an unusable event id is refused");
expect(AIRWALLEX_EVENT_ID_PATTERN.test("evt_100_2019102201540902013102020043_8321220011893766"), "the documented event id matches the pattern");
expect(AIRWALLEX_EVENT_ID_PATTERN.test("int_hkdmr1ak1n1") === false, "a resource id is not an event id");

/* ---- the sandbox record ---- */

expect(Object.isFrozen(AIRWALLEX_SANDBOX_CYCLE), "the sandbox cycle is frozen");
expectEqual(AIRWALLEX_SANDBOX_CYCLE.length, 5, "the cycle has five steps");
expectEqual(AIRWALLEX_REQUIRED_STEP_IDS.join(","), "token,account,payment,transfer,webhook", "the five step ids are the documented order");
for (const step of AIRWALLEX_SANDBOX_CYCLE) {
  expect(step.behaviour.trim().length > 30, `the step ${step.id} states its behaviour`);
  expect(step.evidence.trim().length > 15, `the step ${step.id} states its evidence`);
}
expect(Object.isFrozen(AIRWALLEX_SANDBOX_LIMITS), "the sandbox limits are frozen");
expect(AIRWALLEX_SANDBOX_LIMITS.length >= 5, "the sandbox limits are recorded");
expect(
  AIRWALLEX_SANDBOX_LIMITS.some((limit) => limit.includes("except the Connected Account APIs")),
  "the connected-account sandbox gap is recorded",
);
expect(
  AIRWALLEX_SANDBOX_LIMITS.some((limit) => limit.includes("x-on-behalf-of")),
  "the on-behalf-of call is recorded",
);
expectEqual(AIRWALLEX_SESSION_STATUS, "partial", "this session's status is partial, never verified");
expect(Object.isFrozen(AIRWALLEX_CAPABILITY_MATRIX), "the capability matrix is frozen");
expectEqual(AIRWALLEX_CAPABILITY_MATRIX["sandboxForConnectedAccounts"], false, "the matrix says the connected-account sandbox is missing");
expectEqual(AIRWALLEX_CAPABILITY_MATRIX["connectedAccounts"], true, "the matrix says connected accounts exist as an API");
expectEqual(AIRWALLEX_CAPABILITY_MATRIX["payments"], true, "the matrix says payments exist");
expectEqual(AIRWALLEX_CAPABILITY_MATRIX["payouts"], true, "the matrix says payouts exist");

/* ---- the record and what it may claim ---- */

const notRun: AirwallexStepResult = { stepId: "account", status: "not_run", notes: "no sandbox credential exists", evidence: null };
const verified: (stepId: string) => AirwallexStepResult = (stepId) => ({
  stepId,
  status: "verified",
  notes: "exercised",
  evidence: "recorded",
});

expectEqual(calculateAirwallexStatus([]).status, "not_run", "no steps means not run");
expectEqual(calculateAirwallexStatus([]).missingSteps.length, 5, "every step is missing when nothing ran");
expectEqual(calculateAirwallexStatus([notRun]).status, "not_run", "a record whose only step did not run is not partial");
expectEqual(
  calculateAirwallexStatus([verified("token"), notRun]).status,
  "partial",
  "one verified step beside a recorded-but-not-run step is partial",
);
expectEqual(calculateAirwallexStatus([verified("token")]).status, "partial", "one verified step is partial");
expectEqual(calculateAirwallexStatus([verified("token")]).verifiedSteps, 1, "one verified step is counted");
expectEqual(
  calculateAirwallexStatus([verified("token"), verified("account"), verified("payment"), verified("transfer")]).status,
  "partial",
  "four of five verified steps is still partial",
);
const allVerified = AIRWALLEX_REQUIRED_STEP_IDS.map((id) => verified(id));
expectEqual(calculateAirwallexStatus(allVerified).status, "verified", "five verified steps is verified");
expectEqual(calculateAirwallexStatus(allVerified).missingSteps.length, 0, "nothing is missing once all five are verified");

const store = new InMemoryAirwallexVerificationStore();
const audits: string[] = [];
const recorded = recordAirwallexVerification(
  { environment: "sandbox", apiVersion: "2026-05-29", steps: [verified("token")], reviewedAtEpochMs: NOW },
  { store, recordAudit: (entry) => audits.push(`${entry.action}:${entry.status}`) },
);
expectEqual(recorded.status, "recorded", "a record with one verified step is stored");
expect(recorded.status === "recorded" && recorded.record.status === "partial", "the stored record reads partial");
expectEqual(store.find()?.status, "partial", "the store holds the partial record");
expectEqual(audits.join(","), "airwallex.verification_recorded:partial", "recording writes one audit entry");

const unknownStep = recordAirwallexVerification(
  { environment: "sandbox", apiVersion: "2026-05-29", steps: [{ ...notRun, stepId: "invented" }], reviewedAtEpochMs: NOW },
  { store },
);
expectEqual(unknownStep.status, "failed", "a step outside the cycle is refused");
expect(
  unknownStep.status === "failed" && unknownStep.reason.includes("invented"),
  "the refusal names the invented step",
);
const verifiedWithoutEvidence = recordAirwallexVerification(
  { environment: "sandbox", apiVersion: "2026-05-29", steps: [{ stepId: "token", status: "verified", notes: "claims", evidence: null }], reviewedAtEpochMs: NOW },
  { store },
);
expectEqual(verifiedWithoutEvidence.status, "failed", "a verified step without evidence is refused");
const badVersion = recordAirwallexVerification(
  { environment: "sandbox", apiVersion: "v1", steps: [verified("token")], reviewedAtEpochMs: NOW },
  { store },
);
expectEqual(badVersion.status, "failed", "a record with an unusable version is refused");

/* ---- the session review ---- */

expect(Object.isFrozen(AIRWALLEX_SESSION_CHECKS), "the session checks are frozen");
expect(AIRWALLEX_SESSION_CHECKS.length >= 8, "the session review covers every claim");
for (const check of AIRWALLEX_SESSION_CHECKS) {
  expectEqual(check.passed, true, `the session check ${check.id} passed`);
  expect(check.description.trim().length > 10, `the session check ${check.id} is described`);
  expect(check.evidence.trim().length > 10, `the session check ${check.id} names its evidence`);
}

/* ---- text safety ---- */

expectEqual(sanitizeAirwallexText("  Kohinur   Digital  "), "Kohinur Digital", "the sanitiser collapses whitespace");
expectEqual(sanitizeAirwallexText("a\u0000b"), "a b", "the sanitiser removes a control character");
expectEqual(sanitizeAirwallexText("x".repeat(300)).length, 200, "the sanitiser truncates to the default length");
expectEqual(sanitizeAirwallexText("x".repeat(300), 10).length, 10, "the sanitiser honours a given length");

/* ---- the vocabularies are immutable ---- */

expectThrows(() => {
  (AIRWALLEX_TRANSFER_STATUSES as string[]).push("INVENTED");
}, "the transfer status list cannot be extended at run time");
expectThrows(() => {
  (AIRWALLEX_RECORDED_RULES as unknown as unknown[]).push("rule");
}, "the recorded rules cannot be extended at run time");
expectThrows(() => {
  (AIRWALLEX_SANDBOX_LIMITS as string[]).push("limit");
}, "the sandbox limits cannot be extended at run time");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Airwallex documentation gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Airwallex documentation gate passed: ${checks} checks (the two documented hosts with the community demo host refused, credential bounds where no prefix exists, the major-unit amount conversion in both directions, every documented payment and transfer status mapped with PAID recorded as provisional, the t-and-body webhook signature with its refusals, the documented connected-account body, and a sandbox record that stays partial because the connected-account APIs are not in the sandbox)\n`,
);
