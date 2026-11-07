// path: app/(client-portal)/portal-three-ds.ts
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  evaluatePortalBillingMatch,
  routePortalPaymentReview,
  splitPortalBillingPostalField,
  type PortalBillingMatchDependencies,
} from "./portal-billing-match.ts";
import type { PortalBillingMatch } from "./portal-billing-match-fields.ts";
import { openPortalInvoice, type PortalInvoiceView } from "./portal-invoice.ts";
import { portalMoneyTextOf } from "./portal-invoice-money.ts";
import {
  chargePortalPayment,
  parsePortalPaymentBody,
  type PortalPaidPayment,
  type PortalPaymentDependencies,
} from "./portal-payment.ts";
import { PORTAL_PAYMENT_RULES } from "./portal-payment-fields.ts";
import {
  portalPartPaymentAmountOf,
  portalPartPaymentMovedOf,
  portalPartPaymentRequestBodyOf,
  splitPortalPartPaymentAmountField,
} from "./portal-part-payment.ts";
import {
  PORTAL_THREE_DS_AUDIT_ENTITY,
  PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION,
  PORTAL_THREE_DS_CHALLENGED_AUDIT_ACTION,
  PORTAL_THREE_DS_CHALLENGE_MAXIMUM_LENGTH,
  PORTAL_THREE_DS_HANDLE_LIFETIME_SECONDS,
  PORTAL_THREE_DS_HANDLE_MAXIMUM_LENGTH,
  PORTAL_THREE_DS_HANDLE_PURPOSE,
  PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION,
  PORTAL_THREE_DS_REFUSED_AUDIT_ACTION,
  PORTAL_THREE_DS_RESULT_MAXIMUM_LENGTH,
  PORTAL_THREE_DS_REVIEW_AUDIT_ACTION,
  PORTAL_THREE_DS_REVIEW_OWNER,
  PORTAL_THREE_DS_RULES,
  portalThreeDsAcsUrlOf,
  portalThreeDsCaptureDecisionOf,
  portalThreeDsHandleContext,
  portalThreeDsOutcomeOf,
  portalThreeDsTermUrlOf,
  type PortalThreeDsDecision,
  type PortalThreeDsOutcome,
} from "./portal-three-ds-fields.ts";

/**
 * The 3D Secure step of a card payment: request it, carry the payer through the issuer's page, and read the
 * answer.
 *
 * ## What this file is, and what it is not
 *
 * It is the *flow*: the record a challenge leaves behind, the sealed handle the browser carries to the issuer
 * and back, the clock on that handle, the single use of the issuer's answer, and the decision section 18
 * makes about the money afterwards. It is not the provider: the two operations that actually authenticate a
 * card are behind `PortalThreeDsPort`, because the only code in this platform that may talk to the gateway
 * about a card is STEP 149-152's adapter set, and this STEP does not own it. It is not the charge either: a
 * payment that authentication clears is charged by STEP 183's `chargePortalPayment`, unchanged, so there is
 * one charge path in the repository rather than two that disagree.
 *
 * ## The order, and why it is that order
 *
 *   1. The link, then the invoice, then what it still owes. A challenge for an invoice that cannot be paid is
 *      a challenge that would waste a cardholder's time at a bank's page.
 *   2. The seller's own session, refused before any money moves - a seller cannot pay their own invoice.
 *   3. The body, which is STEP 183's body: a token and a key, and a card-shaped key is refused rather than
 *      read.
 *   4. The two operations and the two capabilities this flow needs: a provider that can authenticate, and a
 *      recorder that can keep a challenge. Missing either is a refusal, because a challenge nobody can finish
 *      is worse than a page that says card payment is not available.
 *   5. The provider's answer: authenticated (frictionless), challenged, refused, or unavailable.
 *   6. On a challenge, the record is opened *before* the browser leaves, and the handle is sealed. The
 *      cardholder's browser then posts to the issuer and comes back with the issuer's answer and this
 *      platform's handle - no card data in either direction.
 *   7. The return: the handle is opened, the record is claimed once, the provider is asked to complete the
 *      authentication, and section 18's capture rule decides what may happen to the money.
 *
 * ## Why the handle is sealed rather than signed
 *
 * The handle travels through a bank's page and comes back, so it is a value the platform must be able to
 * trust without a database round trip, and it must not be readable: an invoice id in a bank's page is not a
 * secret, but a payment attempt's whole state is not something to hand a third party. It is therefore
 * `lib/auth/secrets.ts`'s AES-256-GCM box with the deployment's master key and additional authenticated data
 * naming the challenge, which is the platform's existing cipher, not a fourth one. A handle edited, moved to
 * another challenge, or sealed with another key does not open, and every failure to open is the same refusal
 * so nothing can be learned by probing.
 *
 * ## Why a handle is spent once
 *
 * A 3DS result is an answer to one challenge. Replaying it would let a payer with one authenticated attempt
 * settle a second challenge, so the record is claimed exactly once and a second arrival is refused as a
 * replay - and the charge that follows is keyed by the payer's own idempotency key, so even a lost response
 * cannot take two payments.
 */

/** The provider's authentication operations, as this flow needs them. */
export interface PortalThreeDsPort {
  /** True when this deployment has an operation to authenticate a card with. */
  readonly available: boolean;
  /** Ask the issuer to authenticate the card behind a token. Charges nothing. */
  request(input: PortalThreeDsRequest): Promise<PortalThreeDsRequestAnswer>;
  /** Hand the issuer's result back and read the outcome. */
  complete(input: PortalThreeDsCompleteRequest): Promise<PortalThreeDsCompleteAnswer>;
}

/** What the provider is told when authentication is requested. No card data, because there is none. */
export interface PortalThreeDsRequest {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly number: string | null;
  /** The amount in the provider's own text, dollars and cents. */
  readonly amountText: string;
  /** The amount in the platform's minor units, for the provider's record of what it authenticated. */
  readonly amountMinor: string;
  /** The Collect.js token. The card behind it is never visible to this platform. */
  readonly token: string;
  /** Where the issuer sends the payer back to. */
  readonly returnUrl: string;
  /** The three browser facts a 3DS request carries. Never a keystroke. */
  readonly browser: {
    readonly ipAddress: string;
    readonly userAgent: string | null;
    readonly acceptLanguage: string | null;
  };
}

/** What the provider answered about the authentication. */
export type PortalThreeDsRequestAnswer =
  /** The issuer authenticated the card without asking the cardholder anything. */
  | { readonly status: "authenticated" }
  /** The cardholder must answer the issuer. The request travels through this platform unread. */
  | {
      readonly status: "challenge";
      /** The provider's own id for the challenge, kept beside ours so a support question can be answered. */
      readonly providerChallengeId: string;
      /** Where the payer's browser posts the challenge. */
      readonly acsUrl: string;
      /** The issuer's request, opaque to this platform. */
      readonly paReq: string;
    }
  /** The issuer refused, or the card cannot be authenticated at all. */
  | { readonly status: "failed"; readonly code: string }
  /** This deployment has no operation to authenticate with, so nothing was asked. */
  | { readonly status: "unavailable"; readonly reason: string };

/** What the provider is given on the way back. */
export interface PortalThreeDsCompleteRequest {
  readonly companyId: string;
  readonly challengeId: string;
  readonly paRes: string;
}

/** What completing an authentication answered. */
export type PortalThreeDsCompleteAnswer =
  | { readonly status: "authenticated" }
  /** The cardholder left the issuer's page, or the issuer did not finish the challenge. */
  | { readonly status: "abandoned" }
  /** The issuer said the cardholder failed, or the card is not enrolled. */
  | { readonly status: "failed"; readonly code: string }
  /** The provider could not be reached, so whether the card was authenticated is unknown. */
  | { readonly status: "unavailable"; readonly reason: string };

/** What a started challenge leaves behind. The durable implementation is the platform's, not this file's. */
export interface PortalThreeDsRecord {
  readonly challengeId: string;
  readonly providerChallengeId: string;
  readonly companyId: string;
  readonly invoiceId: string;
  readonly amountMinor: string;
  readonly chargeAmount: string;
  /** The token, kept so the charge can be made after the payer comes back. A durable store seals it. */
  readonly token: string;
  /** The payer's own key, kept so the charge after the challenge is the same payment as the attempt before it. */
  readonly idempotencyKey: string;
  readonly ipAddress: string;
  readonly userAgent: string | null;
  readonly expiresAtEpochMs: number;
  /**
   * Section 18's billing match, decided by STEP 185 when the challenge was opened.
   *
   * The whole comparison and not two booleans, because a reviewer needs to know *which* fact failed and why -
   * an absent postal code and a wrong one are different answers to a support question - and the capture rule
   * only ever reads the two booleans out of it.
   */
  readonly billingMatch: PortalBillingMatch;
}

/** The challenge records this flow keeps. */
export interface PortalThreeDsRecorder {
  /** True when a challenge this recorder opens survives the request. */
  readonly durable: boolean;
  /** Open the record for one challenge, or say why it cannot. */
  open(record: PortalThreeDsRecord): { readonly status: "opened" } | { readonly status: "refused"; readonly reason: string };
  /** Take the record for one completion. A second arrival is a replay, not a second answer. */
  claim(challengeId: string): PortalThreeDsClaim;
  /** Settle the record with what happened. */
  settle(input: PortalThreeDsSettlement): void;
}

/** What claiming a challenge record answered. */
export type PortalThreeDsClaim =
  | { readonly status: "claimed"; readonly record: PortalThreeDsRecord }
  | { readonly status: "spent" }
  | { readonly status: "unknown" };

/** What the record is settled with. */
export interface PortalThreeDsSettlement {
  readonly challengeId: string;
  readonly outcome: PortalThreeDsOutcome;
  readonly decision: PortalThreeDsDecision;
  /** `captured` when the money was taken, `under_review` when it was not, `failed` and `unknown` otherwise. */
  readonly status: "captured" | "under_review" | "failed" | "unknown";
  readonly paymentId: string | null;
  readonly transactionId: string | null;
  readonly code: string | null;
  readonly occurredAtEpochMs: number;
}

/** The deployment's cipher, as this flow uses it: seal one small claim, open one sealed claim. */
export interface PortalThreeDsSecrets {
  seal(plaintext: string, context: string): string;
  open(box: string, context: string): string;
}

/** What the flow needs to exist at all. */
export interface PortalThreeDsDependencies {
  /**
   * STEP 183's payment dependencies, unchanged.
   *
   * The charge after a successful authentication goes through `chargePortalPayment` with these, so the 3DS
   * step cannot charge by any route the payment page does not already take: one provider execution, one
   * idempotency rule, one set of refusals.
   */
  readonly payment: PortalPaymentDependencies;
  readonly port: PortalThreeDsPort | null;
  readonly recorder: PortalThreeDsRecorder | null;
  readonly secrets: PortalThreeDsSecrets | null;
  /**
   * STEP 185's billing match and review routing.
   *
   * Required rather than optional: a flow that could be built without it would be a flow that captured money
   * without ever asking whether section 18's second condition held.
   */
  readonly billing: PortalBillingMatchDependencies;
  readonly now?: () => number;
}

/** What starting a challenge asks. */
export interface StartPortalThreeDsInput {
  readonly token: string;
  readonly body: unknown;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  readonly acceptLanguage: string | null;
  /** The deployment's own origin, for the issuer's return address. */
  readonly origin: string;
  readonly actorCompanyId: string | null;
}

/** A challenge the payer must answer at the issuer's page. */
export interface PortalThreeDsChallenge {
  readonly status: "challenge";
  readonly invoiceId: string;
  readonly companyId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly acsUrl: string;
  readonly paReq: string;
  /** This platform's sealed handle, which the issuer returns untouched. */
  readonly md: string;
  readonly termUrl: string;
  readonly expiresAt: string;
}

/** What starting authentication answered: either the money was taken, or the payer must go to their bank. */
export type PortalThreeDsStartResult =
  | {
      readonly status: "captured";
      readonly payment: PortalPaidPayment;
      readonly outcome: "authenticated";
      readonly basis: "three_ds";
    }
  | PortalThreeDsChallenge;

/** What completing authentication answered. */
export type PortalThreeDsCompleteResult =
  | {
      readonly status: "captured";
      readonly payment: PortalPaidPayment;
      readonly outcome: PortalThreeDsOutcome;
      readonly basis: "three_ds" | "billing_match";
    }
  | {
      readonly status: "review";
      readonly invoiceId: string;
      readonly companyId: string;
      readonly amountMinor: string;
      readonly amountText: string;
      readonly outcome: PortalThreeDsOutcome;
      /** The desk section 18 gives the review to. */
      readonly reviewOwner: string;
    };

/** What completing a challenge asks. The link travels in the path; the handle and the result in the body. */
export interface CompletePortalThreeDsInput {
  readonly token: string;
  readonly body: unknown;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  readonly actorCompanyId: string | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const minorUnitsPattern = /^[0-9]{1,18}$/u;

const opaquePattern = /^[\x21-\x7e]+$/u;

/**
 * The claim inside a sealed handle, strict.
 *
 * Strict because this is a value that travelled through a third party: a field nobody reads is a field
 * somebody is trying to add. `amountMinor` is carried so a handle minted for one amount cannot be completed
 * against an invoice that has since changed, and the two instants are epoch milliseconds so the comparison is
 * a number rather than a date.
 */
const handleClaimSchema = z
  .object({
    purpose: z.literal(PORTAL_THREE_DS_HANDLE_PURPOSE),
    version: z.literal(1),
    challengeId: z.string().regex(uuidPattern),
    companyId: z.string().regex(uuidPattern),
    invoiceId: z.string().regex(uuidPattern),
    amountMinor: z.string().regex(minorUnitsPattern),
    issuedAtEpochMs: z.number().int().min(0),
    expiresAtEpochMs: z.number().int().min(0),
  })
  .strict();

type PortalThreeDsHandleClaim = z.infer<typeof handleClaimSchema>;

/** A refusal, in the field-then-rule shape every portal refusal uses. */
function refused(
  code: "CONFLICT" | "VALIDATION_FAILED" | "SERVICE_UNAVAILABLE",
  field: string,
  rule: string,
): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/** The refusal a link that cannot take money deserves, in the words the page prints. */
function notPayable(view: PortalInvoiceView): AppError {
  switch (view.state) {
    case "void":
      return refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.invoiceVoid);
    case "not_issued":
      return refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.notIssued);
    default:
      return refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.notPayable);
  }
}

/** A chain link that is written if it can be, and never fails the payment it records. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The authentication is the fact; an audit sink that cannot be reached must not turn a
    // finished challenge into a page that never answered.
  }
}

/** The audit shape a 3DS event uses: the invoice, the amount and the outcome, and never the card. */
function threeDsPayloadOf(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...detail };
}

/** A hash of the idempotency key, so the chain can correlate attempts without storing the key. */
function keyHashOf(idempotencyKey: string): string {
  return createHash("sha256").update(`portal_three_ds\n${idempotencyKey}`, "utf8").digest("hex");
}

/**
 * The issuer's answer, parsed strictly.
 *
 * The issuer posts a form, so this is reached with whatever a third party sent: exactly two fields, each a
 * printable run of characters within its ceiling, and nothing else. A body carrying a third field is refused
 * rather than ignored, and no value is ever echoed into a refusal.
 */
export function parsePortalThreeDsResult(body: unknown): {
  readonly paRes: string;
  readonly md: string;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw refused("VALIDATION_FAILED", "PaRes", PORTAL_THREE_DS_RULES.resultInvalid);
  }

  const record = body as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);

  if (keys.length !== 2 || !keys.includes("PaRes") || !keys.includes("MD")) {
    throw refused("VALIDATION_FAILED", "PaRes", PORTAL_THREE_DS_RULES.resultInvalid);
  }

  const paRes = record["PaRes"];
  const md = record["MD"];

  if (typeof paRes !== "string" || typeof md !== "string") {
    throw refused("VALIDATION_FAILED", "PaRes", PORTAL_THREE_DS_RULES.resultInvalid);
  }

  const trimmed = paRes.trim();

  if (
    trimmed.length === 0 ||
    trimmed.length > PORTAL_THREE_DS_RESULT_MAXIMUM_LENGTH ||
    !opaquePattern.test(trimmed)
  ) {
    throw refused("VALIDATION_FAILED", "PaRes", PORTAL_THREE_DS_RULES.resultInvalid);
  }

  if (md.length === 0 || md.length > PORTAL_THREE_DS_HANDLE_MAXIMUM_LENGTH || !opaquePattern.test(md)) {
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.resultInvalid);
  }

  return { paRes: trimmed, md };
}

/**
 * Seal the handle for one challenge.
 *
 * The claim is written compactly and sealed under this challenge's context, which is what stops a handle
 * from being moved to another challenge: the additional authenticated data is part of the box's integrity,
 * so an attacker who copies a handle into another browser session produces one that does not open.
 */
export function sealPortalThreeDsHandle(
  claim: {
    readonly challengeId: string;
    readonly companyId: string;
    readonly invoiceId: string;
    readonly amountMinor: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
  },
  secrets: PortalThreeDsSecrets,
): string {
  const sealed = secrets.seal(
    JSON.stringify({
      purpose: PORTAL_THREE_DS_HANDLE_PURPOSE,
      version: 1,
      challengeId: claim.challengeId,
      companyId: claim.companyId,
      invoiceId: claim.invoiceId,
      amountMinor: claim.amountMinor,
      issuedAtEpochMs: claim.issuedAtEpochMs,
      expiresAtEpochMs: claim.expiresAtEpochMs,
    }),
    portalThreeDsHandleContext(claim.challengeId),
  );

  // The challenge id travels beside the box rather than inside it: the box is bound to its challenge through
  // additional authenticated data, so the context has to be known before the box is opened, and an id is not
  // a secret. Editing it produces a box that does not open, which is the same refusal as a forged one.
  return `${claim.challengeId}.${sealed}`;
}

/**
 * Open a handle, or refuse without saying which part was wrong.
 *
 * A box that is not this platform's, a claim that is not this platform's shape, a context that does not
 * match and a key that is not this deployment's all end in the same refusal, because the difference between
 * them is a difference an attacker would like to know.
 */
export function openPortalThreeDsHandle(text: string, secrets: PortalThreeDsSecrets): PortalThreeDsHandleClaim {
  const separator = text.indexOf(".");
  const challengeId = separator === -1 ? "" : text.slice(0, separator);
  const sealed = separator === -1 ? "" : text.slice(separator + 1);

  if (!uuidPattern.test(challengeId) || sealed.length === 0) {
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.challengeInvalid);
  }

  let plaintext: string;

  try {
    plaintext = secrets.open(sealed, portalThreeDsHandleContext(challengeId));
  } catch {
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.challengeInvalid);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.challengeInvalid);
  }

  const claim = handleClaimSchema.safeParse(parsed);

  if (!claim.success || claim.data.challengeId !== challengeId) {
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.challengeInvalid);
  }

  return claim.data;
}

/** Start authentication for a card payment, and answer either the money or the issuer's challenge. */
export async function startPortalThreeDs(
  input: StartPortalThreeDsInput,
  dependencies: PortalThreeDsDependencies,
): Promise<PortalThreeDsStartResult> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const view = await openPortalInvoice(
    { token: input.token },
    {
      rest: dependencies.payment.rest,
      tokenKeys: dependencies.payment.tokenKeys,
      now: () => nowMs,
    },
  );

  if (!view.payment.open || view.payment.amountMinor === null) {
    throw notPayable(view);
  }

  if (input.actorCompanyId === view.companyId) {
    await appendTolerated(dependencies.payment.audit, {
      action: PORTAL_THREE_DS_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
      entityId: view.invoiceId,
      payload: threeDsPayloadOf({ rule: PORTAL_PAYMENT_RULES.selfPayment, stage: "start" }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.selfPayment);
  }

  // The payer's postal code is taken out first, so STEP 183's strict parser still sees a two-field body and the
  // card-field scan still runs over everything the payer sent. See `splitPortalBillingPostalField`.
  const billing = splitPortalBillingPostalField(input.body);

  // STEP 189's amount is taken out the same way and beside it, so the parser below still sees STEP 183's body.
  const part = splitPortalPartPaymentAmountField(billing.rest);

  // STEP 183's parser, deliberately: a body carrying card data is refused by the same rule here, and the
  // token is held to the same shape, so there is one answer to "what may a payment body contain".
  const parsed = parsePortalPaymentBody(part.rest);

  // STEP 189: the chosen amount, resolved once against the document as this request read it. Everything below
  // - the provider's request, the sealed handle, the record and the audits - carries this one number, so the
  // amount the payer chose cannot differ from the amount the challenge is for.
  const amount = portalPartPaymentAmountOf({ requested: part.amount, view });
  const chargeAmount = amount.chargeAmount;

  const port = dependencies.port;

  if (port === null || !port.available) {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.unavailable);
  }

  if (dependencies.recorder === null || !dependencies.recorder.durable) {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.recorderUnavailable);
  }

  if (dependencies.secrets === null) {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.unavailable);
  }

  // Section 18's two facts, decided once per attempt and carried with the challenge: the postal code the payer
  // typed against the client record's, and the country of the payer's address against the client's. Both fail
  // closed, so a deployment with no resolver reviews every unverified payment rather than capturing it.
  const billingMatch = await evaluatePortalBillingMatch(
    {
      companyId: view.companyId,
      clientId: view.clientId,
      payerPostalCode: billing.postalCode,
      payerIpAddress: input.clientAddress,
    },
    dependencies.billing,
  );

  const termUrl = portalThreeDsTermUrlOf(input.origin, input.token);
  const answer = await port.request({
    companyId: view.companyId,
    invoiceId: view.invoiceId,
    number: view.number,
    amountText: chargeAmount,
    amountMinor: amount.amountMinor,
    token: parsed.token,
    returnUrl: termUrl,
    browser: {
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
      acceptLanguage: input.acceptLanguage,
    },
  });

  if (answer.status === "unavailable") {
    await appendTolerated(dependencies.payment.audit, {
      action: PORTAL_THREE_DS_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
      entityId: view.invoiceId,
      payload: threeDsPayloadOf({ rule: PORTAL_THREE_DS_RULES.unavailable, stage: "start" }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.unavailable);
  }

  if (answer.status === "failed") {
    await appendTolerated(dependencies.payment.audit, {
      action: PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
      entityId: view.invoiceId,
      payload: threeDsPayloadOf({
        rule: PORTAL_THREE_DS_RULES.authenticationFailed,
        three_ds_outcome: "not_completed",
        provider_code: answer.code,
        stage: "start",
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("VALIDATION_FAILED", "card", PORTAL_THREE_DS_RULES.authenticationFailed);
  }

  if (answer.status === "authenticated") {
    // Frictionless: the issuer authenticated the card without the cardholder, so section 18's rule is already
    // satisfied and STEP 183's charge is the only thing left to do.
    const payment = await chargePortalPayment(
      {
        token: input.token,
        body: {
          collectjs_token: parsed.token,
          idempotency_key: parsed.idempotencyKey,
          // STEP 189: the amount the payer chose, re-posted as the text it resolves back from.
          amount: portalPartPaymentRequestBodyOf(amount.amountMinor),
        },
        clientAddress: input.clientAddress,
        userAgent: input.userAgent,
        actorCompanyId: input.actorCompanyId,
      },
      dependencies.payment,
    );

    await appendTolerated(dependencies.payment.audit, {
      action: PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
      entityId: payment.paymentId,
      payload: threeDsPayloadOf({
        invoice_id: view.invoiceId,
        number: view.number,
        amount_minor: amount.amountMinor,
        part_payment: amount.partial,
        three_ds_outcome: "authenticated",
        basis: "frictionless",
        idempotency_key_hash: keyHashOf(parsed.idempotencyKey),
      }),
      companyId: view.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    return { status: "captured", payment, outcome: "authenticated", basis: "three_ds" };
  }

  const acsUrl = portalThreeDsAcsUrlOf(answer.acsUrl);
  const paReq = answer.paReq.trim();
  const providerChallengeId = answer.providerChallengeId.trim();

  if (
    acsUrl === null ||
    paReq.length === 0 ||
    paReq.length > PORTAL_THREE_DS_CHALLENGE_MAXIMUM_LENGTH ||
    !opaquePattern.test(paReq) ||
    providerChallengeId.length === 0 ||
    providerChallengeId.length > 120 ||
    !opaquePattern.test(providerChallengeId)
  ) {
    throw refused("VALIDATION_FAILED", "PaReq", PORTAL_THREE_DS_RULES.resultInvalid);
  }

  const challengeId = randomUUID();
  const expiresAtEpochMs = nowMs + PORTAL_THREE_DS_HANDLE_LIFETIME_SECONDS * 1_000;
  const record: PortalThreeDsRecord = {
    challengeId,
    providerChallengeId,
    companyId: view.companyId,
    invoiceId: view.invoiceId,
    amountMinor: amount.amountMinor,
    chargeAmount,
    token: parsed.token,
    idempotencyKey: parsed.idempotencyKey,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
    expiresAtEpochMs,
    billingMatch,
  };

  const opened = dependencies.recorder.open(record);

  if (opened.status === "refused") {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.recorderUnavailable);
  }

  const md = sealPortalThreeDsHandle(
    {
      challengeId,
      companyId: view.companyId,
      invoiceId: view.invoiceId,
      amountMinor: amount.amountMinor,
      issuedAtEpochMs: nowMs,
      expiresAtEpochMs,
    },
    dependencies.secrets,
  );

  await appendTolerated(dependencies.payment.audit, {
    action: PORTAL_THREE_DS_CHALLENGED_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
    entityId: challengeId,
    payload: threeDsPayloadOf({
      invoice_id: view.invoiceId,
      number: view.number,
      amount_minor: amount.amountMinor,
      part_payment: amount.partial,
      three_ds_outcome: "attempted",
      challenge_id: challengeId,
      postal_code_matched: billingMatch.postalCodeMatched,
      ip_country_matched: billingMatch.ipCountryMatched,
      postal_code_reason: billingMatch.postalCodeReason,
      country_reason: billingMatch.countryReason,
      idempotency_key_hash: keyHashOf(parsed.idempotencyKey),
      expires_at: new Date(expiresAtEpochMs).toISOString(),
    }),
    companyId: view.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
  });

  return {
    status: "challenge",
    invoiceId: view.invoiceId,
    companyId: view.companyId,
    amountMinor: amount.amountMinor,
    amountText: amount.amountText,
    acsUrl,
    paReq,
    md,
    termUrl,
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
  };
}

/** Complete an authentication the payer answered, and decide what may happen to the money. */
export async function completePortalThreeDs(
  input: CompletePortalThreeDsInput,
  dependencies: PortalThreeDsDependencies,
): Promise<PortalThreeDsCompleteResult> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const parsed = parsePortalThreeDsResult(input.body);
  const recorder = dependencies.recorder;
  const port = dependencies.port;
  const secrets = dependencies.secrets;

  if (recorder === null || !recorder.durable) {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.recorderUnavailable);
  }

  if (port === null || !port.available) {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.unavailable);
  }

  if (secrets === null) {
    throw refused("SERVICE_UNAVAILABLE", "payment", PORTAL_THREE_DS_RULES.unavailable);
  }

  const claim = openPortalThreeDsHandle(parsed.md, secrets);

  if (nowMs > claim.expiresAtEpochMs) {
    throw refused("CONFLICT", "MD", PORTAL_THREE_DS_RULES.challengeExpired);
  }

  const view = await openPortalInvoice(
    { token: input.token },
    {
      rest: dependencies.payment.rest,
      tokenKeys: dependencies.payment.tokenKeys,
      now: () => nowMs,
    },
  );

  if (view.invoiceId !== claim.invoiceId || view.companyId !== claim.companyId) {
    // A handle minted under one link presented under another: the two disagree about which payment they are
    // about, and neither is trusted over the other.
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.challengeInvalid);
  }

  if (!view.payment.open || view.payment.amountMinor === null) {
    throw notPayable(view);
  }

  if (portalPartPaymentMovedOf({ chosenMinor: claim.amountMinor, view })) {
    // STEP 189: the handle carries the amount the payer chose, not the whole remainder, so the question here is
    // whether that amount can still be taken - a document that took another payment meanwhile may still owe it.
    throw refused("CONFLICT", "payment", PORTAL_THREE_DS_RULES.staleDocument);
  }

  if (input.actorCompanyId === view.companyId) {
    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.selfPayment);
  }

  const claimed = recorder.claim(claim.challengeId);

  if (claimed.status === "spent") {
    throw refused("CONFLICT", "MD", PORTAL_THREE_DS_RULES.challengeReplayed);
  }

  if (claimed.status === "unknown") {
    throw refused("VALIDATION_FAILED", "MD", PORTAL_THREE_DS_RULES.challengeUnknown);
  }

  const record = claimed.record;

  if (nowMs > record.expiresAtEpochMs) {
    recorder.settle({
      challengeId: record.challengeId,
      outcome: "not_completed",
      decision: "review",
      status: "failed",
      paymentId: null,
      transactionId: null,
      code: PORTAL_THREE_DS_RULES.challengeExpired,
      occurredAtEpochMs: nowMs,
    });

    throw refused("CONFLICT", "MD", PORTAL_THREE_DS_RULES.challengeExpired);
  }

  const answer = await port.complete({
    companyId: record.companyId,
    challengeId: record.providerChallengeId,
    paRes: parsed.paRes,
  });

  if (answer.status === "unavailable") {
    // Whether the cardholder authenticated is unknown. Never retried here: the answer may arrive after this
    // page has, and a second attempt would be a second challenge for one payment.
    recorder.settle({
      challengeId: record.challengeId,
      outcome: "attempted",
      decision: "review",
      status: "unknown",
      paymentId: null,
      transactionId: null,
      code: PORTAL_THREE_DS_RULES.challengeUnknown,
      occurredAtEpochMs: nowMs,
    });

    throw refused("CONFLICT", "payment", PORTAL_PAYMENT_RULES.outcomeUnknown);
  }

  if (answer.status === "failed") {
    recorder.settle({
      challengeId: record.challengeId,
      outcome: "not_completed",
      decision: "review",
      status: "failed",
      paymentId: null,
      transactionId: null,
      code: answer.code,
      occurredAtEpochMs: nowMs,
    });

    await appendTolerated(dependencies.payment.audit, {
      action: PORTAL_THREE_DS_NOT_COMPLETED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
      entityId: record.challengeId,
      payload: threeDsPayloadOf({
        invoice_id: record.invoiceId,
        amount_minor: record.amountMinor,
        three_ds_outcome: "not_completed",
        provider_code: answer.code,
        rule: PORTAL_THREE_DS_RULES.authenticationFailed,
      }),
      companyId: record.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    throw refused("VALIDATION_FAILED", "card", PORTAL_THREE_DS_RULES.authenticationFailed);
  }

  const outcome = portalThreeDsOutcomeOf(answer.status === "authenticated" ? "authenticated" : "abandoned");
  const decision = portalThreeDsCaptureDecisionOf({
    outcome,
    postalCodeMatched: record.billingMatch.postalCodeMatched,
    ipCountryMatched: record.billingMatch.ipCountryMatched,
  });

  if (decision === "review") {
    recorder.settle({
      challengeId: record.challengeId,
      outcome,
      decision,
      status: "under_review",
      paymentId: null,
      transactionId: null,
      code: PORTAL_THREE_DS_RULES.underReview,
      occurredAtEpochMs: nowMs,
    });

    // Section 18's second sentence: nothing is captured, and the payment goes to the desk that reads it.
    const routed = await routePortalPaymentReview(
      {
        companyId: record.companyId,
        invoiceId: record.invoiceId,
        paymentId: null,
        challengeId: record.challengeId,
        amountMinor: record.amountMinor,
        match: record.billingMatch,
        ipAddress: input.clientAddress,
        userAgent: input.userAgent,
      },
      dependencies.billing,
    );

    await appendTolerated(dependencies.payment.audit, {
      action: PORTAL_THREE_DS_REVIEW_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
      entityId: record.challengeId,
      payload: threeDsPayloadOf({
        invoice_id: record.invoiceId,
        amount_minor: record.amountMinor,
        three_ds_outcome: outcome,
        decision,
        review_owner: PORTAL_THREE_DS_REVIEW_OWNER,
        postal_code_matched: record.billingMatch.postalCodeMatched,
        ip_country_matched: record.billingMatch.ipCountryMatched,
        review_routed: routed.status === "routed",
        captured: false,
      }),
      companyId: record.companyId,
      sessionId: null,
      ipAddress: input.clientAddress,
      userAgent: input.userAgent,
    });

    return {
      status: "review",
      invoiceId: record.invoiceId,
      companyId: record.companyId,
      amountMinor: record.amountMinor,
      amountText: portalMoneyTextOf(view.currency, record.amountMinor),
      outcome,
      reviewOwner: PORTAL_THREE_DS_REVIEW_OWNER,
    };
  }

  let payment: PortalPaidPayment;

  try {
    payment = await chargePortalPayment(
      {
        token: input.token,
        body: {
          collectjs_token: record.token,
          idempotency_key: record.idempotencyKey,
          amount: portalPartPaymentRequestBodyOf(record.amountMinor),
        },
        clientAddress: record.ipAddress,
        userAgent: record.userAgent,
        actorCompanyId: null,
      },
      dependencies.payment,
    );
  } catch (error) {
    const code =
      error instanceof AppError ? (error.details[0]?.rule ?? PORTAL_PAYMENT_RULES.notPayable) : "charge_failed";

    recorder.settle({
      challengeId: record.challengeId,
      outcome,
      decision,
      status: "failed",
      paymentId: null,
      transactionId: null,
      code,
      occurredAtEpochMs: nowMs,
    });

    throw error;
  }

  // Why the money may be captured: `three_ds` when the issuer authenticated the card, `billing_match` when the
  // billing postal code and the payer's IP country both matched the invoice instead. The second basis is
  // STEP 185's to fill in; until it does, both flags are false and this branch is unreachable by construction.
  const basis = outcome === "authenticated" ? "three_ds" : "billing_match";

  recorder.settle({
    challengeId: record.challengeId,
    outcome,
    decision,
    status: "captured",
    paymentId: payment.paymentId,
    transactionId: payment.transactionId,
    code: null,
    occurredAtEpochMs: nowMs,
  });

  await appendTolerated(dependencies.payment.audit, {
    action: PORTAL_THREE_DS_AUTHENTICATED_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_THREE_DS_AUDIT_ENTITY,
    entityId: payment.paymentId,
    payload: threeDsPayloadOf({
      invoice_id: record.invoiceId,
      amount_minor: record.amountMinor,
      three_ds_outcome: outcome,
      decision,
      basis,
      payment_id: payment.paymentId,
      transaction_id: payment.transactionId,
      challenge_id: record.challengeId,
      idempotency_key_hash: keyHashOf(record.idempotencyKey),
    }),
    companyId: record.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
  });

  return { status: "captured", payment, outcome, basis };
}
