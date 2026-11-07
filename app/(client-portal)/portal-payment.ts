// path: app/(client-portal)/portal-payment.ts
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { validateCollectJsToken } from "../../lib/payments/adapters/nmi-collectjs.ts";
import type { PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { openPortalInvoice, type PortalInvoiceView } from "./portal-invoice.ts";
import { portalMoneyTextOf } from "./portal-invoice-money.ts";
import {
  PORTAL_PAYMENT_AUDIT_ENTITY,
  PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION,
  PORTAL_PAYMENT_CARD_NUMBER_PATTERN,
  PORTAL_PAYMENT_DECLINED_AUDIT_ACTION,
  PORTAL_PAYMENT_FIELD_ORDER,
  PORTAL_PAYMENT_FORBIDDEN_KEYS,
  PORTAL_PAYMENT_REFUSED_AUDIT_ACTION,
  PORTAL_PAYMENT_RULES,
  PORTAL_PAYMENT_SCRIPT_URL,
  PORTAL_PAYMENT_TOKEN_MAXIMUM_LENGTH,
  PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION,
  portalPaymentChargeAmountOf,
} from "./portal-payment-fields.ts";

/**
 * The payment page's service: what it shows, and the one charge it may make.
 *
 * ## The boundary this file is built around
 *
 * Section 18: "card number, expiry and CVV are entered only inside the provider hosted secure fields.
 * Platform code and servers never read, store or track card data or keystrokes." Nothing here can hold a
 * card number: the body it parses has two fields, a token and an idempotency key, and a body that carries a
 * card-shaped key is refused and audited rather than read. The card itself never arrives - Collect.js hands
 * the browser a token, and the token is what this file sees.
 *
 * ## What the page shows
 *
 * `preparePortalPayment` answers everything the screen needs in one read: the amount the link will take
 * (which is the invoice's own remaining due, never a number the browser sent), the provider's hosted-field
 * configuration when the platform is able to take a card, and a marker when it is not, so the page can say
 * "card payment is not available for this business yet" instead of rendering fields that would fail.
 *
 * ## What a charge is, and what it is not
 *
 * A charge is one call to the platform's payment operation - the provider's own execution plus the record it
 * writes - through the port below. This file does not talk to the provider, does not create a payment row and
 * does not post a ledger entry: those are STEPs 130, 132 and 151's, and the port is where their work enters
 * this page. An amount is computed here from the invoice as this request read it, because a browser that
 * could name its own amount could pay one cent for a thousand dollar invoice.
 *
 * ## Why a charge is refused when the operation is not durable
 *
 * Charging a card and then losing the record of it is the worst outcome this platform can produce: the
 * client's money is gone, the invoice still says it is due, and nothing reconciles the two. So the port
 * declares whether it can record durably, and a page that cannot charge safely says so instead of charging.
 */

/** The hosted-field configuration the browser needs. A public tokenization key, never the private one. */
export interface PortalSecureFields {
  readonly scriptUrl: string;
  readonly tokenizationKey: string;
  readonly environment: "sandbox" | "production";
}

/** Why the page cannot take a card right now. */
export type PortalPaymentUnavailable = "provider" | "recorder";

/** Everything the payment page prints. */
export interface PortalPaymentView {
  readonly invoiceId: string;
  readonly companyId: string;
  readonly tokenId: string;
  readonly number: string | null;
  readonly clientName: string;
  readonly currency: string;
  /** The remaining due, in the platform's minor units, as decimal text. */
  readonly amountMinor: string;
  /** The same amount printed for a person, so the screen and the charge cannot disagree. */
  readonly amountText: string;
  /** The amount in the provider's own spelling, `100.00`, which is what the charge will send. */
  readonly chargeAmount: string;
  /** The key this page's attempt carries, so a double submit is one payment and not two. */
  readonly idempotencyKey: string;
  /** The hosted fields, or null when the platform cannot take a card right now. */
  readonly secureFields: PortalSecureFields | null;
  /** Why the page offers no form, or null when it does. */
  readonly unavailable: PortalPaymentUnavailable | null;
}

/** What a charge asks the payment operation for. No card data, no amount chosen by the browser. */
export interface PortalChargeRequest {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly number: string | null;
  readonly amountMinor: string;
  readonly chargeAmount: string;
  readonly token: string;
  readonly idempotencyKey: string;
  readonly occurredAtEpochMs: number;
}

/** What the payment operation answers. */
export type PortalChargeOutcome =
  | { readonly status: "captured"; readonly paymentId: string; readonly transactionId: string }
  | { readonly status: "declined"; readonly paymentId: string | null; readonly code: string }
  | { readonly status: "unknown"; readonly paymentId: string | null; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: PortalPaymentUnavailable };

/** The platform's payment operation, as this page sees it. */
export interface PortalPaymentProcessor {
  /**
   * True when a payment this operation makes is recorded durably.
   *
   * A reference composition over in-memory stores is not, and a page that charged through it would take
   * money it could not account for. The flag exists so that fact is stated by the operation rather than
   * assumed by the page.
   */
  readonly durable: boolean;
  charge(request: PortalChargeRequest): Promise<PortalChargeOutcome>;
}

/** What the page and the charge need: the link's key ring, the audit chain and the payment operation. */
export interface PortalPaymentDependencies {
  readonly rest: RestClient;
  readonly tokenKeys: PortalTokenKeys;
  readonly audit: AuditTrail;
  /**
   * The platform's payment operation, or null when this deployment has none.
   *
   * Null is a real state: a merchant whose gateway keys are not provisioned has no way to be charged
   * through, and the page says so rather than showing fields that cannot work.
   */
  readonly processor: PortalPaymentProcessor | null;
  /** The public tokenization key of one company, or null when the company has none configured. */
  readonly tokenizationKeyFor: (
    companyId: string,
  ) => { readonly apiKey: string; readonly environment: "sandbox" | "production" } | null;
  readonly now?: () => number;
}

/** A charge that was taken. */
export interface PortalPaidPayment {
  readonly status: "captured";
  readonly invoiceId: string;
  readonly companyId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly chargeAmount: string;
  readonly paymentId: string;
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly capturedAt: string;
}

/** One audit entry, written or not: a chain that is down never fails the money it records. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The payment is the fact; an audit sink that cannot be reached must not turn a taken
    // payment into a page that never finished.
  }
}

/** The refusal a link that cannot take money deserves, in the words the page will print. */
function notPayableView(view: PortalInvoiceView): AppError {
  switch (view.state) {
    case "void":
      return new AppError("CONFLICT", {
        details: [{ field: "payment", rule: PORTAL_PAYMENT_RULES.invoiceVoid }],
      });
    case "not_issued":
      return new AppError("CONFLICT", {
        details: [{ field: "payment", rule: PORTAL_PAYMENT_RULES.notIssued }],
      });
    default:
      return new AppError("CONFLICT", {
        details: [{ field: "payment", rule: PORTAL_PAYMENT_RULES.notPayable }],
      });
  }
}

/** A refusal, in the field-then-rule shape every portal refusal uses. */
function refused(code: "CONFLICT" | "VALIDATION_FAILED" | "SERVICE_UNAVAILABLE", field: string, rule: string): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/**
 * The first card-shaped key in a body, as a path, or null when there is none.
 *
 * Walked at any depth and compared in one spelling - lower case, no underscores or hyphens - so
 * `card_number`, `card-number`, `cardNumber` and `CardNumber` are one key. A body that carries one is not
 * parsed and not echoed: the answer says a card field is refused, and the value never leaves the request.
 */
export function portalPaymentCardFieldOf(body: unknown): string | null {
  const seen = new Set<unknown>();

  function walk(value: unknown, path: string): string | null {
    if (value === null || typeof value !== "object") {
      return null;
    }

    if (seen.has(value)) {
      return null;
    }

    seen.add(value);

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalised = key.toLowerCase().replace(/[_-]/gu, "");
      const here = path.length === 0 ? key : `${path}.${key}`;

      if ((PORTAL_PAYMENT_FORBIDDEN_KEYS as readonly string[]).includes(normalised)) {
        return here;
      }

      const nested = walk(child, here);

      if (nested !== null) {
        return nested;
      }
    }

    return null;
  }

  return walk(body, "");
}

/** The body a payment page accepts, by shape only: a token and the key that makes it one payment. */
export const portalPaymentBodySchema = z
  .object({
    collectjs_token: z.string().max(PORTAL_PAYMENT_TOKEN_MAXIMUM_LENGTH),
    idempotency_key: z.string().uuid(),
  })
  .strict();

/** A parsed payment body. */
export interface ParsedPortalPaymentBody {
  readonly token: string;
  readonly idempotencyKey: string;
}

/**
 * Parse a payment body.
 *
 * The card scan runs first, on the raw value, because the answer a caller needs is "this platform never
 * accepts a card number" rather than "unknown field". Then the token: empty, over-long or card-shaped is
 * refused here, and the provider's own validator has the final word on the shape it will accept.
 */
export function parsePortalPaymentBody(body: unknown): ParsedPortalPaymentBody {
  const cardField = portalPaymentCardFieldOf(body);

  if (cardField !== null) {
    // The field is named, the value is not: a log line and an audit entry must never hold a card number.
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "collectjs_token", rule: PORTAL_PAYMENT_RULES.cardDataRefused }],
      cause: { rule: "portal_payment", field: cardField },
    });
  }

  const attempt = portalPaymentBodySchema.safeParse(body);

  if (!attempt.success) {
    const problems: ErrorDetail[] = [];

    for (const issue of attempt.error.issues) {
      const field = issue.code === "unrecognized_keys" ? issue.keys[0] ?? "payment" : String(issue.path[0] ?? "payment");

      if (!problems.some((problem) => problem.field === field)) {
        problems.push({ field, rule: "invalid_format" });
      }
    }

    throw new AppError("VALIDATION_FAILED", { details: orderedProblems(problems) });
  }

  const token = attempt.data.collectjs_token.trim();

  if (token.length === 0) {
    throw refused("VALIDATION_FAILED", "collectjs_token", "required");
  }

  if (PORTAL_PAYMENT_CARD_NUMBER_PATTERN.test(token)) {
    // A card number pasted into the token box: sixteen digits pass the provider's own character rule, so
    // this refusal is what stops a PAN being forwarded to the provider as if it were a token.
    throw refused("VALIDATION_FAILED", "collectjs_token", PORTAL_PAYMENT_RULES.cardDataRefused);
  }

  if (validateCollectJsToken(token, "card").status !== "valid") {
    throw refused("VALIDATION_FAILED", "collectjs_token", PORTAL_PAYMENT_RULES.invalidToken);
  }

  return { token, idempotencyKey: attempt.data.idempotency_key };
}

/** The order a refusal lists its fields in, which is the order the form meets them. */
function orderedProblems(problems: readonly ErrorDetail[]): readonly ErrorDetail[] {
  const rankOf = (field: string): number => {
    const index = (PORTAL_PAYMENT_FIELD_ORDER as readonly string[]).indexOf(field);

    return index === -1 ? PORTAL_PAYMENT_FIELD_ORDER.length : index;
  };

  return [...problems].sort((left, right) => rankOf(left.field) - rankOf(right.field));
}

/** The audit shape a payment event uses: the amount, the link and the key, and never the card. */
function paymentPayloadOf(view: PortalInvoiceView, detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { invoice_id: view.invoiceId, number: view.number, ...detail };
}

/** A hash of the idempotency key, so the chain can correlate attempts without storing the key. */
function keyHashOf(idempotencyKey: string): string {
  return createHash("sha256").update(`portal_payment\n${idempotencyKey}`, "utf8").digest("hex");
}

/**
 * Open a payment link and read what the page prints.
 *
 * One read of the invoice - three tenant-scoped queries under it - and nothing written: a page that is
 * merely looked at must not spend a payment attempt. The amount is the invoice's own remaining due, and the
 * hosted-field configuration is the company's own public tokenization key, both read rather than requested.
 */
export async function preparePortalPayment(
  input: { readonly token: string },
  dependencies: PortalPaymentDependencies,
): Promise<PortalPaymentView> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const view = await openPortalInvoice({ token: input.token }, {
    rest: dependencies.rest,
    tokenKeys: dependencies.tokenKeys,
    now: () => nowMs,
  });

  if (!view.payment.open || view.payment.amountMinor === null) {
    throw notPayableView(view);
  }

  const chargeAmount = portalPaymentChargeAmountOf(view.payment.amountMinor);

  if (chargeAmount === null) {
    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.amountUnrepresentable);
  }

  const tokenization = dependencies.tokenizationKeyFor(view.companyId);
  const secureFields: PortalSecureFields | null =
    tokenization === null
      ? null
      : {
          scriptUrl: PORTAL_PAYMENT_SCRIPT_URL,
          tokenizationKey: tokenization.apiKey,
          environment: tokenization.environment,
        };
  const unavailable: PortalPaymentUnavailable | null =
    tokenization === null ? "provider" : dependencies.processor === null || !dependencies.processor.durable ? "recorder" : null;

  return {
    invoiceId: view.invoiceId,
    companyId: view.companyId,
    tokenId: view.tokenId,
    number: view.number,
    clientName: view.clientName,
    currency: view.currency,
    amountMinor: view.payment.amountMinor,
    amountText: portalMoneyTextOf(view.currency, view.payment.amountMinor),
    chargeAmount,
    // A fresh key per render. The form sends it back, so a double submit is one payment: the second request
    // finds the record the first one made rather than charging the card again.
    idempotencyKey: randomUUID(),
    secureFields,
    unavailable,
  };
}

/** What a charge carries from the request, which no browser may set itself. */
export interface ChargePortalPaymentInput {
  readonly token: string;
  readonly body: unknown;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  /** The company of the session that made the request, when it had one: a seller cannot pay their own invoice. */
  readonly actorCompanyId: string | null;
}

/**
 * Take one card payment on a tokenized invoice link.
 *
 * The order is the one a payer can act on, and every step is a refusal this page can explain:
 *
 *   1. the link, which verifies the signature, the clock, the kind and the `pay` capability;
 *   2. the invoice, which must still be open with money due - read again in this request, because the page
 *      that rendered the form may be minutes old;
 *   3. the merchant's own session, refused: a seller paying their own invoice has produced nothing, and the
 *      money it moved would be their own card to their own account;
 *   4. the body, with the card scan before the parse;
 *   5. the token, which must be a token and not a card number;
 *   6. the amount, computed here from the invoice and written in the provider's own text;
 *   7. the payment operation, which charges and records, and whose four answers are four different pages.
 *
 * A captured charge is audited with its amount, its transaction and a hash of the key; a decline and an
 * unknown outcome are audited too. An unknown outcome is never retried by this page - the sentence says the
 * payment is being reconciled, because a transport that lost its answer may have taken the money.
 */
export async function chargePortalPayment(
  input: ChargePortalPaymentInput,
  dependencies: PortalPaymentDependencies,
): Promise<PortalPaidPayment> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const view = await openPortalInvoice({ token: input.token }, {
    rest: dependencies.rest,
    tokenKeys: dependencies.tokenKeys,
    now: () => nowMs,
  });

  if (!view.payment.open || view.payment.amountMinor === null) {
    throw notPayableView(view);
  }

  if (input.actorCompanyId === view.companyId) {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_AUDIT_ENTITY,
      entityId: view.invoiceId,
      payload: paymentPayloadOf(view, { rule: PORTAL_PAYMENT_RULES.selfPayment }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.selfPayment);
  }

  let parsed: ParsedPortalPaymentBody;

  try {
    parsed = parsePortalPaymentBody(input.body);
  } catch (error) {
    if (
      error instanceof AppError &&
      error.details.some((detail) => detail.rule === PORTAL_PAYMENT_RULES.cardDataRefused)
    ) {
      // Worth a chain link: somebody posted card data to a page that never accepts it.
      await appendTolerated(dependencies.audit, {
        action: PORTAL_PAYMENT_REFUSED_AUDIT_ACTION,
        actorUserId: null,
        entityType: PORTAL_PAYMENT_AUDIT_ENTITY,
        entityId: view.invoiceId,
        payload: paymentPayloadOf(view, { rule: PORTAL_PAYMENT_RULES.cardDataRefused }),
        companyId: view.companyId,
        sessionId: null,
        ipAddress: input.clientAddress,
        userAgent: input.userAgent,
      });
    }

    throw error;
  }

  const chargeAmount = portalPaymentChargeAmountOf(view.payment.amountMinor);

  if (chargeAmount === null) {
    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.amountUnrepresentable);
  }

  const processor = dependencies.processor;

  if (processor === null || !processor.durable) {
    throw refused(
      "SERVICE_UNAVAILABLE",
      "payment",
      processor === null ? PORTAL_PAYMENT_RULES.providerUnavailable : PORTAL_PAYMENT_RULES.recorderUnavailable,
    );
  }

  const outcome = await processor.charge({
    companyId: view.companyId,
    invoiceId: view.invoiceId,
    number: view.number,
    amountMinor: view.payment.amountMinor,
    chargeAmount,
    token: parsed.token,
    idempotencyKey: parsed.idempotencyKey,
    occurredAtEpochMs: nowMs,
  });

  if (outcome.status === "unavailable") {
    throw refused(
      "SERVICE_UNAVAILABLE",
      "payment",
      outcome.reason === "provider"
        ? PORTAL_PAYMENT_RULES.providerUnavailable
        : PORTAL_PAYMENT_RULES.recorderUnavailable,
    );
  }

  const common = {
    amount_minor: view.payment.amountMinor,
    charge_amount: chargeAmount,
    idempotency_key_hash: keyHashOf(parsed.idempotencyKey),
  };

  if (outcome.status === "captured") {
    const capturedAt = new Date(nowMs).toISOString();

    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_CAPTURED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_AUDIT_ENTITY,
      entityId: outcome.paymentId,
      payload: paymentPayloadOf(view, {
        ...common,
        payment_id: outcome.paymentId,
        transaction_id: outcome.transactionId,
        captured_at: capturedAt,
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    return {
      status: "captured",
      invoiceId: view.invoiceId,
      companyId: view.companyId,
      amountMinor: view.payment.amountMinor,
      amountText: portalMoneyTextOf(view.currency, view.payment.amountMinor),
      chargeAmount,
      paymentId: outcome.paymentId,
      transactionId: outcome.transactionId,
      idempotencyKey: parsed.idempotencyKey,
      capturedAt,
    };
  }

  if (outcome.status === "declined") {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_PAYMENT_DECLINED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_PAYMENT_AUDIT_ENTITY,
      entityId: outcome.paymentId ?? view.invoiceId,
      payload: paymentPayloadOf(view, { ...common, decline_code: outcome.code }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("VALIDATION_FAILED", "collectjs_token", "card_declined");
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_PAYMENT_AUDIT_ENTITY,
    entityId: outcome.paymentId ?? view.invoiceId,
    payload: paymentPayloadOf(view, { ...common, unknown_reason: outcome.reason, reconcile: true }),
    companyId: view.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
  });

  // Never a retry: a transport that lost its answer may have taken the money, and charging again would.
  throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.outcomeUnknown);
}
