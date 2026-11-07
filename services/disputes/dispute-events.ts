// path: services/disputes/dispute-events.ts
import { z } from "zod";
import {
  STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES,
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeWebhookSignature,
} from "../../lib/payments/adapters/stripe.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import {
  DISPUTE_EVENT_ID_MAXIMUM_LENGTH,
  DISPUTE_PROVIDER_STATUSES,
  DISPUTE_RULES,
  DISPUTE_WEBHOOK_MAXIMUM_BODY_BYTES,
  disputeMinorFromProviderHundredths,
  type DisputeStatus,
} from "./dispute-fields.ts";

/**
 * What a provider's dispute delivery says, in this platform's words.
 *
 * ## Why the envelope is neutral
 *
 * Stripe, Airwallex and Rainforest all tell a merchant that a payment was disputed, and each of them says
 * it in its own JSON: Stripe sends `charge.dispute.created` with `data.object.amount` in cents, Airwallex
 * sends a `DISPUTE` webhook with a `dispute_id`, and Rainforest signs a body this build has not confirmed.
 * A service that read any one of those inside its own `if` would have to grow a second `if` for the second
 * provider and a third for the third, and the status machine would end up with three subtly different
 * versions. So this module is the boundary: one provider-specific reader per provider, each answering one
 * neutral {@link DisputeEvent}, and the service behind it never learns which processor spoke.
 *
 * ## Why a reader never throws
 *
 * A provider's body is untrusted input. `read` answers a verdict - an event, or the rule that refused it -
 * and the route turns that into a status code. A thrown `SyntaxError` from `JSON.parse` on a hostile body
 * would be an unhandled rejection in a route handler, which is the one thing a public endpoint must not do.
 *
 * ## What is deliberately not here
 *
 * No signature verification and no storage. `verify` is a pure function of the raw body, the headers and
 * the secret the caller already opened, so the encryption work stays in `lib/auth/settings.ts` and
 * `lib/payments/adapters/stripe.ts`; and nothing here writes.
 */

/** What one delivery asks the platform to do with the dispute it names. */
export const DISPUTE_EVENT_KINDS = deepFreeze([
  "opened",
  "updated",
  "closed",
  "funds_withdrawn",
  "funds_reinstated",
  "ignored",
] as const);

export type DisputeEventKind = (typeof DISPUTE_EVENT_KINDS)[number];

/** One neutral dispute delivery. Every field is optional-in-fact, and `null` says "the provider did not". */
export interface DisputeEvent {
  /** The `payment_providers.provider_key` this endpoint belongs to. */
  readonly providerKey: string;
  /** `live` or `test`, from the provider's own flag, never from a query string. */
  readonly mode: "test" | "live";
  /** The provider's own id for the delivery, which is what makes a retry a no-op. */
  readonly externalEventId: string;
  /** The provider's type, kept for the event row and for an investigator. Never interpreted downstream. */
  readonly eventType: string;
  readonly kind: DisputeEventKind;
  /** The provider's id for the dispute itself, and the platform's idempotency key inside a merchant. */
  readonly processorDisputeId: string | null;
  /** The provider's reference for the payment, matched against `payments.provider_transaction_id`. */
  readonly paymentReference: string | null;
  /** The status this delivery asks for, or null when it asks for no status change at all. */
  readonly status: DisputeStatus | null;
  /** The processor's reason code, which `0039` keeps as `reason_code`. */
  readonly reasonCode: string | null;
  /** The disputed amount, in platform minor units, or null when the delivery does not say. */
  readonly amountMinor: bigint | null;
  /** Three upper case letters, or null when the delivery does not say. */
  readonly currency: string | null;
  /** When the processor opened the dispute, in epoch milliseconds, or null. */
  readonly openedAtEpochMs: number | null;
  /** The sentence the platform keeps as the outcome of a decided dispute, or null. */
  readonly outcomeNote: string | null;
}

/** The verdict of reading one body. */
export type DisputeEventRead =
  | { readonly ok: true; readonly event: DisputeEvent }
  | { readonly ok: false; readonly rule: string };

/** The verdict of verifying one body's signature. `reason` never carries the secret or the signature. */
export type DisputeSignatureRead =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly reason: string };

/** The headers a delivery arrives with, lower cased by the runtime that read them. */
export type DisputeWebhookHeaders = ReadonlyMap<string, string>;

/** One provider this platform receives dispute deliveries from. */
export interface DisputeEventSource {
  /** `payment_providers.provider_key`, the key `0032`'s event row is written under. */
  readonly providerKey: string;
  /** The route the provider posts to. Stated here so the gate can compare it with the file on disk. */
  readonly webhookPath: string;
  /** The `platform_settings` key holding the endpoint's signing secret. */
  readonly secretSettingKey: string;
  /** The header that carries the signature, for the refusal message and for the route's reading. */
  readonly signatureHeader: string;
  /** Read one body, with the clock the row will be stamped with. */
  readonly read: (rawBody: string, receivedAtEpochMs: number) => DisputeEventRead;
  /** Verify one body's signature against the endpoint's secret. */
  readonly verify: (
    rawBody: string,
    headers: DisputeWebhookHeaders,
    secret: string,
    nowEpochMs: number,
  ) => DisputeSignatureRead;
}

/* -------------------------------------------------------------------------------------------------
 * Stripe: `charge.dispute.*`
 * ---------------------------------------------------------------------------------------------- */

/** The provider key of Stripe Connect in `payment_providers_key_check`. */
export const STRIPE_CONNECT_PROVIDER_KEY = "stripe_connect";

/** The endpoint this build mounts for Stripe's dispute deliveries. */
export const STRIPE_DISPUTE_WEBHOOK_PATH = "/api/webhooks/stripe/disputes";

/** The `platform_settings` secret the endpoint verifies against, in the registry's dotted key shape. */
export const STRIPE_DISPUTE_SECRET_SETTING = "gateway.stripe_connect.webhook_secret";

/** The header Stripe signs a delivery in. */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** The `evt_` id shape this endpoint accepts, so a delivery without one is refused rather than applied twice. */
export const STRIPE_DISPUTE_EVENT_PATTERN = /^evt_[A-Za-z0-9]{8,64}$/u;

/**
 * The documented dispute events, and what each one means here.
 *
 * `charge.dispute.created` opens a row, `charge.dispute.updated` says the processor is looking at it, and
 * `charge.dispute.closed` decides it. The two `funds_*` events move money rather than a status, so they are
 * recorded and ignored: the debit they describe belongs to the ledger posting of section 18, which is a
 * later STEP's, and a status machine that treated a withdrawal as a decision would date the outcome wrong.
 */
export const STRIPE_DISPUTE_EVENT_KINDS: Readonly<Record<string, DisputeEventKind>> = deepFreeze({
  "charge.dispute.created": "opened",
  "charge.dispute.updated": "updated",
  "charge.dispute.closed": "closed",
  "charge.dispute.funds_withdrawn": "funds_withdrawn",
  "charge.dispute.funds_reinstated": "funds_reinstated",
});

/** The prefix every Stripe event this endpoint cares about shares. */
export const STRIPE_DISPUTE_EVENT_PREFIX = "charge.dispute.";

/**
 * Stripe's own dispute outcome to this platform's three terminal statuses.
 *
 * `won` and `lost` are the two the processor decides. Everything else - `warning_closed`, and any status a
 * later API version adds - closes the row without a winner, which is the honest third answer `0039` keeps
 * as `closed`, rather than pretending a warning was a loss.
 */
export function stripeDisputeStatusOf(objectStatus: string): DisputeStatus {
  if (objectStatus === "won") {
    return "won";
  }

  if (objectStatus === "lost") {
    return "lost";
  }

  return "closed";
}

/** The status a delivery of each kind asks for, before the row's own state is considered. */
export function stripeDisputeTargetOf(kind: DisputeEventKind, objectStatus: string): DisputeStatus | null {
  switch (kind) {
    case "opened":
      return "open";
    case "updated":
      return "under_review";
    case "closed":
      return stripeDisputeStatusOf(objectStatus);
    default:
      return null;
  }
}

const stripeDisputeObjectSchema = z.looseObject({
  id: z.string().min(3).max(160),
  object: z.string().optional(),
  charge: z.string().min(3).max(160).nullish(),
  payment_intent: z.string().min(3).max(160).nullish(),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(8),
  reason: z.string().min(1).max(48).nullish(),
  status: z.string().min(2).max(48),
  created: z.number().int().nonnegative().nullish(),
  evidence_details: z
    .looseObject({ due_by: z.number().int().nonnegative().nullish() })
    .nullish(),
});

const stripeEventEnvelopeSchema = z.looseObject({
  id: z.string().min(3).max(DISPUTE_EVENT_ID_MAXIMUM_LENGTH),
  object: z.string().optional(),
  type: z.string().min(3).max(120),
  livemode: z.boolean(),
  created: z.number().int().nonnegative().nullish(),
  data: z.looseObject({ object: z.unknown().optional() }),
});

/** The one sentence this platform keeps as the outcome of a dispute the processor decided. */
export function stripeOutcomeNote(status: DisputeStatus): string {
  return `The processor closed the dispute: ${status}.`;
}

/**
 * Read one Stripe delivery.
 *
 * Three refusals and no more: the body must be JSON, the envelope must be the documented one, and the
 * event id must be the `evt_` shape this endpoint can deduplicate on. A *verified* event of a type that is
 * not a dispute is not a refusal - it is read as `ignored`, stored, acknowledged with `200`, because a
 * non-2xx answer makes Stripe retry the same body until its own window closes.
 */
export function readStripeDisputeEvent(rawBody: string, receivedAtEpochMs: number): DisputeEventRead {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return { ok: false, rule: DISPUTE_RULES.bodyInvalid };
  }

  const envelope = stripeEventEnvelopeSchema.safeParse(parsed);

  if (!envelope.success) {
    return { ok: false, rule: DISPUTE_RULES.bodyInvalid };
  }

  const eventId = envelope.data.id.trim();

  if (!STRIPE_DISPUTE_EVENT_PATTERN.test(eventId)) {
    return { ok: false, rule: DISPUTE_RULES.eventIdInvalid };
  }

  const eventType = envelope.data.type.trim();
  const mode = envelope.data.livemode ? "live" : "test";
  const kind = STRIPE_DISPUTE_EVENT_KINDS[eventType] ?? "ignored";

  if (kind === "ignored") {
    return {
      ok: true,
      event: {
        providerKey: STRIPE_CONNECT_PROVIDER_KEY,
        mode,
        externalEventId: eventId,
        eventType,
        kind,
        processorDisputeId: null,
        paymentReference: null,
        status: null,
        reasonCode: null,
        amountMinor: null,
        currency: null,
        openedAtEpochMs: null,
        outcomeNote: null,
      },
    };
  }

  const dispute = stripeDisputeObjectSchema.safeParse(envelope.data.data.object);

  if (!dispute.success) {
    return { ok: false, rule: DISPUTE_RULES.bodyInvalid };
  }

  const object = dispute.data;
  const target = stripeDisputeTargetOf(kind, object.status);
  const currency = object.currency.trim().toUpperCase();
  const reason = object.reason?.trim() ?? null;
  const paymentReference = (object.charge ?? object.payment_intent ?? "").trim();

  if (target !== null && !(DISPUTE_PROVIDER_STATUSES as readonly string[]).includes(target)) {
    return { ok: false, rule: DISPUTE_RULES.statusNotFromProvider };
  }

  return {
    ok: true,
    event: {
      providerKey: STRIPE_CONNECT_PROVIDER_KEY,
      mode,
      externalEventId: eventId,
      eventType,
      kind,
      processorDisputeId: object.id.trim(),
      paymentReference: paymentReference.length === 0 ? null : paymentReference,
      status: target,
      reasonCode: reason,
      amountMinor: disputeMinorFromProviderHundredths(object.amount),
      currency: /^[A-Z]{3}$/u.test(currency) ? currency : null,
      // The processor's own opening instant when it sends one. `data.object.created` is what section 19's
      // 24-hour window runs from, and a body that omits it is dated by the delivery instead of by nothing:
      // `0039` requires the instant, and the deadline arithmetic needs one.
      openedAtEpochMs: object.created === undefined || object.created === null ? receivedAtEpochMs : object.created * 1_000,
      outcomeNote: target !== null && (target === "won" || target === "lost" || target === "closed")
        ? stripeOutcomeNote(target)
        : null,
    },
  };
}

/**
 * Verify one Stripe delivery against the endpoint's signing secret.
 *
 * The verifier is STEP 161's `t=` + `v1` HMAC with its documented five-minute tolerance, and it is not
 * re-implemented here: a second copy of a signature check is a second chance to get the comparison, the
 * tolerance or the timestamp wrong. What this function adds is only the *shape* the neutral source needs.
 */
export function verifyStripeDisputeSignature(
  rawBody: string,
  headers: DisputeWebhookHeaders,
  secret: string,
  nowEpochMs: number,
): DisputeSignatureRead {
  const header = headers.get(STRIPE_SIGNATURE_HEADER) ?? null;
  const verdict = verifyStripeWebhookSignature(rawBody, header, {
    secret,
    toleranceSeconds: STRIPE_SIGNATURE_TOLERANCE_SECONDS,
    nowSeconds: () => Math.floor(nowEpochMs / 1_000),
    maximumBodyBytes: Math.min(STRIPE_MAXIMUM_WEBHOOK_BODY_BYTES, DISPUTE_WEBHOOK_MAXIMUM_BODY_BYTES),
  });

  if (verdict.ok) {
    return { ok: true };
  }

  return { ok: false, rule: DISPUTE_RULES.signatureInvalid, reason: verdict.reason };
}

/* -------------------------------------------------------------------------------------------------
 * The registry
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every provider this platform receives dispute deliveries from.
 *
 * One entry, and the list is honest about it. NMI, Payoneer, Rainforest and Airwallex dispute webhooks are
 * adapter STEPs of their own (147-169) and only Stripe's delivery shape is documented in this build's
 * reference (`RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED` is false in its own adapter, and Airwallex's dispute
 * body is not described anywhere in `PROVIDER_DOCS.md`). A provider absent from this map is refused by the
 * route with `webhook_provider_unsupported`, which is a `404` a provider may retry after a deployment adds
 * it - rather than a silently empty dispute list.
 */
export const DISPUTE_EVENT_SOURCES: readonly DisputeEventSource[] = deepFreeze([
  {
    providerKey: STRIPE_CONNECT_PROVIDER_KEY,
    webhookPath: STRIPE_DISPUTE_WEBHOOK_PATH,
    secretSettingKey: STRIPE_DISPUTE_SECRET_SETTING,
    signatureHeader: STRIPE_SIGNATURE_HEADER,
    read: readStripeDisputeEvent,
    verify: verifyStripeDisputeSignature,
  },
]);

/** The source for one provider key, or null when this build does not receive its disputes. */
export function disputeEventSourceOf(providerKey: string): DisputeEventSource | null {
  return DISPUTE_EVENT_SOURCES.find((source) => source.providerKey === providerKey) ?? null;
}
