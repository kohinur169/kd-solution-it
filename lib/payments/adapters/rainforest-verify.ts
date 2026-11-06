// path: lib/payments/adapters/rainforest-verify.ts

/**
 * The gate for STEP 157: Rainforest documentation verification and sandbox notes recording.
 *
 * A check script, not a test file: it exercises the recording service with the documentation review
 * this session actually produced and with records that must be refused, then fails the run and names
 * every check that did not hold. No network call is made and no credential is used.
 */

import process from "node:process";
import {
  calculateRainforestStatus,
  carriesRainforestApiKeyShapedText,
  InMemoryRainforestVerificationStore,
  isRainforestApiKeyShaped,
  isRainforestDocumentationUrl,
  isRainforestSandboxId,
  parseRainforestEventType,
  RAINFOREST_API_PATH_PREFIX,
  RAINFOREST_API_VERSION,
  RAINFOREST_API_VERSION_HEADER,
  RAINFOREST_APPLICATION_STATUSES,
  RAINFOREST_DOCUMENTATION_HOSTS,
  RAINFOREST_DOCUMENTATION_SOURCES,
  RAINFOREST_EVENT_RESOURCES,
  RAINFOREST_MERCHANT_STATUSES,
  RAINFOREST_OPEN_QUESTIONS,
  RAINFOREST_PAYIN_STATUSES,
  RAINFOREST_PRODUCTION_API_BASE,
  RAINFOREST_PRODUCTION_KEY_PREFIX,
  RAINFOREST_PROVIDER_KEY,
  RAINFOREST_PROVIDER_NAME,
  RAINFOREST_RECORDED_RULES,
  RAINFOREST_SANDBOX_API_BASE,
  RAINFOREST_SANDBOX_CYCLE,
  RAINFOREST_SANDBOX_ID_PREFIX,
  RAINFOREST_SANDBOX_KEY_PREFIX,
  RAINFOREST_SANDBOX_STEP_IDS,
  RAINFOREST_SESSION_CHECKS,
  RAINFOREST_SESSION_SANDBOX_NOTES,
  RAINFOREST_SESSION_STATUS,
  RAINFOREST_WEBHOOK_ACK_TIMEOUT_SECONDS,
  RAINFOREST_WEBHOOK_DISABLE_AFTER_FAILING_DAYS,
  RAINFOREST_WEBHOOK_ENVELOPE_FIELDS,
  RAINFOREST_WEBHOOK_RETRY_DELAYS_SECONDS,
  RAINFOREST_WEBHOOK_RETRY_WINDOW_SECONDS,
  RAINFOREST_WEBHOOK_SOURCE_IPS,
  rainforestApiBaseFor,
  rainforestApiKeyPrefixFor,
  rainforestApiUrlFor,
  rainforestApplicationOutcomeOf,
  rainforestDocumentationHostOf,
  rainforestEnvironmentOfApiKey,
  rainforestMerchantBehaviourOf,
  rainforestPayinOutcomeOf,
  rainforestPayinOutcomeOfEvent,
  recordRainforestVerification,
  sanitizeRainforestText,
  validateRainforestDocumentationCheck,
  validateRainforestSandboxNote,
  type RainforestDocumentationCheck,
  type RainforestSandboxNote,
  type RainforestVerificationAuditEntry,
  type RainforestVerificationRecord,
  type RecordRainforestVerificationResult,
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

function refusalReasonOf(result: RecordRainforestVerificationResult): string {
  return result.status === "failed" ? result.reason : "recorded";
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

/* ------------------------------------------------------------------------------------------------
 * Section 1: the constants
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_PROVIDER_KEY, "rainforest", "the provider key is the registry key");
expectEqual(RAINFOREST_PROVIDER_NAME, "Rainforest", "the provider name is the registered one");
expectEqual(RAINFOREST_SANDBOX_API_BASE, "https://api.sandbox.rainforestpay.com", "the sandbox API base is the documented one");
expectEqual(RAINFOREST_PRODUCTION_API_BASE, "https://api.rainforestpay.com", "the production API base is the documented one");
expectEqual(RAINFOREST_API_PATH_PREFIX, "/v1", "the documented path prefix is recorded");
expectEqual(RAINFOREST_API_VERSION, "2024-10-16", "the current API version is the documented one");
expectEqual(RAINFOREST_API_VERSION_HEADER, "Rainforest-Api-Version", "the documented version header is recorded");
expectEqual(RAINFOREST_SANDBOX_KEY_PREFIX, "sbx_apikey_", "the documented sandbox key prefix is recorded");
expectEqual(RAINFOREST_PRODUCTION_KEY_PREFIX, "apikey_", "the documented production key prefix is recorded");
expectEqual(RAINFOREST_SANDBOX_ID_PREFIX, "sbx_", "the documented sandbox id prefix is recorded");
expectEqual(
  RAINFOREST_WEBHOOK_ENVELOPE_FIELDS.join(","),
  "data,event_type",
  "the documented webhook envelope fields are recorded",
);
expectEqual(RAINFOREST_WEBHOOK_ACK_TIMEOUT_SECONDS, 15, "the documented acknowledgement window is recorded");
expectEqual(
  RAINFOREST_WEBHOOK_RETRY_DELAYS_SECONDS.join(","),
  "0,5,300,1800,7200,18000,36000,36000",
  "the documented retry schedule is recorded",
);
expectEqual(RAINFOREST_WEBHOOK_RETRY_DELAYS_SECONDS.length, 8, "the schedule has the eight documented attempts");
expect(
  RAINFOREST_WEBHOOK_RETRY_WINDOW_SECONDS === 99_305,
  "the retry window is the sum of the documented delays",
);
expect(
  RAINFOREST_WEBHOOK_RETRY_WINDOW_SECONDS > 27 * 3_600 && RAINFOREST_WEBHOOK_RETRY_WINDOW_SECONDS < 29 * 3_600,
  "the retry window is the documented approximate 28 hours",
);
expectEqual(RAINFOREST_WEBHOOK_DISABLE_AFTER_FAILING_DAYS, 5, "the documented disabling rule is recorded");
expectEqual(
  RAINFOREST_WEBHOOK_SOURCE_IPS.join(","),
  "44.228.126.217,50.112.21.217,52.24.126.164,54.148.139.208",
  "the documented source addresses are recorded",
);
expectEqual(RAINFOREST_DOCUMENTATION_HOSTS.join(","), "docs.rainforestpay.com", "only Rainforest's own documentation host is allowed");

/* ------------------------------------------------------------------------------------------------
 * Section 2: the environment, url and key helpers
 * --------------------------------------------------------------------------------------------- */

expectEqual(rainforestApiBaseFor("sandbox"), RAINFOREST_SANDBOX_API_BASE, "the sandbox base is chosen for sandbox");
expectEqual(rainforestApiBaseFor("production"), RAINFOREST_PRODUCTION_API_BASE, "the production base is chosen for production");
expectEqual(
  rainforestApiUrlFor("sandbox", "/v1/payins"),
  "https://api.sandbox.rainforestpay.com/v1/payins",
  "a documented path is joined to the sandbox base",
);
expectEqual(
  rainforestApiUrlFor("production", "/v1/merchants/{merchant_id}/applications/{merchant_application_id}"),
  "https://api.rainforestpay.com/v1/merchants/{merchant_id}/applications/{merchant_application_id}",
  "a documented path with parameters is joined",
);
expectEqual(rainforestApiUrlFor("sandbox", "/v2/payins"), null, "a path outside the documented prefix is refused");
expectEqual(rainforestApiUrlFor("sandbox", "/v1/payins?expand=card"), null, "a query string is refused");
expectEqual(rainforestApiUrlFor("sandbox", "/v1/../../admin"), null, "a traversal attempt is refused");
expectEqual(rainforestApiUrlFor("sandbox", ""), null, "an empty path is refused");
expectEqual(rainforestApiUrlFor("sandbox", `/${"a".repeat(300)}`), null, "an over-long path is refused");

expectEqual(rainforestApiKeyPrefixFor("sandbox"), "sbx_apikey_", "the sandbox key prefix is chosen for sandbox");
expectEqual(rainforestApiKeyPrefixFor("production"), "apikey_", "the production key prefix is chosen for production");
expectEqual(rainforestEnvironmentOfApiKey("sbx_apikey_0123456789abcdef"), "sandbox", "a sandbox key is read as sandbox");
expectEqual(rainforestEnvironmentOfApiKey("apikey_0123456789abcdef"), "production", "a production key is read as production");
expectEqual(rainforestEnvironmentOfApiKey("sk_live_0123456789abcdef"), null, "an unknown key prefix names no environment");
expectEqual(rainforestEnvironmentOfApiKey(""), null, "an empty key names no environment");
expect(isRainforestApiKeyShaped("sbx_apikey_0123456789abcdef"), "a sandbox key is key shaped");
expect(isRainforestApiKeyShaped("apikey_0123456789abcdef"), "a production key is key shaped");
expect(isRainforestApiKeyShaped("apikey_short") === false, "a short value is not key shaped");
expect(isRainforestSandboxId("sbx_pyi_2sP8Qds"), "a sandbox id is recognised");
expect(isRainforestSandboxId("sbx_") === false, "a bare sandbox prefix is not an id");
expect(isRainforestSandboxId("pyi_2sP8Qds") === false, "a production id is not a sandbox id");

/* ------------------------------------------------------------------------------------------------
 * Section 3: the documentation sources
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_DOCUMENTATION_SOURCES.length, 15, "every page read in this session is recorded");
expectEqual(
  new Set(RAINFOREST_DOCUMENTATION_SOURCES.map((source) => source.url)).size,
  RAINFOREST_DOCUMENTATION_SOURCES.length,
  "the source urls are unique",
);
for (const source of RAINFOREST_DOCUMENTATION_SOURCES) {
  expect(isRainforestDocumentationUrl(source.url), `the source ${source.url} is on Rainforest's documentation host`);
  expect(source.topic.trim().length >= 3, `the source ${source.url} names its topic`);
  expect(source.establishes.trim().length >= 40, `the source ${source.url} records what it established`);
  expect(source.url.startsWith("https://docs.rainforestpay.com/"), `the source ${source.url} is on the documented host`);
}

const sourceUrls = RAINFOREST_DOCUMENTATION_SOURCES.map((source) => source.url).join(" ");
expect(sourceUrls.includes("reference/authentication"), "the authentication reference is recorded");
expect(sourceUrls.includes("docs/api-keys"), "the API key guide is recorded");
expect(sourceUrls.includes("docs/moving-to-production"), "the environment split page is recorded");
expect(sourceUrls.includes("docs/api-version-upgrades"), "the API version guide is recorded");
expect(sourceUrls.includes("docs/process-payins-via-api"), "the API payin guide is recorded");
expect(sourceUrls.includes("docs/onboarding-merchants-via-api"), "the API onboarding guide is recorded");
expect(sourceUrls.includes("docs/understanding-payins"), "the payin status page is recorded");
expect(sourceUrls.includes("docs/payin-webhooks"), "the payin webhook page is recorded");
expect(sourceUrls.includes("docs/merchant-webhooks"), "the merchant webhook page is recorded");
expect(sourceUrls.includes("docs/merchant-application-webhooks"), "the application webhook page is recorded");
expect(sourceUrls.includes("docs/webhooks-and-notifications"), "the webhook overview is recorded");
expect(sourceUrls.includes("docs/on-premises-webhook-integration"), "the at-least-once page is recorded");
expect(sourceUrls.includes("docs/test-accounts-and-cards"), "the sandbox test data page is recorded");
expect(sourceUrls.includes("docs/going-live"), "the going live page is recorded");

/* ------------------------------------------------------------------------------------------------
 * Section 4: the documentation url allowlist and provider text
 * --------------------------------------------------------------------------------------------- */

expectEqual(rainforestDocumentationHostOf("https://docs.rainforestpay.com/docs/overview.md"), "docs.rainforestpay.com", "a documentation page host is read");
expectEqual(rainforestDocumentationHostOf("https://docs.rainforestpay.com/reference/create_payin.md"), "docs.rainforestpay.com", "a reference page host is read");
expectEqual(rainforestDocumentationHostOf("http://docs.rainforestpay.com/docs/overview.md"), null, "a plain http url is refused");
expectEqual(rainforestDocumentationHostOf("https://docs.rainforestpay.com"), null, "a url without a path is refused");
expectEqual(rainforestDocumentationHostOf("ftp://docs.rainforestpay.com/docs/overview.md"), null, "a non-https scheme is refused");
expectEqual(rainforestDocumentationHostOf(""), null, "an empty url is refused");
expectEqual(rainforestDocumentationHostOf(`https://docs.rainforestpay.com/${"x".repeat(320)}`), null, "an over-long url is refused");
expectEqual(rainforestDocumentationHostOf("https://docs.rainforestpay.com/docs/ overview"), null, "a url with a space is refused");

expect(isRainforestDocumentationUrl("https://docs.rainforestpay.com/docs/payin-webhooks.md"), "a guide page is a Rainforest page");
expect(isRainforestDocumentationUrl("https://docs.rainforestpay.com/reference/authentication.md"), "the reference is a Rainforest page");
expect(isRainforestDocumentationUrl("https://rainforestpay.evil.example/docs/overview") === false, "a look-alike host is refused");
expect(isRainforestDocumentationUrl("https://docs.rainforestpay.com.evil.example/docs/overview") === false, "a suffixed host is refused");
expect(isRainforestDocumentationUrl("https://docs.nmi.com/reference/overview") === false, "another provider's page is refused");
expect(isRainforestDocumentationUrl("https://www.rainforestpay.com/docs/overview") === false, "the marketing host is not the documentation host");

expectEqual(sanitizeRainforestText("<b>Declined</b> by issuer"), "bDeclined/b by issuer", "markup is stripped");
expectEqual(sanitizeRainforestText("line1\nline2\ttab"), "line1 line2 tab", "control characters collapse");
expectEqual(sanitizeRainforestText(null), "", "missing text is empty");
expectEqual(sanitizeRainforestText(undefined), "", "undefined text is empty");
expectEqual(sanitizeRainforestText(" padded "), "padded", "text is trimmed");
expectEqual(sanitizeRainforestText("x".repeat(900)).length, 500, "text is capped");
expect(sanitizeRainforestText("x".repeat(901)) === sanitizeRainforestText("x".repeat(900)), "text beyond twice the cap is cut the same way");

expect(carriesRainforestApiKeyShapedText("key sbx_apikey_0123456789abcdef used"), "a sandbox key in text is noticed");
expect(carriesRainforestApiKeyShapedText("key apikey_0123456789abcdef."), "a production key with punctuation is noticed");
expect(carriesRainforestApiKeyShapedText("the key was rotated") === false, "prose about a key is not a key");
expect(carriesRainforestApiKeyShapedText("") === false, "empty text carries no key");

/* ------------------------------------------------------------------------------------------------
 * Section 5: the recorded rules and the open questions
 * --------------------------------------------------------------------------------------------- */

expect(RAINFOREST_RECORDED_RULES.length >= 18, "the recorded rules cover the documented behaviour");
expectEqual(new Set(RAINFOREST_RECORDED_RULES).size, RAINFOREST_RECORDED_RULES.length, "the recorded rules are unique");
const rules = RAINFOREST_RECORDED_RULES.join("\n");
expect(rules.includes("api.sandbox.rainforestpay.com"), "the rules record the sandbox base");
expect(rules.includes("api.rainforestpay.com"), "the rules record the production base");
expect(rules.includes("/v1"), "the rules record the documented path prefix");
expect(rules.includes("apikey_"), "the rules record the production key prefix");
expect(rules.includes("sbx_apikey_"), "the rules record the sandbox key prefix");
expect(rules.includes("Bearer"), "the rules record the bearer scheme");
expect(rules.includes("Rainforest-Api-Version"), "the rules record the version header");
expect(rules.includes("2024-10-16"), "the rules record the current API version");
expect(rules.includes("group#all"), "the rules record the permission groups");
expect(rules.includes("/v1/payin_configs"), "the rules record the payin config endpoint");
expect(rules.includes("/v1/payins"), "the rules record the payin endpoint");
expect(rules.includes("method_type"), "the rules record the documented method type field");
expect(rules.includes("minor units"), "the rules record the amount unit");
expect(rules.includes("USD"), "the rules record the single supported currency");
expect(rules.includes("RSA-OAEP-SHA256"), "the rules record the documented ACH encryption");
expect(rules.includes("requires Rainforest approval"), "the rules record the approval requirement");
expect(rules.includes("T+1"), "the rules record the card deposit timing");
expect(rules.includes("T+4"), "the rules record the ACH deposit timing");
expect(rules.includes("NEEDS_INFORMATION"), "the rules record the application status vocabulary");
expect(rules.includes("merchant_application.{status}"), "the rules record the application event names");
expect(rules.includes("deposit_routes"), "the rules record the deposit route wiring");
expect(rules.includes("validation_errors"), "the rules record the validation answer");
expect(rules.includes("event_type"), "the rules record the webhook envelope");
expect(rules.includes("signing key"), "the rules record per-endpoint signing keys");
expect(rules.includes("44.228.126.217"), "the rules record the source addresses");
expect(rules.includes("message.attempt.exhausted"), "the rules record the exhausted attempt event");
expect(rules.includes("at-least-once"), "the rules record the delivery guarantee");
expect(rules.includes("idempotent"), "the rules record the consumer's idempotency duty");
expect(/Bearer [A-Za-z0-9_-]{20,}/u.test(rules) === false, "the rules carry no credential");

expectEqual(RAINFOREST_OPEN_QUESTIONS.length, 4, "the pages' unanswered questions are recorded");
const questions = RAINFOREST_OPEN_QUESTIONS.join("\n");
expect(questions.includes("webhook signature scheme"), "the open question about webhook signing is recorded");
expect(questions.includes("Verify webhooks recipe"), "the open question names the recipe that must be read");
expect(questions.includes("STEP 160"), "the signature open question names the STEP that must read it");
expect(questions.includes("step 160") || questions.includes("STEPs 159 and 160"), "the approval open question names the STEPs that must not assume it");
expect(questions.includes("Rainforest-Api-Version"), "the open question about the minimum API version is recorded");
expect(questions.includes("STEP 158"), "the version open question names the STEP that must send the header");
expect(questions.includes("No Rainforest sandbox account"), "the open question about missing credentials is recorded");
expect(/sbx_apikey_[A-Za-z0-9]{8,}/u.test(questions) === false, "the open questions carry no credential");

/* ------------------------------------------------------------------------------------------------
 * Section 6: the documented vocabularies
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_PAYIN_STATUSES.length, 9, "the payin status vocabulary is complete");
expectEqual(
  RAINFOREST_PAYIN_STATUSES.join(","),
  "CREATED,PRESENTING,AUTHORIZED,PROCESSING,SUCCEEDED,FAILED,RETURNED,CANCELED,IN_REVIEW",
  "the payin statuses are the documented ones in order",
);
expectEqual(RAINFOREST_MERCHANT_STATUSES.join(","), "PENDING,ONBOARDING,ACTIVE,SUSPENDED,DEACTIVATED,CANCELED", "the merchant statuses are the documented ones");
expectEqual(
  RAINFOREST_APPLICATION_STATUSES.join(","),
  "CREATED,IN_PROGRESS,PROCESSING,NEEDS_INFORMATION,IN_REVIEW,COMPLETED,DECLINED",
  "the application statuses are the documented ones",
);
expectEqual(RAINFOREST_EVENT_RESOURCES.length, 11, "the documented event resources are recorded");
expect(RAINFOREST_EVENT_RESOURCES.includes("merchant_application"), "the event resources include the application resource");
expect(RAINFOREST_EVENT_RESOURCES.includes("message"), "the event resources include the message resource");

expectEqual(rainforestPayinOutcomeOf("SUCCEEDED"), "succeeded", "SUCCEEDED is the only payin success");
for (const status of ["CREATED", "PRESENTING", "AUTHORIZED", "PROCESSING", "IN_REVIEW"]) {
  expectEqual(rainforestPayinOutcomeOf(status), "pending", `${status} is pending`);
}
for (const status of ["FAILED", "RETURNED", "CANCELED"]) {
  expectEqual(rainforestPayinOutcomeOf(status), "failed", `${status} is failed`);
}
expectEqual(rainforestPayinOutcomeOf(" succeeded "), "succeeded", "surrounding whitespace is tolerated");
expectEqual(rainforestPayinOutcomeOf("SETTLED"), null, "an undocumented status is unknown");
expectEqual(rainforestPayinOutcomeOf(""), null, "an empty status is unknown");
expectEqual(rainforestPayinOutcomeOf("ALLOWED"), null, "another provider's status word is unknown");

expectEqual(rainforestMerchantBehaviourOf("ACTIVE"), "processes", "an ACTIVE merchant can process");
expectEqual(rainforestMerchantBehaviourOf("PENDING"), "waiting", "a pending merchant is waiting");
expectEqual(rainforestMerchantBehaviourOf("ONBOARDING"), "waiting", "an onboarding merchant is waiting");
for (const status of ["SUSPENDED", "DEACTIVATED", "CANCELED"]) {
  expectEqual(rainforestMerchantBehaviourOf(status), "blocked", `${status} is blocked`);
}
expectEqual(rainforestMerchantBehaviourOf("APPROVED"), null, "an undocumented merchant status is unknown");

expectEqual(rainforestApplicationOutcomeOf("COMPLETED"), "approved", "a completed application is approved");
expectEqual(rainforestApplicationOutcomeOf("DECLINED"), "declined", "a declined application is declined");
for (const status of ["CREATED", "IN_PROGRESS", "PROCESSING", "NEEDS_INFORMATION", "IN_REVIEW"]) {
  expectEqual(rainforestApplicationOutcomeOf(status), "pending", `${status} is still pending`);
}
expectEqual(rainforestApplicationOutcomeOf("APPROVED"), null, "an undocumented application status is unknown");
expectEqual(rainforestApplicationOutcomeOf(""), null, "an empty application status is unknown");

/* ------------------------------------------------------------------------------------------------
 * Section 7: the event types
 * --------------------------------------------------------------------------------------------- */

const payinEvent = parseRainforestEventType("payin.processing");
expectEqual(payinEvent?.resource, "payin", "the payin event resource is parsed");
expectEqual(payinEvent?.status, "processing", "the payin event status is parsed");
expectEqual(parseRainforestEventType("merchant_application.in_review")?.resource, "merchant_application", "an underscored resource is parsed");
expectEqual(parseRainforestEventType("merchant_application.in_review")?.status, "in_review", "an underscored status is parsed");
expectEqual(parseRainforestEventType("message.attempt.exhausted")?.resource, "message", "the delivery failure event parses as the message resource");
expectEqual(parseRainforestEventType("message.attempt.exhausted")?.status, "attempt.exhausted", "the message event keeps its full status segment");
expectEqual(parseRainforestEventType("transfer.created"), null, "an undocumented resource is refused");
expectEqual(parseRainforestEventType("payin"), null, "an event without a status is refused");
expectEqual(parseRainforestEventType(".succeeded"), null, "an event without a resource is refused");
expectEqual(parseRainforestEventType("payin."), null, "an event without a status segment is refused");
expectEqual(parseRainforestEventType("Payin.Succeeded"), null, "an event with capital letters is refused");
expectEqual(parseRainforestEventType("payin.succeeded\n")?.status, "succeeded", "trailing whitespace is tolerated");
expectEqual(parseRainforestEventType("")?.eventType, undefined, "an empty event type is refused");

expectEqual(rainforestPayinOutcomeOfEvent("payin.succeeded"), "succeeded", "a succeeded event is a payin success");
expectEqual(rainforestPayinOutcomeOfEvent("payin.processing"), "pending", "a processing event is pending");
expectEqual(rainforestPayinOutcomeOfEvent("payin.returned"), "failed", "a returned event is a failure");
expectEqual(rainforestPayinOutcomeOfEvent("payin.in_review"), "pending", "an in review event is pending");
expectEqual(rainforestPayinOutcomeOfEvent("payin.expected_deposit_date_updated"), null, "an event whose status is not a payin status is not an outcome");
expectEqual(rainforestPayinOutcomeOfEvent("merchant.active"), null, "a merchant event is not a payin outcome");
expectEqual(rainforestPayinOutcomeOfEvent("refund.succeeded"), null, "a refund event is not a payin outcome");

/* ------------------------------------------------------------------------------------------------
 * Section 8: the sandbox cycle
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_SANDBOX_CYCLE.length, 5, "the acceptance cycle has the five documented steps");
expectEqual(
  RAINFOREST_SANDBOX_STEP_IDS.join(","),
  "api_key_auth,merchant_onboarding,payin_config,payin_card,webhook_signature",
  "the cycle order is the documented one",
);
expectEqual(new Set(RAINFOREST_SANDBOX_STEP_IDS).size, 5, "the cycle step ids are unique");
for (const step of RAINFOREST_SANDBOX_CYCLE) {
  expect(step.test.trim().length >= 20, `the step ${step.id} names what it proves`);
  expect(step.method === "POST" || step.method === "GET", `the step ${step.id} names its method`);
  expect(step.path.startsWith("/"), `the step ${step.id} names its path`);
}
expectEqual(RAINFOREST_SANDBOX_CYCLE[0]?.path, "/v1/api_keys", "the first step authenticates the key");
expectEqual(RAINFOREST_SANDBOX_CYCLE[0]?.method, "GET", "the authentication step is a read");
expectEqual(RAINFOREST_SANDBOX_CYCLE[1]?.path, "/v1/merchants", "the second step onboards a merchant");
expectEqual(RAINFOREST_SANDBOX_CYCLE[2]?.path, "/v1/payin_configs", "the third step creates the payin config");
expectEqual(RAINFOREST_SANDBOX_CYCLE[3]?.path, "/v1/payins", "the fourth step processes the payin");
expectEqual(RAINFOREST_SANDBOX_CYCLE[4]?.method, "POST", "the webhook step receives a delivery");
for (const step of RAINFOREST_SANDBOX_CYCLE) {
  expect(
    step.path.startsWith(RAINFOREST_API_PATH_PREFIX) || step.id === "webhook_signature",
    `the step ${step.id} names a documented API path`,
  );
}

/* ------------------------------------------------------------------------------------------------
 * Section 9: check and note validation
 * --------------------------------------------------------------------------------------------- */

const validCheck: RainforestDocumentationCheck = {
  topic: "Process payins via API",
  url: "https://docs.rainforestpay.com/docs/process-payins-via-api.md",
  verified: true,
  notes: "The documented flow is a payin config followed by POST /v1/payins with method_type CARD or ACH.",
};
expectEqual(validateRainforestDocumentationCheck(validCheck), null, "the documented source is a valid check");
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, topic: "" }),
  "a documentation check needs a topic of 3 to 120 characters",
  "an empty topic is refused",
);
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, topic: "ab" }),
  "a documentation check needs a topic of 3 to 120 characters",
  "a two character topic is refused",
);
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, topic: "<script>" }),
  "a documentation check needs a topic of 3 to 120 characters",
  "a markup topic is refused",
);
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, url: "https://docs.nmi.com/reference/overview" }),
  "a documentation check must name a page on Rainforest's own documentation host",
  "another provider's page is refused as a check",
);
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, url: "http://docs.rainforestpay.com/docs/overview.md" }),
  "a documentation check must name a page on Rainforest's own documentation host",
  "a plain http page is refused as a check",
);
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, notes: "signed with sbx_apikey_0123456789abcdef" }),
  "a documentation note must not carry an API key",
  "a note carrying an API key is refused",
);
expectEqual(
  validateRainforestDocumentationCheck({ ...validCheck, notes: "<>" }),
  "a documentation note must carry readable text",
  "a note of markup only is refused",
);
expectEqual(validateRainforestDocumentationCheck({ ...validCheck, notes: null }), null, "a check without notes is valid");

const validNote: RainforestSandboxNote = { test: "payin_card", result: "pass", details: "The payin reached SUCCEEDED." };
expectEqual(validateRainforestSandboxNote(validNote), null, "a passed cycle step is a valid note");
expectEqual(
  validateRainforestSandboxNote({ ...validNote, test: "refund" }),
  "a sandbox note must name one step of the documented sandbox cycle",
  "an undocumented step is refused",
);
expectEqual(
  validateRainforestSandboxNote({ test: "payin_card", result: "not_tested", details: null }),
  "a sandbox note for a step that was not run must state why",
  "an unrun step without a reason is refused",
);
expectEqual(
  validateRainforestSandboxNote({ test: "payin_card", result: "not_tested", details: "   " }),
  "a sandbox note for a step that was not run must state why",
  "an unrun step with a blank reason is refused",
);
expectEqual(
  validateRainforestSandboxNote({ test: "payin_card", result: "fail", details: null }),
  "a failed sandbox step must carry the provider's answer",
  "a failed step without an answer is refused",
);
expectEqual(
  validateRainforestSandboxNote({ test: "payin_card", result: "fail", details: "DECLINED with an unlisted card." }),
  null,
  "a failed step with the provider's answer is valid",
);
expectEqual(
  validateRainforestSandboxNote({ test: "payin_card", result: "pass", details: "used apikey_0123456789abcdef" }),
  "a sandbox note must not carry an API key",
  "a note carrying an API key is refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 10: the status rule
 * --------------------------------------------------------------------------------------------- */

const verifiedChecks: RainforestDocumentationCheck[] = [{ ...validCheck }];
const passedNotes: RainforestSandboxNote[] = RAINFOREST_SANDBOX_STEP_IDS.map((id) => ({
  test: id,
  result: "pass",
  details: "Ran in the sandbox.",
}));

expectEqual(calculateRainforestStatus(verifiedChecks, passedNotes), "verified", "a complete cycle with verified pages is verified");
expectEqual(
  calculateRainforestStatus([{ ...validCheck, verified: false }], passedNotes),
  "partial",
  "an unverified page makes the record partial",
);
expectEqual(calculateRainforestStatus(verifiedChecks, []), "partial", "verified pages with no sandbox note are only partial");
expectEqual(
  calculateRainforestStatus(verifiedChecks, passedNotes.slice(0, 4)),
  "partial",
  "a cycle missing one step is only partial",
);
expectEqual(
  calculateRainforestStatus(verifiedChecks, [...passedNotes.slice(0, 4), { test: "webhook_signature", result: "not_tested", details: "No endpoint." }]),
  "partial",
  "an unrun step makes the cycle incomplete",
);
expectEqual(
  calculateRainforestStatus(verifiedChecks, [...passedNotes.slice(0, 4), { test: "webhook_signature", result: "fail", details: "Signature rejected." }]),
  "partial",
  "a failed step makes the cycle incomplete",
);
expectEqual(
  calculateRainforestStatus(verifiedChecks, passedNotes.map((note) => ({ ...note, result: "fail" as const }))),
  "partial",
  "notes that all failed are still partial because the pages were verified",
);
expectEqual(
  calculateRainforestStatus(
    [{ ...validCheck, verified: false }],
    [{ test: "payin_card", result: "not_tested", details: "No credentials." }],
  ),
  "not_verified",
  "nothing verified and nothing run is not verified",
);
expectEqual(calculateRainforestStatus([], []), "not_verified", "an empty record is not verified");
expectEqual(
  calculateRainforestStatus([{ ...validCheck, verified: false }], []),
  "not_verified",
  "an unverified page with no notes is not verified",
);

/* ------------------------------------------------------------------------------------------------
 * Section 11: recording
 * --------------------------------------------------------------------------------------------- */

const store = new InMemoryRainforestVerificationStore();
const audits: RainforestVerificationAuditEntry[] = [];
const recorded = recordRainforestVerification(
  {
    environment: "sandbox",
    documentationChecks: [validCheck],
    sandboxNotes: passedNotes,
    verifiedBy: "compliance@example.com",
  },
  { store, occurredAtEpochMs: 1_000, recordAudit: (entry) => audits.push(entry) },
);
expectEqual(recorded.status, "recorded", "a complete review is recorded");
if (recorded.status === "recorded") {
  expectEqual(recorded.record.status, "verified", "a complete review is verified");
  expectEqual(recorded.record.providerKey, "rainforest", "the record names the provider key");
  expectEqual(recorded.record.providerName, "Rainforest", "the record names the provider");
  expectEqual(recorded.record.environment, "sandbox", "the record names the environment");
  expectEqual(recorded.record.verifiedBy, "compliance@example.com", "the record names the verifier");
  expectEqual(recorded.record.verifiedAtEpochMs, 1_000, "the record carries its instant");
  expectEqual(recorded.record.documentationChecks.length, 1, "the record keeps its checks");
  expectEqual(recorded.record.sandboxNotes.length, 5, "the record keeps its notes");
  expect(/^[0-9a-f-]{36}$/u.test(recorded.record.id), "the record id is a uuid");
  expectEqual(store.findById(recorded.record.id)?.id, recorded.record.id, "the record is stored");
  expectEqual(store.findLatest()?.id, recorded.record.id, "the latest record is the one just written");
  expect(Object.isFrozen(recorded.record.documentationChecks), "the recorded checks are frozen");
  expect(Object.isFrozen(recorded.record.sandboxNotes), "the recorded notes are frozen");
}
expectEqual(audits.length, 1, "recording writes one audit entry");
expectEqual(audits[0]?.action, "provider_verification.recorded", "the audit entry names the action");
expectEqual(audits[0]?.providerKey, "rainforest", "the audit entry names the provider");
expectEqual(audits[0]?.status, "verified", "the audit entry carries the calculated status");
expectEqual(audits[0]?.environment, "sandbox", "the audit entry carries the environment");
expectEqual(audits[0]?.occurredAtEpochMs, 1_000, "the audit entry carries the instant");

const trimmed = recordRainforestVerification(
  {
    environment: "production",
    documentationChecks: [{ ...validCheck, topic: "  Process payins via API  ", notes: "  <b>Text</b>  " }],
    sandboxNotes: [{ test: "payin_card", result: "not_tested", details: "  No credentials.  " }],
    verifiedBy: "  compliance@example.com  ",
  },
  { store, occurredAtEpochMs: 2_000 },
);
expectEqual(trimmed.status, "recorded", "a review without an audit writer is recorded");
if (trimmed.status === "recorded") {
  expectEqual(trimmed.record.verifiedBy, "compliance@example.com", "the verifier name is trimmed");
  expectEqual(trimmed.record.documentationChecks[0]?.topic, "Process payins via API", "the topic is trimmed");
  expectEqual(trimmed.record.documentationChecks[0]?.notes, "bText/b", "the notes are sanitised");
  expectEqual(trimmed.record.sandboxNotes[0]?.details, "No credentials.", "the note details are sanitised");
  expectEqual(trimmed.record.status, "partial", "documentation with one unrun step is partial");
  expectEqual(store.findLatest()?.id, trimmed.record.id, "the newer record becomes the latest");
  expectEqual(store.findByProvider().length, 2, "both records are kept");
}

const refusalBase = {
  environment: "sandbox" as const,
  documentationChecks: [validCheck],
  sandboxNotes: [] as RainforestSandboxNote[],
  verifiedBy: "compliance@example.com",
};
expectEqual(
  refusalReasonOf(recordRainforestVerification({ ...refusalBase, documentationChecks: [] }, { store, occurredAtEpochMs: 3_000 })),
  "a verification needs at least one documentation check",
  "a review without a documentation check is refused",
);
expectEqual(
  refusalReasonOf(recordRainforestVerification({ ...refusalBase, verifiedBy: "" }, { store, occurredAtEpochMs: 3_000 })),
  "a verification needs the name of who verified it",
  "a review without a verifier is refused",
);
expectEqual(
  refusalReasonOf(recordRainforestVerification({ ...refusalBase, verifiedBy: "<script>" }, { store, occurredAtEpochMs: 3_000 })),
  "a verification needs the name of who verified it",
  "a markup verifier is refused",
);
expectEqual(
  refusalReasonOf(
    recordRainforestVerification(
      { ...refusalBase, sandboxNotes: [validNote, { ...validNote }] },
      { store, occurredAtEpochMs: 3_000 },
    ),
  ),
  "a sandbox step may be recorded once per verification",
  "a duplicated sandbox step is refused",
);
expectEqual(
  refusalReasonOf(
    recordRainforestVerification(
      { ...refusalBase, documentationChecks: [{ ...validCheck, url: "https://docs.nmi.com/reference/overview" }] },
      { store, occurredAtEpochMs: 3_000 },
    ),
  ),
  "a documentation check must name a page on Rainforest's own documentation host",
  "a review naming another provider's page is refused",
);
expectEqual(
  refusalReasonOf(
    recordRainforestVerification(
      { ...refusalBase, sandboxNotes: [{ test: "payin_card", result: "not_tested", details: null }] },
      { store, occurredAtEpochMs: 3_000 },
    ),
  ),
  "a sandbox note for a step that was not run must state why",
  "an unrun step without a reason is refused before storing",
);
expectEqual(store.findByProvider().length, 2, "every refused review stores nothing");

/* ------------------------------------------------------------------------------------------------
 * Section 12: this session's review
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_SESSION_CHECKS.length, 15, "this session records every page it read");
expect(RAINFOREST_SESSION_CHECKS.every((check) => check.verified), "this session verified every documented page");
expectEqual(RAINFOREST_SESSION_SANDBOX_NOTES.length, 5, "this session records every cycle step");
expect(
  RAINFOREST_SESSION_SANDBOX_NOTES.every((note) => note.result === "not_tested"),
  "no cycle step is claimed as passed",
);
expect(
  RAINFOREST_SESSION_SANDBOX_NOTES.every(
    (note) => note.details !== null && note.details.includes("has not been run") && note.details.includes("Sandbox Platform Portal"),
  ),
  "every unrun step states why",
);
expectEqual(RAINFOREST_SESSION_STATUS, "partial", "this session's review is partial, never verified");

const sessionStore = new InMemoryRainforestVerificationStore();
const sessionAudits: RainforestVerificationAuditEntry[] = [];
const sessionRecord = recordRainforestVerification(
  {
    environment: "sandbox",
    documentationChecks: RAINFOREST_SESSION_CHECKS,
    sandboxNotes: RAINFOREST_SESSION_SANDBOX_NOTES,
    verifiedBy: "step-157-review",
  },
  { store: sessionStore, occurredAtEpochMs: 4_000, recordAudit: (entry) => sessionAudits.push(entry) },
);
expectEqual(sessionRecord.status, "recorded", "this session's review is recorded honestly");
if (sessionRecord.status === "recorded") {
  expectEqual(sessionRecord.record.status, "partial", "the recorded session review is partial");
  expectEqual(sessionRecord.record.documentationChecks.length, 15, "the recorded session review keeps every check");
  expectEqual(
    sessionRecord.record.sandboxNotes.filter((note) => note.result === "not_tested").length,
    5,
    "the recorded session review keeps every unrun step",
  );
  const serialised = JSON.stringify(sessionRecord.record);
  expect(/Bearer [A-Za-z0-9_-]{16,}/u.test(serialised) === false, "the record carries no bearer credential");
  expect(/Authorization:/u.test(serialised) === false, "the record carries no authorization header");
  expect(/sbx_apikey_[A-Za-z0-9]{8,}/u.test(serialised) === false, "the record carries no sandbox key");
  expect(/apikey_[A-Za-z0-9]{8,}/u.test(serialised) === false, "the record carries no production key");
  expect(serialised.includes("docs/webhooks-and-notifications"), "the record keeps the page that documents the deliveries");
}
expectEqual(sessionAudits.length, 1, "the session review writes one audit entry");
expectEqual(sessionAudits[0]?.status, "partial", "the audit entry reports the honest status");

/* ------------------------------------------------------------------------------------------------
 * Section 13: the store's own rules, and the frozen constants
 * --------------------------------------------------------------------------------------------- */

const storeRules = new InMemoryRainforestVerificationStore();
const seedRecord: RainforestVerificationRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  providerKey: "rainforest",
  providerName: "Rainforest",
  environment: "sandbox",
  documentationChecks: [{ ...validCheck }],
  sandboxNotes: [],
  status: "partial",
  verifiedAtEpochMs: 5,
  verifiedBy: "seed",
};
storeRules.insert(seedRecord);
expectEqual(storeRules.findByProvider().length, 1, "the store finds the provider's records");
expectEqual(storeRules.findById(seedRecord.id)?.id, seedRecord.id, "the store finds a record by id");
expectEqual(storeRules.findById("00000000-0000-4000-8000-000000000002"), null, "an unknown id reads as null");
expectThrows(() => storeRules.insert(seedRecord), "a duplicate record id is refused");
expectEqual(storeRules.findLatest()?.id, seedRecord.id, "the single record is the latest");
expectEqual(new InMemoryRainforestVerificationStore().findLatest(), null, "an empty store has no latest");

expect(Object.isFrozen(RAINFOREST_DOCUMENTATION_SOURCES), "the documentation sources are frozen");
expect(Object.isFrozen(RAINFOREST_RECORDED_RULES), "the recorded rules are frozen");
expect(Object.isFrozen(RAINFOREST_OPEN_QUESTIONS), "the open questions are frozen");
expect(Object.isFrozen(RAINFOREST_SANDBOX_CYCLE), "the sandbox cycle is frozen");
expect(Object.isFrozen(RAINFOREST_SANDBOX_STEP_IDS), "the sandbox step ids are frozen");
expect(Object.isFrozen(RAINFOREST_SESSION_CHECKS), "the session checks are frozen");
expect(Object.isFrozen(RAINFOREST_SESSION_SANDBOX_NOTES), "the session notes are frozen");
expect(Object.isFrozen(RAINFOREST_DOCUMENTATION_HOSTS), "the documentation hosts are frozen");
expect(Object.isFrozen(RAINFOREST_PAYIN_STATUSES), "the payin statuses are frozen");
expect(Object.isFrozen(RAINFOREST_MERCHANT_STATUSES), "the merchant statuses are frozen");
expect(Object.isFrozen(RAINFOREST_APPLICATION_STATUSES), "the application statuses are frozen");
expect(Object.isFrozen(RAINFOREST_EVENT_RESOURCES), "the event resources are frozen");
expect(Object.isFrozen(RAINFOREST_WEBHOOK_SOURCE_IPS), "the source addresses are frozen");
expect(Object.isFrozen(RAINFOREST_WEBHOOK_RETRY_DELAYS_SECONDS), "the retry schedule is frozen");
expect(Object.isFrozen(RAINFOREST_WEBHOOK_ENVELOPE_FIELDS), "the envelope fields are frozen");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Rainforest documentation gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Rainforest documentation gate passed: ${checks} checks (sources on Rainforest's own host, recorded rules, the documented status vocabularies, the five step sandbox cycle, the honest partial status, and a record that cannot be inflated to verified)\n`,
);
