// path: lib/payments/adapters/stripe-webhook.ts

/**
 * The Stripe webhook receiver: signature-verified, idempotent, and honest about what it did.
 *
 * The destination-charges page says why this file exists at all: a charge is not confirmed by the browser
 * ("the customer could close the browser window or quit the app before the callback executes, and malicious
 * clients could manipulate the response"), so the platform listens for the documented events instead. It
 * names the three it expects an integration to handle — `payment_intent.succeeded`,
 * `payment_intent.processing` and `payment_intent.payment_failed` — and STEP 162/163's account work adds
 * `account.updated`, which is how a connected account's requirements change reach the platform.
 *
 * ## The shape of a correct receiver, from the documentation
 *
 * 1. **Raw body.** The signature is over the exact bytes Stripe sent, so this file takes a `string` body and
 *    never re-serialises it; any re-encoding changes what was signed.
 * 2. **Signature first.** Nothing in the body is trusted before `verifyStripeWebhookSignature` — STEP 161's
 *    `t` + `v1` HMAC with its documented tolerance — has accepted it against the current signing secret, or
 *    against the previous one while STEP 162's documented 24-hour overlap window is still open.
 * 3. **Idempotency by event id.** Stripe retries, and may deliver one event twice. The event's own `evt_…`
 *    id is the key: the record is written before the effect runs, and a second delivery of a settled record
 *    answers `200` without repeating the effect — which is also what stops Stripe retrying.
 * 4. **Not a body archive.** What is stored is the event id, its type, the object it names, the API version,
 *    and the SHA-256 of the body. The body itself, the signature and the signing secret are never stored.
 * 5. **A real answer code.** `400` for a body that will never verify or parse, `500` when this receiver is
 *    broken or an effect failed — both documented as the retryable case — and `200` only for a delivery that
 *    was verified and settled.
 *
 * ## What it does not do
 *
 * It does not settle a charge itself: it hands the verified event to the caller's `applyEvent`, which reads
 * the intent back from the API (`readStripePaymentIntent`) rather than trusting the event body's amounts.
 * It does not create ledger entries (STEP 132), post a payout (STEP 164's `stripe-payment.ts` does the
 * transfer on the platform's own schedule), and it is not a route: the route that calls it is a later STEP,
 * and this file therefore takes the raw body and the signature header and returns a status and a body.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES,
  STRIPE_PROVIDER_KEY,
  verifyStripeWebhookSignature,
  type StripeSignatureOptions,
} from "./stripe.ts";
import { stripeWebhookSecretsFor, type StripeConfigStore, type StripeKeyConfig } from "./stripe-client.ts";
import { stripeBodyFingerprint } from "./stripe-payment.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The documented event id prefix and shape. */
export const STRIPE_EVENT_PREFIX = "evt_";
export const STRIPE_EVENT_PATTERN = /^evt_[A-Za-z0-9]{8,64}$/u;

/** The only signature scheme the documentation signs a delivery with. */
export const STRIPE_SIGNATURE_SCHEME = "v1" as const;

/** How far a delivery's timestamp may be from now, in seconds — the tolerance STEP 161 documents. */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The longest signature header this receiver reads. */
export const STRIPE_SIGNATURE_HEADER_MAXIMUM_LENGTH = 1_024;

/** The documented event types this receiver acts on. */
export const STRIPE_PAYMENT_EVENT_TYPES: readonly string[] = deepFreeze([
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_intent.payment_failed",
]);

/** The documented event type that reports a connected account's changing requirements. */
export const STRIPE_ACCOUNT_EVENT_TYPES: readonly string[] = deepFreeze(["account.updated"]);

/** What an event is to this receiver. */
export type StripeWebhookClassification = "payment" | "account" | "ignored";

/** Classify one event type. An unrecorded type is `ignored`: it is stored and acknowledged, never acted on. */
export function classifyStripeEventType(eventType: string): StripeWebhookClassification {
  const normalized = eventType.trim();
  if (STRIPE_PAYMENT_EVENT_TYPES.includes(normalized)) return "payment";
  if (STRIPE_ACCOUNT_EVENT_TYPES.includes(normalized)) return "account";
  return "ignored";
}

/* -------------------------------------------------------------------------------------------------
 * The delivery and its record
 * ---------------------------------------------------------------------------------------------- */

/** One delivery as it arrives: the raw body, the signature header and the clock. */
export interface StripeWebhookDelivery {
  readonly companyId: string;
  /** The raw body, exactly as received. */
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly receivedAtEpochMs: number;
}

/** Whether a verified delivery is settled. */
export type StripeWebhookStatus = "stored" | "applied" | "acknowledged" | "requires_sync";

/** One stored event. Never carries the body, the signature or the signing secret. */
export interface StripeWebhookRecord {
  readonly id: string;
  readonly companyId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly classification: StripeWebhookClassification;
  readonly objectId: string;
  readonly objectStatus: string | null;
  readonly apiVersion: string | null;
  readonly livemode: boolean | null;
  readonly bodyFingerprint: string;
  readonly signatureScheme: typeof STRIPE_SIGNATURE_SCHEME;
  readonly secretRole: "current" | "previous";
  readonly status: StripeWebhookStatus;
  readonly deliveryCount: number;
  readonly lastError: string | null;
  readonly firstReceivedAtEpochMs: number;
  readonly lastReceivedAtEpochMs: number;
  readonly version: number;
}

/** The record store: one row per `(companyId, eventId)`. */
export interface StripeWebhookStore {
  insert(record: StripeWebhookRecord): void;
  findByEventId(companyId: string, eventId: string): StripeWebhookRecord | null;
  save(next: StripeWebhookRecord, expectedVersion: number): boolean;
}

/** The in-memory store, enforcing the invariants the real table must carry. */
export class InMemoryStripeWebhookStore implements StripeWebhookStore {
  private readonly records = new Map<string, StripeWebhookRecord>();

  insert(record: StripeWebhookRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate record id");
    if (record.version !== 1) throw new Error("a new record starts at version 1");
    if (record.status !== "stored") throw new Error("a new record is stored, and only a settled one leaves it");
    if (record.deliveryCount !== 1) throw new Error("a new record is the first delivery");
    if (this.findByEventId(record.companyId, record.eventId) !== null) {
      throw new Error("this event is already stored for this company");
    }
    this.records.set(record.id, record);
  }

  findByEventId(companyId: string, eventId: string): StripeWebhookRecord | null {
    return (
      [...this.records.values()].find((record) => record.companyId === companyId && record.eventId === eventId) ?? null
    );
  }

  save(next: StripeWebhookRecord, expectedVersion: number): boolean {
    const current = this.records.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.eventId !== next.eventId) return false;
    if (current.bodyFingerprint !== next.bodyFingerprint) return false;
    if (current.version !== expectedVersion || next.version !== expectedVersion + 1) return false;
    const deliveryAdvanced = next.deliveryCount === current.deliveryCount + 1;
    const deliveryUnchanged = next.deliveryCount === current.deliveryCount;
    if (deliveryAdvanced === false && deliveryUnchanged === false) return false;
    this.records.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * The result
 * ---------------------------------------------------------------------------------------------- */

/** What an effect callback said about one verified event. */
export type StripeWebhookEffect =
  | { readonly status: "applied"; readonly detail: string | null }
  | { readonly status: "requires_sync"; readonly detail: string | null }
  | { readonly status: "skipped"; readonly detail: string | null };

/** What one delivery produced. `status` is the HTTP status the route answers with. */
export type StripeWebhookResult =
  | {
      readonly status: 200;
      readonly body: {
        readonly received: true;
        readonly duplicate: boolean;
        readonly eventId: string;
        readonly classification: StripeWebhookClassification;
      };
      readonly record: StripeWebhookRecord;
      readonly secretRole: StripeWebhookRecord["secretRole"];
    }
  | { readonly status: 400; readonly body: { readonly error: string; readonly reason: string } }
  | { readonly status: 500; readonly body: { readonly error: string; readonly reason: string } };

/** One audit entry this file hands to the caller's audit writer. */
export interface StripeWebhookAuditEntry {
  readonly action:
    | "stripe_webhook.received"
    | "stripe_webhook.duplicate"
    | "stripe_webhook.applied"
    | "stripe_webhook.refused"
    | "stripe_webhook.effect_failed";
  readonly providerKey: typeof STRIPE_PROVIDER_KEY;
  readonly companyId: string;
  readonly eventId: string | null;
  readonly eventType: string | null;
  readonly environment: "sandbox" | "live" | null;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/** What the receiver needs. */
export interface StripeWebhookOptions {
  readonly configStore: StripeConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly store: StripeWebhookStore;
  /**
   * The caller's effect. It is given the verified event's identity and must do its own read before acting;
   * a `payment` event's body is never trusted for an amount.
   */
  readonly applyEvent?: (event: {
    readonly companyId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly classification: StripeWebhookClassification;
    readonly objectId: string;
    readonly environment: "sandbox" | "live";
    readonly occurredAtEpochMs: number;
  }) => Promise<StripeWebhookEffect> | StripeWebhookEffect;
  readonly recordAudit?: (entry: StripeWebhookAuditEntry) => void;
}

/* -------------------------------------------------------------------------------------------------
 * Reading the delivery
 * ---------------------------------------------------------------------------------------------- */

function readableObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;
}

/** The parts of an event this receiver keeps. */
export interface ParsedStripeEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly objectId: string;
  readonly objectStatus: string | null;
  readonly apiVersion: string | null;
  readonly livemode: boolean | null;
}

/**
 * Read an event envelope.
 *
 * The documented envelope is `{ id, object: "event", type, api_version, data: { object } }`. Anything that is
 * not JSON, or that carries no `evt_` id, no type or no object id, is refused: an event the receiver cannot
 * identify cannot be deduplicated, and a receiver that guessed would apply an effect twice.
 */
export function parseStripeEvent(rawBody: string): ParsedStripeEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }

  const envelope = readableObject(payload);
  if (envelope === null) return null;

  const eventId = envelope["id"];
  const eventType = envelope["type"];
  if (typeof eventId !== "string" || STRIPE_EVENT_PATTERN.test(eventId) === false) return null;
  if (typeof eventType !== "string" || /^[a-z0-9_.]{3,64}$/u.test(eventType) === false) return null;

  const data = readableObject(envelope["data"]);
  const object = data === null ? null : readableObject(data["object"]);
  if (object === null) return null;

  const objectId = object["id"];
  if (typeof objectId !== "string" || objectId.trim().length === 0) return null;

  const objectStatus = object["status"];
  const apiVersion = envelope["api_version"];
  const livemode = envelope["livemode"];

  return {
    eventId,
    eventType,
    objectId: objectId.trim().slice(0, 128),
    objectStatus: typeof objectStatus === "string" ? objectStatus.trim().slice(0, 64) : null,
    apiVersion: typeof apiVersion === "string" ? apiVersion.trim().slice(0, 32) : null,
    livemode: typeof livemode === "boolean" ? livemode : null,
  };
}

/**
 * Check a delivery against the company's signing secrets.
 *
 * The current secret is tried first, then the previous one while its documented overlap window is open. Both
 * are tried with STEP 161's verifier, which does the constant-time comparison and the tolerance check; this
 * function only decides which secret answered, so the record can say so without storing anything secret.
 */
export function verifyStripeDelivery(
  rawBody: string,
  signatureHeader: string | null,
  secrets: { readonly current: string | null; readonly previous: string | null },
  options: { readonly nowSeconds: number; readonly toleranceSeconds?: number },
): { readonly ok: true; readonly secretRole: "current" | "previous" } | { readonly ok: false; readonly reason: string } {
  const attempts: readonly { readonly role: "current" | "previous"; readonly secret: string | null }[] = [
    { role: "current", secret: secrets.current },
    { role: "previous", secret: secrets.previous },
  ];

  let lastReason = "no webhook signing secret is configured for this company";
  for (const attempt of attempts) {
    if (attempt.secret === null) continue;
    const signature: StripeSignatureOptions = {
      secret: attempt.secret,
      toleranceSeconds: options.toleranceSeconds ?? STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      nowSeconds: () => options.nowSeconds,
      maximumBodyBytes: STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES,
    };
    const verdict = verifyStripeWebhookSignature(rawBody, signatureHeader, signature);
    if (verdict.ok === true) return { ok: true, secretRole: attempt.role };
    lastReason = verdict.reason;
  }
  return { ok: false, reason: lastReason };
}

/* -------------------------------------------------------------------------------------------------
 * Receiving
 * ---------------------------------------------------------------------------------------------- */

function audit(
  action: StripeWebhookAuditEntry["action"],
  delivery: StripeWebhookDelivery,
  environment: "sandbox" | "live" | null,
  eventId: string | null,
  eventType: string | null,
  outcome: string,
  options: StripeWebhookOptions,
): void {
  if (options.recordAudit === undefined) return;
  options.recordAudit({
    action,
    providerKey: STRIPE_PROVIDER_KEY,
    companyId: delivery.companyId,
    eventId,
    eventType,
    environment,
    outcome,
    occurredAtEpochMs: delivery.receivedAtEpochMs,
  });
}

function refusal(delivery: StripeWebhookDelivery, error: string, reason: string, options: StripeWebhookOptions): StripeWebhookResult {
  audit("stripe_webhook.refused", delivery, null, null, null, error, options);
  return { status: 400, body: { error, reason } };
}

/**
 * Receive one delivery.
 *
 * Order, and why: the company must have an active configuration (otherwise the delivery is for an account
 * this platform does not serve, and a `200` would lose it); the secrets are opened (a keyring failure is this
 * receiver's outage, so `500` and a retry); the signature is verified before anything in the body is read;
 * the event is parsed; the record is written before the effect; the effect runs; the record is settled.
 *
 * A second delivery of a **settled** record answers `200` with `duplicate: true` and repeats nothing. A
 * second delivery of a record that is still `stored` — the effect failed last time — re-runs the effect,
 * because that is what a retry is for. Either way the delivery count moves, so a storm of retries is visible.
 */
export async function receiveStripeWebhook(
  delivery: StripeWebhookDelivery,
  options: StripeWebhookOptions,
): Promise<StripeWebhookResult> {
  const companyId = delivery.companyId.trim();
  if (companyId.length === 0) return refusal(delivery, "unknown_company", "the delivery names no company", options);

  if (delivery.rawBody.length === 0) {
    return refusal(delivery, "invalid_payload", "the delivery carries no body", options);
  }
  if (delivery.rawBody.length > STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES) {
    return refusal(delivery, "invalid_payload", "the delivery is larger than this receiver accepts", options);
  }
  if (delivery.signatureHeader === null || delivery.signatureHeader.length === 0) {
    return refusal(delivery, "missing_signature", "the delivery carries no signature header", options);
  }
  if (delivery.signatureHeader.length > STRIPE_SIGNATURE_HEADER_MAXIMUM_LENGTH) {
    return refusal(delivery, "invalid_signature", "the signature header is larger than this receiver accepts", options);
  }

  const config: StripeKeyConfig | null = options.configStore.findActiveByCompany(companyId);
  if (config === null) {
    return refusal(delivery, "unknown_company", "no active Stripe configuration exists for this company", options);
  }

  const secrets = stripeWebhookSecretsFor(config, options.keyring, delivery.receivedAtEpochMs);
  if (secrets.status === "failed") {
    audit("stripe_webhook.refused", delivery, config.environment, null, null, "webhook_secret_unavailable", options);
    return { status: 500, body: { error: "webhook_secret_unavailable", reason: secrets.reason } };
  }
  if (secrets.current === null && secrets.previous === null) {
    return refusal(delivery, "missing_signature", "no webhook signing secret is configured for this company", options);
  }

  const nowSeconds = Math.floor(delivery.receivedAtEpochMs / 1_000);
  const verified = verifyStripeDelivery(
    delivery.rawBody,
    delivery.signatureHeader,
    { current: secrets.current, previous: secrets.previous },
    { nowSeconds },
  );
  if (verified.ok === false) {
    return refusal(delivery, "invalid_signature", verified.reason, options);
  }

  const event = parseStripeEvent(delivery.rawBody);
  if (event === null) {
    return refusal(delivery, "invalid_payload", "the body is not a documented event envelope", options);
  }

  const classification = classifyStripeEventType(event.eventType);
  const existing = options.store.findByEventId(companyId, event.eventId);

  if (existing !== null && existing.status !== "stored") {
    const counted: StripeWebhookRecord = {
      ...existing,
      deliveryCount: existing.deliveryCount + 1,
      lastReceivedAtEpochMs: delivery.receivedAtEpochMs,
      version: existing.version + 1,
    };
    options.store.save(counted, existing.version);
    audit("stripe_webhook.duplicate", delivery, config.environment, event.eventId, event.eventType, existing.status, options);
    return {
      status: 200,
      body: { received: true, duplicate: true, eventId: event.eventId, classification },
      record: options.store.findByEventId(companyId, event.eventId) ?? counted,
      secretRole: verified.secretRole,
    };
  }

  const stored: StripeWebhookRecord =
    existing === null
      ? {
          id: randomUUID(),
          companyId,
          eventId: event.eventId,
          eventType: event.eventType,
          classification,
          objectId: event.objectId,
          objectStatus: event.objectStatus,
          apiVersion: event.apiVersion,
          livemode: event.livemode,
          bodyFingerprint: stripeBodyFingerprint(delivery.rawBody),
          signatureScheme: STRIPE_SIGNATURE_SCHEME,
          secretRole: verified.secretRole,
          status: "stored",
          deliveryCount: 1,
          lastError: null,
          firstReceivedAtEpochMs: delivery.receivedAtEpochMs,
          lastReceivedAtEpochMs: delivery.receivedAtEpochMs,
          version: 1,
        }
      : {
          ...existing,
          deliveryCount: existing.deliveryCount + 1,
          lastReceivedAtEpochMs: delivery.receivedAtEpochMs,
          secretRole: verified.secretRole,
          version: existing.version + 1,
        };

  if (existing === null) {
    options.store.insert(stored);
  } else if (options.store.save(stored, existing.version) === false) {
    return { status: 500, body: { error: "record_conflict", reason: "the event record moved while it was being stored" } };
  }

  audit("stripe_webhook.received", delivery, config.environment, event.eventId, event.eventType, classification, options);

  let effect: StripeWebhookEffect = {
    status: classification === "ignored" ? "skipped" : "applied",
    detail: null,
  };
  if (classification !== "ignored" && options.applyEvent !== undefined) {
    try {
      effect = await options.applyEvent({
        companyId,
        eventId: event.eventId,
        eventType: event.eventType,
        classification,
        objectId: event.objectId,
        environment: config.environment,
        occurredAtEpochMs: delivery.receivedAtEpochMs,
      });
    } catch {
      effect = { status: "skipped", detail: "the effect threw" };
    }
  }

  if (effect.status === "skipped" && classification !== "ignored") {
    const failed: StripeWebhookRecord = {
      ...stored,
      lastError: effect.detail ?? "the effect was not applied",
      version: stored.version + 1,
    };
    options.store.save(failed, stored.version);
    audit("stripe_webhook.effect_failed", delivery, config.environment, event.eventId, event.eventType, "failed", options);
    return {
      status: 500,
      body: { error: "effect_failed", reason: effect.detail ?? "the effect was not applied" },
    };
  }

  const settledStatus: StripeWebhookStatus =
    classification === "ignored" ? "acknowledged" : effect.status === "requires_sync" ? "requires_sync" : "applied";
  const settled: StripeWebhookRecord = {
    ...stored,
    status: settledStatus,
    lastError: null,
    version: stored.version + 1,
  };
  options.store.save(settled, stored.version);

  audit("stripe_webhook.applied", delivery, config.environment, event.eventId, event.eventType, settledStatus, options);

  return {
    status: 200,
    body: { received: true, duplicate: false, eventId: event.eventId, classification },
    record: options.store.findByEventId(companyId, event.eventId) ?? settled,
    secretRole: verified.secretRole,
  };
}
