// path: lib/payments/adapters/airwallex-webhook.ts

/**
 * Receiving an Airwallex webhook: verify the signature over the raw body, read the documented envelope, deduplicate
 * the event id, and say what it means — before anything in this platform acts on it.
 *
 * ## The order STEP 165 recorded, in code
 *
 * "Verify `x-signature` over `x-timestamp` plus the raw body before parsing anything." So this file verifies first
 * and parses second, and the parse is of the **same raw string** the signature was computed over: no re-serialised
 * JSON, no hand-picked fields. A delivery that fails verification is refused without its body ever being read as an
 * event, which is what makes a forged delivery unable to change a payment, a transfer or an account.
 *
 * ## One secret per URL, so the URL names the company
 *
 * STEP 165 recorded that each subscription's secret is unique to its URL, and STEP 166 stores that secret sealed
 * against the company. The receiver therefore takes the company from the route (the endpoint is mounted per
 * company), opens that company's sealed secret with the keyring, and verifies with it — never with a secret chosen
 * by the caller or carried in the delivery.
 *
 * ## Deduplicated on the documented event id
 *
 * The page's envelope carries `id` (an `evt_` id), `name`, `account_id`, `org_id`, `data.object`, `created_at` and
 * `version`. The provider retries any delivery it does not see answered with `200`, so the same event id arrives
 * more than once in normal operation: the first delivery is recorded and applied, every later one answers `duplicate`
 * and applies nothing. The record keeps a SHA-256 hash of the raw body rather than the body, because a webhook body
 * carries payment detail this platform does not need twice.
 *
 * ## Nothing is claimed beyond what the event says
 *
 * A payment event's status goes through STEP 165's mapping — `SUCCEEDED` is the only `paid`, and `FAILED` is not an
 * Intent status at all. A transfer event's status goes through the transfer mapping, where `PAID` is `paid` **and
 * provisional**, because the page says a paid transfer may still fail. An event name this record does not subscribe
 * to is acknowledged (a non-200 would only make the provider retry something the platform will still ignore) and
 * recorded as `ignored`, never guessed at. The account-status event group is deliberately empty in STEP 165's record,
 * and this file therefore has no account branch to get wrong.
 */

import { createHash } from "node:crypto";
import { deepFreeze } from "../../utils/freeze.ts";
import { openSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  AIRWALLEX_EVENT_NAMES,
  AIRWALLEX_PROVIDER_KEY,
  AIRWALLEX_TEST_SECRET_HEADER,
  AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES,
  airwallexPaymentOutcomeOf,
  airwallexPaymentAttemptOutcomeOf,
  airwallexTransferOutcomeOf,
  isAirwallexEventName,
  parseAirwallexEvent,
  sanitizeAirwallexText,
  verifyAirwallexWebhookSignature,
  type AirwallexEventEnvelope,
  type AirwallexPaymentOutcome,
  type AirwallexTransferOutcome,
} from "./airwallex.ts";
import {
  airwallexWebhookSecretScope,
  type AirwallexConfigStore,
  type AirwallexKeyConfig,
} from "./airwallex-client.ts";

/* -------------------------------------------------------------------------------------------------
 * The documented surface
 * ---------------------------------------------------------------------------------------------- */

/** The three headers a delivery is read from. */
export const AIRWALLEX_WEBHOOK_HEADERS = deepFreeze({
  timestamp: "x-timestamp",
  signature: "x-signature",
  /** The header a simulated delivery carries; it labels a test, and never stands in for a signature. */
  testSecret: AIRWALLEX_TEST_SECRET_HEADER,
});

/** The answer the page demands for a delivery this platform accepted. */
export const AIRWALLEX_WEBHOOK_ACCEPTED_STATUS = 200;

/** The answer for a delivery that is not from Airwallex. */
export const AIRWALLEX_WEBHOOK_REFUSED_STATUS = 401;

/** The answer for a delivery that is signed but unreadable, and cannot become readable by retrying. */
export const AIRWALLEX_WEBHOOK_MALFORMED_STATUS = 400;

/** The answer for a delivery this platform could not record, so the provider should retry it. */
export const AIRWALLEX_WEBHOOK_FAILED_STATUS = 500;

/** The largest answer body this receiver writes back. */
export const AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH = 200;

/** The three resource groups STEP 165 records, in the order they are checked. */
export const AIRWALLEX_WEBHOOK_GROUPS: readonly string[] = deepFreeze(["payment_intent", "payment_attempt", "transfer"]);

/**
 * The key each group's event names live under in STEP 165's record. The two vocabularies differ — the group is the
 * route's word, the key is the record's — and this table is the only place they are matched up, so a lookup that
 * silently searched the wrong key cannot exist.
 */
export const AIRWALLEX_WEBHOOK_GROUP_KEYS: Readonly<Record<string, string>> = deepFreeze({
  payment_intent: "paymentIntent",
  payment_attempt: "paymentAttempt",
  transfer: "transfer",
});

/* -------------------------------------------------------------------------------------------------
 * The delivery record
 * ---------------------------------------------------------------------------------------------- */

/** Where one delivery stands. */
export type AirwallexDeliveryStatus = "received" | "processed" | "ignored" | "failed";

/** One delivery, keyed by the documented `evt_` id. The body itself is never stored. */
export interface AirwallexWebhookDeliveryRecord {
  readonly id: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly companyId: string;
  readonly objectId: string | null;
  /** A SHA-256 hash of the raw body, in lowercase hex. */
  readonly payloadHash: string;
  /** True when the delivery carried the documented simulated-delivery header. */
  readonly isTest: boolean;
  readonly status: AirwallexDeliveryStatus;
  readonly receivedAtEpochMs: number;
  readonly processedAtEpochMs: number | null;
  readonly failureDetail: string | null;
  readonly version: number;
}

/** The only moves a delivery may make. */
export const AIRWALLEX_DELIVERY_OUTCOMES: Readonly<
  Record<AirwallexDeliveryStatus, readonly AirwallexDeliveryStatus[]>
> = deepFreeze({
  received: ["received", "processed", "ignored", "failed"],
  processed: ["processed"],
  ignored: ["ignored"],
  failed: ["failed"],
});

/** What the store reads and writes. One row per event id. */
export interface AirwallexWebhookDeliveryStore {
  insert(record: AirwallexWebhookDeliveryRecord): void;
  findById(id: string): AirwallexWebhookDeliveryRecord | null;
  findByEventId(companyId: string, eventId: string): AirwallexWebhookDeliveryRecord | null;
  save(next: AirwallexWebhookDeliveryRecord, expectedVersion: number): boolean;
}

/**
 * The in-memory store: the invariants the real table must carry — a unique event id per company, an immutable
 * company, event id, name, object and payload hash, a version guard, and forward-only statuses so an applied
 * delivery can never be replayed into a second application.
 */
export class InMemoryAirwallexWebhookDeliveryStore implements AirwallexWebhookDeliveryStore {
  private readonly records = new Map<string, AirwallexWebhookDeliveryRecord>();

  insert(record: AirwallexWebhookDeliveryRecord): void {
    if (this.records.has(record.id)) throw new Error("duplicate delivery id");
    if (record.version !== 1) throw new Error("a new delivery starts at version 1");
    if (record.status !== "received") throw new Error("a new delivery is received");
    if (this.findByEventId(record.companyId, record.eventId) !== null) throw new Error("duplicate event id");
    this.records.set(record.id, record);
  }

  findById(id: string): AirwallexWebhookDeliveryRecord | null {
    return this.records.get(id) ?? null;
  }

  findByEventId(companyId: string, eventId: string): AirwallexWebhookDeliveryRecord | null {
    return (
      [...this.records.values()].find(
        (record) => record.companyId === companyId && record.eventId === eventId,
      ) ?? null
    );
  }

  save(next: AirwallexWebhookDeliveryRecord, expectedVersion: number): boolean {
    const current = this.records.get(next.id);
    if (current === undefined) return false;
    if (current.companyId !== next.companyId || current.eventId !== next.eventId) return false;
    if (current.eventName !== next.eventName || current.objectId !== next.objectId) return false;
    if (current.payloadHash !== next.payloadHash) return false;
    if (current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) return false;
    if (AIRWALLEX_DELIVERY_OUTCOMES[current.status].includes(next.status) === false) return false;
    this.records.set(next.id, next);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 * What a delivery means
 * ---------------------------------------------------------------------------------------------- */

/** What one delivery says about a payment. */
export interface AirwallexPaymentEffect {
  readonly kind: "payment";
  readonly paymentIntentId: string;
  readonly providerStatus: string | null;
  readonly outcome: AirwallexPaymentOutcome;
}

/** What one delivery says about a payment attempt, which is evidence and never a status of its own. */
export interface AirwallexPaymentAttemptEffect {
  readonly kind: "payment_attempt";
  readonly paymentAttemptId: string | null;
  readonly providerStatus: string | null;
  readonly outcome: AirwallexPaymentOutcome;
  readonly eventName: string;
}

/** What one delivery says about a transfer. */
export interface AirwallexTransferEffect {
  readonly kind: "transfer";
  readonly transferId: string;
  readonly providerStatus: string | null;
  readonly outcome: AirwallexTransferOutcome;
  /** True while a `PAID` transfer may still fail, per the transfer-status page. */
  readonly provisional: boolean;
}

/** An event this platform has nothing to do with. */
export interface AirwallexIgnoredEffect {
  readonly kind: "ignored";
  readonly reason: string;
}

/** What one delivery did. */
export type AirwallexWebhookEffect =
  | AirwallexPaymentEffect
  | AirwallexPaymentAttemptEffect
  | AirwallexTransferEffect
  | AirwallexIgnoredEffect;

/** What receiving one delivery concluded. */
export type AirwallexWebhookResult =
  | { readonly status: "refused"; readonly reason: string; readonly httpStatus: 400 | 401 }
  | {
      readonly status: "duplicate";
      readonly deliveryId: string;
      readonly eventId: string;
      readonly eventName: string;
      readonly httpStatus: 200;
    }
  | {
      readonly status: "applied";
      readonly deliveryId: string;
      readonly eventId: string;
      readonly eventName: string;
      readonly effect: AirwallexWebhookEffect;
      readonly isTest: boolean;
      readonly httpStatus: 200;
    }
  | { readonly status: "failed"; readonly reason: string; readonly httpStatus: 500 };

/** The raw delivery, exactly as the route received it. */
export interface AirwallexWebhookDelivery {
  /** The company whose endpoint this is, taken from the route: the secret belongs to that company's URL. */
  readonly companyId: string;
  readonly rawBody: string;
  readonly timestamp: string | null;
  readonly signature: string | null;
  /** The simulated-delivery header, kept only to label a test. It never replaces the signature. */
  readonly testSecret: string | null;
}

/** Everything the receiver needs. */
export interface AirwallexWebhookDeps {
  readonly configStore: AirwallexConfigStore;
  readonly keyring: EncryptionKeyring;
  readonly store: AirwallexWebhookDeliveryStore;
  readonly nowEpochMs: number;
  readonly toleranceSeconds?: number;
  readonly recordAudit?: (entry: AirwallexWebhookAuditEntry) => void;
}

/** One audit entry this file hands to the caller's audit writer. Never carries the body, the secret or the signature. */
export interface AirwallexWebhookAuditEntry {
  readonly action:
    | "airwallex_webhook.received"
    | "airwallex_webhook.duplicate"
    | "airwallex_webhook.refused"
    | "airwallex_webhook.ignored"
    | "airwallex_webhook.failed";
  readonly providerKey: typeof AIRWALLEX_PROVIDER_KEY;
  readonly companyId: string;
  readonly eventId: string | null;
  readonly eventName: string | null;
  readonly outcome: string;
  readonly occurredAtEpochMs: number;
}

/** The SHA-256 hash of a raw body, in lowercase hex. */
export function airwallexPayloadHashOf(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** The company's active configuration, or the reason there is none. */
function configurationOf(
  companyId: string,
  deps: AirwallexWebhookDeps,
): { readonly ok: true; readonly config: AirwallexKeyConfig } | { readonly ok: false; readonly reason: string } {
  const config = deps.configStore.findActiveByCompany(companyId);
  if (config === null) return { ok: false, reason: "no active Airwallex key configuration exists for this company" };
  return { ok: true, config };
}

/** The group a documented event name belongs to, or null. */
export function airwallexEventGroupOf(name: string): string | null {
  const trimmed = name.trim();
  for (const group of AIRWALLEX_WEBHOOK_GROUPS) {
    const key = AIRWALLEX_WEBHOOK_GROUP_KEYS[group] ?? "";
    const names: readonly string[] = key.length === 0 ? [] : (AIRWALLEX_EVENT_NAMES[key] ?? []);
    if (names.includes(trimmed)) return group;
  }
  return null;
}

/**
 * What one verified, parsed event means.
 *
 * The object's own `status` decides a payment, because the Intent vocabulary is complete and STEP 165 records it.
 * A payment attempt event has no Intent status: the name says what happened (`authorized`, `authentication_failed`,
 * `authorization_failed`) and the attempt vocabulary is mapped for reference only, so the caller can record evidence
 * without letting an attempt overwrite an Intent. A transfer's status is read from the object when it is one the
 * page documents, and otherwise derived from the event name, which is one of the eleven recorded ones.
 */
export function airwallexWebhookEffectOf(envelope: AirwallexEventEnvelope): AirwallexWebhookEffect {
  const group = airwallexEventGroupOf(envelope.name);
  if (group === null) {
    return { kind: "ignored", reason: "the event name is not one this subscription records" };
  }

  if (group === "payment_intent") {
    const intentId = envelope.objectId;
    if (intentId === null) return { kind: "ignored", reason: "the payment intent event names no object id" };
    const providerStatus = envelope.objectStatus;
    return {
      kind: "payment",
      paymentIntentId: intentId,
      providerStatus,
      outcome: airwallexPaymentOutcomeOf(providerStatus ?? ""),
    };
  }

  if (group === "payment_attempt") {
    return {
      kind: "payment_attempt",
      paymentAttemptId: envelope.objectId,
      providerStatus: envelope.objectStatus,
      outcome: airwallexPaymentAttemptOutcomeOf(envelope.objectStatus ?? ""),
      eventName: envelope.name,
    };
  }

  const transferId = envelope.objectId;
  if (transferId === null) return { kind: "ignored", reason: "the transfer event names no object id" };
  const providerStatus = envelope.objectStatus ?? transferStatusOfEventName(envelope.name);
  const mapped = airwallexTransferOutcomeOf(providerStatus ?? "");
  return {
    kind: "transfer",
    transferId,
    providerStatus,
    outcome: mapped.outcome,
    provisional: mapped.provisional,
  };
}

/** The status a transfer event's name implies, when the object carries none. */
export function transferStatusOfEventName(name: string): string | null {
  const suffix = name.trim().split(".").pop() ?? "";
  const upper = suffix.toUpperCase();
  const mapping: Readonly<Record<string, string>> = deepFreeze({
    IN_APPROVAL: "IN_APPROVAL",
    APPROVAL_RECALLED: "APPROVAL_RECALLED",
    APPROVAL_REJECTED: "APPROVAL_REJECTED",
    APPROVAL_BLOCKED: "APPROVAL_BLOCKED",
    SCHEDULED: "SCHEDULED",
    OVERDUE: "OVERDUE",
    PROCESSING: "PROCESSING",
    SENT: "SENT",
    PAID: "PAID",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
  });
  return mapping[upper] ?? null;
}

/* -------------------------------------------------------------------------------------------------
 * Receiving
 * ---------------------------------------------------------------------------------------------- */

/** Audit one delivery outcome. */
function auditDelivery(
  action: AirwallexWebhookAuditEntry["action"],
  companyId: string,
  envelope: AirwallexEventEnvelope | null,
  outcome: string,
  deps: AirwallexWebhookDeps,
): void {
  deps.recordAudit?.({
    action,
    providerKey: AIRWALLEX_PROVIDER_KEY,
    companyId,
    eventId: envelope === null ? null : envelope.eventId,
    eventName: envelope === null ? null : envelope.name,
    outcome,
    occurredAtEpochMs: deps.nowEpochMs,
  });
}

/**
 * Receive one delivery.
 *
 * The order is the page's own and it is what this function is: size, headers, signature over the raw body, then the
 * envelope, then the event id, then the record written **before** the effect is handed to the caller. A refused
 * delivery writes nothing; a duplicate applies nothing; an unreadable but signed delivery is refused as malformed so
 * the provider stops retrying something that will never parse; a delivery this platform could not record answers
 * `500`, which is the one case where a retry can help.
 */
export async function receiveAirwallexWebhook(
  delivery: AirwallexWebhookDelivery,
  deps: AirwallexWebhookDeps,
): Promise<AirwallexWebhookResult> {
  if (delivery.rawBody.length === 0) {
    auditDelivery("airwallex_webhook.refused", delivery.companyId, null, "empty body", deps);
    return { status: "refused", reason: "the delivery carries no body", httpStatus: AIRWALLEX_WEBHOOK_MALFORMED_STATUS };
  }
  if (delivery.rawBody.length > AIRWALLEX_WEBHOOK_MAXIMUM_BODY_BYTES) {
    auditDelivery("airwallex_webhook.refused", delivery.companyId, null, "oversized body", deps);
    return {
      status: "refused",
      reason: "the delivery is larger than this receiver accepts",
      httpStatus: AIRWALLEX_WEBHOOK_MALFORMED_STATUS,
    };
  }

  const configuration = configurationOf(delivery.companyId, deps);
  if (configuration.ok === false) {
    auditDelivery("airwallex_webhook.failed", delivery.companyId, null, "no configuration", deps);
    return { status: "failed", reason: configuration.reason, httpStatus: AIRWALLEX_WEBHOOK_FAILED_STATUS };
  }

  if (configuration.config.webhookSecretSealed === null) {
    // A signed delivery cannot be checked without a secret, and answering 200 would drop real events silently: this
    // is a configuration defect an operator must fix, and the provider's retries give them the time.
    auditDelivery("airwallex_webhook.failed", delivery.companyId, null, "no webhook secret", deps);
    return {
      status: "failed",
      reason: "no webhook signing secret is configured for this company",
      httpStatus: AIRWALLEX_WEBHOOK_FAILED_STATUS,
    };
  }

  let secret: string;
  try {
    secret = openSecret(deps.keyring, configuration.config.webhookSecretSealed, {
      purpose: "secret",
      scope: airwallexWebhookSecretScope(delivery.companyId),
    });
  } catch {
    auditDelivery("airwallex_webhook.failed", delivery.companyId, null, "secret unreadable", deps);
    return {
      status: "failed",
      reason: "the sealed webhook signing secret cannot be opened with this keyring",
      httpStatus: AIRWALLEX_WEBHOOK_FAILED_STATUS,
    };
  }

  const verdict = verifyAirwallexWebhookSignature(
    delivery.rawBody,
    { timestamp: delivery.timestamp, signature: delivery.signature },
    {
      secret,
      nowEpochMs: deps.nowEpochMs,
      ...(deps.toleranceSeconds === undefined ? {} : { toleranceSeconds: deps.toleranceSeconds }),
    },
  );
  if (verdict.ok === false) {
    auditDelivery("airwallex_webhook.refused", delivery.companyId, null, "unverified", deps);
    return { status: "refused", reason: verdict.reason, httpStatus: AIRWALLEX_WEBHOOK_REFUSED_STATUS };
  }

  // Only now is the body read as an event, and it is read from the same string the signature covered.
  const envelope = parseAirwallexEvent(delivery.rawBody);
  if (envelope === null) {
    auditDelivery("airwallex_webhook.refused", delivery.companyId, null, "unreadable envelope", deps);
    return {
      status: "refused",
      reason: "the delivery is signed but is not an event envelope this receiver reads",
      httpStatus: AIRWALLEX_WEBHOOK_MALFORMED_STATUS,
    };
  }

  const existing = deps.store.findByEventId(delivery.companyId, envelope.eventId);
  if (existing !== null) {
    auditDelivery("airwallex_webhook.duplicate", delivery.companyId, envelope, existing.status, deps);
    return {
      status: "duplicate",
      deliveryId: existing.id,
      eventId: envelope.eventId,
      eventName: envelope.name,
      httpStatus: AIRWALLEX_WEBHOOK_ACCEPTED_STATUS,
    };
  }

  const effect = airwallexWebhookEffectOf(envelope);
  const isTest = delivery.testSecret !== null && delivery.testSecret.trim().length > 0;
  const record: AirwallexWebhookDeliveryRecord = {
    id: payloadRecordId(delivery.companyId, envelope.eventId),
    eventId: envelope.eventId,
    eventName: envelope.name,
    companyId: delivery.companyId,
    objectId: envelope.objectId,
    payloadHash: airwallexPayloadHashOf(delivery.rawBody),
    isTest,
    status: "received",
    receivedAtEpochMs: deps.nowEpochMs,
    processedAtEpochMs: null,
    failureDetail: null,
    version: 1,
  };
  try {
    deps.store.insert(record);
  } catch {
    auditDelivery("airwallex_webhook.failed", delivery.companyId, envelope, "delivery not recorded", deps);
    return {
      status: "failed",
      reason: "the delivery could not be recorded, so it should be retried",
      httpStatus: AIRWALLEX_WEBHOOK_FAILED_STATUS,
    };
  }

  const ignored = effect.kind === "ignored";
  const settled: AirwallexWebhookDeliveryRecord = {
    ...record,
    status: ignored ? "ignored" : "processed",
    processedAtEpochMs: deps.nowEpochMs,
    failureDetail: ignored ? sanitizeAirwallexText(effect.reason, AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH) : null,
    version: record.version + 1,
  };
  if (deps.store.save(settled, record.version) === false) {
    auditDelivery("airwallex_webhook.failed", delivery.companyId, envelope, "delivery not settled", deps);
    return {
      status: "failed",
      reason: "the delivery record moved while it was being settled, so it should be retried",
      httpStatus: AIRWALLEX_WEBHOOK_FAILED_STATUS,
    };
  }

  if (ignored) {
    auditDelivery("airwallex_webhook.ignored", delivery.companyId, envelope, effect.reason, deps);
  } else {
    auditDelivery("airwallex_webhook.received", delivery.companyId, envelope, effect.kind, deps);
  }

  return {
    status: "applied",
    deliveryId: settled.id,
    eventId: envelope.eventId,
    eventName: envelope.name,
    effect,
    isTest,
    httpStatus: AIRWALLEX_WEBHOOK_ACCEPTED_STATUS,
  };
}

/** A deterministic record id, so a retried delivery cannot create a second row even before the dedupe read commits. */
function payloadRecordId(companyId: string, eventId: string): string {
  return createHash("sha256").update(`${companyId}|${eventId}`, "utf8").digest("hex").slice(0, 32);
}

/* -------------------------------------------------------------------------------------------------
 * Answering
 * ---------------------------------------------------------------------------------------------- */

/** What the route writes back. Never the body, the secret or the signature. */
export interface AirwallexWebhookResponse {
  readonly httpStatus: 200 | 400 | 401 | 500;
  readonly body: string;
  /** True when the provider should retry: only a `500` earns that, because only a `500` can be fixed by retrying. */
  readonly retry: boolean;
}

/**
 * The HTTP answer for one delivery.
 *
 * The page's rule is that anything but `200` is a failed delivery and is retried, so this answers `200` for a
 * delivery that was applied, ignored as unsubscribed, or seen before; `401` for one that is not from Airwallex; `400`
 * for one that will never parse; and `500` only when the platform itself could not record the work.
 */
export function airwallexWebhookResponseOf(result: AirwallexWebhookResult): AirwallexWebhookResponse {
  if (result.status === "applied") {
    return {
      httpStatus: AIRWALLEX_WEBHOOK_ACCEPTED_STATUS,
      body: JSON.stringify({ received: true, event: result.eventId, effect: result.effect.kind }),
      retry: false,
    };
  }
  if (result.status === "duplicate") {
    return {
      httpStatus: AIRWALLEX_WEBHOOK_ACCEPTED_STATUS,
      body: JSON.stringify({ received: true, duplicate: true, event: result.eventId }),
      retry: false,
    };
  }
  if (result.status === "failed") {
    return {
      httpStatus: AIRWALLEX_WEBHOOK_FAILED_STATUS,
      body: JSON.stringify({ received: false, retry: true }),
      retry: true,
    };
  }
  return {
    httpStatus: result.httpStatus,
    body: JSON.stringify({
      received: false,
      reason: sanitizeAirwallexText(result.reason, AIRWALLEX_WEBHOOK_RESPONSE_TEXT_MAXIMUM_LENGTH),
    }),
    retry: false,
  };
}

/** The documented event groups, exported with their counts so a subscription review can see what is subscribed. */
export function airwallexSubscribedEventNames(): readonly string[] {
  const names: string[] = [];
  for (const group of AIRWALLEX_WEBHOOK_GROUPS) {
    const key = AIRWALLEX_WEBHOOK_GROUP_KEYS[group] ?? "";
    if (key.length === 0) continue;
    for (const name of AIRWALLEX_EVENT_NAMES[key] ?? []) names.push(name);
  }
  return deepFreeze(names);
}

/** True when a name is subscribed; the same check the receiver makes before it looks for an effect. */
export function airwallexEventIsSubscribed(name: string): boolean {
  return isAirwallexEventName(name);
}
