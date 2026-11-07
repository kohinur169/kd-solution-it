// path: app/(client-portal)/portal-fraud.ts
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { FraudProviderSignal } from "../../lib/security/fraud.ts";
import {
  PORTAL_FRAUD_AUDIT_ENTITY,
  PORTAL_FRAUD_FAILURE_CODE,
  PORTAL_FRAUD_REJECTED_AUDIT_ACTION,
  PORTAL_FRAUD_REJECT_DECISION,
  PORTAL_FRAUD_REVIEW_DECISION,
  PORTAL_FRAUD_RULES,
  PORTAL_FRAUD_SIGNAL_AUDIT_ACTION,
  PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION,
  portalFraudPayloadOf,
  type PortalFraudDecision,
} from "./portal-fraud-fields.ts";

/**
 * What happens to a payment the gateway flagged: the refusal, the review, and the card's referral.
 *
 * ## Where the signal is read
 *
 * The gateway's answer is read in `portal-payment-processor.ts`, because that is the one place a charge's answer
 * is parsed, and the decision it produces travels out of the processor as an outcome rather than as a thrown
 * error - so the settlement of the payment record and the answer to the payer are the same fact. This module is
 * the *consequences*: the chain entries and the referral.
 *
 * ## Why the referral is a port
 *
 * Section 18's next sentence is "card blacklist entries use card token or provider card fingerprint", and that
 * list is STEP 187's table. A portal page that wrote it would be a second writer of a risk list, so a flagged
 * card is *referred* here through an injected queue, with the honest in-memory implementation saying
 * `durable: false`. A referral that cannot be kept is reported in the chain and never blocks the refusal: the
 * money not moving is the important half, and it does not depend on the list.
 */

/** What a referral carries: the token this platform saw, never the card behind it. */
export interface PortalCardReferral {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly token: string;
  readonly providerSignal: FraudProviderSignal;
  readonly responseCode: string | null;
  readonly occurredAtEpochMs: number;
}

/** What referring answered. */
export type PortalCardReferred =
  | { readonly status: "referred"; readonly referralId: string }
  | {
      readonly status: "refused";
      /**
       * Why the card is not on the list. `actor_required` is STEP 187's: `card_blacklist.blacklisted_by`
       * references `public.users`, so an automatic referral can propose a block but a person has to confirm it.
       * `write_failed` is a list that refused the write.
       */
      readonly reason: "queue_unavailable" | "queue_not_durable" | "actor_required" | "write_failed";
    };

/** The list a flagged card goes on, as this page sees it. */
export interface PortalCardReferralQueue {
  /** True when a referral survives the request. */
  readonly durable: boolean;
  refer(card: PortalCardReferral): Promise<PortalCardReferred>;
}

/** The chain this module writes to. */
export interface PortalFraudDependencies {
  readonly audit: AuditTrail;
  readonly referral: PortalCardReferralQueue | null;
  readonly now?: () => number;
}

/** A chain link that is written if it can be, and never fails the decision it records. */
async function appendTolerated(
  audit: AuditTrail,
  entry: Parameters<AuditTrail["append"]>[0],
): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The refusal is the fact; an audit sink that cannot be reached must not turn a refused
    // payment into a page that never answered.
  }
}

/**
 * Record what the gateway said, before anything is decided.
 *
 * One entry per flagged answer, naming the signal, the code and its documented meaning. It is written for a
 * `suspicious` answer as well as a fraudulent one, because "the issuer asked us to call" is the kind of fact an
 * operator wants in the chain even when the payment is merely held.
 */
export async function recordPortalProviderSignal(
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly paymentId: string | null;
    readonly signal: FraudProviderSignal;
    readonly responseCode: string | null;
    readonly amountMinor: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: PortalFraudDependencies,
): Promise<void> {
  const decision = input.signal === "fraud" ? PORTAL_FRAUD_REJECT_DECISION : PORTAL_FRAUD_REVIEW_DECISION;

  await appendTolerated(dependencies.audit, {
    action: PORTAL_FRAUD_SIGNAL_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_FRAUD_AUDIT_ENTITY,
    entityId: input.paymentId ?? input.invoiceId,
    payload: portalFraudPayloadOf({
      invoiceId: input.invoiceId,
      paymentId: input.paymentId,
      signal: input.signal,
      decision,
      responseCode: input.responseCode,
      amountMinor: input.amountMinor,
    }),
    companyId: input.companyId,
    sessionId: null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}

/**
 * Refer the card behind a token to the blacklist, and say whether the list took it.
 *
 * The token is what this platform has; the card is the gateway's. Section 18 allows exactly that - "card token
 * or provider card fingerprint" - so no fingerprint is invented here and no card detail is asked for.
 */
export async function referPortalCard(
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly paymentId: string | null;
    readonly token: string;
    readonly signal: FraudProviderSignal;
    readonly responseCode: string | null;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: PortalFraudDependencies,
): Promise<PortalCardReferred> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const queue = dependencies.referral;

  const referred: PortalCardReferred =
    queue === null || !queue.durable
      ? { status: "refused", reason: queue === null ? "queue_unavailable" : "queue_not_durable" }
      : await queue.refer({
          companyId: input.companyId,
          invoiceId: input.invoiceId,
          paymentId: input.paymentId,
          token: input.token,
          providerSignal: input.signal,
          responseCode: input.responseCode,
          occurredAtEpochMs: nowMs,
        });

  await appendTolerated(dependencies.audit, {
    action: PORTAL_FRAUD_REJECTED_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_FRAUD_AUDIT_ENTITY,
    entityId: input.paymentId ?? input.invoiceId,
    payload: {
      invoice_id: input.invoiceId,
      payment_id: input.paymentId,
      rule: PORTAL_FRAUD_RULES.rejected,
      failure_code: PORTAL_FRAUD_FAILURE_CODE,
      card_referred: referred.status === "referred",
      ...(referred.status === "referred"
        ? { referral_id: referred.referralId }
        : { referral_rule: PORTAL_FRAUD_RULES.referralUnavailable }),
      // A rejected card is never charged again by this page, whichever way the payer retries.
      retry_permitted: false,
    },
    companyId: input.companyId,
    sessionId: null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return referred;
}

/**
 * The whole consequence of a flagged payment, in one call.
 *
 * A `reject` writes the chain and refers the card; a `review` writes the chain and names the desk. Both answer
 * the decision back, so the caller refuses with the same words the record holds.
 */
export async function handlePortalProviderSignal(
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly paymentId: string | null;
    readonly token: string;
    readonly signal: FraudProviderSignal;
    readonly responseCode: string | null;
    readonly amountMinor: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: PortalFraudDependencies,
): Promise<{ readonly decision: PortalFraudDecision; readonly referred: PortalCardReferred | null }> {
  const decision: PortalFraudDecision =
    input.signal === "fraud" ? PORTAL_FRAUD_REJECT_DECISION : PORTAL_FRAUD_REVIEW_DECISION;

  // The signal itself, first, whichever way it is decided: "the issuer said this card is stolen" is a fact
  // worth having even when the payment is merely held.
  await recordPortalProviderSignal(
    {
      companyId: input.companyId,
      invoiceId: input.invoiceId,
      paymentId: input.paymentId,
      signal: input.signal,
      responseCode: input.responseCode,
      amountMinor: input.amountMinor,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    dependencies,
  );

  if (decision === "review") {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_FRAUD_SUSPICIOUS_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_FRAUD_AUDIT_ENTITY,
      entityId: input.paymentId ?? input.invoiceId,
      payload: portalFraudPayloadOf({
        invoiceId: input.invoiceId,
        paymentId: input.paymentId,
        signal: input.signal,
        decision,
        responseCode: input.responseCode,
        amountMinor: input.amountMinor,
      }),
      companyId: input.companyId,
      sessionId: null,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { decision, referred: null };
  }

  const referred = await referPortalCard(input, dependencies);

  return { decision, referred };
}
