// path: lib/payments/adapters/stripe-verify.ts

/**
 * The gate for STEP 161: Stripe Connect documentation verification and sandbox notes recording.
 *
 * A check script, not a test file: it exercises the record module with the documentation review this
 * session actually produced, with the documented signature scheme (and the deliveries that must be
 * refused), with records that must be refused, and with the honest partial status. No network call is
 * made and no credential is used.
 */

import { createHmac } from "node:crypto";
import process from "node:process";
import {
  calculateStripeStatus,
  carriesStripeKeyShapedText,
  InMemoryStripeVerificationStore,
  isStripeDocumentationUrl,
  isStripePublishableKeyShaped,
  isStripeServerKeyShaped,
  isStripeWebhookSecretShaped,
  parseStripeEventType,
  parseStripeSignatureHeader,
  recordStripeVerification,
  sanitizeStripeText,
  STRIPE_ACCOUNT_ID_PATTERN,
  STRIPE_ACCOUNT_ID_PREFIX,
  STRIPE_API_BASE,
  STRIPE_API_VERSION_HEADER,
  STRIPE_CAPABILITY_STATUSES,
  STRIPE_CHARGE_TYPES,
  STRIPE_CHARGE_TYPE_FACTS,
  STRIPE_DOCUMENTATION_HOSTS,
  STRIPE_DOCUMENTATION_SOURCES,
  STRIPE_EVENT_ID_PATTERN,
  STRIPE_EVENT_ID_PREFIX,
  STRIPE_EVENT_RESOURCES,
  STRIPE_KEY_PREFIXES,
  STRIPE_MAXIMUM_SIGNATURES,
  STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES,
  STRIPE_MAXIMUM_WEBHOOK_ENDPOINTS,
  STRIPE_MINIMUM_TLS_VERSION,
  STRIPE_OBSERVED_API_VERSION,
  STRIPE_OPEN_QUESTIONS,
  STRIPE_PROVIDER_KEY,
  STRIPE_PROVIDER_NAME,
  STRIPE_RECORDED_EVENT_TYPES,
  STRIPE_RECORDED_RULES,
  STRIPE_REQUIREMENT_FIELDS,
  STRIPE_SANDBOX_CYCLE,
  STRIPE_SANDBOX_STEP_IDS,
  STRIPE_SANDBOX_WEBHOOK_RETRY_ATTEMPTS,
  STRIPE_SESSION_CHECKS,
  STRIPE_SESSION_SANDBOX_NOTES,
  STRIPE_SESSION_STATUS,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  STRIPE_TEXT_MAXIMUM_LENGTH,
  STRIPE_V2_ACCOUNTS_PATH,
  STRIPE_V1_ACCOUNTS_PATH,
  STRIPE_WEBHOOK_RESEND_WINDOW_DAYS,
  STRIPE_WEBHOOK_RETRY_WINDOW_DAYS,
  STRIPE_WEBHOOK_SECRET_PREFIX,
  stripeCapabilityAllowsActions,
  stripeChargeTypeFactsOf,
  stripeDocumentationHostOf,
  stripeEnvironmentOfApiKey,
  stripeOnboardingStateOf,
  stripeSignedPayload,
  validateStripeDocumentationCheck,
  validateStripeSandboxNote,
  verifyStripeWebhookSignature,
  type RecordStripeVerificationResult,
  type StripeDocumentationCheck,
  type StripeSandboxNote,
  type StripeVerificationAuditEntry,
  type StripeVerificationRecord,
} from "./stripe.ts";

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

function reasonOf(result: RecordStripeVerificationResult): string {
  return result.status === "failed" ? result.reason : "recorded";
}

/* ------------------------------------------------------------------------------------------------
 * Section 1: the provider, its hosts and its documented surface
 * --------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_PROVIDER_KEY, "stripe", "the provider key is the registry key");
expectEqual(STRIPE_PROVIDER_NAME, "Stripe", "the provider name is the registered one");
expectEqual(STRIPE_API_BASE, "https://api.stripe.com", "the documented API base is recorded");
expectEqual(STRIPE_API_VERSION_HEADER, "Stripe-Version", "the documented version header is recorded");
expectEqual(STRIPE_OBSERVED_API_VERSION, "2026-10-28.preview", "the version the pages used is recorded");
expectEqual(STRIPE_V1_ACCOUNTS_PATH, "/v1/accounts", "the v1 accounts path is recorded");
expectEqual(STRIPE_V2_ACCOUNTS_PATH, "/v2/core/accounts", "the Accounts v2 path is recorded");
expectEqual(STRIPE_SIGNATURE_HEADER, "Stripe-Signature", "the documented signature header is recorded");
expectEqual(STRIPE_SIGNATURE_TOLERANCE_SECONDS, 300, "the documented five minute tolerance is recorded");
expectEqual(STRIPE_MAXIMUM_WEBHOOK_ENDPOINTS, 16, "the documented endpoint limit is recorded");
expectEqual(STRIPE_WEBHOOK_RETRY_WINDOW_DAYS, 3, "the documented three day retry window is recorded");
expectEqual(STRIPE_SANDBOX_WEBHOOK_RETRY_ATTEMPTS, 3, "the documented sandbox retry count is recorded");
expectEqual(STRIPE_MINIMUM_TLS_VERSION, "1.2", "the documented minimum TLS version is recorded");
expectEqual(STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES, 1_048_576, "the receiver's body ceiling is recorded");
expectEqual(STRIPE_ACCOUNT_ID_PREFIX, "acct_", "the documented account id prefix is recorded");
expectEqual(STRIPE_EVENT_ID_PREFIX, "evt_", "the documented event id prefix is recorded");
expectEqual(STRIPE_WEBHOOK_SECRET_PREFIX, "whsec_", "the documented signing secret prefix is recorded");
expectEqual(STRIPE_TEXT_MAXIMUM_LENGTH, 500, "the text ceiling is recorded");
expectEqual(STRIPE_KEY_PREFIXES.length, 7, "the seven documented key prefixes are recorded");

expect(STRIPE_ACCOUNT_ID_PATTERN.test("acct_1Nxxxxxxxxxxxxx"), "a documented account id matches");
expect(!STRIPE_ACCOUNT_ID_PATTERN.test("cus_1Nxxxxxxxxxxxxx"), "a customer id is not an account id");
expect(STRIPE_EVENT_ID_PATTERN.test("evt_1Nxxxxxxxxxxxxx"), "a documented event id matches");
expect(!STRIPE_EVENT_ID_PATTERN.test("acct_1Nxxxxxxxxxxxxx"), "an account id is not an event id");

expectEqual(stripeEnvironmentOfApiKey("sk_test_1234567890abcdef"), "sandbox", "an sk_test key is sandbox");
expectEqual(stripeEnvironmentOfApiKey("rk_test_1234567890abcdef"), "sandbox", "an rk_test key is sandbox");
expectEqual(stripeEnvironmentOfApiKey("pk_live_1234567890abcdef"), "live", "a pk_live key is live");
expectEqual(stripeEnvironmentOfApiKey("sk_live_1234567890abcdef"), "live", "an sk_live key is live");
expectEqual(stripeEnvironmentOfApiKey("whsec_1234567890abcdef"), null, "a signing secret is not a mode");
expectEqual(stripeEnvironmentOfApiKey("sk_1234567890"), null, "an unprefixed key is not a documented shape");

expect(isStripeServerKeyShaped("sk_test_1234567890abcdef"), "a secret key is a server key shape");
expect(isStripeServerKeyShaped("rk_live_1234567890abcdef"), "a restricted key is a server key shape");
expect(isStripeServerKeyShaped("sk_org_1234567890abcdef"), "an organization key is a server key shape");
expect(!isStripeServerKeyShaped("pk_test_1234567890abcdef"), "a publishable key is never a server key");
expect(!isStripeServerKeyShaped("whsec_1234567890abcdef"), "a signing secret is not an API key");
expect(isStripePublishableKeyShaped("pk_test_1234567890abcdef"), "a publishable key is recognised");
expect(!isStripePublishableKeyShaped("sk_test_1234567890abcdef"), "a secret key is never publishable");
expect(isStripeWebhookSecretShaped("whsec_1234567890abcdef"), "a signing secret is recognised");
expect(!isStripeWebhookSecretShaped("sk_test_1234567890abcdef"), "an API key is never a signing secret");

/* ------------------------------------------------------------------------------------------------
 * Section 2: the documentation sources
 * --------------------------------------------------------------------------------------------- */

expect(STRIPE_DOCUMENTATION_SOURCES.length >= 10, "the record names the pages that were actually read");
for (const source of STRIPE_DOCUMENTATION_SOURCES) {
  expect(isStripeDocumentationUrl(source.url), `the source ${source.topic} lives on Stripe's documentation host`);
  expect(source.establishes.trim().length > 20, `the source ${source.topic} says what it established`);
  expect(source.topic.trim().length >= 3, `the source ${source.topic} has a readable topic`);
}

const sourceTopics = STRIPE_DOCUMENTATION_SOURCES.map((source) => source.topic);
expectEqual(new Set(sourceTopics).size, sourceTopics.length, "no two sources share a topic");
const sourceUrls = STRIPE_DOCUMENTATION_SOURCES.map((source) => source.url);
expectEqual(new Set(sourceUrls).size, sourceUrls.length, "no two sources share a URL");
expect(
  sourceUrls.every((url) => url.startsWith("https://")),
  "every source is fetched over HTTPS",
);
expect(
  sourceUrls.some((url) => url.endsWith("/connect/accounts-v2")),
  "the Accounts v2 page is recorded as the recommended surface",
);
expect(
  sourceUrls.some((url) => url.endsWith("/connect/accounts")),
  "the legacy account-types page is recorded so the deprecation is visible",
);
expect(
  sourceUrls.some((url) => url.endsWith("/connect/charges")),
  "the charge-types page is recorded",
);
expect(sourceUrls.some((url) => url.includes("/webhooks#verify-manually")), "the manual signature page is recorded");
expect(sourceUrls.some((url) => url.endsWith("/connect/handle-verification-updates")), "the requirements page is recorded");
expect(sourceUrls.some((url) => url.endsWith("/connect/testing")), "the Connect testing page is recorded");
expect(sourceUrls.some((url) => url.endsWith("/keys")), "the API keys page is recorded");
expect(sourceUrls.some((url) => url.endsWith("/connect/account-capabilities")), "the capabilities page is recorded");

expectEqual(STRIPE_DOCUMENTATION_HOSTS.length, 1, "exactly one documentation host is trusted");
expectEqual(STRIPE_DOCUMENTATION_HOSTS[0], "docs.stripe.com", "the trusted host is Stripe's own");
expect(isStripeDocumentationUrl("https://docs.stripe.com/connect/charges"), "a page on the host is accepted");
expect(!isStripeDocumentationUrl("https://dashboard.stripe.com/webhooks"), "the dashboard is not documentation");
expect(!isStripeDocumentationUrl("https://docs.stripe.com.evil.example/connect/charges"), "a lookalike host is refused");
expect(!isStripeDocumentationUrl("http://docs.stripe.com/connect/charges"), "plain HTTP is refused");
expect(!isStripeDocumentationUrl("https://docs.stripe.com"), "a bare host with no page is refused");
expect(!isStripeDocumentationUrl(""), "an empty URL is refused");
expectEqual(stripeDocumentationHostOf("https://docs.stripe.com/webhooks#verify-manually"), "docs.stripe.com", "the host is read");
expectEqual(stripeDocumentationHostOf("https://docs.stripe.com.evil.example/x"), "docs.stripe.com.evil.example", "a lookalike host is read literally");
expectEqual(stripeDocumentationHostOf("not a url"), null, "a non-URL has no host");

/* ------------------------------------------------------------------------------------------------
 * Section 3: the recorded rules and the open questions
 * --------------------------------------------------------------------------------------------- */

expect(STRIPE_RECORDED_RULES.length >= 12, "the recorded rules cover the pages that were read");
for (const rule of STRIPE_RECORDED_RULES) {
  expect(rule.trim().length > 40 && rule.trim().length <= 400, "each recorded rule is one checkable sentence");
  expect(!carriesStripeKeyShapedText(rule), "no recorded rule carries a key-shaped string");
}
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("Accounts v2")),
  "the Accounts v2 rule is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.toLowerCase().includes("legacy")),
  "the legacy account-type warning is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("card_payments") && rule.includes("active")),
  "the capability gate is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("merchant of record")),
  "the charge-type consequence is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("constant time")),
  "the constant-time comparison rule is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("three days")),
  "the retry window rule is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("idempotent")),
  "the idempotency rule is recorded",
);
expect(
  STRIPE_RECORDED_RULES.some((rule) => rule.includes("raw card number")),
  "the no-raw-card-data rule is recorded",
);

expect(STRIPE_OPEN_QUESTIONS.length >= 4, "the open questions are recorded rather than guessed at");
for (const question of STRIPE_OPEN_QUESTIONS) {
  expect(question.trim().length > 40, "each open question states what is unknown");
  expect(!carriesStripeKeyShapedText(question), "no open question carries a key-shaped string");
}
expect(
  STRIPE_OPEN_QUESTIONS.some((question) => question.includes("Accounts v2")),
  "the account-surface decision is left open for STEP 162",
);
expect(
  STRIPE_OPEN_QUESTIONS.some((question) => question.toLowerCase().includes("version")),
  "the API version decision is left open for STEP 162",
);
expect(
  STRIPE_OPEN_QUESTIONS.some((question) => question.includes("No Stripe account")),
  "the absence of a sandbox is stated in the record",
);

/* ------------------------------------------------------------------------------------------------
 * Section 4: the documented signature header
 * --------------------------------------------------------------------------------------------- */

const parsedHeader = parseStripeSignatureHeader(
  "t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd",
);
expect(parsedHeader !== null, "a documented header parses");
expectEqual(parsedHeader?.timestamp, 1492774577, "the timestamp is read from the t pair");
expectEqual(parsedHeader?.signatures.length, 1, "one v1 signature is read");
expectEqual(
  parsedHeader?.signatures[0],
  "5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd",
  "the v1 signature is kept verbatim",
);

const parsedWithV0 = parseStripeSignatureHeader(
  "t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39",
);
expectEqual(parsedWithV0?.signatures.length, 1, "the v0 scheme a test event carries is dropped");

const parsedRotated = parseStripeSignatureHeader(
  "t=1700000000,v1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,v1=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
expectEqual(parsedRotated?.signatures.length, 2, "both signatures of a rotated secret pair are read");
expectEqual(parsedRotated?.signatures[1]?.slice(0, 2), "bb", "the second signature keeps its order");

expectEqual(parseStripeSignatureHeader(null), null, "a missing header is refused");
expectEqual(parseStripeSignatureHeader(""), null, "an empty header is refused");
expectEqual(parseStripeSignatureHeader("v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd"), null, "a header with no timestamp is refused");
expectEqual(parseStripeSignatureHeader("t=1492774577"), null, "a header with no v1 signature is refused");
expectEqual(parseStripeSignatureHeader("t=1492774577,v2=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd"), null, "a future scheme alone is refused");
expectEqual(parseStripeSignatureHeader("t=not-a-number,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd"), null, "a non-numeric timestamp is refused");
expectEqual(parseStripeSignatureHeader("t=1492774577,v1=zzzz"), null, "a malformed signature is refused");
expectEqual(parseStripeSignatureHeader("t=1492774577,v1=5257A869E7ECEBEDA32AFFA62CDCA3FA51CAD7E77A0E56FF536D0CE8E108D8BD"), null, "an upper-case signature is refused");
expectEqual(parseStripeSignatureHeader("t=1492774577,t=1492774578,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd"), null, "two timestamps are refused rather than one picked");
expectEqual(parseStripeSignatureHeader("  t=1492774577 , v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd  ")?.timestamp, 1492774577, "spaces around the pairs are tolerated");
expectEqual(STRIPE_MAXIMUM_SIGNATURES, 5, "the signature ceiling is recorded");
expectEqual(stripeSignedPayload(1492774577, '{"id":"evt_1"}'), '1492774577.{"id":"evt_1"}', "the signed content is the timestamp, a dot and the body");

/* ------------------------------------------------------------------------------------------------
 * Section 5: verifying a delivery
 * --------------------------------------------------------------------------------------------- */

const SECRET = "whsec_1234567890abcdefghijklmn";
const BODY = '{"id":"evt_1Nxxxxxxxxxxxxx","type":"account.updated","data":{"object":{"id":"acct_1Nxxxxxxxxxxxxx"}}}';

function signatureFor(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

const NOW = 1_700_000_000;
const freshTimestamp = NOW - 10;

const accepted = verifyStripeWebhookSignature(BODY, `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`, {
  secret: SECRET,
  nowSeconds: () => NOW,
});
expectEqual(accepted.ok, true, "a correctly signed fresh delivery is accepted");
expectEqual(accepted.ok === true ? accepted.timestamp : null, freshTimestamp, "the accepted timestamp is reported");

expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${freshTimestamp},v1=${signatureFor("whsec_othersecret000000000", freshTimestamp, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
  }).ok,
  false,
  "a delivery signed with another secret is refused",
);
expectEqual(
  verifyStripeWebhookSignature(`${BODY} `, `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
  }).ok,
  false,
  "a body changed by one byte is refused",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${NOW - 400},v1=${signatureFor(SECRET, NOW - 400, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
  }).ok,
  false,
  "a delivery older than the tolerance is refused even with a correct signature",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${NOW + 400},v1=${signatureFor(SECRET, NOW + 400, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
  }).ok,
  false,
  "a delivery from the future is refused as well",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${NOW - 299},v1=${signatureFor(SECRET, NOW - 299, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
  }).ok,
  true,
  "a delivery inside the tolerance is accepted",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
    toleranceSeconds: 5,
  }).ok,
  false,
  "a narrower tolerance is honoured",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
    toleranceSeconds: 0,
  }).ok,
  false,
  "a tolerance of zero is refused instead of disabling the recency check",
);

const rotatedHeader = `t=${freshTimestamp},v1=${signatureFor("whsec_previoussecret0000000", freshTimestamp, BODY)},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`;
expectEqual(
  verifyStripeWebhookSignature(BODY, rotatedHeader, { secret: SECRET, nowSeconds: () => NOW }).ok,
  true,
  "the delivery verifies while two secrets are active",
);
const v0Only = `t=${freshTimestamp},v0=${signatureFor(SECRET, freshTimestamp, BODY)}`;
expectEqual(
  verifyStripeWebhookSignature(BODY, v0Only, { secret: SECRET, nowSeconds: () => NOW }).ok,
  false,
  "a v0 signature is never believed",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, null, { secret: SECRET, nowSeconds: () => NOW }).ok,
  false,
  "a delivery with no signature header is refused",
);
expectEqual(
  verifyStripeWebhookSignature("", `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, "")}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
  }).ok,
  false,
  "a delivery with no body is refused",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`, {
    secret: "",
    nowSeconds: () => NOW,
  }).ok,
  false,
  "a missing secret is refused before any comparison",
);
expectEqual(
  verifyStripeWebhookSignature(BODY, `t=${freshTimestamp},v1=${signatureFor(SECRET, freshTimestamp, BODY)}`, {
    secret: SECRET,
    nowSeconds: () => NOW,
    maximumBodyBytes: 16,
  }).ok,
  false,
  "a body larger than the receiver accepts is refused",
);

const refusal = verifyStripeWebhookSignature(BODY, "t=1,v1=zzzz", { secret: SECRET, nowSeconds: () => NOW });
expect(refusal.ok === false && refusal.reason.length > 0, "a refusal carries a reason");
expect(
  (refusal.ok === false ? refusal.reason : "").includes(SECRET) === false,
  "a refusal never repeats the secret",
);
const acceptedVerdict = verifyStripeWebhookSignature(BODY, rotatedHeader, { secret: SECRET, nowSeconds: () => NOW });
expect(
  !("signature" in acceptedVerdict) || JSON.stringify(acceptedVerdict).includes(SECRET) === false,
  "an acceptance never carries the secret either",
);

/* ------------------------------------------------------------------------------------------------
 * Section 6: capabilities and requirements
 * --------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_CAPABILITY_STATUSES.join(","), "active,inactive,pending,unrequested", "the four documented capability statuses are recorded");
expectEqual(stripeCapabilityAllowsActions("active"), true, "only an active capability allows the action");
expectEqual(stripeCapabilityAllowsActions("pending"), false, "a pending capability does not allow it");
expectEqual(stripeCapabilityAllowsActions("inactive"), false, "an inactive capability does not allow it");
expectEqual(stripeCapabilityAllowsActions("unrequested"), false, "an unrequested capability does not allow it");
expectEqual(stripeCapabilityAllowsActions(" ACTIVE "), true, "the comparison is case and space tolerant");
expectEqual(stripeCapabilityAllowsActions("restricted"), null, "an unrecorded status is unknown, never permission");

expectEqual(
  STRIPE_REQUIREMENT_FIELDS.join(","),
  "currently_due,eventually_due,past_due,pending_verification,disabled_reason,current_deadline,errors",
  "the documented requirement fields are recorded",
);
expectEqual(
  stripeOnboardingStateOf({ currentlyDue: 0, pastDue: 0, pendingVerification: 0, disabledReason: null }),
  "ready",
  "an account with nothing outstanding is ready",
);
expectEqual(
  stripeOnboardingStateOf({ currentlyDue: 2, pastDue: 0, pendingVerification: 0, disabledReason: null }),
  "waiting",
  "an account with something due is waiting",
);
expectEqual(
  stripeOnboardingStateOf({ currentlyDue: 0, pastDue: 0, pendingVerification: 1, disabledReason: null }),
  "waiting",
  "an account with something in review is waiting",
);
expectEqual(
  stripeOnboardingStateOf({ currentlyDue: 0, pastDue: 1, pendingVerification: 0, disabledReason: null }),
  "blocked",
  "an account with something past due is blocked",
);
expectEqual(
  stripeOnboardingStateOf({ currentlyDue: 0, pastDue: 0, pendingVerification: 0, disabledReason: "requirements.past_due" }),
  "blocked",
  "a disabled reason blocks regardless of the counts",
);
expectEqual(
  stripeOnboardingStateOf({ currentlyDue: 1, pastDue: 1, pendingVerification: 1, disabledReason: "listed" }),
  "blocked",
  "blocked wins over waiting",
);

/* ------------------------------------------------------------------------------------------------
 * Section 7: charge types and events
 * --------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_CHARGE_TYPES.join(","), "direct,destination,separate_charges_and_transfers", "the three documented charge types are recorded");
expectEqual(STRIPE_CHARGE_TYPE_FACTS.length, 3, "each charge type carries its facts");
for (const facts of STRIPE_CHARGE_TYPE_FACTS) {
  expect(STRIPE_CHARGE_TYPES.includes(facts.type), `the facts of ${facts.type} name a documented type`);
  expect(facts.note.length > 40, `the facts of ${facts.type} say what the type decides`);
}
const direct = stripeChargeTypeFactsOf("direct");
expectEqual(direct?.fundsLandIn, "connected_account", "a direct charge lands in the connected account");
expectEqual(direct?.merchantOfRecord, "connected_account", "a direct charge makes the connected account merchant of record");
expectEqual(direct?.lossesFallOn, "connected_account", "a direct charge puts losses on the connected account");
const destination = stripeChargeTypeFactsOf("destination");
expectEqual(destination?.fundsLandIn, "platform", "a destination charge lands in the platform balance");
expectEqual(destination?.merchantOfRecord, "platform", "a destination charge makes the platform merchant of record");
expectEqual(destination?.lossesFallOn, "platform", "a destination charge puts losses on the platform");
expectEqual(destination?.applicationFee, true, "a destination charge can carry an application fee");
expectEqual(stripeChargeTypeFactsOf("destination")?.type, "destination", "the facts are found by name");
expectEqual(stripeChargeTypeFactsOf(" DESTINATION ")?.type, "destination", "the lookup is case and space tolerant");
expectEqual(stripeChargeTypeFactsOf("standard"), null, "an undocumented charge type is unknown");

expectEqual(STRIPE_EVENT_RESOURCES.join(","), "account,charge,customer,invoice,payment_intent,payment_method", "the recorded event resources are listed");
expect(STRIPE_RECORDED_EVENT_TYPES.includes("account.updated"), "the account.updated event is recorded");
expect(STRIPE_RECORDED_EVENT_TYPES.includes("payment_intent.succeeded"), "the payment_intent.succeeded event is recorded");
for (const eventType of STRIPE_RECORDED_EVENT_TYPES) {
  expect(parseStripeEventType(eventType) !== null, `the recorded event type ${eventType} parses`);
}
const parsedEvent = parseStripeEventType("payment_intent.succeeded");
expectEqual(parsedEvent?.resource, "payment_intent", "the resource is the part before the first dot");
expectEqual(parsedEvent?.action, "succeeded", "the action is the rest");
expectEqual(parsedEvent?.eventType, "payment_intent.succeeded", "the original type is kept");
expectEqual(parseStripeEventType("account.updated")?.resource, "account", "account.updated parses to the account resource");
expectEqual(parseStripeEventType("charge.refund.updated")?.action, "refund.updated", "an action may itself contain dots");
expectEqual(parseStripeEventType("treasury.outbound_transfer.created"), null, "an unrecorded resource is refused");
expectEqual(parseStripeEventType("nope"), null, "a type with no dot is refused");
expectEqual(parseStripeEventType("account."), null, "a type with an empty action is refused");
expectEqual(parseStripeEventType(""), null, "an empty type is refused");
expectEqual(parseStripeEventType("Account.Updated"), null, "an upper-case type is refused");

/* ------------------------------------------------------------------------------------------------
 * Section 8: text handling
 * ---------------------------------------------------------------------------------------------- */

expectEqual(sanitizeStripeText("  Card declined  "), "Card declined", "surrounding space is trimmed");
expectEqual(sanitizeStripeText("<b>Card</b> declined"), "Card declined", "markup is stripped");
expectEqual(sanitizeStripeText("Card\u0000 declined"), "Card declined", "control characters are removed");
expectEqual(sanitizeStripeText(null), "", "null reads as empty text");
expectEqual(sanitizeStripeText(undefined), "", "undefined reads as empty text");
expectEqual(sanitizeStripeText("a".repeat(900)).length, STRIPE_TEXT_MAXIMUM_LENGTH, "text is capped at the ceiling");
expectEqual(sanitizeStripeText("<script>x</script>"), "x", "a script tag is stripped rather than kept");

expect(carriesStripeKeyShapedText("sk_test_1234567890abcdef"), "a secret key is key-shaped text");
expect(carriesStripeKeyShapedText("rk_live_1234567890abcdef"), "a restricted key is key-shaped text");
expect(carriesStripeKeyShapedText("whsec_1234567890abcdef"), "a signing secret is key-shaped text");
expect(carriesStripeKeyShapedText("sk_org_1234567890abcdef"), "an organization key is key-shaped text");
expect(!carriesStripeKeyShapedText("Card declined"), "a plain reason is not key-shaped");
expect(!carriesStripeKeyShapedText("the whsec_ prefix"), "a bare prefix is not key-shaped");
expect(!carriesStripeKeyShapedText("sk_"), "an empty key body is not key-shaped");

/* ------------------------------------------------------------------------------------------------
 * Section 9: the sandbox cycle
 * --------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_SANDBOX_CYCLE.length, 5, "the cycle has the five documented steps");
expectEqual(
  STRIPE_SANDBOX_STEP_IDS.join(","),
  "key_auth,connected_account_create,hosted_onboarding,test_payment,signed_webhook",
  "the step ids are stable",
);
expectEqual(new Set(STRIPE_SANDBOX_STEP_IDS).size, STRIPE_SANDBOX_STEP_IDS.length, "no step id repeats");
expectEqual(STRIPE_SANDBOX_CYCLE[0]?.method, "GET", "the connection step reads rather than writes");
expectEqual(STRIPE_SANDBOX_CYCLE[0]?.path, "/v1/accounts", "the connection step reads the accounts it is allowed to read");
expectEqual(STRIPE_SANDBOX_CYCLE[1]?.path, "/v2/core/accounts", "the account step uses Accounts v2");
expectEqual(STRIPE_SANDBOX_CYCLE[1]?.method, "POST", "the account step creates an account");
expectEqual(STRIPE_SANDBOX_CYCLE[2]?.path, "/v1/account_links", "the onboarding step uses an account link");
expectEqual(STRIPE_SANDBOX_CYCLE[3]?.path, "/v1/payment_intents", "the payment step uses a PaymentIntent");
expectEqual(STRIPE_SANDBOX_CYCLE[4]?.path, "/webhooks/stripe", "the webhook step names the receiver's own route");
for (const step of STRIPE_SANDBOX_CYCLE) {
  expect(step.test.trim().length > 20, `the step ${step.id} says what it proves`);
  expect(step.method === "GET" || step.method === "POST", `the step ${step.id} uses a documented method`);
}

/* ------------------------------------------------------------------------------------------------
 * Section 10: validating a documentation check
 * --------------------------------------------------------------------------------------------- */

const goodCheck: StripeDocumentationCheck = {
  topic: "Charge types",
  url: "https://docs.stripe.com/connect/charges",
  verified: true,
  notes: "Destination charges put the platform in the balance path.",
};

expectEqual(validateStripeDocumentationCheck(goodCheck), null, "a well formed check is valid");
expectEqual(
  validateStripeDocumentationCheck({ ...goodCheck, url: "https://example.com/connect/charges" }),
  "a documentation check must name a page on Stripe's own documentation host",
  "a check on another host is refused",
);
expectEqual(
  validateStripeDocumentationCheck({ ...goodCheck, topic: "  " }),
  "a documentation check needs a topic of 3 to 120 characters",
  "a check with no topic is refused",
);
expectEqual(
  validateStripeDocumentationCheck({ ...goodCheck, topic: "<b>Charges</b>" }),
  "a documentation check needs a topic of 3 to 120 characters",
  "a check whose topic carries markup is refused",
);
expectEqual(
  validateStripeDocumentationCheck({ ...goodCheck, notes: "verified with sk_test_1234567890abcdef" }),
  "a documentation note must not carry an API key or a signing secret",
  "a note carrying a secret key is refused",
);
expectEqual(
  validateStripeDocumentationCheck({ ...goodCheck, notes: "verified with whsec_1234567890abcdef" }),
  "a documentation note must not carry an API key or a signing secret",
  "a note carrying a signing secret is refused",
);
expectEqual(validateStripeDocumentationCheck({ ...goodCheck, notes: null }), null, "a check may carry no note");
expectEqual(
  validateStripeDocumentationCheck({ ...goodCheck, notes: "<i></i>" }),
  "a documentation note must carry readable text",
  "a note that reduces to nothing is refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 11: validating a sandbox note
 * ---------------------------------------------------------------------------------------------- */

const goodNote: StripeSandboxNote = {
  test: "key_auth",
  result: "not_tested",
  details: "No Stripe sandbox key exists in this environment.",
};

expectEqual(validateStripeSandboxNote(goodNote), null, "a not_tested note needs no detail of what happened");
expectEqual(
  validateStripeSandboxNote({ test: "charge_everything", result: "pass", details: "fine" }),
  "a sandbox note must name one of the documented cycle steps",
  "a note naming an unrecorded step is refused",
);
expectEqual(
  validateStripeSandboxNote({ test: "key_auth", result: "maybe", details: "fine" } as unknown as StripeSandboxNote),
  "a sandbox note result must be pass, fail or not_tested",
  "a note with an invented result is refused",
);
expectEqual(
  validateStripeSandboxNote({ test: "key_auth", result: "pass", details: null }),
  "a sandbox note that was run must say what happened",
  "a passing note with no detail is refused",
);
expectEqual(
  validateStripeSandboxNote({ test: "key_auth", result: "fail", details: "   " }),
  "a sandbox note that was run must say what happened",
  "a failing note with no detail is refused",
);
expectEqual(
  validateStripeSandboxNote({ test: "key_auth", result: "pass", details: "ran with sk_test_1234567890abcdef" }),
  "a sandbox note must not carry an API key or a signing secret",
  "a note carrying a key is refused",
);
expectEqual(
  validateStripeSandboxNote({ test: "key_auth", result: "pass", details: "a".repeat(STRIPE_TEXT_MAXIMUM_LENGTH + 1) }),
  "a sandbox note is too long",
  "a note beyond the ceiling is refused",
);

/* ------------------------------------------------------------------------------------------------
 * Section 12: calculating the status
 * ---------------------------------------------------------------------------------------------- */

const allChecks: readonly StripeDocumentationCheck[] = [
  { topic: "Charge types", url: "https://docs.stripe.com/connect/charges", verified: true, notes: null },
  { topic: "Webhooks", url: "https://docs.stripe.com/webhooks", verified: true, notes: null },
];
const allPassingNotes: readonly StripeSandboxNote[] = STRIPE_SANDBOX_STEP_IDS.map((id) => ({
  test: id,
  result: "pass" as const,
  details: "ran in a Stripe sandbox",
}));

expectEqual(calculateStripeStatus(allChecks, allPassingNotes), "verified", "every page and every step passing is verified");
expectEqual(calculateStripeStatus(allChecks, []), "partial", "pages alone are only partial, never verified");
expectEqual(
  calculateStripeStatus(allChecks, allPassingNotes.slice(0, 4)),
  "partial",
  "four of five cycle steps is partial, never verified",
);
expectEqual(
  calculateStripeStatus(allChecks, [{ test: "key_auth", result: "pass", details: "ran" }, ...STRIPE_SANDBOX_STEP_IDS.slice(1).map((id) => ({ test: id, result: "not_tested" as const, details: null }))]),
  "partial",
  "one passing step among untested ones is partial",
);
expectEqual(
  calculateStripeStatus(allChecks, allPassingNotes.map((note) => ({ ...note, result: "fail" as const }))),
  "partial",
  "pages read but every step failing is partial, and never verified",
);
expectEqual(
  calculateStripeStatus([], []),
  "not_verified",
  "no evidence at all is not verified",
);
expectEqual(
  calculateStripeStatus([], allPassingNotes),
  "partial",
  "steps without any page read are partial",
);
expectEqual(
  calculateStripeStatus(
    [{ topic: "Charge types", url: "https://docs.stripe.com/connect/charges", verified: false, notes: null }],
    [{ test: "key_auth", result: "fail", details: "the key was refused" }],
  ),
  "not_verified",
  "an unverified page and a failed step is not verified",
);
expectEqual(
  calculateStripeStatus(allChecks, [{ test: "key_auth", result: "fail", details: "refused" }, ...STRIPE_SANDBOX_STEP_IDS.slice(1).map((id) => ({ test: id, result: "pass" as const, details: "ran" }))]),
  "partial",
  "one failed step among passing ones is partial",
);

/* ------------------------------------------------------------------------------------------------
 * Section 13: recording a verification
 * ---------------------------------------------------------------------------------------------- */

function recordingInput(overrides: Partial<{
  environment: "sandbox" | "live";
  documentationChecks: readonly StripeDocumentationCheck[];
  sandboxNotes: readonly StripeSandboxNote[];
  verifiedBy: string;
}> = {}) {
  return {
    environment: overrides.environment ?? ("sandbox" as const),
    documentationChecks: overrides.documentationChecks ?? allChecks,
    sandboxNotes: overrides.sandboxNotes ?? allPassingNotes,
    verifiedBy: overrides.verifiedBy ?? "STEP 161 gate",
  };
}

const audits: StripeVerificationAuditEntry[] = [];
const store = new InMemoryStripeVerificationStore();
const recorded = recordStripeVerification(recordingInput(), {
  store,
  occurredAtEpochMs: 1_760_000_000_000,
  recordAudit: (entry) => audits.push(entry),
});
expectEqual(recorded.status, "recorded", "a complete verification is recorded");
const record = recorded.status === "recorded" ? recorded.record : null;
expectEqual(record?.providerKey, "stripe", "the record names the provider key");
expectEqual(record?.providerName, "Stripe", "the record names the provider");
expectEqual(record?.status, "verified", "the calculated status is verified when the evidence is complete");
expectEqual(record?.environment, "sandbox", "the record keeps the mode the notes were taken in");
expectEqual(record?.verifiedAtEpochMs, 1_760_000_000_000, "the record keeps the time it was taken");
expectEqual(record?.verifiedBy, "STEP 161 gate", "the record names who verified it");
expectEqual(record?.documentationChecks.length, 2, "the record keeps every check");
expectEqual(record?.sandboxNotes.length, STRIPE_SANDBOX_STEP_IDS.length, "the record keeps every step");
expectEqual(store.findByProvider().length, 1, "the record reaches the store");
expectEqual(store.findLatest()?.id, record?.id ?? "", "the record is the latest");
expectEqual(audits.length, 1, "one verification writes one audit entry");
expectEqual(audits[0]?.action, "provider_verification.recorded", "the audit entry names the action");
expectEqual(audits[0]?.status, "verified", "the audit entry carries the calculated status");
expectEqual(audits[0]?.environment, "sandbox", "the audit entry carries the mode");
expectEqual(audits[0]?.providerKey, "stripe", "the audit entry names the provider");
expect(record?.id !== undefined && record.id.length === 36, "the record id is a generated identifier");

const noAuditStore = new InMemoryStripeVerificationStore();
expectEqual(
  recordStripeVerification(recordingInput(), { store: noAuditStore, occurredAtEpochMs: 1_760_000_000_001 }).status,
  "recorded",
  "a recording without an audit writer still records",
);

expectEqual(
  reasonOf(recordStripeVerification(recordingInput({ documentationChecks: [] }), { store, occurredAtEpochMs: 1 })),
  "a verification needs at least one documentation check",
  "a recording with no page read is refused",
);
expectEqual(
  reasonOf(recordStripeVerification(recordingInput({ verifiedBy: " " }), { store, occurredAtEpochMs: 1 })),
  "a verification needs the name of who verified it",
  "a recording with no verifier is refused",
);
expectEqual(
  reasonOf(recordStripeVerification(recordingInput({ verifiedBy: "<script>" }), { store, occurredAtEpochMs: 1 })),
  "a verification needs the name of who verified it",
  "a verifier name carrying markup is refused",
);
expectEqual(
  reasonOf(
    recordStripeVerification(
      recordingInput({ documentationChecks: [{ ...goodCheck, url: "https://example.com/charges" }] }),
      { store, occurredAtEpochMs: 1 },
    ),
  ),
  "a documentation check must name a page on Stripe's own documentation host",
  "a recording with a check on another host is refused",
);
expectEqual(
  reasonOf(
    recordStripeVerification(
      recordingInput({ sandboxNotes: [{ test: "key_auth", result: "pass", details: "ran with sk_test_1234567890abcdef" }] }),
      { store, occurredAtEpochMs: 1 },
    ),
  ),
  "a sandbox note must not carry an API key or a signing secret",
  "a recording with a key in a note is refused",
);
expectEqual(
  reasonOf(
    recordStripeVerification(
      recordingInput({ sandboxNotes: [allPassingNotes[0] as StripeSandboxNote, allPassingNotes[0] as StripeSandboxNote] }),
      { store, occurredAtEpochMs: 1 },
    ),
  ),
  "a sandbox step may be recorded once per verification",
  "a repeated step is refused",
);

const partialStore = new InMemoryStripeVerificationStore();
const partialResult = recordStripeVerification(
  recordingInput({ documentationChecks: [goodCheck], sandboxNotes: [{ test: "key_auth", result: "not_tested", details: null }] }),
  { store: partialStore, occurredAtEpochMs: 1_760_000_000_002 },
);
expectEqual(partialResult.status === "recorded" ? partialResult.record.status : null, "partial", "a page read with no step run records as partial");
expectEqual(partialStore.findLatest()?.status, "partial", "the store keeps the honest status");

const failingStore = new InMemoryStripeVerificationStore();
const failingResult = recordStripeVerification(
  recordingInput({
    documentationChecks: [{ ...goodCheck, verified: false }],
    sandboxNotes: [{ test: "key_auth", result: "fail", details: "the key was refused" }],
  }),
  { store: failingStore, occurredAtEpochMs: 1_760_000_000_003 },
);
expectEqual(failingResult.status === "recorded" ? failingResult.record.status : null, "not_verified", "nothing verified records as not_verified");

const sanitizedStore = new InMemoryStripeVerificationStore();
const sanitized = recordStripeVerification(
  recordingInput({
    documentationChecks: [goodCheck],
    sandboxNotes: [{ test: "key_auth", result: "pass", details: "<b>ran</b> in a sandbox" }],
  }),
  { store: sanitizedStore, occurredAtEpochMs: 1_760_000_000_004 },
);
expectEqual(
  sanitized.status === "recorded" ? sanitized.record.sandboxNotes[0]?.details : null,
  "ran in a sandbox",
  "a recorded note is sanitized on the way in",
);
expectEqual(
  sanitized.status === "recorded" ? sanitized.record.documentationChecks[0]?.topic : null,
  "Charge types",
  "a recorded topic is trimmed and kept",
);

/* ------------------------------------------------------------------------------------------------
 * Section 14: the store
 * ---------------------------------------------------------------------------------------------- */

const seedRecord: StripeVerificationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  providerKey: "stripe",
  providerName: "Stripe",
  environment: "sandbox",
  documentationChecks: deepFreezeChecks(),
  sandboxNotes: deepFreezeNotes(),
  status: "partial",
  verifiedAtEpochMs: 1_760_000_000_005,
  verifiedBy: "seed",
};

function deepFreezeChecks(): readonly StripeDocumentationCheck[] {
  return [{ topic: "Charge types", url: "https://docs.stripe.com/connect/charges", verified: true, notes: null }];
}

function deepFreezeNotes(): readonly StripeSandboxNote[] {
  return [{ test: "key_auth", result: "not_tested", details: null }];
}

const storeRules = new InMemoryStripeVerificationStore();
expectEqual(storeRules.findLatest(), null, "an empty store has no latest record");
storeRules.insert(seedRecord);
expectEqual(storeRules.findByProvider().length, 1, "the store finds the provider's records");
expectEqual(storeRules.findById(seedRecord.id)?.id, seedRecord.id, "the store finds a record by id");
expectEqual(storeRules.findById("11111111-1111-4111-8111-111111111112"), null, "an unknown id reads as null");
expectThrows(() => storeRules.insert(seedRecord), "a duplicate record id is refused");
expectEqual(storeRules.findLatest()?.id, seedRecord.id, "the single record is the latest");

const orderedStore = new InMemoryStripeVerificationStore();
orderedStore.insert({ ...seedRecord, id: "22222222-2222-4222-8222-222222222222", verifiedAtEpochMs: 1_760_000_000_010 });
orderedStore.insert({ ...seedRecord, id: "33333333-3333-4333-8333-333333333333", verifiedAtEpochMs: 1_760_000_000_020 });
expectEqual(orderedStore.findLatest()?.id, "33333333-3333-4333-8333-333333333333", "the newest record is the latest");

/* ------------------------------------------------------------------------------------------------
 * Section 15: this session's review
 * ---------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_SESSION_CHECKS.length, STRIPE_DOCUMENTATION_SOURCES.length, "every source read becomes a check");
expect(STRIPE_SESSION_CHECKS.every((check) => check.verified), "every page this session read was verified as documentation");
expect(STRIPE_SESSION_CHECKS.every((check) => isStripeDocumentationUrl(check.url)), "every recorded page is on the documentation host");
expect(STRIPE_SESSION_CHECKS.every((check) => validateStripeDocumentationCheck(check) === null), "every session check is valid");
expectEqual(STRIPE_SESSION_SANDBOX_NOTES.length, STRIPE_SANDBOX_CYCLE.length, "every cycle step carries a note");
expect(
  STRIPE_SESSION_SANDBOX_NOTES.every((note) => note.result === "not_tested"),
  "no sandbox step was run, and every note says so",
);
expect(
  STRIPE_SESSION_SANDBOX_NOTES.every((note) => validateStripeSandboxNote(note) === null),
  "every session note is valid",
);
expect(
  STRIPE_SESSION_SANDBOX_NOTES.every((note) => (note.details ?? "").includes("No Stripe account")),
  "every note states why it was not run",
);
expectEqual(STRIPE_SESSION_STATUS, "partial", "the session's status is partial, never verified");
expectEqual(
  calculateStripeStatus(STRIPE_SESSION_CHECKS, STRIPE_SESSION_SANDBOX_NOTES),
  "partial",
  "the status is the calculated one, not a supplied label",
);
expect(
  STRIPE_SESSION_CHECKS.every((check) => !carriesStripeKeyShapedText(check.notes ?? "")),
  "no session note carries a key-shaped string",
);

const sessionStore = new InMemoryStripeVerificationStore();
const sessionAudits: StripeVerificationAuditEntry[] = [];
const sessionRecorded = recordStripeVerification(
  {
    environment: "sandbox",
    documentationChecks: STRIPE_SESSION_CHECKS,
    sandboxNotes: STRIPE_SESSION_SANDBOX_NOTES,
    verifiedBy: "STEP 161 documentation review",
  },
  { store: sessionStore, occurredAtEpochMs: 1_760_000_000_000, recordAudit: (entry) => sessionAudits.push(entry) },
);
expectEqual(sessionRecorded.status, "recorded", "this session's review records");
expectEqual(
  sessionRecorded.status === "recorded" ? sessionRecorded.record.status : null,
  "partial",
  "this session's recorded status is partial",
);
expectEqual(sessionAudits[0]?.status, "partial", "the audit entry says partial, so nobody reads it as verified");

/* ---- the immutability of the recorded vocabulary ---- */

expect(Object.isFrozen(STRIPE_DOCUMENTATION_SOURCES), "the documentation sources are frozen");
expect(Object.isFrozen(STRIPE_DOCUMENTATION_HOSTS), "the documentation hosts are frozen");
expect(Object.isFrozen(STRIPE_RECORDED_RULES), "the recorded rules are frozen");
expect(Object.isFrozen(STRIPE_OPEN_QUESTIONS), "the open questions are frozen");
expect(Object.isFrozen(STRIPE_KEY_PREFIXES), "the key prefixes are frozen");
expect(Object.isFrozen(STRIPE_CAPABILITY_STATUSES), "the capability statuses are frozen");
expect(Object.isFrozen(STRIPE_REQUIREMENT_FIELDS), "the requirement fields are frozen");
expect(Object.isFrozen(STRIPE_CHARGE_TYPES), "the charge types are frozen");
expect(Object.isFrozen(STRIPE_CHARGE_TYPE_FACTS), "the charge type facts are frozen");
expect(Object.isFrozen(STRIPE_RECORDED_EVENT_TYPES), "the recorded event types are frozen");
expect(Object.isFrozen(STRIPE_EVENT_RESOURCES), "the event resources are frozen");
expect(Object.isFrozen(STRIPE_SANDBOX_CYCLE), "the sandbox cycle is frozen");
expect(Object.isFrozen(STRIPE_SANDBOX_STEP_IDS), "the sandbox step ids are frozen");
expect(Object.isFrozen(STRIPE_SESSION_CHECKS), "the session checks are frozen");
expect(Object.isFrozen(STRIPE_SESSION_SANDBOX_NOTES), "the session notes are frozen");
expect(Object.isFrozen(STRIPE_WEBHOOK_RESEND_WINDOW_DAYS), "the resend windows are frozen");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Stripe Connect documentation gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Stripe Connect documentation gate passed: ${checks} checks (sources on Stripe's own host, the documented Accounts v2 rule, the published Stripe-Signature scheme verified and refused, the capability and requirement vocabularies, the charge-type facts, the five step sandbox cycle, the honest partial status, and a record that cannot be inflated to verified)\n`,
);
