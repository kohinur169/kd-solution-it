// path: lib/payments/adapters/rainforest-webhook-verify.ts

/**
 * The gate for STEP 160's webhook half: the signature-verified, idempotent Rainforest receiver.
 *
 * A check script, not a test file. It signs its own deliveries with a secret built for the run, drives
 * the receiver through every documented resource, every refusal and every duplicate path, and then
 * fails and names every check that did not hold. No network call is made and no real signing key is
 * used.
 */

import process from "node:process";
import { createHmac } from "node:crypto";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  activateRainforestConfig,
  configureRainforestKeys,
  InMemoryRainforestConfigStore,
  testRainforestConnection,
} from "./rainforest-client.ts";
import { RAINFOREST_SANDBOX_API_BASE } from "./rainforest.ts";
import type { RainforestPaymentAuditEntry, RainforestPaymentTransport } from "./rainforest-payment.ts";
import {
  createRainforestHmacWebhookVerifier,
  DELIVERY_OUTCOMES,
  InMemoryRainforestWebhookDeliveryStore,
  RAINFOREST_WEBHOOK_ACK_SECONDS,
  RAINFOREST_WEBHOOK_HANDLED_RESOURCES,
  RAINFOREST_WEBHOOK_MAXIMUM_BODY_BYTES,
  RAINFOREST_WEBHOOK_MAXIMUM_SIGNATURES,
  RAINFOREST_WEBHOOK_REFERENCE_SCHEME,
  RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION,
  RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED,
  RAINFOREST_WEBHOOK_TOLERANCE_SECONDS,
  rainforestDeliveryIdOf,
  rainforestPayloadHashOf,
  rainforestSignatureCandidates,
  rainforestWebhookResponseOf,
  receiveRainforestWebhook,
  refuseRainforestWebhookVerifier,
  type RainforestPayinExpectation,
  type RainforestWebhookDelivery,
  type RainforestWebhookDeps,
} from "./rainforest-webhook.ts";

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

/* ---- fixtures ---- */

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const companyId = "018f2b8a-0000-4000-8000-00000000f001";
const sandboxKey = "sbx_apikey_GATEWEBHOOKSANDBOX0001ABCDEF";
const merchantId = "sbx_mid_2DrDFJPutxE5AIbJSopAnqniEbr";
const applicationId = "sbx_app_2DrD4yH7fH8aLIA7ZCnyVPcL9V9";
const payinId = "sbx_pyi_2DrDPKzdQypRudLd8DhQKZX27dA";

const secretBytes = Buffer.alloc(32, 5);
const signingSecret = `whsec_${secretBytes.toString("base64")}`;
const plainSecret = "gate-webhook-signing-secret-0001";

const nowMs = 1_800_000_000_000;
const nowSeconds = Math.floor(nowMs / 1_000);

/** The key the reference verifier derives from a `whsec_` secret. */
const secretKey = secretBytes;

/** A signed delivery in the reference scheme's shape. */
function signedDelivery(
  body: string,
  overrides: {
    secret?: string;
    key?: Buffer;
    atSeconds?: number;
    id?: string;
    tamperSignature?: boolean;
  } = {},
): RainforestWebhookDelivery {
  const at = overrides.atSeconds ?? nowSeconds;
  const id = overrides.id ?? "msg_2DrDPKzdQypRudLd8DhQKZX27dA";
  const key =
    overrides.key ??
    (overrides.secret === undefined
      ? secretKey
      : overrides.secret.startsWith("whsec_")
        ? Buffer.from(overrides.secret.slice("whsec_".length), "base64")
        : Buffer.from(overrides.secret, "utf8"));
  const signature = createHmac("sha256", key).update(`${id}.${at}.${body}`, "utf8").digest("base64");
  const signatureHeader = overrides.tamperSignature === true
    ? `v1,${createHmac("sha256", Buffer.alloc(32, 9)).update(`${id}.${at}.${body}`, "utf8").digest("base64")}`
    : `v1,${signature}`;
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": `${at}`,
      "webhook-signature": signatureHeader,
    },
    rawBody: body,
    receivedAtEpochMs: nowMs,
  };
}

/** The verifier of the run. */
const verifier = createRainforestHmacWebhookVerifier({ secret: signingSecret, nowMs: () => nowMs });

/** A store holding one active Rainforest configuration for the fixture company. */
async function activeStore() {
  const store = new InMemoryRainforestConfigStore();
  const configured = configureRainforestKeys(
    { companyId, environment: "sandbox", apiKey: sandboxKey },
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

/** A payment transport answering one fixed answer and recording the reads. */
function payinTransport(status: number, body: string) {
  const calls: { endpoint: string; method: string }[] = [];
  const transport: RainforestPaymentTransport = async (endpoint, method) => {
    calls.push({ endpoint, method });
    return { status, body };
  };
  return { transport, calls };
}

/** A documented payin read answer. */
function payinAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      payin_id: payinId,
      amount: 12_500,
      currency_code: "USD",
      status: "SUCCEEDED",
      method_type: "CARD",
      ...overrides,
    },
  });
}

/** One event body. */
function eventBody(eventType: string, data: Record<string, unknown>): string {
  return JSON.stringify({ data, event_type: eventType });
}

/** The receiver dependencies of the run. */
function depsOf(options: {
  transport?: RainforestPaymentTransport;
  store?: InMemoryRainforestWebhookDeliveryStore;
  audits?: RainforestPaymentAuditEntry[];
  expectation?: RainforestPayinExpectation | null;
  verifierOverride?: RainforestWebhookDeps["verifier"];
}) {
  const audits = options.audits;
  return {
    verifier: options.verifierOverride ?? verifier,
    store: options.store ?? new InMemoryRainforestWebhookDeliveryStore(),
    payments: {
      configStore: configStoreForRun,
      keyring,
      occurredAtEpochMs: nowMs,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    },
    resolvePayinExpectation: () =>
      options.expectation === undefined
        ? { companyId, expectedAmountMinor: 12_500n, expectedCurrency: "USD" }
        : options.expectation,
    companyOfMerchant: (id: string) => (id === merchantId ? companyId : null),
    ...(audits === undefined ? {} : { recordAudit: (entry: RainforestPaymentAuditEntry) => audits.push(entry) }),
  } satisfies RainforestWebhookDeps;
}

let configStoreForRun: Awaited<ReturnType<typeof activeStore>>;

/* ------------------------------------------------------------------------------------------------
 * Section 1: the documented facts and the acknowledged gap
 * --------------------------------------------------------------------------------------------- */

expectEqual(RAINFOREST_WEBHOOK_ACK_SECONDS, 15, "the documented 15 second acknowledgement budget is recorded");
expectEqual(RAINFOREST_WEBHOOK_MAXIMUM_BODY_BYTES, 1_048_576, "the receiver caps the body it reads");
expectEqual(RAINFOREST_WEBHOOK_MAXIMUM_SIGNATURES, 5, "the receiver caps the signatures it tries");
expectEqual(RAINFOREST_WEBHOOK_TOLERANCE_SECONDS, 300, "the receiver tolerates five minutes of clock skew, as the delivery service does");
expectEqual(RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED, false, "the signature scheme is recorded as unconfirmed");
expect(RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION.includes("Verify Webhooks"), "the assumption names the unread recipe");
expect(RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION.includes("HMAC-SHA256"), "the assumption names the digest");
expectEqual(RAINFOREST_WEBHOOK_HANDLED_RESOURCES.length, 3, "the receiver handles three documented resources");
expect(RAINFOREST_WEBHOOK_HANDLED_RESOURCES.includes("payin"), "the receiver handles payins");
expect(RAINFOREST_WEBHOOK_HANDLED_RESOURCES.includes("merchant"), "the receiver handles merchants");
expect(RAINFOREST_WEBHOOK_HANDLED_RESOURCES.includes("merchant_application"), "the receiver handles merchant applications");
expectEqual(RAINFOREST_WEBHOOK_REFERENCE_SCHEME.signedContent, "id.timestamp.body", "the reference scheme signs id, timestamp and body");
expectEqual(RAINFOREST_WEBHOOK_REFERENCE_SCHEME.encoding, "base64", "the reference scheme encodes signatures as base64");
expectEqual(RAINFOREST_WEBHOOK_REFERENCE_SCHEME.versionPrefix, "v1", "the reference scheme versions its signatures");
expect(Object.isFrozen(RAINFOREST_WEBHOOK_REFERENCE_SCHEME), "the reference scheme is frozen so a caller cannot edit it in place");
expect(Object.isFrozen(RAINFOREST_WEBHOOK_HANDLED_RESOURCES), "the handled resources are frozen");
expect(Object.isFrozen(DELIVERY_OUTCOMES), "the delivery outcome table is frozen");

/* ------------------------------------------------------------------------------------------------
 * Section 2: signature parsing and the reference verifier
 * --------------------------------------------------------------------------------------------- */

const candidateSignature = createHmac("sha256", secretKey).update("x", "utf8").digest("base64");
expectEqual(rainforestSignatureCandidates(`v1,${candidateSignature}`, RAINFOREST_WEBHOOK_REFERENCE_SCHEME).length, 1, "a versioned signature is parsed");
expectEqual(
  rainforestSignatureCandidates(`v1,${candidateSignature} v1,${candidateSignature}`, RAINFOREST_WEBHOOK_REFERENCE_SCHEME).length,
  2,
  "a rotation pair is parsed into two candidates",
);
expectEqual(rainforestSignatureCandidates("v2,abcdefghijklmnop", RAINFOREST_WEBHOOK_REFERENCE_SCHEME).length, 0, "a signature of another version is ignored");
expectEqual(rainforestSignatureCandidates("", RAINFOREST_WEBHOOK_REFERENCE_SCHEME).length, 0, "an empty signature header yields nothing");
expectEqual(rainforestSignatureCandidates("v1,short", RAINFOREST_WEBHOOK_REFERENCE_SCHEME).length, 0, "a signature of the wrong shape is ignored");
expectEqual(
  rainforestSignatureCandidates(candidateSignature, { ...RAINFOREST_WEBHOOK_REFERENCE_SCHEME, versionPrefix: null }).length,
  1,
  "a bare signature is parsed when the scheme has no version prefix",
);
expectEqual(
  rainforestSignatureCandidates("0123456789abcdef0123456789abcdef", { ...RAINFOREST_WEBHOOK_REFERENCE_SCHEME, versionPrefix: null, encoding: "hex" }).length,
  1,
  "a hex signature is parsed under a hex scheme",
);

{
  const body = eventBody("merchant_application.completed", { merchant_id: merchantId, merchant_application_id: applicationId, status: "COMPLETED" });
  expectEqual(verifier(signedDelivery(body)).ok, true, "a correctly signed delivery is accepted");
  expectEqual(verifier({ ...signedDelivery(body), rawBody: `${body} ` }).ok, false, "a body changed after signing is refused");
  expectEqual(verifier(signedDelivery(body, { tamperSignature: true })).ok, false, "a signature made with another key is refused");
  expectEqual(verifier(signedDelivery(body, { atSeconds: nowSeconds - 301 })).ok, false, "a delivery older than the tolerance is refused");
  expectEqual(verifier(signedDelivery(body, { atSeconds: nowSeconds + 301 })).ok, false, "a delivery from the future beyond the tolerance is refused");
  expectEqual(verifier(signedDelivery(body, { atSeconds: nowSeconds - 299 })).ok, true, "a delivery inside the tolerance is accepted");
  expectEqual(verifier(signedDelivery(body, { id: "msg_other" })).ok, true, "a delivery with another message id is still validly signed");
  expectEqual(verifier({ ...signedDelivery(body), rawBody: "" }).ok, false, "an empty body is refused");

  const missingTimestamp = { ...signedDelivery(body) };
  delete (missingTimestamp.headers as Record<string, string | undefined>)["webhook-timestamp"];
  expectEqual(verifier(missingTimestamp).ok, false, "a delivery without a timestamp is refused");

  const missingSignature = { ...signedDelivery(body) };
  delete (missingSignature.headers as Record<string, string | undefined>)["webhook-signature"];
  expectEqual(verifier(missingSignature).ok, false, "a delivery without a signature is refused");

  const missingId = { ...signedDelivery(body) };
  delete (missingId.headers as Record<string, string | undefined>)["webhook-id"];
  const missingIdVerdict = verifier(missingId);
  expectEqual(missingIdVerdict.ok, false, "a delivery without a message id is refused under the id-signed scheme");
  if (missingIdVerdict.ok === false) expect(missingIdVerdict.reason.includes("webhook-id"), "the refusal names the missing header");

  const badTimestamp = { ...signedDelivery(body), headers: { ...signedDelivery(body).headers, "webhook-timestamp": "soon" } };
  const badTimestampVerdict = verifier(badTimestamp);
  expectEqual(badTimestampVerdict.ok, false, "a non numeric timestamp is refused");
  if (badTimestampVerdict.ok === false) expect(badTimestampVerdict.reason.includes("not a Unix timestamp"), "the refusal says the timestamp is not a Unix one");

  expectEqual(verifier(signedDelivery(body, { secret: plainSecret })).ok, false, "a delivery signed with another secret is refused");
  const plainVerifier = createRainforestHmacWebhookVerifier({ secret: plainSecret, nowMs: () => nowMs });
  const plainDelivery = signedDelivery(body, { key: Buffer.from(plainSecret, "utf8") });
  expectEqual(plainVerifier(plainDelivery).ok, true, "a plain signing secret is used as UTF-8 bytes");

  const shortKeyVerifier = createRainforestHmacWebhookVerifier({ secret: "short", nowMs: () => nowMs });
  const shortVerdict = shortKeyVerifier(signedDelivery(body));
  expectEqual(shortVerdict.ok, false, "an unusable signing key refuses every delivery");
  if (shortVerdict.ok === false) expectEqual(shortVerdict.reason, "the webhook signing key is missing or unusable", "the refusal names the key");

  const hexVerifier = createRainforestHmacWebhookVerifier({
    secret: plainSecret,
    nowMs: () => nowMs,
    scheme: { ...RAINFOREST_WEBHOOK_REFERENCE_SCHEME, encoding: "hex", versionPrefix: null },
  });
  const hexSignature = createHmac("sha256", Buffer.from(plainSecret, "utf8")).update(`msg_2DrDPKzdQypRudLd8DhQKZX27dA.${nowSeconds}.${body}`, "utf8").digest("hex");
  expectEqual(
    hexVerifier({ headers: { "webhook-id": "msg_2DrDPKzdQypRudLd8DhQKZX27dA", "webhook-timestamp": `${nowSeconds}`, "webhook-signature": hexSignature }, rawBody: body }).ok,
    true,
    "a hex scheme verifies a hex signature",
  );

  const timestampOnlyScheme = { ...RAINFOREST_WEBHOOK_REFERENCE_SCHEME, signedContent: "timestamp.body" as const, versionPrefix: null };
  const timestampOnlyVerifier = createRainforestHmacWebhookVerifier({ secret: plainSecret, scheme: timestampOnlyScheme, nowMs: () => nowMs });
  const timestampOnlySignature = createHmac("sha256", Buffer.from(plainSecret, "utf8")).update(`${nowSeconds}.${body}`, "utf8").digest("base64");
  expectEqual(
    timestampOnlyVerifier({ headers: { "webhook-timestamp": `${nowSeconds}`, "webhook-signature": timestampOnlySignature }, rawBody: body }).ok,
    true,
    "a scheme without the message id verifies without that header",
  );

  expectEqual(verifier({ ...signedDelivery(body), headers: { ...signedDelivery(body).headers, "Webhook-Signature": signedDelivery(body).headers["webhook-signature"] } }).ok, true, "header names are matched case insensitively");
}

/* ------------------------------------------------------------------------------------------------
 * Section 3: refusals before anything is stored
 * --------------------------------------------------------------------------------------------- */

{
  configStoreForRun = await activeStore();

  const noVerifierStore = new InMemoryRainforestWebhookDeliveryStore();
  const noVerifierAudits: RainforestPaymentAuditEntry[] = [];
  const refusedByDefault = await receiveRainforestWebhook(
    signedDelivery(eventBody("merchant.active", { merchant_id: merchantId, status: "ACTIVE" })),
    depsOf({ store: noVerifierStore, audits: noVerifierAudits, verifierOverride: refuseRainforestWebhookVerifier }),
  );
  expectEqual(refusedByDefault.status, "refused", "a receiver without a verifier refuses every delivery");
  if (refusedByDefault.status === "refused") {
    expectEqual(refusedByDefault.httpStatus, 401, "a refusal is answered 401");
    expectEqual(
      refusedByDefault.reason,
      "no Rainforest webhook verifier is configured, so no delivery can be trusted",
      "the refusal names the missing verifier",
    );
  }
  expectEqual(noVerifierStore.findByKey(merchantId, "merchant.active"), null, "a refused delivery is not recorded");
  expectEqual(
    noVerifierAudits.filter((entry) => entry.action === "webhook.rainforest_refused").length,
    1,
    "a refused delivery is audited",
  );

  const badSignature = await receiveRainforestWebhook(
    signedDelivery(eventBody("merchant.active", { merchant_id: merchantId, status: "ACTIVE" }), { tamperSignature: true }),
    depsOf({}),
  );
  expectEqual(badSignature.status, "refused", "a delivery with a bad signature is refused");
  if (badSignature.status === "refused") {
    expectEqual(badSignature.httpStatus, 401, "a signature refusal is answered 401");
    expect(badSignature.reason.includes("signature does not match"), "the refusal names the signature");
  }

  for (const [label, body] of [
    ["not json", "not json"],
    ["no data", JSON.stringify({ event_type: "merchant.active" })],
    ["no event type", JSON.stringify({ data: { merchant_id: merchantId } })],
    ["an array", JSON.stringify([{ data: {}, event_type: "merchant.active" }])],
    ["an undocumented resource", eventBody("invoice.paid", { merchant_id: merchantId })],
    ["an undocumented status shape", eventBody("merchant", { merchant_id: merchantId })],
  ] as const) {
    const refused = await receiveRainforestWebhook(signedDelivery(body), depsOf({}));
    expectEqual(refused.status, "refused", `a delivery with ${label} is refused`);
    if (refused.status === "refused") expectEqual(refused.httpStatus, 400, `a delivery with ${label} is answered 400`);
  }

  const noId = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { amount: 12_500 })),
    depsOf({}),
  );
  expectEqual(noId.status, "refused", "a payin event without a payin id is refused");
  if (noId.status === "refused") {
    expectEqual(noId.reason, "the payload carries no payin id", "the refusal names the missing id");
  }

  const wrongIdShape = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: "pyi_../admin" })),
    depsOf({}),
  );
  expectEqual(wrongIdShape.status, "refused", "a payin id of the wrong shape is refused");
}

/* ------------------------------------------------------------------------------------------------
 * Section 4: a payin event is applied by re-reading the payin
 * --------------------------------------------------------------------------------------------- */

{
  configStoreForRun = await activeStore();

  const succeededRead = payinTransport(200, payinAnswer());
  const store = new InMemoryRainforestWebhookDeliveryStore();
  const audits: RainforestPaymentAuditEntry[] = [];
  const applied = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId, amount: 12_500, status: "SUCCEEDED" })),
    depsOf({ store, audits, transport: succeededRead.transport }),
  );
  expectEqual(applied.status, "applied", "a verified first delivery is applied");
  if (applied.status === "applied") {
    expectEqual(applied.eventType, "payin.succeeded", "the result carries the event type");
    expectEqual(applied.effect.kind, "payin", "the effect is a payin outcome");
    if (applied.effect.kind === "payin") {
      expectEqual(applied.effect.outcome, "succeeded", "the documented success status is a success");
      expectEqual(applied.effect.payinId, payinId, "the effect names the payin");
    }
  }
  expectEqual(succeededRead.calls.length, 1, "applying a payin event reads the payin once");
  expectEqual(succeededRead.calls[0]?.endpoint, `${RAINFOREST_SANDBOX_API_BASE}/v1/payins/${payinId}`, "the read uses the documented payin endpoint");
  expectEqual(succeededRead.calls[0]?.method, "GET", "the read is a get");

  const stored = store.findByKey(payinId, "payin.succeeded");
  expectEqual(stored?.status, "processed", "the delivery is recorded as processed");
  expectEqual(stored?.payloadHash, rainforestPayloadHashOf(JSON.stringify({ data: { payin_id: payinId, amount: 12_500, status: "SUCCEEDED" }, event_type: "payin.succeeded" })), "the delivery records a hash of the body");
  expectEqual(stored?.version, 2, "the delivery advanced one version");

  const verifications = audits.filter((entry) => entry.action === "webhook.rainforest_verified");
  const applications = audits.filter((entry) => entry.action === "webhook.rainforest_applied");
  expectEqual(verifications.length, 1, "a verified delivery is audited");
  expectEqual(applications.length, 1, "an applied delivery is audited");
  expectEqual(applications[0]?.providerObjectId, payinId, "the applied audit names the payin");
  expectEqual(applications[0]?.outcome.includes("payin"), true, "the applied audit records the effect");

  const replay = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId, amount: 12_500, status: "SUCCEEDED" })),
    depsOf({ store, audits, transport: succeededRead.transport }),
  );
  expectEqual(replay.status, "duplicate", "a redelivery of the same pair is a duplicate");
  if (replay.status === "duplicate") {
    expectEqual(replay.deliveryId, rainforestDeliveryIdOf(payinId, "payin.succeeded"), "the duplicate names the stored delivery");
  }
  expectEqual(succeededRead.calls.length, 1, "a duplicate reads nothing");
  expectEqual(
    audits.filter((entry) => entry.action === "webhook.rainforest_duplicate").length,
    1,
    "a duplicate is audited",
  );

  const manualReplay = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId, amount: 12_500, status: "SUCCEEDED" }), { id: "msg_replayed_in_portal" }),
    depsOf({ store, audits, transport: succeededRead.transport }),
  );
  expectEqual(manualReplay.status, "duplicate", "a portal replay with a new message id is the same duplicate");

  const laterEvent = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.failed", { payin_id: payinId, status: "FAILED", refusal_code: "DECLINED" })),
    depsOf({ store, audits, transport: payinTransport(200, payinAnswer({ status: "FAILED", refusal_code: "DECLINED" })).transport }),
  );
  expectEqual(laterEvent.status, "applied", "a different event type for the same payin is applied");
}

/* ---- every documented payin outcome, and the ones that stay unknown ---- */

{
  configStoreForRun = await activeStore();

  for (const [status, expected] of [
    ["PROCESSING", "pending"],
    ["AUTHORIZED", "pending"],
    ["IN_REVIEW", "pending"],
    ["FAILED", "failed"],
    ["RETURNED", "failed"],
    ["CANCELED", "failed"],
  ] as const) {
    const applied = await receiveRainforestWebhook(
      signedDelivery(eventBody(`payin.${status.toLowerCase()}`, { payin_id: payinId, status })),
      depsOf({ transport: payinTransport(200, payinAnswer({ status })).transport }),
    );
    expectEqual(applied.status, "applied", `a ${status} delivery is applied`);
    if (applied.status === "applied" && applied.effect.kind === "payin") {
      expectEqual(applied.effect.outcome, expected, `a ${status} payin reads as ${expected}`);
    }
  }

  const failedDetail = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.failed", { payin_id: payinId, status: "FAILED" })),
    depsOf({ transport: payinTransport(200, payinAnswer({ status: "FAILED", refusal_code: "INSUFFICIENT_FUNDS" })).transport }),
  );
  if (failedDetail.status === "applied" && failedDetail.effect.kind === "payin") {
    expectEqual(failedDetail.effect.detail, "INSUFFICIENT_FUNDS", "a failure carries the documented refusal code");
  } else {
    expectEqual(failedDetail.status, "applied", "a failed payin delivery is applied");
  }

  const amountMismatch = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId, amount: 99_999, status: "SUCCEEDED" })),
    depsOf({ transport: payinTransport(200, payinAnswer({ amount: 99_999 })).transport }),
  );
  expectEqual(amountMismatch.status, "applied", "a delivery whose read reports another amount is still applied as a conclusion");
  if (amountMismatch.status === "applied" && amountMismatch.effect.kind === "payin") {
    expectEqual(amountMismatch.effect.outcome, "unknown", "a read reporting another amount is never a success");
    expect(amountMismatch.effect.detail !== null && amountMismatch.effect.detail.includes("another amount"), "the detail names the amount mismatch");
  }

  const eventClaimsSuccess = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId, amount: 12_500, status: "SUCCEEDED" })),
    depsOf({ transport: payinTransport(200, payinAnswer({ status: "PROCESSING" })).transport }),
  );
  if (eventClaimsSuccess.status === "applied" && eventClaimsSuccess.effect.kind === "payin") {
    expectEqual(eventClaimsSuccess.effect.outcome, "pending", "the event's own claim never overrides the read");
  } else {
    expectEqual(eventClaimsSuccess.status, "applied", "a claim of success is applied as the read says");
  }

  const unknownToPlatform = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId, amount: 12_500 })),
    depsOf({ expectation: null, transport: payinTransport(200, payinAnswer()).transport }),
  );
  if (unknownToPlatform.status === "applied" && unknownToPlatform.effect.kind === "payin") {
    expectEqual(unknownToPlatform.effect.outcome, "unknown", "a payin the platform does not know is unknown");
    expectEqual(
      unknownToPlatform.effect.detail,
      "the platform has no record of this payin, so no outcome is claimed",
      "the detail says why nothing is claimed",
    );
  } else {
    expectEqual(unknownToPlatform.status, "applied", "an unknown payin is still applied as a conclusion");
  }

  const unreachable = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId })),
    depsOf({
      transport: async () => {
        throw new Error("network down");
      },
    }),
  );
  if (unreachable.status === "applied" && unreachable.effect.kind === "payin") {
    expectEqual(unreachable.effect.outcome, "unknown", "an unreachable read is unknown, never a failure");
  } else {
    expectEqual(unreachable.status, "applied", "an unreachable read is still applied as a conclusion");
  }

  const readRefused = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId })),
    depsOf({ transport: payinTransport(404, JSON.stringify({ errors: [{ message: "Payin not found" }] })).transport }),
  );
  if (readRefused.status === "applied" && readRefused.effect.kind === "payin") {
    expectEqual(readRefused.effect.outcome, "unknown", "a 404 read is unknown, never a failure");
  } else {
    expectEqual(readRefused.status, "applied", "a refused read is applied as a conclusion");
  }

  const undocumentedStatus = await receiveRainforestWebhook(
    signedDelivery(eventBody("payin.succeeded", { payin_id: payinId })),
    depsOf({ transport: payinTransport(200, payinAnswer({ status: "SETTLED" })).transport }),
  );
  if (undocumentedStatus.status === "applied" && undocumentedStatus.effect.kind === "payin") {
    expectEqual(undocumentedStatus.effect.outcome, "unknown", "an undocumented payin status is unknown");
  } else {
    expectEqual(undocumentedStatus.status, "applied", "an undocumented status is applied as a conclusion");
  }
}

/* ------------------------------------------------------------------------------------------------
 * Section 5: merchant applications and merchants
 * --------------------------------------------------------------------------------------------- */

{
  configStoreForRun = await activeStore();

  for (const [status, expected] of [
    ["COMPLETED", "approved"],
    ["DECLINED", "declined"],
    ["PROCESSING", "pending"],
    ["NEEDS_INFORMATION", "pending"],
    ["IN_REVIEW", "pending"],
    ["CREATED", "pending"],
    ["IN_PROGRESS", "pending"],
  ] as const) {
    const eventType = `merchant_application.${status.toLowerCase()}`;
    const applied = await receiveRainforestWebhook(
      signedDelivery(eventBody(eventType, { merchant_id: merchantId, merchant_application_id: applicationId, status })),
      depsOf({}),
    );
    expectEqual(applied.status, "applied", `a ${eventType} delivery is applied`);
    if (applied.status === "applied" && applied.effect.kind === "merchant_application") {
      expectEqual(applied.effect.outcome, expected, `a ${status} application reads as ${expected}`);
      expectEqual(applied.effect.merchantId, merchantId, `a ${status} application names the merchant`);
      expectEqual(applied.effect.applicationId, applicationId, `a ${status} application names the application`);
    }
  }

  for (const [status, expected] of [
    ["ACTIVE", "processes"],
    ["PENDING", "waiting"],
    ["ONBOARDING", "waiting"],
    ["SUSPENDED", "blocked"],
    ["DEACTIVATED", "blocked"],
    ["CANCELED", "blocked"],
  ] as const) {
    const applied = await receiveRainforestWebhook(
      signedDelivery(eventBody(`merchant.${status.toLowerCase()}`, { merchant_id: merchantId, status })),
      depsOf({}),
    );
    expectEqual(applied.status, "applied", `a merchant.${status.toLowerCase()} delivery is applied`);
    if (applied.status === "applied" && applied.effect.kind === "merchant") {
      expectEqual(applied.effect.behaviour, expected, `a ${status} merchant is ${expected}`);
    }
  }

  const undocumentedApplication = await receiveRainforestWebhook(
    signedDelivery(eventBody("merchant_application.decided", { merchant_id: merchantId, merchant_application_id: applicationId, status: "MAYBE" })),
    depsOf({}),
  );
  if (undocumentedApplication.status === "applied" && undocumentedApplication.effect.kind === "merchant_application") {
    expectEqual(undocumentedApplication.effect.outcome, "unknown", "an undocumented application status is unknown, never approved");
  } else {
    expectEqual(undocumentedApplication.status, "applied", "an undocumented application status is still applied as a conclusion");
  }

  const undocumentedMerchant = await receiveRainforestWebhook(
    signedDelivery(eventBody("merchant.settled", { merchant_id: merchantId, status: "SETTLED" })),
    depsOf({}),
  );
  if (undocumentedMerchant.status === "applied" && undocumentedMerchant.effect.kind === "merchant") {
    expectEqual(undocumentedMerchant.effect.behaviour, "unknown", "an undocumented merchant status is unknown");
  } else {
    expectEqual(undocumentedMerchant.status, "applied", "an undocumented merchant status is still applied as a conclusion");
  }

  const noMerchantOnApplication = await receiveRainforestWebhook(
    signedDelivery(eventBody("merchant_application.completed", { merchant_application_id: applicationId, status: "COMPLETED" })),
    depsOf({}),
  );
  if (noMerchantOnApplication.status === "applied") {
    expectEqual(noMerchantOnApplication.effect.kind, "ignored", "an application event naming no merchant is ignored");
  } else {
    expectEqual(noMerchantOnApplication.status, "applied", "an application event naming no merchant is acknowledged");
  }
}

/* ---- a documented resource this receiver does not act on is acknowledged and ignored ---- */

{
  configStoreForRun = await activeStore();

  const depositApplied = await receiveRainforestWebhook(
    signedDelivery(eventBody("deposit.succeeded", { deposit_id: "sbx_dep_1" })),
    depsOf({}),
  );
  expectEqual(depositApplied.status, "applied", "a deposit event is acknowledged");
  if (depositApplied.status === "applied") {
    expectEqual(depositApplied.effect.kind, "ignored", "a deposit event is ignored");
    if (depositApplied.effect.kind === "ignored") {
      expect(depositApplied.effect.reason.includes("deposit"), "the ignore reason names the resource");
    }
  }

  const exhausted = await receiveRainforestWebhook(
    signedDelivery(eventBody("message.attempt.exhausted", { message_id: "msg_1" })),
    depsOf({}),
  );
  expectEqual(exhausted.status, "applied", "an exhausted attempt notice is acknowledged");
}

/* ------------------------------------------------------------------------------------------------
 * Section 6: the delivery store's invariants
 * --------------------------------------------------------------------------------------------- */

{
  const store = new InMemoryRainforestWebhookDeliveryStore();
  const record = {
    id: "rfdel_0001",
    resourceId: payinId,
    eventType: "payin.succeeded",
    payloadHash: rainforestPayloadHashOf("{}"),
    status: "received" as const,
    receivedAtEpochMs: 1_000,
    processedAtEpochMs: null,
    failureDetail: null,
    version: 1,
  };
  store.insert(record);
  expectEqual(store.findByKey(payinId, "payin.succeeded")?.id, record.id, "the store reads back what it wrote");

  let threw = false;
  try {
    store.insert({ ...record, id: "rfdel_0002" });
  } catch {
    threw = true;
  }
  expectEqual(threw, true, "a second row for the same resource and event type is refused");

  threw = false;
  try {
    store.insert({ ...record, id: "rfdel_0003", resourceId: "sbx_pyi_other", status: "processed" });
  } catch {
    threw = true;
  }
  expectEqual(threw, true, "a new row cannot start outside received");

  expectEqual(store.save({ ...record, status: "processed", processedAtEpochMs: 2_000, version: 2 }, 2), false, "a stale version writes nothing");
  expectEqual(store.save({ ...record, status: "processed", processedAtEpochMs: 2_000, version: 2 }, 1), true, "a received row advances to processed");
  expectEqual(store.save({ ...record, status: "failed", version: 3 }, 2), false, "a processed row never becomes failed");
  expectEqual(DELIVERY_OUTCOMES["received"].includes("failed"), true, "a received row may fail");
  expectEqual(DELIVERY_OUTCOMES["failed"].length, 1, "a failed row is final in this store");

  const second = { ...record, id: "rfdel_0004", resourceId: "sbx_pyi_second", version: 1 };
  store.insert(second);
  expectEqual(store.save({ ...second, status: "failed", failureDetail: "the event could not be applied", version: 2 }, 1), true, "a received row may fail");
}

/* ------------------------------------------------------------------------------------------------
 * Section 7: the answer the route sends, and the security sweep
 * --------------------------------------------------------------------------------------------- */

{
  expectEqual(rainforestWebhookResponseOf({ status: "duplicate", deliveryId: "rfdel_1", eventType: "payin.succeeded" }).httpStatus, 200, "a duplicate is answered 200 so the retry schedule stops");
  expectEqual(rainforestWebhookResponseOf({ status: "duplicate", deliveryId: "rfdel_1", eventType: "payin.succeeded" }).body["duplicate"], true, "the duplicate answer says it was a duplicate");
  expectEqual(
    rainforestWebhookResponseOf({ status: "applied", deliveryId: "rfdel_1", eventType: "payin.succeeded", effect: { kind: "ignored", reason: "not handled" } }).httpStatus,
    200,
    "an applied event is answered 200",
  );
  expectEqual(
    rainforestWebhookResponseOf({ status: "refused", reason: "the signature does not match", httpStatus: 401 }).httpStatus,
    401,
    "a signature refusal is answered 401",
  );
  expectEqual(
    rainforestWebhookResponseOf({ status: "refused", reason: "not an envelope", httpStatus: 400 }).httpStatus,
    400,
    "an envelope refusal is answered 400",
  );
  expectEqual(
    rainforestWebhookResponseOf({ status: "failed", reason: "not applied", httpStatus: 500 }).httpStatus,
    500,
    "a failure to apply is answered 500 so Rainforest retries",
  );
  const sanitised = rainforestWebhookResponseOf({ status: "refused", reason: "<b>the signature does not match</b>", httpStatus: 401 });
  expectEqual(sanitised.body["reason"], "bthe signature does not match/b", "the refusal reason is sanitised of markup");
  expectEqual(sanitised.body["received"], false, "a refusal never claims the delivery was received");
}

{
  configStoreForRun = await activeStore();
  const body = eventBody("merchant.active", { merchant_id: merchantId, status: "ACTIVE" });
  const store = new InMemoryRainforestWebhookDeliveryStore();
  const audits: RainforestPaymentAuditEntry[] = [];
  const applied = await receiveRainforestWebhook(signedDelivery(body), depsOf({ store, audits }));
  expectEqual(applied.status, "applied", "the sweep delivery is applied");

  const storedDump = JSON.stringify(store.findById(applied.status === "applied" ? applied.deliveryId : ""));
  expect(storedDump.includes(body) === false, "the stored delivery carries no payload");
  expect(storedDump.includes("v1,") === false, "the stored delivery carries no signature");
  expect(storedDump.includes(signingSecret) === false, "the stored delivery carries no signing key");
  expect(storedDump.includes(plainSecret) === false, "the stored delivery carries no other key");
  expectEqual(rainforestPayloadHashOf(body).length, 64, "the payload hash is a SHA-256 hex digest");
  expectEqual(rainforestPayloadHashOf(body), rainforestPayloadHashOf(body), "the payload hash is deterministic");
  expect(rainforestPayloadHashOf(body) !== rainforestPayloadHashOf(`${body} `), "a one byte change changes the hash");

  const auditDump = JSON.stringify(audits);
  expect(auditDump.includes(body) === false, "the audit trail carries no payload");
  expect(auditDump.includes(signingSecret) === false, "the audit trail carries no signing key");
  expect(auditDump.includes(sandboxKey) === false, "the audit trail carries no API key");
  expectEqual(audits.filter((entry) => entry.action === "webhook.rainforest_verified").length, 1, "one verification is audited");
  const appliedAudits = audits.filter((entry) => entry.action === "webhook.rainforest_applied");
  expectEqual(appliedAudits.length, 1, "one application is audited");
  expectEqual(appliedAudits[0]?.companyId, companyId, "a merchant event names the company in the audit trail");

  expectEqual(rainforestDeliveryIdOf(payinId, "payin.succeeded"), rainforestDeliveryIdOf(payinId, "payin.succeeded"), "the delivery id of a pair is stable");
  expect(rainforestDeliveryIdOf(payinId, "payin.succeeded") !== rainforestDeliveryIdOf(payinId, "payin.failed"), "a different event type is a different delivery id");
  expect(rainforestDeliveryIdOf("a", "payin.succeeded") !== rainforestDeliveryIdOf("b", "payin.succeeded"), "a different resource is a different delivery id");
  expect(rainforestDeliveryIdOf(payinId, "payin.succeeded").startsWith("rfdel_"), "a delivery id carries a readable prefix");
}

/* ---- the verdict ---- */

const label =
  "payments Rainforest webhook gate passed: " +
  `${checks} checks (signature verification before anything is stored, HMAC-SHA256 with a timestamp tolerance over the ` +
  "raw body, the documented resource id plus event type as the idempotency key, a payin event applied only through a " +
  "fresh read, and an unreadable or unknown answer that never becomes a success)";

if (failures.length > 0) {
  process.stderr.write(`payments Rainforest webhook gate failed: ${failures.length} of ${checks} checks\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`${label}\n`);
