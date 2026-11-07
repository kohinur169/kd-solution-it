// path: services/disputes/dispute-webhook.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { isConflictError } from "../../lib/auth/rest.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import {
  applyDisputeEvent,
  findDisputePayment,
  findDisputeProvider,
  noteIgnoredDispute,
  type DisputeDependencies,
  type DisputePaymentRow,
} from "./dispute.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_RULES,
  DISPUTE_WEBHOOK_MAXIMUM_BODY_BYTES,
} from "./dispute-fields.ts";
import {
  disputeEventSourceOf,
  type DisputeEvent,
  type DisputeEventSource,
  type DisputeWebhookHeaders,
} from "./dispute-events.ts";

/**
 * The endpoint a processor posts a dispute to: verify, record, apply, answer - in that order, and never a
 * step skipped.
 *
 * ## Why the order is the whole design
 *
 * 1. **The signature first.** Nothing inside the body is read before the provider's own signature over the
 *    exact bytes has been verified against the endpoint's secret. The body is not re-serialised, because
 *    the signature is over the bytes that arrived, and a `JSON.parse`/`JSON.stringify` round trip changes
 *    them.
 * 2. **The endpoint's provider row next.** `0032`'s foreign key needs the `payment_providers` id, and a
 *    delivery for a provider this database does not have is refused with `404`. It is read after the
 *    signature, so an unverified body never makes this endpoint read a table.
 * 3. **The event row before any effect.** `0032`'s `webhook_events` is keyed by
 *    `(provider_id, mode, external_event_id)`, so writing the row *is* the idempotency claim: whichever
 *    delivery gets there first owns the effect, and a concurrent second one loses at the unique index
 *    instead of applying the same dispute twice.
 * 4. **The effect next.** The payment is resolved from the event's own reference, and the dispute is
 *    moved by `applyDisputeEvent`, which is the only writer of a dispute status in this build.
 * 5. **The outcome last.** The event row is settled to `processed` (or `ignored`, or `failed` with a
 *    reason), and only after the row it describes is settled, so a crash between the two leaves an event a
 *    later delivery can retry rather than a dispute nobody can account for.
 *
 * ## What it answers, and why
 *
 * `200` for anything that reached a verdict - including a duplicate, a stale status and an event this build
 * does not act on - because a non-2xx answer makes the provider redeliver a body the platform has already
 * understood. `401` for a signature that does not verify, `400` for a body that will never parse, `404` for
 * a provider this build does not receive disputes from, and `503` when a secret is missing or unreadable.
 * `500` is reserved for the one case where a redelivery can genuinely help: a verified dispute naming a
 * payment this database has no row for yet.
 *
 * ## What it does not do
 *
 * It does not decide a dispute, send evidence, write the chargeback fee, or post the ledger entry the
 * withdrawal of funds belongs to. Those are STEPs of their own; this module moves `public.disputes` and
 * writes the chain entry that says why.
 */

/** The settings reader, narrowed to what a receiver needs: one secret by key. */
export interface DisputeWebhookSettings {
  readSecret(key: string): Promise<string | null>;
}

/** What the receiver needs: the database, the chain, the settings and a clock. */
export interface DisputeWebhookDependencies extends DisputeDependencies {
  readonly settings: DisputeWebhookSettings;
  readonly now: () => number;
}

/** One delivery as it arrives: the provider the endpoint belongs to, the raw bytes and the headers. */
export interface DisputeWebhookDelivery {
  readonly providerKey: string;
  readonly rawBody: string;
  readonly headers: DisputeWebhookHeaders;
}

/** The state one delivery settled on, which is what a provider's log and an operator both read. */
export const DISPUTE_WEBHOOK_OUTCOMES = deepFreeze([
  "opened",
  "moved",
  "ignored",
  "duplicate",
  "unmatched",
] as const);

export type DisputeWebhookOutcome = (typeof DISPUTE_WEBHOOK_OUTCOMES)[number];

/** The body of a delivery that reached a verdict. */
export interface DisputeWebhookAccepted {
  readonly received: true;
  readonly outcome: DisputeWebhookOutcome;
  readonly eventId: string;
  readonly disputeId: string | null;
  readonly disputeStatus: string | null;
  readonly rule: string | null;
}

/** The body of a delivery that did not: a machine readable rule and a sentence that carries no secret. */
export interface DisputeWebhookRefused {
  readonly received: false;
  readonly rule: string;
  readonly reason: string;
}

/** What one delivery produced. `status` is the HTTP status the route answers with. */
export type DisputeWebhookResult =
  | { readonly status: 200; readonly body: DisputeWebhookAccepted }
  | { readonly status: 400 | 401 | 404 | 413 | 500 | 503; readonly body: DisputeWebhookRefused };

/** The row `0032` keeps, as this module writes and reads it. */
const webhookEventRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid().nullable(),
  status: z.string(),
  signature_ok: z.boolean(),
  received_at: z.string(),
  version: z.number(),
});

type WebhookEventRow = z.infer<typeof webhookEventRowSchema>;

const WEBHOOK_EVENT_COLUMNS = "select=id,company_id,status,signature_ok,received_at,version";

/** The SHA-256 of a body, which is what `webhook_events_payload_check` keeps instead of the body. */
export function disputePayloadHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/** A refusal with its HTTP status: the whole vocabulary of "this delivery did nothing". */
function refuse(
  status: 400 | 401 | 404 | 413 | 500 | 503,
  rule: string,
  reason: string,
): DisputeWebhookResult {
  return { status, body: { received: false, rule, reason } };
}

/**
 * Verify one delivery's signature and open its secret.
 *
 * Exported because it is one half of the route's identity decision: the audit gate refuses a mutating route
 * that names no identity primitive, and for a machine-to-machine endpoint the primitive *is* the signature
 * over the body. Naming this function in the route is that decision, made once and visible.
 */
export async function verifyProviderWebhookSignature(
  source: DisputeEventSource,
  input: { readonly rawBody: string; readonly headers: DisputeWebhookHeaders },
  dependencies: DisputeWebhookDependencies,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly result: DisputeWebhookResult }> {
  let secret: string | null;

  try {
    secret = await dependencies.settings.readSecret(source.secretSettingKey);
  } catch {
    return {
      ok: false,
      result: refuse(503, DISPUTE_RULES.secretMissing, "the signing secret could not be read"),
    };
  }

  if (secret === null || secret.trim().length === 0) {
    return {
      ok: false,
      result: refuse(503, DISPUTE_RULES.secretMissing, "this deployment holds no signing secret for that provider"),
    };
  }

  const verdict = source.verify(input.rawBody, input.headers, secret, dependencies.now());

  if (!verdict.ok) {
    return { ok: false, result: refuse(401, verdict.rule, verdict.reason) };
  }

  // The secret stops here. It is used once, inside `source.verify`, and is never returned to a caller, never
  // written to a row and never put in an answer or a chain entry.
  return { ok: true };
}

/** Find `0032`'s row for one event, or null. The unique index it is read under is the idempotency claim. */
async function findWebhookEvent(
  dependencies: DisputeWebhookDependencies,
  input: { readonly providerId: string; readonly mode: string; readonly externalEventId: string },
): Promise<WebhookEventRow | null> {
  const rows = await dependencies.rest.select(
    "webhook_events",
    `${WEBHOOK_EVENT_COLUMNS}&provider_id=eq.${input.providerId}` +
      `&mode=eq.${encodeURIComponent(input.mode)}` +
      `&external_event_id=eq.${encodeURIComponent(input.externalEventId)}` +
      "&deleted_at=is.null&limit=1",
    webhookEventRowSchema,
  );

  return rows[0] ?? null;
}

/** Settle one event row: the status, the instant it was processed and the reason it failed, if it did. */
async function settleWebhookEvent(
  dependencies: DisputeWebhookDependencies,
  row: WebhookEventRow,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  await dependencies.rest.update(
    "webhook_events",
    `id=eq.${row.id}&version=eq.${row.version}&deleted_at=is.null`,
    values,
  );
}

/** Mark an event row failed, keeping the reason under `webhook_events_failure_check`'s 280 characters. */
async function failWebhookEvent(
  dependencies: DisputeWebhookDependencies,
  row: WebhookEventRow,
  detail: string,
): Promise<void> {
  await settleWebhookEvent(dependencies, row, {
    status: "failed",
    failure_detail: detail.slice(0, 280),
    processed_at: null,
  });
}

/** Record a refusal in the chain: never the body, never the signature, never the secret. */
async function noteRefused(
  dependencies: DisputeWebhookDependencies,
  input: { readonly rule: string; readonly providerKey: string; readonly eventId: string | null },
): Promise<void> {
  await noteIgnoredDispute(dependencies, {
    action: DISPUTE_AUDIT.refused,
    rule: input.rule,
    webhookEventId: input.eventId ?? `${input.providerKey}:unrecorded`,
    companyId: null,
    disputeId: null,
  });
}

/**
 * Receive one dispute delivery.
 *
 * The steps are the numbered list in this module's header, in that order, and each one answers before the
 * next runs. Nothing here throws for input: a hostile body, a wrong signature and an unknown provider are
 * all verdicts, and the only way out of this function with an exception is a database or chain failure,
 * which the route turns into the platform's error envelope.
 */
export async function receiveDisputeWebhook(
  delivery: DisputeWebhookDelivery,
  dependencies: DisputeWebhookDependencies,
): Promise<DisputeWebhookResult> {
  const source = disputeEventSourceOf(delivery.providerKey);

  if (source === null) {
    await noteRefused(dependencies, {
      rule: DISPUTE_RULES.providerUnsupported,
      providerKey: delivery.providerKey,
      eventId: null,
    });

    return refuse(404, DISPUTE_RULES.providerUnsupported, "this deployment receives no dispute webhooks for that provider");
  }

  if (delivery.rawBody.length === 0) {
    return refuse(400, DISPUTE_RULES.bodyInvalid, "the delivery carries no body");
  }

  if (Buffer.byteLength(delivery.rawBody, "utf8") > DISPUTE_WEBHOOK_MAXIMUM_BODY_BYTES) {
    return refuse(413, DISPUTE_RULES.bodyTooLarge, "the delivery is larger than this receiver accepts");
  }

  // The signature, before the database is touched at all: a forged delivery costs one HMAC and no read.
  const verified = await verifyProviderWebhookSignature(source, delivery, dependencies);

  if (!verified.ok) {
    await noteRefused(dependencies, {
      rule: verified.result.status === 200 ? DISPUTE_RULES.signatureInvalid : verified.result.body.rule,
      providerKey: source.providerKey,
      eventId: null,
    });

    return verified.result;
  }

  const read = source.read(delivery.rawBody, dependencies.now());

  if (!read.ok) {
    await noteRefused(dependencies, {
      rule: read.rule,
      providerKey: source.providerKey,
      eventId: null,
    });

    return refuse(400, read.rule, "the delivery is not the envelope this endpoint documents");
  }

  const event = read.event;

  if (event.providerKey !== source.providerKey) {
    // The reader names its own provider, so this is a defect rather than an attack; refusing is still the
    // only safe answer, because the row would otherwise be written under the wrong provider's key.
    return refuse(400, DISPUTE_RULES.bodyInvalid, "the reader answered for another provider");
  }

  // The endpoint's provider row, which `0032`'s foreign key needs and which says whether this database has
  // the provider at all. It is read after the signature, so no unverified body can make this endpoint read
  // a table. A delivery is recorded whether the provider is enabled or not: a dispute is money the
  // processor has already taken back, and hiding it because a switch is off would be the worse answer.
  const provider = await findDisputeProvider(dependencies, source.providerKey);

  if (provider === null) {
    await noteRefused(dependencies, {
      rule: DISPUTE_RULES.providerUnknown,
      providerKey: source.providerKey,
      eventId: null,
    });

    return refuse(404, DISPUTE_RULES.providerUnknown, "no payment provider row carries that key");
  }

  return applyDelivery(dependencies, provider.id, event, delivery.rawBody);
}

/** The second half: the event row, the payment, the effect and the settled outcome. */
async function applyDelivery(
  dependencies: DisputeWebhookDependencies,
  providerId: string,
  event: DisputeEvent,
  rawBody: string,
): Promise<DisputeWebhookResult> {
  const existing = await findWebhookEvent(dependencies, {
    providerId,
    mode: event.mode,
    externalEventId: event.externalEventId,
  });

  if (existing !== null && existing.status !== "failed" && existing.status !== "processing") {
    await noteIgnoredDispute(dependencies, {
      action: DISPUTE_AUDIT.ignored,
      rule: "webhook_duplicate",
      webhookEventId: existing.id,
      companyId: existing.company_id,
      disputeId: null,
    });

    return {
      status: 200,
      body: {
        received: true,
        outcome: "duplicate",
        eventId: event.externalEventId,
        disputeId: null,
        disputeStatus: null,
        rule: "webhook_duplicate",
      },
    };
  }

  const row = existing ?? (await recordWebhookEvent(dependencies, providerId, event, rawBody));

  if (row === null) {
    // Two deliveries of one event raced the unique index. The one that lost has nothing to do.
    return {
      status: 200,
      body: {
        received: true,
        outcome: "duplicate",
        eventId: event.externalEventId,
        disputeId: null,
        disputeStatus: null,
        rule: "webhook_duplicate",
      },
    };
  }

  if (event.kind === "ignored") {
    await settleWebhookEvent(dependencies, row, { status: "ignored", processed_at: null, failure_detail: null });
    await noteIgnoredDispute(dependencies, {
      action: DISPUTE_AUDIT.ignored,
      rule: "dispute_event_unsupported",
      webhookEventId: row.id,
      companyId: null,
      disputeId: null,
    });

    return {
      status: 200,
      body: {
        received: true,
        outcome: "ignored",
        eventId: event.externalEventId,
        disputeId: null,
        disputeStatus: null,
        rule: "dispute_event_unsupported",
      },
    };
  }

  if (event.paymentReference === null) {
    await failWebhookEvent(dependencies, row, DISPUTE_RULES.paymentNotFound);
    await noteIgnoredDispute(dependencies, {
      action: DISPUTE_AUDIT.refused,
      rule: DISPUTE_RULES.paymentNotFound,
      webhookEventId: row.id,
      companyId: null,
      disputeId: null,
    });

    return {
      status: 200,
      body: {
        received: true,
        outcome: "unmatched",
        eventId: event.externalEventId,
        disputeId: null,
        disputeStatus: null,
        rule: DISPUTE_RULES.paymentNotFound,
      },
    };
  }

  const payment = await findDisputePayment(dependencies, {
    providerId,
    mode: event.mode,
    reference: event.paymentReference,
  });

  if (payment === null) {
    await failWebhookEvent(dependencies, row, DISPUTE_RULES.paymentNotFound);
    await noteIgnoredDispute(dependencies, {
      action: DISPUTE_AUDIT.refused,
      rule: DISPUTE_RULES.paymentNotFound,
      webhookEventId: row.id,
      companyId: null,
      disputeId: null,
    });

    // A retryable case: the capture that records `provider_transaction_id` may not have landed yet, and a
    // redelivery in a minute is a better answer than a dispute nobody can match to a payment.
    return refuse(500, DISPUTE_RULES.paymentNotFound, "the event names a payment this database does not have yet");
  }

  return applyToPayment(dependencies, row, event, payment);
}

/** The effect on the dispute itself, and the outcome the row records. */
async function applyToPayment(
  dependencies: DisputeWebhookDependencies,
  row: WebhookEventRow,
  event: DisputeEvent,
  payment: DisputePaymentRow,
): Promise<DisputeWebhookResult> {
  const outcome = await applyDisputeEvent(dependencies, {
    event,
    payment,
    webhookEventId: row.id,
  });

  if (outcome.kind === "refused") {
    await failWebhookEvent(dependencies, row, outcome.rule ?? DISPUTE_RULES.bodyInvalid);
    await noteIgnoredDispute(dependencies, {
      action: DISPUTE_AUDIT.refused,
      rule: outcome.rule ?? DISPUTE_RULES.bodyInvalid,
      webhookEventId: row.id,
      companyId: payment.company_id,
      disputeId: null,
    });

    return {
      status: 200,
      body: {
        received: true,
        outcome: "unmatched",
        eventId: event.externalEventId,
        disputeId: null,
        disputeStatus: null,
        rule: outcome.rule,
      },
    };
  }

  if (outcome.kind === "ignored") {
    // A stale status, a resolved row or a lost race: the delivery was correct and changed nothing. The event
    // row keeps the merchant the payment belongs to, because that is what the row is about.
    await settleWebhookEvent(dependencies, row, {
      status: "ignored",
      processed_at: null,
      failure_detail: null,
      company_id: row.company_id ?? payment.company_id,
    });
    await noteIgnoredDispute(dependencies, {
      action: DISPUTE_AUDIT.ignored,
      rule: outcome.rule ?? "dispute_event_ignored",
      webhookEventId: row.id,
      companyId: payment.company_id,
      disputeId: outcome.dispute?.id ?? null,
    });

    return {
      status: 200,
      body: {
        received: true,
        outcome: "ignored",
        eventId: event.externalEventId,
        disputeId: outcome.dispute?.id ?? null,
        disputeStatus: outcome.dispute?.status ?? null,
        rule: outcome.rule,
      },
    };
  }

  await settleWebhookEvent(dependencies, row, {
    status: "processed",
    processed_at: new Date(dependencies.now()).toISOString(),
    failure_detail: null,
    company_id: row.company_id ?? payment.company_id,
  });

  return {
    status: 200,
    body: {
      received: true,
      outcome: outcome.kind,
      eventId: event.externalEventId,
      disputeId: outcome.dispute?.id ?? null,
      disputeStatus: outcome.dispute?.status ?? null,
      rule: null,
    },
  };
}

/**
 * Write the event row, or answer null when another delivery of the same event won the race.
 *
 * `signature_ok: true` and `status: "processing"` is the only pair `webhook_events_signature_check` allows
 * before the effect has run, and the row is written *before* the effect on purpose: the unique index is the
 * lock, and a row that already exists is how the second delivery knows to do nothing.
 */
async function recordWebhookEvent(
  dependencies: DisputeWebhookDependencies,
  providerId: string,
  event: DisputeEvent,
  rawBody: string,
): Promise<WebhookEventRow | null> {
  try {
    const rows = await dependencies.rest.insertReturning(
      "webhook_events",
      [
        {
          company_id: null,
          provider_id: providerId,
          mode: event.mode,
          external_event_id: event.externalEventId,
          event_type: event.eventType,
          payload_hash: disputePayloadHash(rawBody),
          signature_ok: true,
          received_at: new Date(dependencies.now()).toISOString(),
          status: "processing",
        },
      ],
      webhookEventRowSchema,
    );

    return rows[0] ?? null;
  } catch (error) {
    if (isConflictError(error)) {
      return null;
    }

    throw error;
  }
}
