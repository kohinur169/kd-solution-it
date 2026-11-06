// path: lib/payments/adapters/rainforest-webhook.ts

/**
 * The Rainforest webhook receiver: signature first, then idempotency, then the platform's own reading of
 * the event.
 *
 * ## What section 6 and section 29 require
 *
 * Section 6 requires the sub-merchant flow to end in a decision the platform can act on, and Rainforest
 * sends that decision as a webhook. Section 29 requires every inbound callback to be authenticated and
 * to survive being delivered more than once. Rainforest's own documentation states both sides plainly:
 * "we sign each request with a signing key, unique to your account", and "Apply idempotency at the
 * component consuming the event … Webhooks are at-least-once … Use the resource ID and `event_type` as
 * the idempotency key."
 *
 * ## The honest state of the signature scheme
 *
 * The Webhooks page points at a "Verify Webhooks" recipe for the algorithm, and **that recipe is not
 * published** at any readable URL in this environment: `/recipes/verify-webhooks-1` answers *page not
 * found*, and the page's own copy carries only the recipe placeholder. So this file does not pretend to
 * know Rainforest's exact header names, signed content or digest encoding. It does these four things
 * instead:
 *
 * 1. The receiver **requires a verifier**. `receiveRainforestWebhook` refuses every delivery when none is
 *    configured, which is the only safe default while the scheme is unread — the same rule STEP 156's
 *    Payoneer notification handler applies.
 * 2. The header names, signed content and encoding are a **scheme value**, not constants baked into the
 *    comparison, so confirming the recipe changes one table and no logic.
 * 3. One reference verifier ships: `createRainforestHmacWebhookVerifier`, an HMAC-SHA256 verifier over a
 *    versioned `v1,<signature>` list with a timestamp tolerance, which is the shape Rainforest's delivery
 *    service uses. It is exported **with**
 *    `RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED = false` and
 *    `RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION`, and `PROVIDER_DOCS.md` records the open question.
 * 4. The verifier never decides what an event means. Verification happens before the body is parsed, and
 *    a refused delivery is answered without touching the store.
 *
 * ## Idempotency and trust
 *
 * The idempotency key is the documented pair: the resource id from `data` plus `event_type`. The first
 * delivery of a pair inserts a `received` row and applies the event; every later delivery of the same
 * pair is answered `duplicate` without applying anything, including a manual replay from the portal,
 * which the documentation says redelivers events you may already have processed.
 *
 * The event's own amount and status are **never** trusted as money. A `payin.*` delivery is applied by
 * re-reading the payin through STEP 159's `readRainforestPayin`, which is the only thing that can say
 * `succeeded`, and it says so only for the documented `SUCCEEDED` status at the amount and currency the
 * platform expects. A delivery the platform cannot tie to a known payin is `unknown`, never a success.
 *
 * ## What this file is not
 *
 * It is not a route: it answers `{httpStatus, body}` for the route STEP 183's handler mounts, and the
 * documented 15 second acknowledgement budget is a constant the route must honour. It stores no
 * payload: the record keeps a SHA-256 hash of the raw body, the documented pair and the outcome, never
 * the body and never the signature.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import {
  parseRainforestEventType,
  RAINFOREST_PROVIDER_KEY,
  rainforestApplicationOutcomeOf,
  rainforestMerchantBehaviourOf,
  sanitizeRainforestText,
  type RainforestEventType,
} from "./rainforest.ts";
import { RAINFOREST_MERCHANT_ID_PATTERN, RAINFOREST_APPLICATION_ID_PATTERN } from "./rainforest-merchant.ts";
import {
  RAINFOREST_PAYIN_ID_PATTERN,
  RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH,
  readRainforestPayin,
  type RainforestPaymentAuditEntry,
  type RainforestPaymentOptions,
} from "./rainforest-payment.ts";

/* -------------------------------------------------------------------------------------------------
 * Documented facts and the acknowledged gap
 * ---------------------------------------------------------------------------------------------- */

/** The documented acknowledgement budget: a `2XX` within 15 seconds or the retry schedule starts. */
export const RAINFOREST_WEBHOOK_ACK_SECONDS = 15;

/** The largest body this receiver reads. */
export const RAINFOREST_WEBHOOK_MAXIMUM_BODY_BYTES = 1_048_576;

/** The largest number of signature entries one delivery may carry. */
export const RAINFOREST_WEBHOOK_MAXIMUM_SIGNATURES = 5;

/** The longest provider text this file keeps. */
export const RAINFOREST_WEBHOOK_TEXT_MAXIMUM_LENGTH = RAINFOREST_PAYMENT_TEXT_MAXIMUM_LENGTH;

/** How far a delivery timestamp may be from the platform's clock, in seconds. */
export const RAINFOREST_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * False until the "Verify Webhooks" recipe is readable.
 *
 * The value is exported so that a screen, a health check or a reviewer can see the state of the
 * integration without reading this comment, and so that turning it to `true` is a deliberate act that
 * requires the recipe in hand.
 */
export const RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED = false;

/** What is assumed while the recipe is unread, in one sentence, for the record. */
export const RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION =
  "Assumed HMAC-SHA256 over a versioned signature list with a timestamp tolerance, because Rainforest's Verify Webhooks recipe is not published; confirm the header names, signed content and encoding before production.";

/** The resources this receiver acts on. Every other documented resource is acknowledged and ignored. */
export const RAINFOREST_WEBHOOK_HANDLED_RESOURCES: readonly string[] = deepFreeze([
  "merchant",
  "merchant_application",
  "payin",
]);

/* -------------------------------------------------------------------------------------------------
 * The signature scheme
 * ---------------------------------------------------------------------------------------------- */

/** How one delivery's signature is carried and computed. */
export interface RainforestHmacScheme {
  /** The header carrying the message id, which is part of the signed content. */
  readonly idHeader: string;
  /** The header carrying the attempt timestamp in Unix seconds. */
  readonly timestampHeader: string;
  /** The header carrying the space separated, versioned signature list. */
  readonly signatureHeader: string;
  /** What is signed, in order. */
  readonly signedContent: "id.timestamp.body" | "timestamp.body";
  /** How a signature is encoded. */
  readonly encoding: "base64" | "hex";
  /** The version prefix a signature entry carries, or null when entries are bare signatures. */
  readonly versionPrefix: string | null;
}

/** The scheme the reference verifier assumes, pending the recipe. */
export const RAINFOREST_WEBHOOK_REFERENCE_SCHEME: RainforestHmacScheme = deepFreeze({
  idHeader: "webhook-id",
  timestampHeader: "webhook-timestamp",
  signatureHeader: "webhook-signature",
  signedContent: "id.timestamp.body",
  encoding: "base64",
  versionPrefix: "v1",
});

/** One delivery as the route hands it to this file. The body must be the raw, unparsed text. */
export interface RainforestWebhookDelivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
  readonly receivedAtEpochMs?: number;
}

/** The verifier's answer. No detail ever contains the signature, the secret or the body. */
export type RainforestWebhookVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** The verifier port: the receiver trusts a delivery only when this says so. */
export type RainforestWebhookVerifier = (delivery: RainforestWebhookDelivery) => RainforestWebhookVerdict;

/** The verifier a platform without a readable scheme must use: it refuses everything. */
export const refuseRainforestWebhookVerifier: RainforestWebhookVerifier = () => ({
  ok: false,
  reason: "no Rainforest webhook verifier is configured, so no delivery can be trusted",
});

/** The options of the reference HMAC verifier. */
export interface RainforestHmacVerifierOptions {
  /** The portal's signing key. A `whsec_` prefix is decoded as a base64 key, as the delivery service does. */
  readonly secret: string;
  readonly scheme?: RainforestHmacScheme;
  readonly toleranceSeconds?: number;
  /** The clock, for the tolerance check. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
}

/** The header lookup a delivery offers, case insensitive, first value wins. */
function headerOf(delivery: RainforestWebhookDelivery, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(delivery.headers)) {
    if (key.trim().toLowerCase() === wanted && value !== undefined && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** The key bytes of a signing secret: `whsec_` bodies are base64, anything else is UTF-8. */
function signingKeyBytes(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (trimmed.length < 16) return null;
  if (trimmed.startsWith("whsec_")) {
    const body = trimmed.slice("whsec_".length);
    if (/^[A-Za-z0-9+/]{16,}={0,2}$/u.test(body) === false) return null;
    const decoded = Buffer.from(body, "base64");
    return decoded.length >= 16 ? decoded : null;
  }
  return Buffer.from(trimmed, "utf8");
}

/** Split a signature header into its candidate signatures, honouring the scheme's version prefix. */
export function rainforestSignatureCandidates(header: string, scheme: RainforestHmacScheme): readonly string[] {
  const candidates: string[] = [];
  for (const entry of header.split(" ")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    let value = trimmed;
    if (scheme.versionPrefix !== null) {
      const prefix = `${scheme.versionPrefix},`;
      if (trimmed.startsWith(prefix) === false) continue;
      value = trimmed.slice(prefix.length);
    }
    if (value.length === 0) continue;
    const shape =
      scheme.encoding === "base64" ? /^[A-Za-z0-9+/]{16,}={0,2}$/u : /^[0-9a-f]{16,128}$/u;
    if (shape.test(value) === false) continue;
    candidates.push(value);
    if (candidates.length >= RAINFOREST_WEBHOOK_MAXIMUM_SIGNATURES) break;
  }
  return candidates;
}

/**
 * The reference HMAC verifier.
 *
 * It checks the body size, the timestamp (a number within the tolerance of the clock, in both
 * directions, so a replayed old delivery and a delivery from a clock far in the future are both
 * refused), builds the signed content the scheme names, and compares every candidate signature with
 * `timingSafeEqual`. The raw body is used, never a re-serialised payload, because any re-encoding
 * changes the bytes the provider signed.
 */
export function createRainforestHmacWebhookVerifier(options: RainforestHmacVerifierOptions): RainforestWebhookVerifier {
  const scheme = options.scheme ?? RAINFOREST_WEBHOOK_REFERENCE_SCHEME;
  const tolerance = options.toleranceSeconds ?? RAINFOREST_WEBHOOK_TOLERANCE_SECONDS;
  const now = options.nowMs ?? (() => Date.now());
  const key = signingKeyBytes(options.secret);

  return (delivery) => {
    if (key === null) return { ok: false, reason: "the webhook signing key is missing or unusable" };
    if (delivery.rawBody.length === 0) return { ok: false, reason: "the delivery carries no body" };
    if (delivery.rawBody.length > RAINFOREST_WEBHOOK_MAXIMUM_BODY_BYTES) {
      return { ok: false, reason: "the delivery is larger than this receiver accepts" };
    }

    const timestamp = headerOf(delivery, scheme.timestampHeader);
    if (timestamp === null) return { ok: false, reason: `the delivery carries no ${scheme.timestampHeader} header` };
    if (/^[0-9]{1,12}$/u.test(timestamp) === false) {
      return { ok: false, reason: "the delivery timestamp is not a Unix timestamp" };
    }
    const seconds = Number(timestamp);
    const nowSeconds = Math.floor(now() / 1_000);
    if (Math.abs(nowSeconds - seconds) > tolerance) {
      return { ok: false, reason: "the delivery timestamp is outside the tolerance" };
    }

    const signatureHeader = headerOf(delivery, scheme.signatureHeader);
    if (signatureHeader === null) {
      return { ok: false, reason: `the delivery carries no ${scheme.signatureHeader} header` };
    }
    const candidates = rainforestSignatureCandidates(signatureHeader, scheme);
    if (candidates.length === 0) return { ok: false, reason: "the signature header carries no usable signature" };

    let signed: string;
    if (scheme.signedContent === "id.timestamp.body") {
      const id = headerOf(delivery, scheme.idHeader);
      if (id === null) return { ok: false, reason: `the delivery carries no ${scheme.idHeader} header` };
      signed = `${id}.${timestamp}.${delivery.rawBody}`;
    } else {
      signed = `${timestamp}.${delivery.rawBody}`;
    }

    const expected = createHmacDigest(key, signed, scheme.encoding);
    for (const candidate of candidates) {
      if (constantTimeEquals(expected, candidate)) return { ok: true };
    }
    return { ok: false, reason: "the signature does not match" };
  };
}

/** The HMAC of the signed content, in the scheme's encoding. */
function createHmacDigest(key: Buffer, signed: string, encoding: "base64" | "hex"): string {
  return createHmac("sha256", key).update(signed, "utf8").digest(encoding);
}

/** A constant time comparison that requires equal lengths: the platform's rule for every signature. */
function constantTimeEquals(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------------------------------
 * The delivery record
 * ---------------------------------------------------------------------------------------------- */

/** Where one delivery stands. */
export type RainforestDeliveryStatus = "received" | "processed" | "failed";

/** One delivery, keyed by the documented pair: the resource id and the event type. */
export interface RainforestWebhookDeliveryRecord {
  readonly id: string;
  readonly resourceId: string;
  readonly eventType: string;
  /** A SHA-256 hash of the raw body. The body itself is never stored. */
  readonly payloadHash: string;
  readonly status: RainforestDeliveryStatus;
  readonly receivedAtEpochMs: number;
  readonly processedAtEpochMs: number | null;
  readonly failureDetail: string | null;
  readonly version: number;
}

/** The only moves a delivery may make. */
export const DELIVERY_OUTCOMES: Readonly<Record<RainforestDeliveryStatus, readonly RainforestDeliveryStatus[]>> =
  deepFreeze({
    received: ["received", "processed", "failed"],
    processed: ["processed"],
    failed: ["failed"],
  });

/** What the store reads and writes. One row per documented pair. The store is the caller's. */
export interface RainforestWebhookDeliveryStore {
  insert(record: RainforestWebhookDeliveryRecord): void;
  findById(id: string): RainforestWebhookDeliveryRecord | null;
  /** The delivery this pair already holds, or null. */
  findByKey(resourceId: string, eventType: string): RainforestWebhookDeliveryRecord | null;
  save(next: RainforestWebhookDeliveryRecord, expectedVersion: number): boolean;
}

/** The in-memory store: one row per resource id and event type, version-guarded, forward-only. */
export class InMemoryRainforestWebhookDeliveryStore implements RainforestWebhookDeliveryStore {
  private readonly records = new Map<string, RainforestWebhookDeliveryRecord>();

  insert(record: RainforestWebhookDeliveryRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate delivery id");
    if (record.version !== 1) throw new Error("a new delivery starts at version 1");
    if (record.status !== "received") throw new Error("a new delivery is received");
    if (this.findByKey(record.resourceId, record.eventType) !== null) throw new Error("duplicate delivery");
    this.records.set(record.id, record);
  }

  findById(id: string): RainforestWebhookDeliveryRecord | null {
    return this.records.get(id) ?? null;
  }

  findByKey(resourceId: string, eventType: string): RainforestWebhookDeliveryRecord | null {
    return (
      [...this.records.values()].find(
        (record) => record.resourceId === resourceId && record.eventType === eventType,
      ) ?? null
    );
  }

  save(next: RainforestWebhookDeliveryRecord, expectedVersion: number): boolean {
    const current = this.records.get(next.id);
    if (current === undefined) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (current.resourceId !== next.resourceId || current.eventType !== next.eventType) return false;
    if (DELIVERY_OUTCOMES[current.status].includes(next.status) === false) return false;
    this.records.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Applying an event
 * ---------------------------------------------------------------------------------------------- */

/** What one delivery did to the platform, in the vocabulary the callers understand. */
export type RainforestWebhookEffect =
  | {
      readonly kind: "payin";
      readonly payinId: string;
      readonly outcome: "succeeded" | "pending" | "failed" | "unknown";
      readonly detail: string | null;
    }
  | {
      readonly kind: "merchant_application";
      readonly merchantId: string;
      readonly applicationId: string;
      readonly outcome: "approved" | "pending" | "declined" | "unknown";
    }
  | {
      readonly kind: "merchant";
      readonly merchantId: string;
      readonly behaviour: "processes" | "waiting" | "blocked" | "unknown";
    }
  | { readonly kind: "ignored"; readonly reason: string };

/** What receiving one delivery concluded. */
export type RainforestWebhookResult =
  | { readonly status: "refused"; readonly reason: string; readonly httpStatus: 400 | 401 }
  | { readonly status: "duplicate"; readonly deliveryId: string; readonly eventType: string }
  | {
      readonly status: "applied";
      readonly deliveryId: string;
      readonly eventType: string;
      readonly effect: RainforestWebhookEffect;
    }
  | { readonly status: "failed"; readonly reason: string; readonly httpStatus: 500 };

/** Where the platform's knowledge of a payin comes from: its own record, never the event's numbers. */
export interface RainforestPayinExpectation {
  readonly companyId: string;
  readonly expectedAmountMinor: bigint;
  readonly expectedCurrency: string;
}

/** Everything the receiver needs. */
export interface RainforestWebhookDeps {
  readonly verifier: RainforestWebhookVerifier;
  readonly store: RainforestWebhookDeliveryStore;
  /** The payment options of STEP 159: the key configuration, the keyring and the payment transport. */
  readonly payments: RainforestPaymentOptions;
  /** The platform's record of a payin, or null when it knows nothing about it. */
  readonly resolvePayinExpectation: (payinId: string) => RainforestPayinExpectation | null;
  /** The company a merchant belongs to, for the audit trail, when the platform knows it. */
  readonly companyOfMerchant?: (merchantId: string) => string | null;
  readonly recordAudit?: (entry: RainforestPaymentAuditEntry) => void;
}

/** The body of a delivery, parsed and checked. */
interface RainforestEnvelope {
  readonly event: RainforestEventType;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Read a `data` key as trimmed text, or null. */
function textOf(data: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Parse and check the documented envelope: a `data` object and an `event_type` string. */
function envelopeOf(rawBody: string): RainforestEnvelope | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Readonly<Record<string, unknown>>;
  const eventType = record["event_type"];
  const data = record["data"];
  if (typeof eventType !== "string") return null;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const event = parseRainforestEventType(eventType);
  if (event === null) return null;
  return { event, data: data as Readonly<Record<string, unknown>> };
}

/** The resource id of a payload, by the id field the documented resource uses. */
function resourceIdOf(data: Readonly<Record<string, unknown>>, resource: string): string | null {
  if (resource === "payin") {
    const payinId = textOf(data, "payin_id");
    return payinId !== null && RAINFOREST_PAYIN_ID_PATTERN.test(payinId) ? payinId : null;
  }
  if (resource === "merchant_application") {
    const applicationId = textOf(data, "merchant_application_id");
    return applicationId !== null && RAINFOREST_APPLICATION_ID_PATTERN.test(applicationId) ? applicationId : null;
  }
  const merchantId = textOf(data, "merchant_id");
  return merchantId !== null && RAINFOREST_MERCHANT_ID_PATTERN.test(merchantId) ? merchantId : null;
}

/** The SHA-256 hash of a raw body, in lowercase hex. */
export function rainforestPayloadHashOf(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** The audit entry of a delivery, with the outcome and no payload. */
function auditOf(
  deps: RainforestWebhookDeps,
  action: RainforestPaymentAuditEntry["action"],
  companyId: string,
  merchantId: string,
  providerObjectId: string | null,
  outcome: string,
): RainforestPaymentAuditEntry {
  return {
    action,
    providerKey: RAINFOREST_PROVIDER_KEY,
    companyId,
    merchantId,
    providerObjectId,
    outcome: sanitizeRainforestText(outcome).slice(0, RAINFOREST_WEBHOOK_TEXT_MAXIMUM_LENGTH),
    occurredAtEpochMs: deps.payments.occurredAtEpochMs,
  };
}

/**
 * Receive one delivery.
 *
 * The order is the whole point: verify, parse, dedupe, record, apply. A refused delivery is answered
 * before anything is stored; a duplicate is answered before anything is applied; and the applied effect
 * for a payin comes from a fresh read of the payin, never from the numbers in the event.
 */
export async function receiveRainforestWebhook(
  delivery: RainforestWebhookDelivery,
  deps: RainforestWebhookDeps,
): Promise<RainforestWebhookResult> {
  const verdict = deps.verifier(delivery);
  if (verdict.ok === false) {
    if (deps.recordAudit !== undefined) {
      deps.recordAudit(auditOf(deps, "webhook.rainforest_refused", "", "", null, verdict.reason));
    }
    return { status: "refused", reason: verdict.reason, httpStatus: 401 };
  }

  const envelope = envelopeOf(delivery.rawBody);
  if (envelope === null) {
    const reason = "the delivery is not a documented Rainforest event envelope";
    if (deps.recordAudit !== undefined) {
      deps.recordAudit(auditOf(deps, "webhook.rainforest_refused", "", "", null, reason));
    }
    return { status: "refused", reason, httpStatus: 400 };
  }

  if (deps.recordAudit !== undefined) {
    deps.recordAudit(
      auditOf(deps, "webhook.rainforest_verified", "", "", null, `verified ${envelope.event.eventType}`),
    );
  }

  if (RAINFOREST_WEBHOOK_HANDLED_RESOURCES.includes(envelope.event.resource) === false) {
    return {
      status: "applied",
      deliveryId: "",
      eventType: envelope.event.eventType,
      effect: {
        kind: "ignored",
        reason: `the ${envelope.event.resource} resource is not one this receiver acts on`,
      },
    };
  }

  const resourceId = resourceIdOf(envelope.data, envelope.event.resource);
  if (resourceId === null) {
    const reason = `the payload carries no ${envelope.event.resource} id`;
    if (deps.recordAudit !== undefined) {
      deps.recordAudit(auditOf(deps, "webhook.rainforest_refused", "", "", null, reason));
    }
    return { status: "refused", reason, httpStatus: 400 };
  }

  const existing = deps.store.findByKey(resourceId, envelope.event.eventType);
  if (existing !== null) {
    if (deps.recordAudit !== undefined) {
      deps.recordAudit(
        auditOf(deps, "webhook.rainforest_duplicate", "", "", resourceId, `duplicate ${envelope.event.eventType}`),
      );
    }
    return { status: "duplicate", deliveryId: existing.id, eventType: envelope.event.eventType };
  }

  const record: RainforestWebhookDeliveryRecord = {
    id: rainforestDeliveryIdOf(resourceId, envelope.event.eventType),
    resourceId,
    eventType: envelope.event.eventType,
    payloadHash: rainforestPayloadHashOf(delivery.rawBody),
    status: "received",
    receivedAtEpochMs: delivery.receivedAtEpochMs ?? deps.payments.occurredAtEpochMs,
    processedAtEpochMs: null,
    failureDetail: null,
    version: 1,
  };
  try {
    deps.store.insert(record);
  } catch {
    return { status: "failed", reason: "the delivery could not be recorded, so it was not applied", httpStatus: 500 };
  }

  let effect: RainforestWebhookEffect;
  try {
    effect = await applyRainforestEvent(envelope, resourceId, deps);
  } catch {
    deps.store.save(
      {
        ...record,
        status: "failed",
        failureDetail: "the event could not be applied",
        version: 2,
        processedAtEpochMs: deps.payments.occurredAtEpochMs,
      },
      1,
    );
    return { status: "failed", reason: "the event could not be applied, so the delivery may be retried", httpStatus: 500 };
  }

  deps.store.save(
    {
      ...record,
      status: "processed",
      processedAtEpochMs: deps.payments.occurredAtEpochMs,
      version: 2,
    },
    1,
  );

  if (deps.recordAudit !== undefined) {
    const companyId = effect.kind === "ignored" ? "" : (deps.companyOfMerchant?.(resourceId) ?? "");
    deps.recordAudit(
      auditOf(deps, "webhook.rainforest_applied", companyId, "", resourceId, `${envelope.event.eventType} ${effect.kind}`),
    );
  }

  return { status: "applied", deliveryId: record.id, eventType: envelope.event.eventType, effect };
}

/** The delivery id of the documented pair: stable, so a replay finds the same row. */
export function rainforestDeliveryIdOf(resourceId: string, eventType: string): string {
  return `rfdel_${createHash("sha256").update(`${resourceId}|${eventType}`, "utf8").digest("hex").slice(0, 32)}`;
}

/** Apply one verified, first-seen event. */
async function applyRainforestEvent(
  envelope: RainforestEnvelope,
  resourceId: string,
  deps: RainforestWebhookDeps,
): Promise<RainforestWebhookEffect> {
  const { event, data } = envelope;

  if (event.resource === "payin") {
    const expectation = deps.resolvePayinExpectation(resourceId);
    if (expectation === null) {
      return {
        kind: "payin",
        payinId: resourceId,
        outcome: "unknown",
        detail: "the platform has no record of this payin, so no outcome is claimed",
      };
    }
    const read = await readRainforestPayin(
      {
        companyId: expectation.companyId,
        payinId: resourceId,
        expectedAmountMinor: expectation.expectedAmountMinor,
        expectedCurrency: expectation.expectedCurrency,
      },
      deps.payments,
    );
    if (read.status === "succeeded") return { kind: "payin", payinId: resourceId, outcome: "succeeded", detail: null };
    if (read.status === "pending") {
      return { kind: "payin", payinId: resourceId, outcome: "pending", detail: read.payinStatus };
    }
    if (read.status === "failed") {
      return { kind: "payin", payinId: resourceId, outcome: "failed", detail: read.refusalCode };
    }
    return { kind: "payin", payinId: resourceId, outcome: "unknown", detail: read.reason };
  }

  if (event.resource === "merchant_application") {
    const merchantId = textOf(data, "merchant_id");
    const applicationId = resourceId;
    if (merchantId === null || RAINFOREST_MERCHANT_ID_PATTERN.test(merchantId) === false) {
      return { kind: "ignored", reason: "the merchant application event names no usable merchant" };
    }
    const status = textOf(data, "status");
    const decision = status === null ? null : rainforestApplicationOutcomeOf(status);
    return {
      kind: "merchant_application",
      merchantId,
      applicationId,
      outcome: decision ?? "unknown",
    };
  }

  const status = textOf(data, "status");
  const behaviour = status === null ? null : rainforestMerchantBehaviourOf(status);
  return { kind: "merchant", merchantId: resourceId, behaviour: behaviour ?? "unknown" };
}

/* -------------------------------------------------------------------------------------------------
 * The answer the route sends
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP answer a route sends for one delivery. */
export interface RainforestWebhookResponse {
  readonly httpStatus: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The answer a route sends.
 *
 * A `2XX` is the documented "successful response" and stops the retry schedule, so it is sent for a
 * duplicate as well as for an applied event, and it carries no payload detail. A refusal is `401` when
 * the signature failed and `400` when the envelope was unreadable, with the reason sanitised; a failure
 * to record or apply is `500` so that Rainforest retries. The route must answer within the documented
 * 15 seconds, which `RAINFOREST_WEBHOOK_ACK_SECONDS` records.
 */
export function rainforestWebhookResponseOf(result: RainforestWebhookResult): RainforestWebhookResponse {
  if (result.status === "refused") {
    return {
      httpStatus: result.httpStatus,
      body: { received: false, reason: sanitizeRainforestText(result.reason).slice(0, RAINFOREST_WEBHOOK_TEXT_MAXIMUM_LENGTH) },
    };
  }
  if (result.status === "failed") {
    return {
      httpStatus: result.httpStatus,
      body: { received: false, reason: "the delivery was not applied" },
    };
  }
  if (result.status === "duplicate") {
    return { httpStatus: 200, body: { received: true, duplicate: true } };
  }
  return { httpStatus: 200, body: { received: true } };
}
