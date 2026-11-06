// path: lib/payments/adapters/airwallex-webhook-verify.ts

/**
 * The gate for STEP 169's webhook half: receiving an Airwallex delivery.
 *
 * A check script, not a test file. It builds a real configuration with STEP 166's code — sealed secrets, a proven
 * connection test, an activation — signs raw bodies with STEP 165's own payload builder, and drives the receiver
 * through the documented answers and the ones that must never be trusted. No network call is made and no real
 * credential exists.
 */

import process from "node:process";
import { createHmac } from "node:crypto";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_DELIVERY_OUTCOMES,
  AIRWALLEX_WEBHOOK_ACCEPTED_STATUS,
  AIRWALLEX_WEBHOOK_FAILED_STATUS,
  AIRWALLEX_WEBHOOK_GROUP_KEYS,
  AIRWALLEX_WEBHOOK_GROUPS,
  AIRWALLEX_WEBHOOK_HEADERS,
  AIRWALLEX_WEBHOOK_MALFORMED_STATUS,
  AIRWALLEX_WEBHOOK_REFUSED_STATUS,
  AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH,
  InMemoryAirwallexWebhookDeliveryStore,
  airwallexEventGroupOf,
  airwallexEventIsSubscribed,
  airwallexPayloadHashOf,
  airwallexSubscribedEventNames,
  airwallexWebhookEffectOf,
  airwallexWebhookResponseOf,
  receiveAirwallexWebhook,
  transferStatusOfEventName,
  type AirwallexWebhookAuditEntry,
  type AirwallexWebhookDelivery,
  type AirwallexWebhookDeliveryRecord,
  type AirwallexWebhookDeps,
  type AirwallexWebhookResponse,
  type AirwallexWebhookResult,
} from "./airwallex-webhook.ts";
import {
  AIRWALLEX_EVENT_NAMES,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_TEST_SECRET_HEADER,
  AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES,
  airwallexSignaturePayload,
  parseAirwallexEvent,
  type AirwallexEventEnvelope,
} from "./airwallex.ts";
import {
  activateAirwallexConfig,
  configureAirwallexKeys,
  InMemoryAirwallexConfigStore,
  InMemoryAirwallexTokenCache,
  testAirwallexConnection,
  AIRWALLEX_LOGIN_PATH,
} from "./airwallex-client.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

/** Render any value for a failure message, including the bigint amounts this record shapes carry. */
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

/* ---- fixtures ---- */

const NOW = 1_760_000_000_000;
const timestampHeader = String(Math.floor(NOW / 1_000));
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const unconfiguredCompanyId = "9b2d3e4f-0000-4000-8000-000000000003";
const clientId = "cid_AbCd1234EfGh5678";
const apiKey = "key_ZzYyXx9876WwVvUuTtSsRrQq";
const accessToken = "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MjQwMDAwMDB9.c2lnbmF0dXJlLXZhbHVl";
const webhookSecret = "whsec_kd_airwallex_test_secret_0001";
const otherSecret = "whsec_kd_airwallex_test_secret_0002";
const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const otherKeyring: EncryptionKeyring = { primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") } };
const loginAnswer = JSON.stringify({ token: accessToken, expires_at: "2026-01-01T12:30:00+0000" });
const balancesAnswer = JSON.stringify([{ currency: "USD", available_amount: 1 }]);

const intentId = "int_KdPaymentIntent0001";
const transferId = "tra_KdPayout0000000001";
const attemptId = "att_KdPaymentAttempt0001";

const eventIdOf = (suffix: string): string => `evt_KdWebhook${suffix}`;

function intentBody(eventId: string, status: string | null, name = "payment_intent.succeeded"): string {
  return JSON.stringify({
    id: eventId,
    name,
    account_id: "acct_A1b2C3d4E5f6G7h8I9j0",
    org_id: "org_KdSolutionIt0001",
    data: { object: status === null ? { id: intentId } : { id: intentId, status } },
    created_at: "2026-01-01T12:00:00+0000",
    version: "2026-01-01",
  });
}

function attemptBody(eventId: string, status: string | null, name = "payment_attempt.authorized"): string {
  return JSON.stringify({
    id: eventId,
    name,
    data: { object: status === null ? { id: attemptId } : { id: attemptId, status } },
  });
}

function transferBody(eventId: string, status: string | null, name = "payout.transfer.paid"): string {
  return JSON.stringify({
    id: eventId,
    name,
    data: { object: status === null ? { id: transferId } : { id: transferId, status } },
    created_at: "2026-01-01T12:00:00+0000",
  });
}

/** An active configuration, optionally carrying a sealed webhook secret, built with STEP 166's own functions. */
async function activeConfigStore(secret: string | null, company = companyId): Promise<InMemoryAirwallexConfigStore> {
  const configStore = new InMemoryAirwallexConfigStore();
  const tokenCache = new InMemoryAirwallexTokenCache();
  const configured = configureAirwallexKeys(
    { companyId: company, environment: "sandbox", clientId, apiKey, webhookSecret: secret },
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
  return configStore;
}

function sign(rawBody: string, secret = webhookSecret, timestamp = timestampHeader): string {
  return createHmac("sha256", secret).update(airwallexSignaturePayload(timestamp, rawBody), "utf8").digest("hex");
}

function deliveryOf(rawBody: string, overrides: Partial<AirwallexWebhookDelivery> = {}): AirwallexWebhookDelivery {
  return {
    companyId,
    rawBody,
    timestamp: timestampHeader,
    signature: sign(rawBody),
    testSecret: null,
    ...overrides,
  };
}

interface Harness {
  readonly deps: AirwallexWebhookDeps;
  readonly store: InMemoryAirwallexWebhookDeliveryStore;
  readonly audits: AirwallexWebhookAuditEntry[];
  readonly configStore: InMemoryAirwallexConfigStore;
  receive(rawBody: string, overrides?: Partial<AirwallexWebhookDelivery>): Promise<AirwallexWebhookResult>;
}

interface HarnessOptions {
  readonly secret?: string | null;
  readonly ring?: EncryptionKeyring;
  readonly company?: string;
  readonly signedWith?: string;
}

async function harnessOf(options: HarnessOptions = {}): Promise<Harness> {
  const company = options.company ?? companyId;
  const secret = options.secret === undefined ? webhookSecret : options.secret;
  const signedWith = options.signedWith ?? secret ?? webhookSecret;
  const configStore = await activeConfigStore(secret, company);
  const store = new InMemoryAirwallexWebhookDeliveryStore();
  const audits: AirwallexWebhookAuditEntry[] = [];
  const deps: AirwallexWebhookDeps = {
    configStore,
    keyring: options.ring ?? keyring,
    store,
    nowEpochMs: NOW,
    recordAudit: (entry) => audits.push(entry),
  };
  return {
    deps,
    store,
    audits,
    configStore,
    receive: async (rawBody, overrides = {}) =>
      receiveAirwallexWebhook(
        deliveryOf(rawBody, { companyId: company, signature: sign(rawBody, signedWith), ...overrides }),
        deps,
      ),
  };
}

/* ---- the documented surface ---- */

async function checkSurface(): Promise<void> {
  expectEqual(AIRWALLEX_WEBHOOK_HEADERS.timestamp, "x-timestamp", "the timestamp header is documented");
  expectEqual(AIRWALLEX_WEBHOOK_HEADERS.signature, "x-signature", "the signature header is documented");
  expectEqual(AIRWALLEX_WEBHOOK_HEADERS.testSecret, "client-secret-key", "the simulated-delivery header is documented");
  expectEqual(AIRWALLEX_TEST_SECRET_HEADER, AIRWALLEX_WEBHOOK_HEADERS.testSecret, "the test header comes from STEP 165");
  expectEqual(AIRWALLEX_WEBHOOK_ACCEPTED_STATUS, 200, "the accepted answer is 200");
  expectEqual(AIRWALLEX_WEBHOOK_REFUSED_STATUS, 401, "an unverified delivery is answered 401");
  expectEqual(AIRWALLEX_WEBHOOK_MALFORMED_STATUS, 400, "an unparseable delivery is answered 400");
  expectEqual(AIRWALLEX_WEBHOOK_FAILED_STATUS, 500, "an unrecordable delivery is answered 500");
  expect(AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH >= 64, "the answer text is bounded");
  expectEqual(AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES, 1_048_576, "the body ceiling is STEP 165's");

  expectEqual(AIRWALLEX_WEBHOOK_GROUPS.length, 3, "three resource groups are received");
  expectEqual(AIRWALLEX_WEBHOOK_GROUPS[0], "payment_intent", "payment intents come first");
  expectEqual(AIRWALLEX_WEBHOOK_GROUPS[1], "payment_attempt", "payment attempts come second");
  expectEqual(AIRWALLEX_WEBHOOK_GROUPS[2], "transfer", "transfers come last");
  for (const group of AIRWALLEX_WEBHOOK_GROUPS) {
    const key = AIRWALLEX_WEBHOOK_GROUP_KEYS[group];
    expectEqual(typeof key, "string", `the group ${group} names a key in STEP 165's record`);
    const names = key === undefined ? undefined : AIRWALLEX_EVENT_NAMES[key];
    expect(Array.isArray(names), `the key ${key ?? ""} holds event names`);
  }

  const subscribed = airwallexSubscribedEventNames();
  const total = Object.values(AIRWALLEX_EVENT_NAMES).reduce((sum, names) => sum + names.length, 0);
  expectEqual(subscribed.length, total, "every documented event name is subscribed");
  expectEqual(new Set(subscribed).size, subscribed.length, "no event name is subscribed twice");
  expect(
    subscribed.every((name) => /^[a-z0-9_.]{3,64}$/u.test(name)),
    "every subscribed name is one the envelope parser accepts",
  );
  expect(subscribed.includes("payment_intent.succeeded"), "a payment intent event is subscribed");
  expect(subscribed.includes("payment_attempt.authorized"), "a payment attempt event is subscribed");
  expect(subscribed.includes("payout.transfer.paid"), "a transfer event is subscribed");
  expect(
    subscribed.some((name) => name.startsWith("account")) === false,
    "no account event is subscribed, because none was ever read",
  );
  expectEqual(Object.keys(AIRWALLEX_EVENT_NAMES).includes("account"), false, "the record holds no account group");

  expectEqual(airwallexEventGroupOf("payment_intent.succeeded"), "payment_intent", "an intent event is grouped");
  expectEqual(airwallexEventGroupOf("payment_attempt.authorized"), "payment_attempt", "an attempt event is grouped");
  expectEqual(airwallexEventGroupOf("payout.transfer.paid"), "transfer", "a transfer event is grouped");
  expectEqual(airwallexEventGroupOf(" account.updated "), null, "an unsubscribed name is not grouped");
  expectEqual(airwallexEventGroupOf("payment_intent.updated"), "payment_intent", "an intent update is grouped");
  expectEqual(airwallexEventIsSubscribed("payment_intent.succeeded"), true, "the receiver recognises a subscribed name");
  expectEqual(airwallexEventIsSubscribed("account.updated"), false, "the receiver refuses an unsubscribed name");
  expectEqual(airwallexEventIsSubscribed("payment_attempt.authorization_failed"), true, "a failed attempt is subscribed");

  expectEqual(transferStatusOfEventName("payout.transfer.in_approval"), "IN_APPROVAL", "the approval event names its status");
  expectEqual(transferStatusOfEventName("payout.transfer.paid"), "PAID", "the paid event names its status");
  expectEqual(transferStatusOfEventName("payout.transfer.cancelled"), "CANCELLED", "the cancelled event names its status");
  expectEqual(transferStatusOfEventName("payment_intent.succeeded"), null, "a payment event's suffix names no transfer status");
  expectEqual(transferStatusOfEventName("payout.transfer.mystery"), null, "an undocumented suffix names nothing");
}

/* ---- the envelope and what an event means ---- */

async function checkEffects(): Promise<void> {
  const paid = intentBody(eventIdOf("01"), "SUCCEEDED");
  const envelope = parseAirwallexEvent(paid);
  expect(envelope !== null, "a documented envelope parses");
  if (envelope === null) throw new Error("the intent fixture did not parse");

  const parsed: AirwallexEventEnvelope = envelope;
  expectEqual(parsed.eventId, eventIdOf("01"), "the event id is read");
  expectEqual(parsed.name, "payment_intent.succeeded", "the event name is read");
  expectEqual(parsed.objectId, intentId, "the object id is read from data.object");
  expectEqual(parsed.objectStatus, "SUCCEEDED", "the object status is read from data.object");
  expectEqual(parsed.accountId, "acct_A1b2C3d4E5f6G7h8I9j0", "the account id is read");

  const paymentEffect = airwallexWebhookEffectOf(parsed);
  expectEqual(paymentEffect.kind, "payment", "an intent event is a payment effect");
  if (paymentEffect.kind === "payment") {
    expectEqual(paymentEffect.paymentIntentId, intentId, "the effect carries the intent id");
    expectEqual(paymentEffect.providerStatus, "SUCCEEDED", "the effect carries the provider status");
    expectEqual(paymentEffect.outcome, "paid", "a SUCCEEDED intent is paid");
  }

  const cancelled = airwallexWebhookEffectOf(parseAirwallexEvent(intentBody(eventIdOf("02"), "CANCELLED")) ?? parsed);
  expectEqual(cancelled.kind, "payment", "a cancelled intent is still a payment effect");
  if (cancelled.kind === "payment") expectEqual(cancelled.outcome, "failed", "a CANCELLED intent is a failure");
  expectEqual(cancelled.kind === "payment" && cancelled.outcome === "paid", false, "a cancelled intent is never paid");

  const pending = airwallexWebhookEffectOf(parseAirwallexEvent(intentBody(eventIdOf("03"), "PENDING")) ?? parsed);
  if (pending.kind === "payment") expectEqual(pending.outcome, "pending", "a pending intent is in flight");

  const stateless = airwallexWebhookEffectOf(
    parseAirwallexEvent(intentBody(eventIdOf("04"), null, "payment_intent.updated")) ?? parsed,
  );
  if (stateless.kind === "payment") {
    expectEqual(stateless.providerStatus, null, "an object without a status carries none");
    expectEqual(stateless.outcome, "unknown", "an object without a status is never paid");
  }

  const idless = airwallexWebhookEffectOf({
    ...parsed,
    objectId: null,
  });
  expectEqual(idless.kind, "ignored", "an intent event without an object id is ignored");
  if (idless.kind === "ignored") expect(idless.reason.length > 0, "the ignored effect says why");

  const attempt = airwallexWebhookEffectOf(parseAirwallexEvent(attemptBody(eventIdOf("05"), "AUTHORIZED")) ?? parsed);
  expectEqual(attempt.kind, "payment_attempt", "an attempt event is a payment attempt effect");
  if (attempt.kind === "payment_attempt") {
    expectEqual(attempt.paymentAttemptId, attemptId, "the attempt effect carries the attempt id");
    expectEqual(attempt.eventName, "payment_attempt.authorized", "the attempt effect carries its event name");
    expectEqual(attempt.outcome, "unknown", "AUTHORIZED is not a documented attempt status, so it is not paid");
  }
  const abandoned = airwallexWebhookEffectOf(
    parseAirwallexEvent(attemptBody(eventIdOf("06"), "FAILED", "payment_attempt.authorization_failed")) ?? parsed,
  );
  if (abandoned.kind === "payment_attempt") {
    expectEqual(abandoned.outcome, "failed", "an attempt the record maps to failure is a failure");
    expectEqual(abandoned.eventName, "payment_attempt.authorization_failed", "the failing attempt keeps its name");
  }

  const transferPaid = airwallexWebhookEffectOf(parseAirwallexEvent(transferBody(eventIdOf("07"), "PAID")) ?? parsed);
  expectEqual(transferPaid.kind, "transfer", "a transfer event is a transfer effect");
  if (transferPaid.kind === "transfer") {
    expectEqual(transferPaid.transferId, transferId, "the transfer effect carries the transfer id");
    expectEqual(transferPaid.outcome, "paid", "a PAID transfer reads paid");
    expectEqual(transferPaid.provisional, true, "a PAID transfer is provisional");
    expectEqual(airwallexWebhookEffectOf(parsed).kind === "transfer", false, "an intent event is not a transfer");
  }

  const derived = airwallexWebhookEffectOf(
    parseAirwallexEvent(transferBody(eventIdOf("08"), null, "payout.transfer.paid")) ?? parsed,
  );
  if (derived.kind === "transfer") {
    expectEqual(derived.providerStatus, "PAID", "an object without a status takes the event name's status");
    expectEqual(derived.outcome, "paid", "the derived status is paid");
    expectEqual(derived.provisional, true, "the derived paid status is still provisional");
  }

  const processing = airwallexWebhookEffectOf(
    parseAirwallexEvent(transferBody(eventIdOf("09"), null, "payout.transfer.processing")) ?? parsed,
  );
  if (processing.kind === "transfer") {
    expectEqual(processing.outcome, "in_flight", "a processing transfer is in flight");
    expectEqual(processing.provisional, false, "an in-flight transfer is not a provisional payment");
  }

  const cancelledTransfer = airwallexWebhookEffectOf(
    parseAirwallexEvent(transferBody(eventIdOf("10"), "CANCELLED", "payout.transfer.cancelled")) ?? parsed,
  );
  if (cancelledTransfer.kind === "transfer") {
    expectEqual(cancelledTransfer.outcome, "cancelled", "a CANCELLED transfer is cancelled");
    expectEqual(cancelledTransfer.outcome === "paid", false, "a cancelled transfer is never paid");
  }

  const unknownStatus = airwallexWebhookEffectOf(parseAirwallexEvent(transferBody(eventIdOf("11"), "MYSTERY")) ?? parsed);
  if (unknownStatus.kind === "transfer") {
    expectEqual(unknownStatus.outcome, "unknown", "an undocumented status is unknown, never paid");
    expectEqual(unknownStatus.provisional, false, "an unknown status claims no provisional payment");
  }

  const transferIdless = airwallexWebhookEffectOf({
    ...parsed,
    name: "payout.transfer.paid",
    objectId: null,
  });
  expectEqual(transferIdless.kind, "ignored", "a transfer event without an object id is ignored");

  const unsubscribed = airwallexWebhookEffectOf({ ...parsed, name: "account.updated" });
  expectEqual(unsubscribed.kind, "ignored", "an unsubscribed event name is ignored");
  if (unsubscribed.kind === "ignored") {
    expect(unsubscribed.reason.includes("not one this subscription records"), "the ignored effect names the reason");
  }

  const accountStatus = airwallexWebhookEffectOf({ ...parsed, name: "account.status_changed", objectStatus: "ACTIVE" });
  expectEqual(accountStatus.kind, "ignored", "no account event has an effect, because no account name was recorded");
}

/* ---- receiving: what is applied ---- */

async function checkApplied(): Promise<void> {
  const harness = await harnessOf();

  const body = transferBody(eventIdOf("20"), "PAID");
  const applied = await harness.receive(body);
  expectEqual(applied.status, "applied", "a signed, documented delivery is applied");
  expectEqual(applied.httpStatus, 200, "an applied delivery is answered 200");
  if (applied.status !== "applied") throw new Error("the first delivery was not applied");
  expectEqual(applied.eventId, eventIdOf("20"), "the result names the event id");
  expectEqual(applied.eventName, "payout.transfer.paid", "the result names the event name");
  expectEqual(applied.effect.kind, "transfer", "the result carries the transfer effect");
  expectEqual(applied.isTest, false, "a delivery without the test header is not a test");
  expectEqual(applied.deliveryId.length, 32, "the record id is a bounded digest");

  const record = harness.store.findByEventId(companyId, eventIdOf("20"));
  expect(record !== null, "the delivery is recorded");
  if (record === null) throw new Error("the delivery record was not written");
  expectEqual(record.status, "processed", "an applied delivery is processed");
  expectEqual(record.version, 2, "the settled record moved once");
  expectEqual(record.processedAtEpochMs, NOW, "the processed time is the receiver's clock");
  expectEqual(record.eventName, "payout.transfer.paid", "the record keeps the event name");
  expectEqual(record.objectId, transferId, "the record keeps the object id");
  expectEqual(record.payloadHash, airwallexPayloadHashOf(body), "the record keeps the body's digest");
  expectEqual(record.payloadHash.length, 64, "the body digest is a full SHA-256");
  expectEqual(record.isTest, false, "the record is not a test");
  expectEqual(record.failureDetail, null, "an applied delivery carries no failure detail");

  const keys = Object.keys(record).sort();
  expectEqual(
    keys.join(","),
    [
      "companyId",
      "eventId",
      "eventName",
      "failureDetail",
      "id",
      "isTest",
      "objectId",
      "payloadHash",
      "processedAtEpochMs",
      "receivedAtEpochMs",
      "status",
      "version",
    ]
      .sort()
      .join(","),
    "the record keeps a digest and never the body",
  );
  expect(asText(record).includes("payout.transfer.paid"), "the record keeps the event name only, not the payload");
  expect(asText(record).includes(intentId) === false, "the record carries no resource body");

  expectEqual(harness.audits.length, 1, "one applied delivery writes one audit entry");
  expectEqual(harness.audits[0]?.action, "airwallex_webhook.received", "the audit names receipt");
  expectEqual(harness.audits[0]?.providerKey, AIRWALLEX_PROVIDER_KEY, "the audit names the provider");
  expectEqual(harness.audits[0]?.outcome, "transfer", "the audit names the effect kind");
  expectEqual(harness.audits[0]?.eventId, eventIdOf("20"), "the audit names the event");
  expectEqual(harness.audits[0]?.occurredAtEpochMs, NOW, "the audit carries the receiver's clock");
  expect(asText(harness.audits).includes(webhookSecret) === false, "no audit entry carries the secret");
  expect(asText(harness.audits).includes(record.payloadHash) === false, "no audit entry carries the body digest");

  // A retried delivery is the normal case, not an error.
  const retried = await harness.receive(body);
  expectEqual(retried.status, "duplicate", "a retried delivery is a duplicate");
  expectEqual(retried.httpStatus, 200, "a duplicate is answered 200, so the provider stops retrying");
  expectEqual(harness.store.findByEventId(companyId, eventIdOf("20"))?.version, 2, "a duplicate changes nothing");
  expectEqual(harness.store.findByEventId(companyId, eventIdOf("20"))?.status, "processed", "a duplicate stays processed");
  expectEqual(harness.audits[harness.audits.length - 1]?.action, "airwallex_webhook.duplicate", "a duplicate is audited");

  const replayed = await harness.receive(transferBody(eventIdOf("20"), "FAILED", "payout.transfer.failed"));
  expectEqual(replayed.status, "duplicate", "the same event id with another body is still a duplicate");
  expectEqual(
    harness.store.findByEventId(companyId, eventIdOf("20"))?.payloadHash,
    airwallexPayloadHashOf(body),
    "the first delivery's digest is the one kept",
  );
  expectEqual(harness.store.findById(record.id)?.status, "processed", "the replayed body is never applied");

  // An unsubscribed event is acknowledged and recorded as ignored, so a retry argues duplicate rather than looping.
  const ignoredBody = intentBody(eventIdOf("21"), "SUCCEEDED", "account.updated");
  const ignored = await harness.receive(ignoredBody);
  expectEqual(ignored.status, "applied", "an unsubscribed event is still acknowledged");
  if (ignored.status === "applied") expectEqual(ignored.effect.kind, "ignored", "an unsubscribed event has no effect");
  const ignoredRecord = harness.store.findByEventId(companyId, eventIdOf("21"));
  expectEqual(ignoredRecord?.status, "ignored", "an ignored delivery is recorded as ignored");
  expect(ignoredRecord?.failureDetail !== null, "an ignored delivery records why");
  expectEqual(harness.audits[harness.audits.length - 1]?.action, "airwallex_webhook.ignored", "an ignored delivery is audited");
  expectEqual((await harness.receive(ignoredBody)).status, "duplicate", "an ignored delivery is deduplicated too");

  const idlessBody = intentBody(eventIdOf("22"), "SUCCEEDED");
  const idless: unknown = JSON.parse(idlessBody) as unknown;
  if (typeof idless === "object" && idless !== null) {
    (idless as Record<string, unknown>)["data"] = { object: { status: "SUCCEEDED" } };
  }
  const idlessResult = await harness.receive(JSON.stringify(idless));
  expectEqual(idlessResult.status, "applied", "a signed event that cannot be routed is acknowledged");
  if (idlessResult.status === "applied") expectEqual(idlessResult.effect.kind, "ignored", "it has no effect");

  // The simulated-delivery header labels a test; it never stands in for a signature.
  const testHarness = await harnessOf();
  const testBody = intentBody(eventIdOf("23"), "SUCCEEDED");
  const asTest = await testHarness.receive(testBody, { testSecret: "simulated-delivery-secret" });
  expectEqual(asTest.status, "applied", "a correctly signed test delivery is applied");
  if (asTest.status === "applied") expectEqual(asTest.isTest, true, "the test header labels the delivery");
  expectEqual(testHarness.store.findByEventId(companyId, eventIdOf("23"))?.isTest, true, "the record keeps the test label");
  const forgedTest = await testHarness.receive(testBody, {
    testSecret: "simulated-delivery-secret",
    signature: sign("another body"),
  });
  expectEqual(forgedTest.status, "refused", "the test header does not replace a signature");
  expectEqual(forgedTest.httpStatus, 401, "a forged test delivery is answered 401");
}

/* ---- receiving: what is refused ---- */

async function checkRefused(): Promise<void> {
  const harness = await harnessOf();
  const body = intentBody(eventIdOf("30"), "SUCCEEDED");

  const forged = await harness.receive(body, { signature: sign(body, otherSecret) });
  expectEqual(forged.status, "refused", "a delivery signed with another secret is refused");
  expectEqual(forged.httpStatus, 401, "an unverified delivery is answered 401");
  expectEqual(harness.store.findByEventId(companyId, eventIdOf("30")), null, "a refused delivery is never recorded");
  expectEqual(harness.audits[harness.audits.length - 1]?.action, "airwallex_webhook.refused", "a refusal is audited");
  expectEqual(harness.audits[harness.audits.length - 1]?.eventId, null, "a refusal names no event, because none was read");

  const tampered = await harness.receive(body.replace("\"SUCCEEDED\"", "\"PENDING\""), { signature: sign(body) });
  expectEqual(tampered.status, "refused", "a body changed after signing is refused");
  expectEqual(harness.store.findByEventId(companyId, eventIdOf("30")), null, "a tampered delivery is never recorded");

  const uppercase = await harness.receive(body, { signature: sign(body).toUpperCase() });
  expectEqual(uppercase.status, "refused", "an upper-case digest is not the documented signature form");

  const noSignature = await harness.receive(body, { signature: null });
  expectEqual(noSignature.status, "refused", "a delivery without a signature is refused");
  const noTimestamp = await harness.receive(body, { timestamp: null });
  expectEqual(noTimestamp.status, "refused", "a delivery without a timestamp is refused");
  const badTimestamp = await harness.receive(body, { timestamp: "yesterday" });
  expectEqual(badTimestamp.status, "refused", "a timestamp that is not a Unix time is refused");

  const staleTimestamp = String(Math.floor(NOW / 1_000) - 900);
  const stale = await harness.receive(body, { timestamp: staleTimestamp, signature: sign(body, webhookSecret, staleTimestamp) });
  expectEqual(stale.status, "refused", "a delivery outside the timestamp tolerance is refused");
  if (stale.status === "refused") expect(stale.reason.includes("tolerance"), "the refusal names the tolerance");

  const empty = await harness.receive("");
  expectEqual(empty.status, "refused", "an empty delivery is refused");
  expectEqual(empty.httpStatus, 400, "an empty delivery is answered 400");

  const oversizedBody = `{"id":"${eventIdOf("31")}","name":"payment_intent.succeeded","pad":"${"x".repeat(AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES)}"}`;
  const oversized = await harness.receive(oversizedBody);
  expectEqual(oversized.status, "refused", "an oversized delivery is refused");
  expectEqual(oversized.httpStatus, 400, "an oversized delivery is answered 400");
  expectEqual(harness.store.findByEventId(companyId, eventIdOf("31")), null, "an oversized delivery is never recorded");

  const unparseable = await harness.receive("{not json at all");
  expectEqual(unparseable.status, "refused", "a signed but unreadable body is refused");
  expectEqual(unparseable.httpStatus, 400, "an unreadable body is answered 400, so it is not retried");

  const noEventId = await harness.receive(JSON.stringify({ name: "payment_intent.succeeded", data: {} }));
  expectEqual(noEventId.status, "refused", "an envelope without an evt_ id is refused");
  expectEqual(noEventId.httpStatus, 400, "an envelope without an id is answered 400");

  const shortEventId = await harness.receive(JSON.stringify({ id: "evt_1", name: "payment_intent.succeeded", data: {} }));
  expectEqual(shortEventId.status, "refused", "an envelope with a truncated event id is refused");

  const noName = await harness.receive(JSON.stringify({ id: eventIdOf("32"), data: {} }));
  expectEqual(noName.status, "refused", "an envelope without a name is refused");

  expectEqual(harness.store.findByEventId(companyId, eventIdOf("32")), null, "no refused delivery wrote a record");
  expect(harness.audits.every((entry) => entry.action !== "airwallex_webhook.received"), "no refusal was audited as receipt");
}

/* ---- receiving: what cannot be recorded ---- */

async function checkFailed(): Promise<void> {
  const unconfigured = await harnessOf();
  const orphan = await receiveAirwallexWebhook(deliveryOf(intentBody(eventIdOf("40"), "SUCCEEDED"), { companyId: unconfiguredCompanyId }), unconfigured.deps);
  expectEqual(orphan.status, "failed", "a company with no configuration cannot be verified");
  expectEqual(orphan.httpStatus, 500, "an unverifiable delivery is answered 500, so it is retried");

  const secretless = await harnessOf({ secret: null, company: otherCompanyId });
  const nosSecret = await secretless.receive(intentBody(eventIdOf("41"), "SUCCEEDED"));
  expectEqual(nosSecret.status, "failed", "a company without a signing secret cannot be verified");
  expectEqual(nosSecret.httpStatus, 500, "a missing secret is answered 500, not 200");
  if (nosSecret.status === "failed") expect(nosSecret.reason.includes("signing secret"), "the failure names the missing secret");
  expectEqual(secretless.store.findByEventId(otherCompanyId, eventIdOf("41")), null, "nothing is recorded without a secret");

  const wrongRing = await harnessOf({ ring: otherKeyring });
  const unopenable = await wrongRing.receive(intentBody(eventIdOf("42"), "SUCCEEDED"));
  expectEqual(unopenable.status, "failed", "a secret sealed under another keyring cannot be opened");
  if (unopenable.status === "failed") expect(unopenable.reason.includes("cannot be opened"), "the failure names the keyring");
  expectEqual(wrongRing.store.findByEventId(companyId, eventIdOf("42")), null, "nothing is recorded when the secret is unreadable");

  const refusingStore: InMemoryAirwallexWebhookDeliveryStore = new InMemoryAirwallexWebhookDeliveryStore();
  refusingStore.insert = () => {
    throw new Error("the table refused the row");
  };
  const audits: AirwallexWebhookAuditEntry[] = [];
  const refusingDeps: AirwallexWebhookDeps = {
    configStore: await activeConfigStore(webhookSecret),
    keyring,
    store: refusingStore,
    nowEpochMs: NOW,
    recordAudit: (entry) => audits.push(entry),
  };
  const notRecorded = await receiveAirwallexWebhook(deliveryOf(intentBody(eventIdOf("43"), "SUCCEEDED")), refusingDeps);
  expectEqual(notRecorded.status, "failed", "a delivery the store refused is a failure");
  expectEqual(notRecorded.httpStatus, 500, "an unrecorded delivery is answered 500");
  if (notRecorded.status === "failed") expect(notRecorded.reason.includes("retried"), "the failure asks for a retry");
  expectEqual(audits[audits.length - 1]?.action, "airwallex_webhook.failed", "an unrecorded delivery is audited as failed");

  const movingStore = new InMemoryAirwallexWebhookDeliveryStore();
  movingStore.save = () => false;
  const movingDeps: AirwallexWebhookDeps = {
    configStore: await activeConfigStore(webhookSecret),
    keyring,
    store: movingStore,
    nowEpochMs: NOW,
  };
  const notSettled = await receiveAirwallexWebhook(deliveryOf(intentBody(eventIdOf("44"), "SUCCEEDED")), movingDeps);
  expectEqual(notSettled.status, "failed", "a delivery that moved while settling is a failure");
  if (notSettled.status === "failed") expect(notSettled.reason.includes("moved"), "the failure names the move");
  expectEqual(movingStore.findByEventId(companyId, eventIdOf("44"))?.status, "received", "the unsettled row stays received");
}

/* ---- the answers ---- */

async function checkResponses(): Promise<void> {
  const harness = await harnessOf();
  const applied = await harness.receive(transferBody(eventIdOf("50"), "PAID"));
  const appliedResponse: AirwallexWebhookResponse = airwallexWebhookResponseOf(applied);
  expectEqual(appliedResponse.httpStatus, 200, "an applied delivery is answered 200");
  expectEqual(appliedResponse.retry, false, "an applied delivery asks for no retry");
  expect(appliedResponse.body.length <= AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH, "the answer body is bounded");
  expect(appliedResponse.body.includes(eventIdOf("50")), "the answer names the event");
  expect(appliedResponse.body.includes("transfer"), "the answer names the effect");
  expect(appliedResponse.body.includes(webhookSecret) === false, "the answer never carries the secret");
  expect(appliedResponse.body.includes("signature") === false, "the answer never mentions the signature");

  const duplicate = airwallexWebhookResponseOf(await harness.receive(transferBody(eventIdOf("50"), "PAID")));
  expectEqual(duplicate.httpStatus, 200, "a duplicate is answered 200");
  expectEqual(duplicate.retry, false, "a duplicate asks for no retry");
  expect(duplicate.body.includes("duplicate"), "the answer says the delivery was seen before");

  const refused401 = airwallexWebhookResponseOf(
    await harness.receive(intentBody(eventIdOf("51"), "SUCCEEDED"), { signature: sign("other") }),
  );
  expectEqual(refused401.httpStatus, 401, "an unverified delivery is answered 401");
  expectEqual(refused401.retry, false, "an unverified delivery is not retried");
  expect(refused401.body.includes("received") && refused401.body.includes("false"), "the answer says it was not received");

  const refused400 = airwallexWebhookResponseOf(await harness.receive("{oops"));
  expectEqual(refused400.httpStatus, 400, "an unreadable delivery is answered 400");
  expectEqual(refused400.retry, false, "an unreadable delivery is not retried");

  const failed500 = airwallexWebhookResponseOf(
    await receiveAirwallexWebhook(deliveryOf(intentBody(eventIdOf("52"), "SUCCEEDED"), { companyId: unconfiguredCompanyId }), {
      configStore: harness.configStore,
      keyring,
      store: harness.store,
      nowEpochMs: NOW,
    }),
  );
  expectEqual(failed500.httpStatus, 500, "a delivery this platform could not record is answered 500");
  expectEqual(failed500.retry, true, "only a 500 asks the provider to retry");
  expect(failed500.body.includes("true"), "the answer asks for the retry in its body");

  const forbidden = airwallexWebhookResponseOf({
    status: "refused",
    reason: "the signature does not match",
    httpStatus: 401,
  });
  expectEqual(forbidden.httpStatus, 401, "a refusal keeps its own status");
  expect(forbidden.body.includes("does not match"), "a refusal explains itself");
  expect(forbidden.body.length <= AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH, "a refusal's reason is bounded");
}

/* ---- the store's invariants ---- */

async function checkStore(): Promise<void> {
  const store = new InMemoryAirwallexWebhookDeliveryStore();
  const base: AirwallexWebhookDeliveryRecord = {
    id: "record-0001",
    eventId: eventIdOf("60"),
    eventName: "payment_intent.succeeded",
    companyId,
    objectId: intentId,
    payloadHash: airwallexPayloadHashOf("{}"),
    isTest: false,
    status: "received",
    receivedAtEpochMs: NOW,
    processedAtEpochMs: null,
    failureDetail: null,
    version: 1,
  };
  store.insert(base);

  expectThrows(() => store.insert(base), "the same row id cannot be inserted twice");
  expectThrows(
    () => store.insert({ ...base, id: "record-0002" }),
    "the same event id cannot be inserted twice for one company",
  );
  expectThrows(
    () => store.insert({ ...base, id: "record-0003", status: "processed" }),
    "a new delivery cannot start settled",
  );
  expectThrows(
    () => store.insert({ ...base, id: "record-0004", version: 2 }),
    "a new delivery starts at version 1",
  );

  store.insert({ ...base, id: "record-0005", companyId: otherCompanyId });
  expectEqual(
    store.findByEventId(otherCompanyId, eventIdOf("60"))?.id,
    "record-0005",
    "the same event id may exist for another company",
  );

  expectEqual(store.save({ ...base, status: "processed", version: 2 }, 9), false, "a stale version cannot be saved");
  expectEqual(store.save({ ...base, status: "processed", version: 3 }, 1), false, "a version may only move by one");
  expectEqual(
    store.save({ ...base, payloadHash: airwallexPayloadHashOf("{\"other\":1}"), status: "processed", version: 2 }, 1),
    false,
    "a delivery's body digest never changes",
  );
  expectEqual(
    store.save({ ...base, eventName: "payment_intent.cancelled", status: "processed", version: 2 }, 1),
    false,
    "a delivery's event name never changes",
  );
  expectEqual(
    store.save({ ...base, objectId: transferId, status: "processed", version: 2 }, 1),
    false,
    "a delivery's object id never changes",
  );
  expectEqual(
    store.save({ ...base, companyId: otherCompanyId, status: "processed", version: 2 }, 1),
    false,
    "a delivery's company never changes",
  );

  expectEqual(store.save({ ...base, status: "processed", version: 2 }, 1), true, "a received delivery can be settled once");
  expectEqual(store.save({ ...base, status: "received", version: 3 }, 2), false, "a settled delivery never goes back");
  expectEqual(store.save({ ...base, status: "processed", version: 3 }, 2), true, "a settled delivery stays settled");
  expectEqual(store.save({ ...base, status: "ignored", version: 4 }, 3), false, "a processed delivery never becomes ignored");
  expectEqual(
    AIRWALLEX_DELIVERY_OUTCOMES.processed.join(","),
    "processed",
    "the outcome table makes processing final",
  );
  expectEqual(AIRWALLEX_DELIVERY_OUTCOMES.failed.join(","), "failed", "a failed delivery stays failed");
  expectEqual(AIRWALLEX_DELIVERY_OUTCOMES.received.length, 4, "a fresh delivery may go anywhere");
}

/* ---- running ---- */

await checkSurface();
await checkEffects();
await checkApplied();
await checkRefused();
await checkFailed();
await checkResponses();
await checkStore();

expectEqual(
  AIRWALLEX_WEBHOOK_HEADERS.testSecret,
  AIRWALLEX_TEST_SECRET_HEADER,
  "the test header is the one STEP 165 recorded",
);

if (failures.length > 0) {
  process.stderr.write(
    `payments Airwallex webhook gate failed: ${failures.length} of ${checks} checks did not hold\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Airwallex webhook gate passed: ${checks} checks (the signature is verified over x-timestamp plus the raw body before the body is parsed, an evt_ id is deduplicated so a retry applies nothing, a payment event is mapped by the Intent vocabulary and a transfer by the transfer one where PAID is paid and provisional, an unsubscribed name is ignored rather than guessed at, and 200 answers applied, ignored and duplicate while 401 refuses, 400 refuses permanently and only 500 asks for a retry)\n`,
);
