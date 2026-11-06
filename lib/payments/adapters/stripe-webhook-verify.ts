// path: lib/payments/adapters/stripe-webhook-verify.ts

/**
 * The gate for STEP 164's webhook receiver: a delivery is verified against the company's signing secret
 * before anything in it is read, and one event is applied once however many times it is delivered.
 *
 * A check script, not a test file. It signs its own deliveries with the fixture's secret, so the verifier is
 * exercised end to end without a provider, and it records every way a delivery may be refused.
 */

import { createHmac } from "node:crypto";
import process from "node:process";
import { sealSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  configureStripeKeys,
  stripeWebhookSecretScope,
  type StripeConfigStore,
  type StripeKeyConfig,
} from "./stripe-client.ts";
import { stripeSignedPayload, STRIPE_PROVIDER_KEY } from "./stripe.ts";
import {
  classifyStripeEventType,
  InMemoryStripeWebhookStore,
  parseStripeEvent,
  receiveStripeWebhook,
  STRIPE_ACCOUNT_EVENT_TYPES,
  STRIPE_EVENT_PATTERN,
  STRIPE_EVENT_PREFIX,
  STRIPE_PAYMENT_EVENT_TYPES,
  STRIPE_SIGNATURE_HEADER_MAXIMUM_LENGTH,
  STRIPE_SIGNATURE_SCHEME,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  verifyStripeDelivery,
  type StripeWebhookEffect,
  type StripeWebhookOptions,
  type StripeWebhookRecord,
} from "./stripe-webhook.ts";

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
const sandboxSecret = fixture("sk_test", "51NxAbCdEfGhIjKlMnOpQrStUvWx");
const firstWebhookSecret = fixture("whsec", "abcdefghijklmnopqrstuvwx");
const secondWebhookSecret = fixture("whsec", "zyxwvutsrqponmlkjihgfedc");
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const NOW = 1_760_000_000_000;
const NOW_SECONDS = NOW / 1_000;
const EVENT_ID = "evt_1QxAbCdEfGhIjKlMnOpQ";
const SECOND_EVENT_ID = "evt_1QxAbCdEfGhIjKlMnOpR";
const PAYMENT_INTENT_ID = "pi_3QxAbCdEfGhIjKlMnOpQ";
const ACCOUNT_ID = "acct_1QxAbCdEfGhIjKlMnOpQ";

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const foreignKeyring: EncryptionKeyring = { primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") } };

class MemoryConfigStore implements StripeConfigStore {
  private readonly configs = new Map<string, StripeKeyConfig>();
  insert(config: StripeKeyConfig): void {
    this.configs.set(config.id, config);
  }
  findById(id: string): StripeKeyConfig | null {
    return this.configs.get(id) ?? null;
  }
  findByCompany(target: string): StripeKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === target);
  }
  findActiveByCompany(target: string): StripeKeyConfig | null {
    return this.findByCompany(target).find((config) => config.status === "active") ?? null;
  }
  findPendingByCompany(target: string): StripeKeyConfig | null {
    return this.findByCompany(target).find((config) => config.status === "pending_activation") ?? null;
  }
  save(next: StripeKeyConfig): boolean {
    this.configs.set(next.id, next);
    return true;
  }
}

type ConfigFixture = { readonly store: StripeConfigStore; readonly config: StripeKeyConfig };

function configStoreFor(
  options: { readonly webhookSecret?: string | null; readonly previousSecret?: string | null; readonly previousExpiresAt?: number | null; readonly targetCompanyId?: string } = {},
): ConfigFixture {
  const store = new MemoryConfigStore();
  const targetCompanyId = options.targetCompanyId ?? companyId;
  const configured = configureStripeKeys(
    {
      companyId: targetCompanyId,
      environment: "sandbox",
      secretKey: sandboxSecret,
      publishableKey: null,
      webhookSecret: options.webhookSecret === undefined ? firstWebhookSecret : options.webhookSecret,
    },
    { store, keyring, occurredAtEpochMs: NOW },
  );
  const base = configured.status === "configured" ? configured.config : null;
  if (base === null) throw new Error("the fixture configuration could not be built");

  const previousSecret = options.previousSecret === undefined ? null : options.previousSecret;
  const previousSealed =
    previousSecret === null
      ? null
      : sealSecret(keyring, previousSecret, { purpose: "secret", scope: stripeWebhookSecretScope(targetCompanyId) });

  const active: StripeKeyConfig = {
    ...base,
    previousWebhookSecretSealed: previousSealed,
    previousWebhookSecretExpiresAtEpochMs: previousSealed === null ? null : (options.previousExpiresAt ?? NOW + 86_400_000),
    status: "active",
    lastTest: { outcome: "connected", testedAtEpochMs: NOW, environment: "sandbox", apiVersionSent: base.apiVersion },
  };
  store.insert(active);
  return { store, config: active };
}

function sign(secret: string, timestamp: number, body: string): string {
  const signature = createHmac("sha256", secret).update(stripeSignedPayload(timestamp, body), "utf8").digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const succeededEvent = JSON.stringify({
  id: EVENT_ID,
  object: "event",
  type: "payment_intent.succeeded",
  api_version: "2026-10-28.preview",
  livemode: false,
  data: { object: { id: PAYMENT_INTENT_ID, object: "payment_intent", status: "succeeded", amount: 10000, currency: "usd-sentinel" } },
});

const processingEvent = JSON.stringify({
  id: SECOND_EVENT_ID,
  object: "event",
  type: "payment_intent.processing",
  api_version: "2026-10-28.preview",
  livemode: false,
  data: { object: { id: PAYMENT_INTENT_ID, object: "payment_intent", status: "processing" } },
});

const accountEvent = JSON.stringify({
  id: "evt_1QxAbCdEfGhIjKlMnOpS",
  object: "event",
  type: "account.updated",
  api_version: "2026-10-28.preview",
  livemode: false,
  data: { object: { id: ACCOUNT_ID, object: "account" } },
});

const ignoredEvent = JSON.stringify({
  id: "evt_1QxAbCdEfGhIjKlMnOpT",
  object: "event",
  type: "charge.refunded",
  api_version: "2026-10-28.preview",
  livemode: false,
  data: { object: { id: "ch_3QxAbCdEfGhIjKlMnOpQ", object: "charge", status: "succeeded" } },
});

/** One receiver wired with a fresh store and a recording effect. */
function receiverWith(
  options: Partial<StripeWebhookOptions> & { readonly configStore: StripeConfigStore },
): {
  readonly store: InMemoryStripeWebhookStore;
  readonly audits: string[];
  readonly effects: string[];
  readonly options: StripeWebhookOptions;
} {
  const store = new InMemoryStripeWebhookStore();
  const audits: string[] = [];
  const effects: string[] = [];
  const applyEffect = options.applyEvent;
  const receiverOptions: StripeWebhookOptions = {
    keyring,
    ...options,
    store: options.store ?? store,
    recordAudit: (entry) => audits.push(entry.action),
    ...(applyEffect === undefined
      ? {
          applyEvent: (event): StripeWebhookEffect => {
            effects.push(event.eventId);
            return { status: "applied", detail: null };
          },
        }
      : { applyEvent: applyEffect }),
  };
  return { store, audits, effects, options: receiverOptions };
}

/* ---- the documented vocabulary ---- */

expectEqual(STRIPE_EVENT_PREFIX, "evt_", "the documented event prefix is kept");
expect(STRIPE_EVENT_PATTERN.test(EVENT_ID), "a documented event id is accepted");
expect(STRIPE_EVENT_PATTERN.test("pi_3QxAbCdEfGhIjKlMnOpQ") === false, "an intent id is not an event id");
expectEqual(STRIPE_SIGNATURE_SCHEME, "v1", "the documented scheme is the one verified");
expectEqual(STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300, "the documented tolerance is kept");
expectEqual(STRIPE_SIGNATURE_HEADER_MAXIMUM_LENGTH, 1_024, "the header bound is recorded");
expectEqual(STRIPE_PROVIDER_KEY, "stripe", "the provider key is the registry key");
expect(Object.isFrozen(STRIPE_PAYMENT_EVENT_TYPES), "the payment event types are frozen");
expect(Object.isFrozen(STRIPE_ACCOUNT_EVENT_TYPES), "the account event types are frozen");
expectEqual(STRIPE_PAYMENT_EVENT_TYPES.length, 3, "the three documented payment events are handled");
expect(STRIPE_PAYMENT_EVENT_TYPES.includes("payment_intent.succeeded"), "the succeeded event is handled");
expect(STRIPE_PAYMENT_EVENT_TYPES.includes("payment_intent.processing"), "the processing event is handled");
expect(STRIPE_PAYMENT_EVENT_TYPES.includes("payment_intent.payment_failed"), "the failed event is handled");
expect(STRIPE_ACCOUNT_EVENT_TYPES.includes("account.updated"), "the account event is handled");

expectEqual(classifyStripeEventType("payment_intent.succeeded"), "payment", "a payment event is classified as payment");
expectEqual(classifyStripeEventType(" payment_intent.processing "), "payment", "the classification trims");
expectEqual(classifyStripeEventType("account.updated"), "account", "an account event is classified as account");
expectEqual(classifyStripeEventType("charge.refunded"), "ignored", "an unrecorded event is ignored");
expectEqual(classifyStripeEventType(""), "ignored", "an empty type is ignored");

/* ---- reading the envelope ---- */

const parsed = parseStripeEvent(succeededEvent);
expect(parsed !== null, "a documented envelope is parsed");
expectEqual(parsed?.eventId, EVENT_ID, "the event id is read");
expectEqual(parsed?.eventType, "payment_intent.succeeded", "the event type is read");
expectEqual(parsed?.objectId, PAYMENT_INTENT_ID, "the object id is read");
expectEqual(parsed?.objectStatus, "succeeded", "the object status is read");
expectEqual(parsed?.apiVersion, "2026-10-28.preview", "the API version is read");
expectEqual(parsed?.livemode, false, "the livemode flag is read");
expectEqual(parseStripeEvent("not json"), null, "an unparsable body is refused");
expectEqual(parseStripeEvent("[]"), null, "an array is not an envelope");
expectEqual(parseStripeEvent(JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: PAYMENT_INTENT_ID } } })), null, "an envelope without an id is refused");
expectEqual(parseStripeEvent(JSON.stringify({ id: EVENT_ID, data: { object: { id: PAYMENT_INTENT_ID } } })), null, "an envelope without a type is refused");
expectEqual(parseStripeEvent(JSON.stringify({ id: EVENT_ID, type: "payment_intent.succeeded" })), null, "an envelope without data is refused");
expectEqual(parseStripeEvent(JSON.stringify({ id: EVENT_ID, type: "payment_intent.succeeded", data: { object: {} } })), null, "an envelope whose object has no id is refused");
expectEqual(parseStripeEvent(JSON.stringify({ id: "evt_short", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } })), null, "an envelope with an unusable id is refused");

/* ---- the signature check ---- */

const deliveryAt = (body: string, timestamp: number, secret: string) => ({
  rawBody: body,
  signatureHeader: sign(secret, timestamp, body),
  nowSeconds: NOW_SECONDS,
  timestamp,
});

{
  const signed = deliveryAt(succeededEvent, NOW_SECONDS, firstWebhookSecret);
  const verdict = verifyStripeDelivery(signed.rawBody, signed.signatureHeader, { current: firstWebhookSecret, previous: null }, {
    nowSeconds: signed.nowSeconds,
  });
  expect(verdict.ok === true && verdict.secretRole === "current", "a delivery signed with the current secret is accepted");
}

{
  const signed = deliveryAt(succeededEvent, NOW_SECONDS, firstWebhookSecret);
  const verdict = verifyStripeDelivery(signed.rawBody, signed.signatureHeader, { current: secondWebhookSecret, previous: firstWebhookSecret }, {
    nowSeconds: signed.nowSeconds,
  });
  expect(verdict.ok === true && verdict.secretRole === "previous", "a delivery signed with the previous secret is accepted while the window is open");
}

{
  const signed = deliveryAt(succeededEvent, NOW_SECONDS, firstWebhookSecret);
  const verdict = verifyStripeDelivery(signed.rawBody, signed.signatureHeader, { current: firstWebhookSecret, previous: null }, {
    nowSeconds: signed.nowSeconds + STRIPE_WEBHOOK_TOLERANCE_SECONDS + 1,
  });
  expectEqual(verdict.ok, false, "a delivery older than the tolerance is refused");
}

{
  const signed = deliveryAt(succeededEvent, NOW_SECONDS, fixture("whsec", "anothersecretvalue12345"));
  const verdict = verifyStripeDelivery(signed.rawBody, signed.signatureHeader, { current: firstWebhookSecret, previous: null }, {
    nowSeconds: signed.nowSeconds,
  });
  expectEqual(verdict.ok, false, "a delivery signed with another secret is refused");
}

{
  const verdict = verifyStripeDelivery(succeededEvent, "not a signature", { current: firstWebhookSecret, previous: null }, {
    nowSeconds: NOW_SECONDS,
  });
  expectEqual(verdict.ok, false, "an unparsable header is refused");
}

{
  const verdict = verifyStripeDelivery(succeededEvent, sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), { current: null, previous: null }, {
    nowSeconds: NOW_SECONDS,
  });
  expect(verdict.ok === false && verdict.reason.includes("no webhook signing secret"), "no secret means a named refusal");
}

{
  const otherBody = `${succeededEvent} `;
  const verdict = verifyStripeDelivery(otherBody, sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), { current: firstWebhookSecret, previous: null }, {
    nowSeconds: NOW_SECONDS,
  });
  expectEqual(verdict.ok, false, "a body altered after signing is refused");
}

/* ---- receiving a delivery ---- */

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore });
  const result = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(result.status, 200, "a verified delivery is answered with 200");
  expect(result.status === 200 && result.body.duplicate === false, "the first delivery is not a duplicate");
  expect(result.status === 200 && result.body.eventId === EVENT_ID, "the answer names the event");
  expect(result.status === 200 && result.body.classification === "payment", "the answer names the classification");
  expect(result.status === 200 && result.secretRole === "current", "the answer names the secret that verified it");
  expectEqual(result.status === 200 ? result.record.status : "", "applied", "the record is settled as applied");
  expectEqual(receiver.effects.length, 1, "the effect runs once");
  expectEqual(receiver.audits.join(","), "stripe_webhook.received,stripe_webhook.applied", "the receipt and the effect are audited");
  expectEqual(result.status === 200 ? result.record.bodyFingerprint.length : 0, 64, "the record keeps a SHA-256 fingerprint of the body");
  expect(result.status === 200 && JSON.stringify(result.record).includes("v1=") === false, "the record never stores the signature header");
  expect(result.status === 200 && JSON.stringify(result.record).includes("whsec") === false, "the record never stores the secret");
  expect(result.status === 200 && JSON.stringify(result.record).includes("4242") === false, "the record never stores card-shaped detail");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore });
  const delivery = {
    companyId,
    rawBody: succeededEvent,
    signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent),
    receivedAtEpochMs: NOW,
  };
  const first = await receiveStripeWebhook(delivery, receiver.options);
  const second = await receiveStripeWebhook(delivery, receiver.options);
  expectEqual(first.status, 200, "the first delivery is accepted");
  expectEqual(second.status, 200, "a retry is answered with 200 so Stripe stops retrying");
  expect(second.status === 200 && second.body.duplicate === true, "the retry says it is a duplicate");
  expectEqual(receiver.effects.length, 1, "the effect never runs twice for one event");
  expectEqual(receiver.store.findByEventId(companyId, EVENT_ID)?.deliveryCount, 2, "both deliveries are counted");
  expectEqual(receiver.store.findByEventId(companyId, EVENT_ID)?.version, 3, "the record moved once per delivery and once for its settlement");
  expect(receiver.audits.join(",").endsWith("stripe_webhook.duplicate"), "the duplicate is audited");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore });
  await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  const other = await receiveStripeWebhook(
    { companyId, rawBody: processingEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, processingEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(other.status, 200, "a second, different event is accepted");
  expectEqual(receiver.effects.length, 2, "two events run two effects");
  expectEqual(other.status === 200 ? other.record.objectStatus : "", "processing", "the object status is kept");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({
    configStore,
    applyEvent: () => ({ status: "requires_sync", detail: "the account must be synchronised" }),
  });
  const result = await receiveStripeWebhook(
    { companyId, rawBody: accountEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, accountEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(result.status, 200, "an account event is accepted");
  expect(result.status === 200 && result.body.classification === "account", "the account event is classified");
  expectEqual(result.status === 200 ? result.record.status : "", "requires_sync", "an account event asks for a synchronisation");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore });
  const result = await receiveStripeWebhook(
    { companyId, rawBody: ignoredEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, ignoredEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(result.status, 200, "an unrecorded event is acknowledged");
  expect(result.status === 200 && result.body.classification === "ignored", "the unrecorded event is classified as ignored");
  expectEqual(result.status === 200 ? result.record.status : "", "acknowledged", "an ignored event is acknowledged, not applied");
  expectEqual(receiver.effects.length, 0, "an ignored event runs no effect");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore, applyEvent: () => ({ status: "skipped", detail: "the intent could not be read" }) });
  const result = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(result.status, 500, "an effect that did not apply is answered with 500 so Stripe retries");
  expect(result.status === 500 && result.body.error === "effect_failed", "the failure names the effect");
  expectEqual(receiver.store.findByEventId(companyId, EVENT_ID)?.status, "stored", "the record stays stored for the retry");
  expect(receiver.audits.includes("stripe_webhook.effect_failed"), "the failed effect is audited");
}

{
  const { store: configStore } = configStoreFor();
  let attempt = 0;
  const receiver = receiverWith({
    configStore,
    applyEvent: () => {
      attempt += 1;
      return attempt === 1 ? { status: "skipped", detail: "not yet" } : { status: "applied", detail: null };
    },
  });
  const delivery = {
    companyId,
    rawBody: succeededEvent,
    signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent),
    receivedAtEpochMs: NOW,
  };
  const failed = await receiveStripeWebhook(delivery, receiver.options);
  const retried = await receiveStripeWebhook(delivery, receiver.options);
  expectEqual(failed.status, 500, "the first attempt fails");
  expectEqual(retried.status, 200, "the retry succeeds");
  expect(retried.status === 200 && retried.body.duplicate === false, "a retry of an unsettled record is not a duplicate");
  expectEqual(attempt, 2, "the effect is retried for an unsettled record");
  expectEqual(receiver.store.findByEventId(companyId, EVENT_ID)?.status, "applied", "the retry settles the record");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({
    configStore,
    applyEvent: () => {
      throw new Error("boom");
    },
  });
  const result = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(result.status, 500, "an effect that throws is answered with 500");
  expectEqual(receiver.store.findByEventId(companyId, EVENT_ID)?.lastError, "the effect threw", "the recorded error is the effect's");
}

/* ---- the refusals ---- */

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore });
  const noCompany = await receiveStripeWebhook(
    { companyId: "  ", rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(noCompany.status, 400, "a delivery naming no company is refused");
  expect(noCompany.status === 400 && noCompany.body.error === "unknown_company", "the refusal names the company");

  const empty = await receiveStripeWebhook(
    { companyId, rawBody: "", signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, ""), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(empty.status, 400, "an empty body is refused");
  expect(empty.status === 400 && empty.body.error === "invalid_payload", "the empty body is named");

  const unsigned = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: null, receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(unsigned.status, 400, "a delivery with no signature is refused");
  expect(unsigned.status === 400 && unsigned.body.error === "missing_signature", "the missing signature is named");

  const oversizedHeader = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: `t=1,v1=${"a".repeat(2_000)}`, receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(oversizedHeader.status, 400, "an oversized signature header is refused");
  expect(oversizedHeader.status === 400 && oversizedHeader.body.error === "invalid_signature", "the oversized header is named");

  const wrongSecret = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(fixture("whsec", "wrongsecretvalue1234567"), NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(wrongSecret.status, 400, "a delivery signed with another secret is refused");
  expect(wrongSecret.status === 400 && wrongSecret.body.error === "invalid_signature", "the bad signature is named");
  expectEqual(receiver.effects.length, 0, "a refused delivery runs no effect");
  expectEqual(receiver.store.findByEventId(companyId, EVENT_ID), null, "a refused delivery is not stored");
  expect(receiver.audits.every((action) => action === "stripe_webhook.refused"), "every refusal is audited as a refusal");

  const stale = await receiveStripeWebhook(
    {
      companyId,
      rawBody: succeededEvent,
      signatureHeader: sign(firstWebhookSecret, NOW_SECONDS - 3_600, succeededEvent),
      receivedAtEpochMs: NOW,
    },
    receiver.options,
  );
  expectEqual(stale.status, 400, "a stale delivery is refused");
  expect(stale.status === 400 && stale.body.reason.length > 0, "the stale refusal carries a reason");

  const unparsable = await receiveStripeWebhook(
    { companyId, rawBody: "not json", signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, "not json"), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(unparsable.status, 400, "a verified but unparsable body is refused");
  expect(unparsable.status === 400 && unparsable.body.error === "invalid_payload", "the unparsable body is named");
}

{
  const store = new MemoryConfigStore();
  const receiver = receiverWith({ configStore: store });
  const unknown = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(unknown.status, 400, "a company with no configuration is refused");
  expect(unknown.status === 400 && unknown.body.error === "unknown_company", "the unknown company is named");
}

{
  const { store: configStore } = configStoreFor({ webhookSecret: null });
  const receiver = receiverWith({ configStore });
  const unconfigured = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(unconfigured.status, 400, "a configuration without a signing secret cannot accept a delivery");
  expect(unconfigured.status === 400 && unconfigured.body.error === "missing_signature", "the missing secret is named");
}

{
  const { store: configStore } = configStoreFor();
  const receiver = receiverWith({ configStore, keyring: foreignKeyring });
  const unopenable = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(unopenable.status, 500, "a keyring that cannot open the secret is an outage, not a bad delivery");
  expect(unopenable.status === 500 && unopenable.body.error === "webhook_secret_unavailable", "the outage is named");
  expectEqual(receiver.effects.length, 0, "an outage runs no effect");
}

{
  const { store: configStore } = configStoreFor({
    webhookSecret: secondWebhookSecret,
    previousSecret: firstWebhookSecret,
    previousExpiresAt: NOW + 3_600_000,
  });
  const receiver = receiverWith({ configStore });
  const signedByPrevious = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(signedByPrevious.status, 200, "a delivery signed by the previous secret is accepted while the window is open");
  expect(signedByPrevious.status === 200 && signedByPrevious.secretRole === "previous", "the answer names the previous secret");

  const signedByCurrent = await receiveStripeWebhook(
    { companyId, rawBody: processingEvent, signatureHeader: sign(secondWebhookSecret, NOW_SECONDS, processingEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(signedByCurrent.status, 200, "a delivery signed by the current secret is accepted after a roll");
}

{
  const { store: configStore } = configStoreFor({
    webhookSecret: secondWebhookSecret,
    previousSecret: firstWebhookSecret,
    previousExpiresAt: NOW - 1_000,
  });
  const receiver = receiverWith({ configStore });
  const expired = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(expired.status, 400, "a delivery signed by an expired previous secret is refused");
}

{
  const first = configStoreFor({ targetCompanyId: otherCompanyId });
  const receiver = receiverWith({ configStore: first.store });
  const crossCompany = await receiveStripeWebhook(
    { companyId, rawBody: succeededEvent, signatureHeader: sign(firstWebhookSecret, NOW_SECONDS, succeededEvent), receivedAtEpochMs: NOW },
    receiver.options,
  );
  expectEqual(crossCompany.status, 400, "one company's configuration never verifies another company's delivery");
}

/* ---- the store's invariants ---- */

{
  const store = new InMemoryStripeWebhookStore();
  const record: StripeWebhookRecord = {
    id: "0a1b2c3d-0000-4000-8000-000000000040",
    companyId,
    eventId: EVENT_ID,
    eventType: "payment_intent.succeeded",
    classification: "payment",
    objectId: PAYMENT_INTENT_ID,
    objectStatus: "succeeded",
    apiVersion: "2026-10-28.preview",
    livemode: false,
    bodyFingerprint: "a".repeat(64),
    signatureScheme: "v1",
    secretRole: "current",
    status: "stored",
    deliveryCount: 1,
    lastError: null,
    firstReceivedAtEpochMs: NOW,
    lastReceivedAtEpochMs: NOW,
    version: 1,
  };
  store.insert(record);
  expectThrows(() => store.insert(record), "the store refuses a duplicate record id");
  expectThrows(
    () => store.insert({ ...record, id: "0a1b2c3d-0000-4000-8000-000000000041" }),
    "the store refuses a second record for one event",
  );
  expectEqual(store.findByEventId(companyId, EVENT_ID)?.id, record.id, "the event id finds the record");
  expectEqual(store.findByEventId(otherCompanyId, EVENT_ID), null, "the event id is scoped to the company");
  expectEqual(store.save({ ...record, status: "applied", version: 2 }, 1), true, "a settlement is saved without a new delivery");
  expectEqual(store.save({ ...record, status: "applied", version: 2 }, 1), false, "a stale version is refused");
  expectEqual(store.save({ ...record, bodyFingerprint: "b".repeat(64), status: "applied", version: 3 }, 2), false, "the body fingerprint never changes");
  expectEqual(store.save({ ...record, eventId: SECOND_EVENT_ID, version: 3 }, 2), false, "the event id never changes");
  expectEqual(store.save({ ...record, deliveryCount: 3, status: "applied", version: 3 }, 2), false, "the delivery count moves one delivery at a time");
  expectThrows(
    () => store.insert({ ...record, id: "0a1b2c3d-0000-4000-8000-000000000042", eventId: SECOND_EVENT_ID, status: "applied" as const }),
    "the store refuses a record that starts settled",
  );
}

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Stripe Connect webhooks gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Stripe Connect webhooks gate passed: ${checks} checks (the documented t and v1 signature checked before anything in the body is read, the previous secret accepted only inside its overlap window, one event applied once however often it is delivered, a failed effect answered with 500 so the retry repeats it, and a record that keeps a fingerprint instead of the body)\n`,
);
