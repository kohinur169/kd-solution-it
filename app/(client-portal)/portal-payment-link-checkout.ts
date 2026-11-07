// path: app/(client-portal)/portal-payment-link-checkout.ts
import { createHash, randomUUID } from "node:crypto";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import type { PortalCardReferralQueue } from "./portal-fraud.ts";
import { PORTAL_FRAUD_RULES } from "./portal-fraud-fields.ts";
import { PORTAL_BLACKLIST_RULES } from "./portal-blacklist-fields.ts";
import { portalCardFingerprintOf } from "./portal-blacklist.ts";
import { PORTAL_VELOCITY_REFUSAL_FIELD, PORTAL_VELOCITY_RULES, portalVelocityRuleOf } from "./portal-velocity-fields.ts";
import { portalVelocityCardFingerprint } from "./portal-velocity.ts";
import {
  PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
  PORTAL_PAYMENT_LINK_CAPTURED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_DECLINED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_RULES,
  PORTAL_PAYMENT_LINK_UNKNOWN_AUDIT_ACTION,
} from "./portal-payment-link-fields.ts";
import { openPortalPaymentLink, type PortalPaymentLinkView } from "./portal-payment-link.ts";
import {
  parsePortalPaymentBody,
  type PortalChargeRequest,
  type PortalPaymentProcessor,
} from "./portal-payment.ts";
import {
  PORTAL_PAYMENT_AUDIT_ENTITY,
  PORTAL_PAYMENT_RULES,
  PORTAL_PAYMENT_SCRIPT_URL,
  portalPaymentChargeAmountOf,
} from "./portal-payment-fields.ts";
import type { PortalPartPaymentLimits } from "./portal-part-payment-fields.ts";
import type { PortalPaymentLinkDependencies } from "./portal-payment-link.ts";
import { portalMoneyTextOf } from "./portal-invoice-money.ts";

/**
 * The hosted checkout: the card a payer makes on a general payment link.
 *
 * ## What is shared with STEP 183, and what is not
 *
 * The **money** is the same operation: this module calls STEP 183's processor, so the three pre-charge checks
 * every payment page runs - STEP 186's fraud signal, STEP 187's card blacklist and STEP 188's card and address
 * counters - fire here too, unchanged and in the same order. The **document** is not: a general link names an
 * amount and a sentence, not an invoice, so the charge carries `invoiceId: null` (which `0037` allows, and which
 * is why `payments.invoice_id` is nullable) and the gateway's reference is the link's own id.
 *
 * ## Why a second charge path and not one parameterised one
 *
 * STEP 183's `chargePortalPayment` opens an invoice, reads its remaining, applies STEP 189's part-payment rules
 * and writes invoice-scoped audit payloads. A link has none of those facts, and threading `null` through them
 * would put a branch in every one of them - a branch a future STEP has to keep true. So the link has its own
 * service over the same ports, the same parser and the same refusal vocabulary, and the two share everything
 * that decides money rather than everything that decides wording.
 *
 * ## What a link payment leaves behind
 *
 * One `payments` row with no invoice, one audit entry under `portal.payment_link_*`, and - on capture - the
 * link's own row moved to `paid`. A failed, declined or unknown attempt never touches the link: it stays
 * `active`, because the payer may try again and the merchant has not been paid.
 */

/** What the checkout needs: the link's dependencies, the processor, and STEP 186's referral for a flagged card. */
export interface PortalPaymentLinkCheckoutDependencies extends PortalPaymentLinkDependencies {
  readonly processor: PortalPaymentProcessor | null;
  readonly referral?: PortalCardReferralQueue | null;
  /**
   * The merchant's public tokenization key, or null when the company has none configured.
   *
   * Optional because the charge does not need it: the page does, and a composition without it renders the
   * checkout's own "card payment is not available" panel rather than empty fields the provider would reject.
   */
  readonly tokenizationKeyFor?: (
    companyId: string,
  ) => { readonly apiKey: string; readonly environment: "sandbox" | "production" } | null;
}

/** Everything the hosted checkout page prints about one link. */
export interface PortalPaymentLinkCheckoutView {
  readonly link: PortalPaymentLinkView;
  /**
   * What this link takes in parts, which is all of it and nothing less.
   *
   * A general link names one amount and one sentence: there is no document to leave open, so the form renders
   * no amount field and STEP 189's floor does not apply. The shape is the form's, so the form needs no branch.
   */
  readonly partPayment: PortalPartPaymentLimits;
  /** The key this attempt carries, so a double submit is one payment and not two. */
  readonly idempotencyKey: string;
  /** The hosted fields, or null when the platform cannot take a card right now. */
  readonly secureFields: {
    readonly scriptUrl: string;
    readonly tokenizationKey: string;
    readonly environment: "sandbox" | "production";
  } | null;
  /** Why the page offers no form, or null when it does. */
  readonly unavailable: "provider" | "recorder" | null;
}

/** What a payer's request carries, and no browser may set the first three itself. */
export interface ChargePortalPaymentLinkInput {
  readonly token: string;
  readonly body: unknown;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  /** The merchant's own company when the actor is signed in, so a seller cannot pay their own link. */
  readonly actorCompanyId: string | null;
}

/** A captured payment on a link. */
export interface PortalPaymentLinkPaid {
  readonly status: "captured";
  readonly linkId: string;
  readonly companyId: string;
  readonly paymentId: string;
  readonly transactionId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly chargeAmount: string;
  readonly idempotencyKey: string;
  readonly capturedAt: string;
  /** True when the link had already taken a payment by the time this one was marked. */
  readonly duplicate: boolean;
}

/** A refusal with the code and rule a screen maps to a sentence. */
function refused(code: "VALIDATION_FAILED" | "CONFLICT" | "SERVICE_UNAVAILABLE", field: string, rule: string): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/** One audit entry, written or not: a chain that is down never fails the payment it records. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate, and the same bargain every write in this repository makes: the record is the fact.
  }
}

/** The payload a link's audit entry carries: the link, the amount and the key's hash, never the card. */
function payloadOf(view: PortalPaymentLinkView, detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    link_id: view.linkId,
    description: view.description,
    reference: view.reference,
    amount_minor: view.amountMinor,
    charge_amount: view.chargeAmount,
    ...detail,
  };
}

/** The charge amount a link's own amount produces, refused when the provider cannot write it. */
function chargeAmountOf(view: PortalPaymentLinkView): string {
  const chargeAmount = portalPaymentChargeAmountOf(view.amountMinor);

  if (chargeAmount === null) {
    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.amountUnrepresentable);
  }

  return chargeAmount;
}

/**
 * Take one card payment on a general payment link.
 *
 * The order is the one a payer can act on: the link (verify, read, refuse a dead one), the merchant's own
 * session, the body with the card scan before the parse, the provider's cents, whether the platform can record
 * the money, and only then the operation.
 */
export async function chargePortalPaymentLink(
  input: ChargePortalPaymentLinkInput,
  dependencies: PortalPaymentLinkCheckoutDependencies,
): Promise<PortalPaymentLinkPaid> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const view = await openPortalPaymentLink({ token: input.token }, dependencies);

  if (input.actorCompanyId === view.companyId) {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
      entityId: view.linkId,
      payload: payloadOf(view, { rule: PORTAL_PAYMENT_LINK_RULES.selfPayment }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_LINK_RULES.selfPayment);
  }

  let parsed: ReturnType<typeof parsePortalPaymentBody>;

  try {
    parsed = parsePortalPaymentBody(input.body);
  } catch (error) {
    if (error instanceof AppError && error.details.some((detail) => detail.rule === PORTAL_PAYMENT_RULES.cardDataRefused)) {
      await appendTolerated(dependencies.audit, {
        action: PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
        actorUserId: null,
        entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
        entityId: view.linkId,
        payload: payloadOf(view, { rule: PORTAL_PAYMENT_RULES.cardDataRefused }),
        companyId: view.companyId,
        sessionId: null,
        ipAddress: input.clientAddress,
        userAgent: input.userAgent,
      });
    }

    throw error;
  }

  const chargeAmount = chargeAmountOf(view);
  const processor = dependencies.processor;

  if (processor === null || !processor.durable) {
    throw refused(
      "SERVICE_UNAVAILABLE",
      "payment",
      processor === null ? PORTAL_PAYMENT_RULES.providerUnavailable : PORTAL_PAYMENT_RULES.recorderUnavailable,
    );
  }

  const request: PortalChargeRequest = {
    companyId: view.companyId,
    invoiceId: null,
    number: null,
    amountMinor: view.amountMinor,
    chargeAmount,
    token: parsed.token,
    idempotencyKey: parsed.idempotencyKey,
    occurredAtEpochMs: nowMs,
    clientAddress: input.clientAddress,
    userAgent: input.userAgent,
  };

  const outcome = await processor.charge(request);

  if (outcome.status === "unavailable") {
    if (outcome.reason === "velocity") {
      throw refused("SERVICE_UNAVAILABLE", PORTAL_VELOCITY_REFUSAL_FIELD, PORTAL_VELOCITY_RULES.unavailable);
    }

    if (outcome.reason === "blacklist") {
      throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_BLACKLIST_RULES.unavailable);
    }

    throw refused(
      "SERVICE_UNAVAILABLE",
      "payment",
      outcome.reason === "provider" ? PORTAL_PAYMENT_RULES.providerUnavailable : PORTAL_PAYMENT_RULES.recorderUnavailable,
    );
  }

  if (outcome.status === "captured") {
    const capturedAt = new Date(nowMs).toISOString();
    const marked = await dependencies.store.markPaid({
      id: view.linkId,
      companyId: view.companyId,
      paymentId: outcome.paymentId,
      paidAtEpochMs: nowMs,
    });

    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_LINK_CAPTURED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
      entityId: view.linkId,
      payload: payloadOf(view, {
        payment_id: outcome.paymentId,
        transaction_id: outcome.transactionId,
        idempotency_key_hash: idempotencyHashOf(parsed.idempotencyKey),
        // A second payment on a link that was already paid is a refund problem, not a hidden one: it is
        // recorded here, and the handoff names the two-phase claim a later STEP's table would need.
        duplicate_link_payment: marked !== "changed",
        entity: PORTAL_PAYMENT_AUDIT_ENTITY,
        captured_at: capturedAt,
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    return {
      status: "captured",
      linkId: view.linkId,
      companyId: view.companyId,
      paymentId: outcome.paymentId,
      transactionId: outcome.transactionId,
      amountMinor: view.amountMinor,
      amountText: portalMoneyTextOf(view.currency, view.amountMinor),
      chargeAmount,
      idempotencyKey: parsed.idempotencyKey,
      capturedAt,
      duplicate: marked !== "changed",
    };
  }

  if (outcome.status === "declined") {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_LINK_DECLINED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
      entityId: view.linkId,
      payload: payloadOf(view, { payment_id: outcome.paymentId, decline_code: outcome.code }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("VALIDATION_FAILED", "collectjs_token", "card_declined");
  }

  if (outcome.status === "refused_by_velocity") {
    const rule = portalVelocityRuleOf(outcome.limited.subject);

    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
      entityId: view.linkId,
      payload: payloadOf(view, {
        rule,
        subject: outcome.limited.subject,
        hits: outcome.limited.hits,
        limit: outcome.limited.limit,
        window_seconds: outcome.limited.windowSeconds,
        retry_after_seconds: outcome.limited.retryAfterSeconds,
        card_fingerprint: outcome.limited.subject === "card" ? portalVelocityCardFingerprint(parsed.token) : null,
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw new AppError("RATE_LIMITED", {
      retryAfterSeconds: outcome.limited.retryAfterSeconds,
      details: [{ field: PORTAL_VELOCITY_REFUSAL_FIELD, rule }],
    });
  }

  if (outcome.status === "refused_by_blacklist") {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
      entityId: view.linkId,
      payload: payloadOf(view, {
        rule: PORTAL_BLACKLIST_RULES.blocked,
        card_fingerprint: portalCardFingerprintOf(parsed.token.trim()),
        fingerprint_source: "card_token",
        block_reason: outcome.block?.reason ?? null,
        block_source: outcome.block?.source ?? null,
        replayed: outcome.replayed,
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("VALIDATION_FAILED", "payment", PORTAL_BLACKLIST_RULES.blocked);
  }

  if (outcome.status === "refused_by_risk") {
    // Section 18's first sentence, on this surface: a provider fraud signal rejects the payment at once. The
    // compliance referral STEP 186 writes is opened against a document, and a link has none - the handoff names
    // that gap rather than inventing a case against a row that does not exist.
    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
      entityId: view.linkId,
      payload: payloadOf(view, {
        rule: outcome.decision === "reject" ? PORTAL_FRAUD_RULES.rejected : PORTAL_FRAUD_RULES.suspicious,
        provider_code: outcome.code,
        decision: outcome.decision,
        referral_owner: null,
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw outcome.decision === "reject"
      ? refused("VALIDATION_FAILED", "payment", PORTAL_FRAUD_RULES.rejected)
      : refused("CONFLICT", "payment", PORTAL_FRAUD_RULES.suspicious);
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_PAYMENT_LINK_UNKNOWN_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
    entityId: view.linkId,
    payload: payloadOf(view, { payment_id: outcome.paymentId, unknown_reason: outcome.reason, reconcile: true }),
    companyId: view.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
  });

  throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.outcomeUnknown);
}

/** A hash of the idempotency key, so the chain can correlate attempts without storing the key. */
function idempotencyHashOf(idempotencyKey: string): string {
  return createHash("sha256").update(`portal_payment_link\n${idempotencyKey}`, "utf8").digest("hex");
}

/**
 * What the hosted checkout page needs to render one link, or a refusal.
 *
 * The order is the payer's: the link first, because a dead one is answered by the page's own notice rather
 * than by a form; then the two facts about this deployment - a key to tokenize a card with, and a payment
 * operation that records what it charges. Both are read here rather than in the page, so the page and the
 * charge agree about which of the three states they are in: a business with no gateway, a platform that
 * cannot record, or a payable link.
 *
 * The idempotency key is fresh on every render for the same reason STEP 183's is: the form sends it back, so
 * a second submit finds the payment the first one made instead of charging the card twice.
 */
export async function preparePortalPaymentLinkCheckout(
  input: { readonly token: string },
  dependencies: PortalPaymentLinkCheckoutDependencies,
): Promise<PortalPaymentLinkCheckoutView> {
  const link = await openPortalPaymentLink({ token: input.token }, dependencies);
  const tokenization =
    dependencies.tokenizationKeyFor === undefined ? null : dependencies.tokenizationKeyFor(link.companyId);
  const secureFields =
    tokenization === null
      ? null
      : {
          scriptUrl: PORTAL_PAYMENT_SCRIPT_URL,
          tokenizationKey: tokenization.apiKey,
          environment: tokenization.environment,
        };
  const unavailable: "provider" | "recorder" | null =
    tokenization === null
      ? "provider"
      : dependencies.processor === null || !dependencies.processor.durable
        ? "recorder"
        : null;

  return {
    link,
    partPayment: {
      remainingMinor: link.amountMinor,
      minimumMinor: null,
      allowPartial: false,
      remainingText: link.amountText,
      minimumText: null,
      currency: link.currency,
    },
    idempotencyKey: randomUUID(),
    secureFields,
    unavailable,
  };
}
