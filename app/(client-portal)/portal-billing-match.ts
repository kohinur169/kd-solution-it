// path: app/(client-portal)/portal-billing-match.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  PORTAL_BILLING_AUDIT_ENTITY,
  PORTAL_BILLING_DECIDED_AUDIT_ACTION,
  PORTAL_BILLING_REVIEW_DECISION,
  PORTAL_BILLING_REVIEW_OWNER,
  PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION,
  PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION,
  PORTAL_BILLING_REVIEW_STATUS,
  PORTAL_BILLING_POSTAL_FIELD,
  PORTAL_BILLING_RULES,
  portalBillingMatchOf,
  portalBillingPostalCodeKey,
  portalBillingReviewPayloadOf,
  type PortalBillingFacts,
  type PortalBillingMatch,
} from "./portal-billing-match-fields.ts";

/**
 * Section 18's billing match, and the routing that follows when it fails.
 *
 * ## What this file is
 *
 * The two facts the capture rule needs, read from the places that own them: the billing postal code from the
 * client record the invoice was issued to, and the country of the payer's address from a resolver. Then one
 * comparison (`portalBillingMatchOf`, which is the whole rule) and one destination (`routePortalPaymentReview`),
 * because section 18's sentence has two halves and a platform that implements the first without the second
 * would silently drop the payments it could not verify.
 *
 * ## Why the facts are read rather than trusted
 *
 * The payer's postal code arrives in a request, and the browser could say anything - so it is normalised and
 * compared with the *client record*, never with another value from the same request. The country comes from a
 * resolver that answers about an address, never from a header or a form field, because a payer who could choose
 * their own country would make section 18's second condition a formality.
 *
 * ## Why a resolver is a port
 *
 * Nothing in this repository turns an IP address into a country: there is no geolocation database, no service
 * and no configuration for one, and inventing a lookup table in a portal file would be a second source of truth
 * about where somebody is. So the resolver is an injected operation with a documented contract, the production
 * wiring binds the honest absence (`noPortalCountryResolver`), and both facts fail closed: while it is absent,
 * `ipCountryMatched` is `false`, capture without 3D Secure is impossible, and every unverified payment is
 * reviewed. That is the same shape STEP 184 used for the bank, and for the same reason.
 *
 * ## Why the review queue is a port
 *
 * `payments` already has the destination - `status = 'under_review'`, `risk_decision = 'review'`, and an index
 * on the first - but the portal is not allowed to write the payments table: STEP 130/132's payment operation
 * owns it, and the review in the STEP 117-151 record says a portal writing money rows is a defect. So the queue
 * is a port, the in-memory implementation says `durable: false`, and a routing that cannot be recorded durably
 * is reported as unrouted rather than claimed. What never depends on the queue is the money: the decision not
 * to capture is made by the caller before this is consulted, so an unavailable queue means a payment that is
 * unverified and unqueued, never a payment that was captured.
 */

/** The client columns this comparison reads. Two facts, no name, no address. */
const PORTAL_CLIENT_TABLE = "clients";
const PORTAL_CLIENT_COLUMNS = "select=id,company_id,postal_code,country";

/** The row shape, strict: a client record with a column this module does not expect is not this module's row. */
const clientBillingRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
});

/**
 * Where a cardholder's connection appears to be.
 *
 * `available` is a fact about the deployment, and it is checked before the resolver is called so a page can
 * decide what to tell a payer without catching an error. `countryOf` answers an ISO 3166-1 alpha-2 code, or
 * `null` when the address is not in the resolver's data - which the comparison treats as a mismatch.
 */
export interface PortalCountryResolver {
  readonly available: boolean;
  countryOf(ipAddress: string): Promise<string | null>;
}

/** The review queue section 18 sends an unverified payment to. */
export interface PortalPaymentReviewQueue {
  /** True when a routed review survives the request. */
  readonly durable: boolean;
  /** Route one payment for manual review, or say why it could not be routed. */
  route(input: PortalPaymentReviewRequest): Promise<PortalPaymentReviewRouted>;
}

/** What a routing writes: the payment, the two facts and the desk. */
export interface PortalPaymentReviewRequest {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly challengeId: string | null;
  readonly amountMinor: string;
  readonly status: string;
  readonly riskDecision: string;
  readonly reviewOwner: string;
  readonly postalCodeMatched: boolean;
  readonly ipCountryMatched: boolean;
  readonly postalCodeReason: string;
  readonly countryReason: string;
  readonly occurredAtEpochMs: number;
}

/** What routing answered. */
export type PortalPaymentReviewRouted =
  | { readonly status: "routed"; readonly reviewId: string }
  | { readonly status: "refused"; readonly reason: "queue_unavailable" | "queue_not_durable" };

/** What this service needs: the platform's rows, the audit chain, and the two ports. */
export interface PortalBillingMatchDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly resolver: PortalCountryResolver | null;
  readonly queue: PortalPaymentReviewQueue | null;
  readonly now?: () => number;
}

/** A chain link that is written if it can be, and never fails the money it records. */
async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The decision is the fact; an audit sink that cannot be reached must not turn a reviewed
    // payment into a page that never answered.
  }
}

/**
 * The billing facts on the client an invoice was issued to.
 *
 * One tenant-scoped read, and `null` when the row is not there: an invoice whose client record has been deleted
 * has no billing facts, which is a mismatch on both halves rather than an error a payer could ever fix.
 */
export async function readPortalBillingFacts(
  input: { readonly companyId: string; readonly clientId: string },
  dependencies: PortalBillingMatchDependencies,
): Promise<PortalBillingFacts | null> {
  const rows = await dependencies.rest.select(
    PORTAL_CLIENT_TABLE,
    `${PORTAL_CLIENT_COLUMNS}&company_id=eq.${input.companyId}&id=eq.${input.clientId}&deleted_at=is.null&limit=1`,
    clientBillingRowSchema,
  );

  const row = rows[0];

  return row === undefined ? null : { postalCode: row.postal_code, country: row.country };
}

/**
 * Decide whether section 18's billing match holds for one payment attempt.
 *
 * Two reads - the client's facts and the resolver's answer - and one comparison. `countryResolved` is carried
 * out of the resolver step rather than inferred from a `null` country, because "the resolver looked and did not
 * find this address" and "there is no resolver" are different facts for the audit and the reviewer, and both
 * are still a mismatch.
 */
export async function evaluatePortalBillingMatch(
  input: {
    readonly companyId: string;
    readonly clientId: string;
    readonly payerPostalCode: string | null;
    readonly payerIpAddress: string;
  },
  dependencies: PortalBillingMatchDependencies,
): Promise<PortalBillingMatch> {
  const facts = await readPortalBillingFacts(
    { companyId: input.companyId, clientId: input.clientId },
    dependencies,
  );

  const resolver = dependencies.resolver;

  if (resolver === null || !resolver.available) {
    return portalBillingMatchOf(
      { payerPostalCode: input.payerPostalCode, payerCountry: null, facts },
      { countryResolved: false },
    );
  }

  let country: string | null;

  try {
    country = await resolver.countryOf(input.payerIpAddress);
  } catch {
    // A resolver that fails is a resolver that could not say where the payer is, which is a mismatch and not a
    // refusal of the payment: the caller reviews it, exactly as section 18 says.
    country = null;
  }

  return portalBillingMatchOf(
    { payerPostalCode: input.payerPostalCode, payerCountry: country, facts },
    { countryResolved: true },
  );
}

/**
 * Route an unverified payment to the compliance desk, and write the decision into the chain.
 *
 * The audit entry is written either way - a payment that should be reviewed is a fact whether or not there is a
 * queue to put it in - and the return value says which happened, so a caller can tell a payer "your payment is
 * being checked" without claiming that a human has seen it.
 */
export async function routePortalPaymentReview(
  input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly paymentId: string | null;
    readonly challengeId: string | null;
    readonly amountMinor: string;
    readonly match: PortalBillingMatch;
    readonly ipAddress: string;
    readonly userAgent: string | null;
  },
  dependencies: PortalBillingMatchDependencies,
): Promise<PortalPaymentReviewRouted> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const queue = dependencies.queue;

  const routed: PortalPaymentReviewRouted =
    queue === null || !queue.durable
      ? { status: "refused", reason: queue === null ? "queue_unavailable" : "queue_not_durable" }
      : await queue.route({
          companyId: input.companyId,
          invoiceId: input.invoiceId,
          paymentId: input.paymentId,
          challengeId: input.challengeId,
          amountMinor: input.amountMinor,
          status: PORTAL_BILLING_REVIEW_STATUS,
          riskDecision: PORTAL_BILLING_REVIEW_DECISION,
          reviewOwner: PORTAL_BILLING_REVIEW_OWNER,
          postalCodeMatched: input.match.postalCodeMatched,
          ipCountryMatched: input.match.ipCountryMatched,
          postalCodeReason: input.match.postalCodeReason,
          countryReason: input.match.countryReason,
          occurredAtEpochMs: nowMs,
        });

  await appendTolerated(dependencies.audit, {
    action: PORTAL_BILLING_DECIDED_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_BILLING_AUDIT_ENTITY,
    entityId: input.paymentId ?? input.challengeId ?? input.invoiceId,
    payload: portalBillingReviewPayloadOf({
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      paymentId: input.paymentId,
      challengeId: input.challengeId,
      match: input.match,
    }),
    companyId: input.companyId,
    sessionId: null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  await appendTolerated(dependencies.audit, {
    action:
      routed.status === "routed"
        ? PORTAL_BILLING_REVIEW_ROUTED_AUDIT_ACTION
        : PORTAL_BILLING_REVIEW_REFUSED_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_BILLING_AUDIT_ENTITY,
    entityId: routed.status === "routed" ? routed.reviewId : (input.paymentId ?? input.invoiceId),
    payload: {
      invoice_id: input.invoiceId,
      review_owner: PORTAL_BILLING_REVIEW_OWNER,
      status: PORTAL_BILLING_REVIEW_STATUS,
      risk_decision: PORTAL_BILLING_REVIEW_DECISION,
      ...(routed.status === "routed"
        ? { review_id: routed.reviewId }
        : {
            rule:
              routed.reason === "queue_unavailable"
                ? PORTAL_BILLING_RULES.reviewQueueUnavailable
                : PORTAL_BILLING_RULES.reviewQueueNotDurable,
          }),
    },
    companyId: input.companyId,
    sessionId: null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return routed;
}

/**
 * Split a payment body into the payer's postal code and the rest.
 *
 * STEP 183's body is strict: a token and a key, and nothing else. Section 18's billing match needs one more
 * value from the payer, and the honest way to add it is to take it out here and hand the *rest* to STEP 183's
 * parser - so the card-field scan still runs over everything the payer sent, and a body carrying a card number
 * is still refused by the rule that has always refused it.
 *
 * An absent field is not a failure: a payer who typed no postal code simply cannot satisfy the fallback rule,
 * and the payment is reviewed. A field that is present and unreadable is a refusal, because a value the platform
 * cannot compare is a value the payer believes it sent.
 */
export function splitPortalBillingPostalField(body: unknown): {
  readonly postalCode: string | null;
  readonly rest: unknown;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { postalCode: null, rest: body };
  }

  const record = body as Record<string, unknown>;

  if (!Object.hasOwn(record, PORTAL_BILLING_POSTAL_FIELD)) {
    return { postalCode: null, rest: body };
  }

  const value = record[PORTAL_BILLING_POSTAL_FIELD];
  const rest: Record<string, unknown> = { ...record };

  delete rest[PORTAL_BILLING_POSTAL_FIELD];

  if (typeof value !== "string" || portalBillingPostalCodeKey(value) === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: PORTAL_BILLING_POSTAL_FIELD, rule: PORTAL_BILLING_RULES.postalCodeInvalid }],
    });
  }

  return { postalCode: value.trim(), rest };
}
