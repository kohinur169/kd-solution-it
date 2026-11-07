// path: lib/api/store-webhooks.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { packSecretBox, unpackSecretBox, type SecretBox } from "../auth/secrets.ts";
import { AppError } from "../errors/app-error.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { JobRegistry } from "../jobs/registry.ts";
import type { JobContext, JobDefinition } from "../jobs/types.ts";
import { requireHttpUrl } from "../security/url.ts";
import { credentialSecretContext } from "./credential-fields.ts";
import {
  isFinalWebhookRule,
  STORE_WEBHOOK_ATTEMPT_HEADER,
  STORE_WEBHOOK_AUDIT,
  STORE_WEBHOOK_CONTENT_TYPE,
  STORE_WEBHOOK_ENDPOINT_FIELD,
  STORE_WEBHOOK_ENDPOINT_MAXIMUM_LENGTH,
  STORE_WEBHOOK_ENTITY,
  STORE_WEBHOOK_EVENT_ID_HEADER,
  STORE_WEBHOOK_EVENT_ID_PATTERN,
  STORE_WEBHOOK_EVENT_TYPE_HEADER,
  STORE_WEBHOOK_EVENT_TYPES,
  STORE_WEBHOOK_JOB_NAME,
  STORE_WEBHOOK_MAXIMUM_ATTEMPTS,
  STORE_WEBHOOK_MAXIMUM_BODY_BYTES,
  STORE_WEBHOOK_OBJECT,
  STORE_WEBHOOK_RULES,
  STORE_WEBHOOK_SIGNATURE_HEADER,
  STORE_WEBHOOK_SIGNATURE_VERSION,
  STORE_WEBHOOK_TIMEOUT_MS,
  STORE_WEBHOOK_USER_AGENT,
  storeWebhookEventOf,
  storeWebhookRuleForStatus,
  type StoreWebhookAttemptOutcome,
  type StoreWebhookEnvelope,
  type StoreWebhookEventType,
  type StoreWebhookJobPayload,
  type StoreWebhookPayment,
  type StoreWebhookRule,
} from "./store-webhook-fields.ts";
import type { ApiStorePaymentStatusView } from "./store-payment-status.ts";

/**
 * Section 20's outbound delivery: one signed webhook to a store, with retries.
 *
 * ## The shape of one delivery
 *
 * 1. **Schedule.** A caller that has just moved a payment hands the platform the payment's new state and the store's
 *    endpoint. `scheduleStorePaymentWebhook` refuses a `pending` payment (STEP 203's `201` already said so), derives
 *    a stable event id from `(company, payment, status)`, validates the endpoint, enqueues one job under that id and
 *    writes `api.webhook_scheduled`.
 * 2. **Attempt.** The job opens the credential's signing secret, builds the envelope, signs it, and posts it once
 *    with a ten second ceiling and no redirects followed. Delivered is `api.webhook_delivered`; a refusal is
 *    `api.webhook_failed` with the reason and whether another attempt will follow.
 * 3. **Retry.** A transient failure throws, so the queue's own backoff decides when the next attempt is and its own
 *    ceiling decides when the delivery is dead. Nothing here invents a retry loop: the foundation's attempt counter,
 *    `available_at`, lease and `max_attempts` are the state, because a retry schedule kept in a handler is a retry
 *    schedule that dies with the process.
 *
 * ## Why the endpoint is an argument and not a lookup
 *
 * No migration in this tree holds a merchant's webhook endpoint and STEP 205's block grants no exception to add one.
 * So the endpoint is supplied, validated twice - when it is scheduled and again when the attempt runs, because a
 * payload written by an older build is not a reason to trust a URL today - and carried in the job payload, which is
 * what makes a retry after a restart still know where to go. The gap is named in the handoff.
 *
 * ## Why the secret is opened here and not in the payload
 *
 * A job payload is a row in a queue table that an operator can read and a support tool can print. The signing secret
 * is therefore never in it: the payload names the credential, and the secret is decrypted inside the attempt from the
 * AES-256-GCM box under the tenant's associated data, which is the only place a secret exists in the clear and only
 * for the microseconds it takes to sign one body.
 */

/** What one attempt needs from the outside world, injected so the gate can drive it without a network or a key. */
export interface StoreWebhookDeliveryDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
  /** Opens a stored signing-secret box under its tenant context. */
  readonly openSecret: (box: SecretBox, context: string) => string;
  readonly send: StoreWebhookTransport;
}

/** What scheduling needs: the queue, the chain and a clock. */
export interface StoreWebhookScheduleDependencies {
  readonly queue: JobQueue;
  readonly audit: AuditTrail;
  readonly now: () => number;
}

/** One attempt request. The body is the exact string that was signed. */
export interface StoreWebhookTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

/** A store's answer. Only the status is read; the body is never parsed, stored or logged. */
export interface StoreWebhookTransportResponse {
  readonly status: number;
}

/** The port: one POST, no redirects, no retries, no body reading. */
export type StoreWebhookTransport = (
  request: StoreWebhookTransportRequest,
) => Promise<StoreWebhookTransportResponse>;

/** Why a transport did not produce a status. Both are transient; they are named so the chain can say which. */
export class StoreWebhookTransportError extends Error {
  readonly reason: "timeout" | "unreachable";

  constructor(reason: "timeout" | "unreachable") {
    super(`The webhook endpoint was ${reason}.`);
    this.name = "StoreWebhookTransportError";
    this.reason = reason;
  }
}

/**
 * The production transport.
 *
 * Three decisions are in the options rather than in a caller's head: `redirect: "manual"` so a `3xx` is answered by
 * the classifier instead of being followed (following one would let a merchant's URL aim this request at a host
 * nobody approved); `cache: "no-store"` so no intermediary keeps a payment event; and `AbortSignal.timeout` so a
 * store that accepts the connection and never answers cannot hold a worker slot beyond the ceiling. The response
 * body is never read - a store's error page is not the platform's data.
 */
export function createStoreWebhookTransport(
  fetchImplementation: typeof fetch = fetch,
): StoreWebhookTransport {
  return async (request) => {
    let response: Response;

    try {
      response = await fetchImplementation(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";

      throw new StoreWebhookTransportError(timedOut ? "timeout" : "unreachable");
    }

    return { status: response.status };
  };
}

/** The endpoint as this platform will call it, or a refusal naming the field a caller can fix. */
export function requireStoreWebhookEndpoint(endpointUrl: string): string {
  return requireHttpUrl(endpointUrl, STORE_WEBHOOK_ENDPOINT_FIELD, {
    allowedProtocols: ["https:"],
    maximumLength: STORE_WEBHOOK_ENDPOINT_MAXIMUM_LENGTH,
  });
}

/**
 * The event id: stable for one `(company, payment, status)` and different for every other.
 *
 * Deterministic rather than random, because the same event scheduled twice must be one event to a store that
 * dedupes - and a refund after a capture is a different status, so it is a different id.
 */
export function storeWebhookEventIdOf(input: {
  readonly companyId: string;
  readonly paymentId: string;
  readonly eventType: StoreWebhookEventType;
}): string {
  const digest = createHash("sha256")
    .update(`${input.companyId}|${input.paymentId}|${input.eventType}`, "utf8")
    .digest("hex");

  return `evt_${digest.slice(0, 32)}`;
}

/** The envelope, in the field order the platform writes and the signature covers. */
export function storeWebhookEnvelopeOf(payload: StoreWebhookJobPayload): StoreWebhookEnvelope {
  return {
    id: payload.eventId,
    object: STORE_WEBHOOK_OBJECT,
    type: payload.eventType,
    created: payload.created,
    data: { payment: payload.payment },
  };
}

/** The bytes that are signed and sent. Identical on every attempt, because only the signature's timestamp moves. */
export function serializeStoreWebhookEnvelope(envelope: StoreWebhookEnvelope): string {
  const body = JSON.stringify(envelope);

  if (Buffer.byteLength(body, "utf8") > STORE_WEBHOOK_MAXIMUM_BODY_BYTES) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "body", rule: STORE_WEBHOOK_RULES.bodyTooLarge }],
    });
  }

  return body;
}

/** The signature header for one attempt: the timestamp and the HMAC over `"<timestamp>.<body>"`. */
export function signStoreWebhook(input: {
  readonly body: string;
  readonly secret: string;
  readonly timestampSeconds: number;
}): string {
  // The instant is inside the signed string, so a captured delivery cannot be replayed with a fresh-looking header.
  const signedPayload = `${String(input.timestampSeconds)}.${input.body}`;
  const signature = createHmac("sha256", input.secret).update(signedPayload, "utf8").digest("hex");

  return `t=${String(input.timestampSeconds)},${STORE_WEBHOOK_SIGNATURE_VERSION}=${signature}`;
}

/**
 * The mirror of the signature, for the store that verifies it and for this STEP's gate.
 *
 * A scheme stated without a verifier is half a contract, so both halves live here: the platform signs, and this
 * function states exactly what a store must do - parse `t` and `v1`, refuse a timestamp outside its tolerance
 * window, recompute the HMAC over the timestamp and the raw bytes, and compare without leaking position through a
 * length-dependent early exit.
 */
export function verifyStoreWebhookSignature(input: {
  readonly header: string;
  readonly body: string;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}): boolean {
  const parts = input.header.split(",");
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signaturePart = parts.find((part) => part.startsWith(`${STORE_WEBHOOK_SIGNATURE_VERSION}=`));

  if (timestampPart === undefined || signaturePart === undefined) {
    return false;
  }

  const timestamp = Number.parseInt(timestampPart.slice(2), 10);

  if (!Number.isSafeInteger(timestamp)) {
    return false;
  }

  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? 300)) {
    return false;
  }

  const signedPayload = `${String(timestamp)}.${input.body}`;
  const expected = createHmac("sha256", input.secret).update(signedPayload, "utf8").digest();
  const presented = Buffer.from(signaturePart.slice(STORE_WEBHOOK_SIGNATURE_VERSION.length + 1), "hex");

  return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
}

const paymentSchema = z.object({
  id: z.string().uuid(),
  object: z.literal("payment"),
  status: z.enum([
    "pending",
    "authorized",
    "captured",
    "settled",
    "failed",
    "voided",
    "partially_refunded",
    "refunded",
    "under_review",
  ]),
  amount_minor: z.number().int(),
  refunded_minor: z.number().int(),
  currency: z.string(),
  mode: z.enum(["test", "live"]),
  payment_method: z.enum(["card", "bank_transfer", "e_wallet"]),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const payloadSchema = z.strictObject({
  companyId: z.string().uuid(),
  credentialId: z.string().uuid(),
  mode: z.enum(["test", "live"]),
  endpointUrl: z.string().min(1),
  eventId: z.string().regex(STORE_WEBHOOK_EVENT_ID_PATTERN),
  eventType: z.enum(STORE_WEBHOOK_EVENT_TYPES as unknown as [StoreWebhookEventType, ...StoreWebhookEventType[]]),
  created: z.number().int().nonnegative(),
  payment: paymentSchema,
});

const credentialSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  mode: z.enum(["test", "live"]),
  status: z.enum(["active", "revoked"]),
  signing_secret_ciphertext: z.string(),
  signing_secret_iv: z.string(),
  signing_secret_tag: z.string(),
  encryption_key_version: z.number().int().positive(),
});

const CREDENTIAL_COLUMNS =
  "select=id,company_id,mode,status,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag," +
  "encryption_key_version&deleted_at=is.null&limit=1";

/**
 * One chain entry, best effort.
 *
 * A store that is not told about a payment is a product failure, but a chain that cannot be written must not turn a
 * delivered event into a redelivered one: the delivery already happened, and the attempt's own row in the queue still
 * says so.
 */
async function note(
  dependencies: { readonly audit: AuditTrail },
  entry: AuditEntry,
): Promise<void> {
  try {
    await dependencies.audit.append(entry);
  } catch {
    // Recorded where it can be; the delivery's outcome does not change because the chain was unreachable.
  }
}

function hostOf(endpointUrl: string): string | null {
  try {
    return new URL(endpointUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Deliver one webhook event, once.
 *
 * Returns the attempt's outcome rather than throwing for a delivery the store refused: a `404` from a store is not
 * a platform exception, it is an answer. It throws only for a failure another attempt could fix, which is how the
 * queue learns to schedule one - and on the last attempt it still throws, so the job ends `failed` where an operator
 * counting webhook failures (FEATURE_LIST section 32) will see it.
 */
export async function deliverStoreWebhook(
  payload: StoreWebhookJobPayload,
  context: { readonly attempt: number; readonly maxAttempts: number },
  dependencies: StoreWebhookDeliveryDependencies,
): Promise<StoreWebhookAttemptOutcome> {
  const eventType = storeWebhookEventOf(payload.payment.status);

  if (eventType === null || eventType !== payload.eventType) {
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.statusNotDeliverable, null);
  }

  let endpointUrl: string;

  try {
    // Re-validated at attempt time: the payload was written by a build that may have been wrong, and the payload is
    // what decides where the platform's own request goes.
    endpointUrl = requireStoreWebhookEndpoint(payload.endpointUrl);
  } catch {
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.endpointInvalid, null);
  }

  const credentials = await dependencies.rest.select(
    "merchant_api_credentials",
    `${CREDENTIAL_COLUMNS}&id=eq.${encodeURIComponent(payload.credentialId)}` +
      `&company_id=eq.${encodeURIComponent(payload.companyId)}`,
    credentialSchema,
  );
  const credential = credentials[0];

  if (credential === undefined) {
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.credentialUnavailable, null);
  }

  if (credential.status !== "active") {
    // A revoked key is the merchant withdrawing access; deliveries stop with it.
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.credentialRevoked, null);
  }

  if (credential.mode !== payload.mode) {
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.credentialModeMismatch, null);
  }

  const box = unpackSecretBox(packSecretBox({
    iv: credential.signing_secret_iv,
    tag: credential.signing_secret_tag,
    ciphertext: credential.signing_secret_ciphertext,
  }));

  if (box === null) {
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.credentialUnavailable, null);
  }

  let secret: string;

  try {
    secret = dependencies.openSecret(box, credentialSecretContext(credential.company_id));
  } catch {
    // A box that will not open under this tenant's context is a platform problem, and it is not fixable by asking
    // the store again.
    return fail(payload, context, dependencies, STORE_WEBHOOK_RULES.credentialUnavailable, null);
  }

  const body = serializeStoreWebhookEnvelope(storeWebhookEnvelopeOf(payload));
  const attemptAt = Math.floor(dependencies.now() / 1_000);
  const headers: Readonly<Record<string, string>> = {
    "content-type": STORE_WEBHOOK_CONTENT_TYPE,
    "user-agent": STORE_WEBHOOK_USER_AGENT,
    [STORE_WEBHOOK_EVENT_ID_HEADER]: payload.eventId,
    [STORE_WEBHOOK_EVENT_TYPE_HEADER]: payload.eventType,
    [STORE_WEBHOOK_ATTEMPT_HEADER]: String(context.attempt),
    [STORE_WEBHOOK_SIGNATURE_HEADER]: signStoreWebhook({ body, secret, timestampSeconds: attemptAt }),
  };

  let status: number;

  try {
    const response = await dependencies.send({
      url: endpointUrl,
      headers,
      body,
      timeoutMs: STORE_WEBHOOK_TIMEOUT_MS,
    });

    status = response.status;
  } catch (error) {
    const rule =
      error instanceof StoreWebhookTransportError && error.reason === "timeout"
        ? STORE_WEBHOOK_RULES.endpointTimeout
        : STORE_WEBHOOK_RULES.endpointUnreachable;

    return fail(payload, context, dependencies, rule, null);
  }

  if (status >= 200 && status < 300) {
    await note(dependencies, {
      action: STORE_WEBHOOK_AUDIT.delivered,
      actorUserId: null,
      entityType: STORE_WEBHOOK_ENTITY,
      entityId: payload.payment.id,
      payload: {
        event_id: payload.eventId,
        event_type: payload.eventType,
        mode: payload.mode,
        attempt: context.attempt,
        status_code: status,
        endpoint_host: hostOf(endpointUrl),
      },
      companyId: payload.companyId,
      sessionId: null,
      ipAddress: null,
      userAgent: null,
    });

    return { delivered: true, rule: null, statusCode: status, attempt: context.attempt, willRetry: false };
  }

  return fail(payload, context, dependencies, storeWebhookRuleForStatus(status), status);
}

/** Record a failed attempt and throw when another attempt is worth making. */
async function fail(
  payload: StoreWebhookJobPayload,
  context: { readonly attempt: number; readonly maxAttempts: number },
  dependencies: StoreWebhookDeliveryDependencies,
  rule: StoreWebhookRule,
  statusCode: number | null,
): Promise<StoreWebhookAttemptOutcome> {
  const willRetry = !isFinalWebhookRule(rule) && context.attempt < context.maxAttempts;

  await note(dependencies, {
    action: STORE_WEBHOOK_AUDIT.failed,
    actorUserId: null,
    entityType: STORE_WEBHOOK_ENTITY,
    entityId: payload.payment.id,
    payload: {
      event_id: payload.eventId,
      event_type: payload.eventType,
      mode: payload.mode,
      attempt: context.attempt,
      rule,
      status_code: statusCode,
      will_retry: willRetry,
      endpoint_host: hostOf(payload.endpointUrl),
    },
    companyId: payload.companyId,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  });

  if (!isFinalWebhookRule(rule)) {
    // `DEPENDENCY_FAILED` is the catalog's retryable code, so the queue's backoff and attempt ceiling take over: a
    // transient failure on the last attempt still throws, so the job ends `failed` - the count section 32 asks an
    // operator to watch - rather than `completed` with a delivery that never happened.
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule } });
  }

  return { delivered: false, rule, statusCode, attempt: context.attempt, willRetry: false };
}

/**
 * The job definition, registered on the STEP 011 foundation.
 *
 * The name, the payload schema and the attempt ceiling are the whole contract; the queue validates the payload on
 * the way in and the registry validates it again before the handler runs, which is what turns a payload written by
 * an older build into a clear failure rather than a crash on a missing field.
 */
export function storeWebhookJobDefinition(
  dependencies: StoreWebhookDeliveryDependencies,
): JobDefinition<StoreWebhookJobPayload> {
  return {
    name: STORE_WEBHOOK_JOB_NAME,
    payloadSchema: payloadSchema as unknown as JobDefinition<StoreWebhookJobPayload>["payloadSchema"],
    maxAttempts: STORE_WEBHOOK_MAXIMUM_ATTEMPTS,
    timeoutMs: STORE_WEBHOOK_TIMEOUT_MS * 2,
    handler: async (context: JobContext<StoreWebhookJobPayload>): Promise<void> => {
      context.signal.throwIfAborted();

      await deliverStoreWebhook(
        context.payload,
        { attempt: Math.max(1, context.attempt), maxAttempts: Math.max(1, context.maxAttempts) },
        dependencies,
      );
    },
  };
}

/** Register the delivery job. Returns false when it is already registered, so a second boot cannot throw. */
export function registerStoreWebhookJob(
  registry: JobRegistry,
  dependencies: StoreWebhookDeliveryDependencies,
): boolean {
  if (registry.has(STORE_WEBHOOK_JOB_NAME)) {
    return false;
  }

  registry.register(storeWebhookJobDefinition(dependencies));

  return true;
}

/** What a caller gives the scheduler: the payment's new state, the credential that will sign, and where to send it. */
export interface StoreWebhookScheduleInput {
  readonly companyId: string;
  readonly credentialId: string;
  readonly endpointUrl: string;
  readonly payment: ApiStorePaymentStatusView;
}

/** What the scheduler answers: the stable event id, the queue's own record and whether it was a duplicate. */
export interface StoreWebhookScheduleResult {
  readonly eventId: string;
  readonly jobId: string;
  readonly deduplicated: boolean;
}

/**
 * Schedule one delivery.
 *
 * The idempotency key is the tenant and the event id together, so a caller that schedules the same event twice -
 * two workers reacting to one payment, a retry of the caller's own job - enqueues one delivery and the second call
 * is answered with the first job. The endpoint is validated before a row is written and before a store is told
 * anything, and a `pending` payment is refused outright: nothing has happened to it yet.
 */
export async function scheduleStorePaymentWebhook(
  input: StoreWebhookScheduleInput,
  dependencies: StoreWebhookScheduleDependencies,
): Promise<StoreWebhookScheduleResult> {
  const eventType = storeWebhookEventOf(input.payment.status);

  if (eventType === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "payment.status", rule: STORE_WEBHOOK_RULES.statusNotDeliverable }],
    });
  }

  const endpointUrl = requireStoreWebhookEndpoint(input.endpointUrl);
  const eventId = storeWebhookEventIdOf({
    companyId: input.companyId,
    paymentId: input.payment.id,
    eventType,
  });
  const payload: StoreWebhookJobPayload = {
    companyId: input.companyId,
    credentialId: input.credentialId,
    mode: input.payment.mode,
    endpointUrl,
    eventId,
    eventType,
    created: Math.floor(dependencies.now() / 1_000),
    payment: paymentOf(input.payment),
  };
  const enqueued = await dependencies.queue.enqueue(STORE_WEBHOOK_JOB_NAME, payload, {
    // The event id already hashes the tenant, so it is unique across merchants by construction; adding the company
    // again would only make the key longer than the thing it identifies.
    idempotencyKey: eventId,
    maxAttempts: STORE_WEBHOOK_MAXIMUM_ATTEMPTS,
    now: dependencies.now(),
  });

  if (!enqueued.deduplicated) {
    await note(dependencies, {
      action: STORE_WEBHOOK_AUDIT.scheduled,
      actorUserId: null,
      entityType: STORE_WEBHOOK_ENTITY,
      entityId: input.payment.id,
      payload: {
        event_id: eventId,
        event_type: eventType,
        mode: input.payment.mode,
        status: input.payment.status,
        endpoint_host: hostOf(endpointUrl),
      },
      companyId: input.companyId,
      sessionId: null,
      ipAddress: null,
      userAgent: null,
    });
  }

  return { eventId, jobId: enqueued.job.id, deduplicated: enqueued.deduplicated };
}

/** The payment as an envelope carries it: STEP 204's ten fields, copied rather than re-derived. */
function paymentOf(payment: ApiStorePaymentStatusView): StoreWebhookPayment {
  return {
    id: payment.id,
    object: "payment",
    status: payment.status,
    amount_minor: payment.amount_minor,
    refunded_minor: payment.refunded_minor,
    currency: payment.currency,
    mode: payment.mode,
    payment_method: payment.payment_method,
    failure_code: payment.failure_code,
    created_at: payment.created_at,
    updated_at: payment.updated_at,
  };
}
