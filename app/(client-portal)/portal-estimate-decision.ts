// path: app/(client-portal)/portal-estimate-decision.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import type { PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { sanitizeSingleLineText } from "../../lib/security/text.ts";
import { ESTIMATE_COLUMNS, ESTIMATE_TABLE } from "../../services/estimates/estimate-fields.ts";
import { ESTIMATE_SIGNATURE_EMAIL_PATTERN, ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN } from "../../services/estimates/estimate-signature-fields.ts";
import { captureEstimateSignature, type EstimateSignatureSnapshot } from "../../services/estimates/estimate-signature.ts";
import {
  estimateRowSchema,
  type EstimateRow,
} from "../../services/estimates/estimates.ts";
import {
  PORTAL_ESTIMATE_ACCEPTED_AUDIT_ACTION,
  PORTAL_ESTIMATE_AUDIT_ENTITY,
  PORTAL_ESTIMATE_CONSENT_KEY,
  PORTAL_ESTIMATE_DECISIONS,
  PORTAL_ESTIMATE_DECLINED_AUDIT_ACTION,
  PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION,
  PORTAL_ESTIMATE_FIELD_ORDER,
  PORTAL_ESTIMATE_LIMITS,
  PORTAL_ESTIMATE_RULES,
  PORTAL_ESTIMATE_VIEWED_AUDIT_ACTION,
  type PortalEstimateState,
} from "./portal-estimate-fields.ts";
import {
  isPortalEstimateOpenStatus,
  openPortalEstimate,
  type PortalEstimateView,
} from "./portal-estimate.ts";

/**
 * The one write of the tokenized estimate page, and the two states a quote reaches around it.
 *
 * ## The three transitions this module applies
 *
 * `0025` lets a quote move `sent` -> `viewed` -> `accepted` or `void`, and freezes it once decided. Three
 * moments map onto that graph:
 *
 *   1. **Opened.** A `sent` quote that somebody opens becomes `viewed`. It is the only thing a quote link can
 *      tell a merchant that an invoice link cannot, and it is the state `0027`'s own comment assumes when it
 *      says a client has seen the offer.
 *   2. **Decided.** The client accepts or declines. The evidence row is written by STEP 022's
 *      `captureEstimateSignature`, and *this* module applies the status the decision implies: `accepted`
 *      with `accepted_at`, or `void` with `void_reason = 'declined'` and `voided_at`.
 *   3. **Expired.** The clock passes `expires_at` while the quote is still open, and opening the link voids it
 *      with `void_reason = 'expired'`. Section 16: "a client can decline an estimate, and an estimate expires
 *      at its expiry time. Both paths set the estimate to void."
 *
 * ## Why the decision is applied here and not in STEP 022's service
 *
 * `captureEstimateSignature` writes evidence and nothing else, deliberately: it is called from a merchant
 * route where the merchant is the one recording a decision their client gave in person. A tokenized link is
 * the other direction - the client decides, and the platform must move the document - so the transition
 * belongs to the surface that learned about it. The freeze is still the database's: `estimates_guard_terminal`
 * refuses every later change, and `0027`'s unique index refuses a second decision even if this module were
 * wrong.
 *
 * ## Zero trust
 *
 * The browser sends a decision, a name, an address and a consent tick. It does not send the quote, the
 * company, the address of the request, the user agent or the digest: all four are read here - the first two
 * from the token, the next two from the request, the last from the document as this request read it. The
 * consent wording is the catalog's, so what is stored is what was shown.
 */

/** A decision body, by shape only. Every semantic rule is measured below, one field at a time. */
export const portalEstimateDecisionSchema = z
  .object({
    decision: z.enum(PORTAL_ESTIMATE_DECISIONS),
    signer_name: z.string().max(400),
    signer_email: z.string().max(400),
    consent_accepted: z.boolean(),
    device_fingerprint: z.string().max(200).nullish(),
    geo_location: z.string().max(400).nullish(),
  })
  .strict();

/** A parsed decision, already trimmed and already measured. */
export interface ParsedPortalEstimateDecision {
  readonly decision: (typeof PORTAL_ESTIMATE_DECISIONS)[number];
  readonly signerName: string;
  readonly signerEmail: string;
  readonly deviceFingerprint: string | null;
  readonly geoLocation: string | null;
}

/** What both writes need: the read model's dependencies plus the audit chain. */
export interface PortalEstimateDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** The key ring a link is verified with, so a re-read costs a verification rather than a lookup. */
  readonly tokenKeys: PortalTokenKeys;
  readonly now?: () => number;
}

/** The details of a zod refusal, one per field, in the form's own order. */
function problemsOf(error: z.ZodError): readonly ErrorDetail[] {
  const problems: ErrorDetail[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (!problems.some((problem) => problem.field === key)) {
          problems.push({ field: key, rule: "unknown_field" });
        }
      }

      continue;
    }

    const field = String(issue.path[0] ?? "decision");

    if (!problems.some((problem) => problem.field === field)) {
      problems.push({ field, rule: "invalid_format" });
    }
  }

  return problems;
}

/** The order a refusal lists its fields in, which is the order a signer meets the boxes. */
function ordered(problems: readonly ErrorDetail[]): readonly ErrorDetail[] {
  const rankOf = (field: string): number => {
    const index = (PORTAL_ESTIMATE_FIELD_ORDER as readonly string[]).indexOf(field);

    return index === -1 ? PORTAL_ESTIMATE_FIELD_ORDER.length : index;
  };

  return [...problems].sort((left, right) => rankOf(left.field) - rankOf(right.field));
}

/** A single line problem, or null: the value the sanitiser would store differs from the one sent. */
function singleLineProblem(value: string, limits: { readonly min: number; readonly max: number }): string | null {
  if (value.length < limits.min) {
    return "too_short";
  }

  if (value.length > limits.max) {
    return "too_long";
  }

  return sanitizeSingleLineText(value, limits.max) === value ? null : "invalid_format";
}

/**
 * Parse a decision body.
 *
 * The consent flag is checked here as well as by the column's `check (consent_accepted)`, because the answer
 * a client needs is "tick the box", not a database error. A drawn signature is not offered by this page, so
 * `signature_path` is an unknown key and is refused rather than ignored: a caller who sends one believes it
 * will be stored.
 */
export function parsePortalEstimateDecision(body: unknown): ParsedPortalEstimateDecision {
  const attempt = portalEstimateDecisionSchema.safeParse(body);

  if (!attempt.success) {
    throw new AppError("VALIDATION_FAILED", { details: ordered(problemsOf(attempt.error)) });
  }

  const data = attempt.data;
  const problems: ErrorDetail[] = [];

  if (!data.consent_accepted) {
    problems.push({ field: "consent_accepted", rule: "required" });
  }

  const signerName = data.signer_name.trim();
  const signerEmail = data.signer_email.trim();
  const fingerprint = (data.device_fingerprint ?? "").trim();
  const geoLocation = (data.geo_location ?? "").trim();

  const nameProblem = singleLineProblem(signerName, PORTAL_ESTIMATE_LIMITS.signerName);

  if (nameProblem !== null) {
    problems.push({ field: "signer_name", rule: nameProblem });
  }

  const emailProblem = singleLineProblem(signerEmail, PORTAL_ESTIMATE_LIMITS.signerEmail);

  if (emailProblem !== null) {
    problems.push({ field: "signer_email", rule: emailProblem });
  } else if (!ESTIMATE_SIGNATURE_EMAIL_PATTERN.test(signerEmail)) {
    problems.push({ field: "signer_email", rule: "invalid_format" });
  }

  if (fingerprint.length > 0 && !ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN.test(fingerprint)) {
    problems.push({ field: "device_fingerprint", rule: "invalid_format" });
  }

  if (geoLocation.length > 0) {
    const geoProblem = singleLineProblem(geoLocation, PORTAL_ESTIMATE_LIMITS.geoLocation);

    if (geoProblem !== null) {
      problems.push({ field: "geo_location", rule: geoProblem });
    }
  }

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: ordered(problems) });
  }

  return {
    decision: data.decision,
    signerName,
    signerEmail,
    deviceFingerprint: fingerprint.length === 0 ? null : fingerprint,
    geoLocation: geoLocation.length === 0 ? null : geoLocation,
  };
}

/** One audit entry, written or not: a chain that is down never fails the fact it records. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The quote's own state is the fact; an audit sink that cannot be reached must not turn a
    // client's decision into a page that never finished.
  }
}

/** The stored row of one quote, read again after a write because a REST update answers nothing. */
async function readEstimateRow(
  rest: RestClient,
  companyId: string,
  estimateId: string,
): Promise<EstimateRow | null> {
  const rows = await rest.select(
    ESTIMATE_TABLE,
    `${ESTIMATE_COLUMNS}&id=eq.${estimateId}&company_id=eq.${companyId}&deleted_at=is.null&limit=1`,
    estimateRowSchema,
  );

  return rows[0] ?? null;
}

/** The rule that explains why a decided quote cannot be decided again. */
function closedRuleOf(state: PortalEstimateState): string {
  switch (state) {
    case "accepted":
      return PORTAL_ESTIMATE_RULES.alreadyAccepted;
    case "declined":
      return PORTAL_ESTIMATE_RULES.alreadyDeclined;
    case "expired":
      return PORTAL_ESTIMATE_RULES.expired;
    case "withdrawn":
      return PORTAL_ESTIMATE_RULES.withdrawn;
    case "not_issued":
      return PORTAL_ESTIMATE_RULES.notIssued;
    case "open":
      return PORTAL_ESTIMATE_RULES.staleVersion;
  }
}

/**
 * Void a quote whose lifetime has passed, and answer the link as it now is.
 *
 * Called on open, before anything is decided, so an expired offer cannot be signed and the stored status
 * catches up with the clock. The update is scoped by the version that was read and by the two open statuses,
 * so two visitors arriving at the same second cannot both void it and neither can void a quote somebody has
 * just accepted - the loser re-reads and finds the winner's state, which is the honest answer rather than a
 * second void.
 *
 * A quote that is not past its expiry is answered unchanged and costs no write.
 */
export async function applyPortalEstimateExpiry(
  input: { readonly token: string; readonly view: PortalEstimateView },
  dependencies: PortalEstimateDependencies,
): Promise<PortalEstimateView> {
  const view = input.view;

  if (!view.expired || !isPortalEstimateOpenStatus(view.estimate.status)) {
    return view;
  }

  const nowMs = dependencies.now?.() ?? Date.now();
  const at = new Date(nowMs).toISOString();

  await dependencies.rest.update(
    ESTIMATE_TABLE,
    `id=eq.${view.estimate.id}&company_id=eq.${view.estimate.companyId}` +
      `&version=eq.${view.estimate.version}&deleted_at=is.null&status=in.(sent,viewed)`,
    { status: "void", void_reason: "expired", voided_at: at },
  );

  const after = await readEstimateRow(dependencies.rest, view.estimate.companyId, view.estimate.id);

  if (after !== null && after.status === "void" && after.void_reason === "expired") {
    await appendTolerated(dependencies.audit, {
      action: PORTAL_ESTIMATE_EXPIRED_AUDIT_ACTION,
      actorUserId: null,
      entityType: PORTAL_ESTIMATE_AUDIT_ENTITY,
      entityId: view.estimate.id,
      payload: {
        number: view.estimate.number,
        expires_at: view.estimate.expiresAt,
        voided_at: after.voided_at,
        document_hash: view.documentHash,
      },
      companyId: view.estimate.companyId,
      sessionId: null,
      ipAddress: null,
      userAgent: null,
    });
  }

  // The token is passed in rather than carried on the view: a view is printed, logged and handed to
  // components, and a credential does not belong in any of those. The caller that holds it re-reads with it.
  return openPortalEstimate(
    { token: input.token },
    { rest: dependencies.rest, tokenKeys: dependencies.tokenKeys, now: () => nowMs },
  );
}

/**
 * Record a quote as opened, once.
 *
 * `sent` -> `viewed` and nothing else: a quote already viewed, accepted or void is answered without a write,
 * and a quote whose update loses a race is left to the winner. It is deliberately tolerant - the page must
 * render even when this cannot be written, because the client came to read an offer, not to update a status -
 * and it is audited once, when the write lands.
 */
export async function applyPortalEstimateView(
  view: PortalEstimateView,
  dependencies: PortalEstimateDependencies,
): Promise<void> {
  if (view.estimate.status !== "sent") {
    return;
  }

  const nowMs = dependencies.now?.() ?? Date.now();

  try {
    await dependencies.rest.update(
      ESTIMATE_TABLE,
      `id=eq.${view.estimate.id}&company_id=eq.${view.estimate.companyId}` +
        `&version=eq.${view.estimate.version}&deleted_at=is.null&status=eq.sent`,
      { status: "viewed" },
    );
  } catch {
    return;
  }

  const after = await readEstimateRow(dependencies.rest, view.estimate.companyId, view.estimate.id).catch(
    () => null,
  );

  if (after === null || after.status !== "viewed") {
    return;
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_ESTIMATE_VIEWED_AUDIT_ACTION,
    actorUserId: null,
    entityType: PORTAL_ESTIMATE_AUDIT_ENTITY,
    entityId: view.estimate.id,
    payload: { number: view.estimate.number, viewed_at: new Date(nowMs).toISOString() },
    companyId: view.estimate.companyId,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  });
}

/** What a client's decision carries from the request, which no browser may set itself. */
export interface DecidePortalEstimateInput {
  readonly token: string;
  readonly body: unknown;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  /**
   * The company of the session that made the request, when it had one.
   *
   * A client has no session, so this is null for the case the page exists for. It is not null when the
   * merchant's own browser posts the form, and that is the case this field refuses: a seller who signs their
   * own offer has produced evidence of nothing, and the acceptance a conversion later depends on would be a
   * merchant's own word.
   */
  readonly actorCompanyId: string | null;
}

/** The answer of a recorded decision. */
export interface DecidedPortalEstimate {
  readonly estimateId: string;
  readonly companyId: string;
  readonly number: string | null;
  readonly decision: EstimateSignatureSnapshot["decision"];
  readonly state: PortalEstimateState;
  readonly decidedAt: string;
  readonly documentHash: string;
  readonly signatureId: string;
  readonly signerName: string;
}

/**
 * Record a client's decision on a quote and move the document to the state it implies.
 *
 * The order is the one a client can act on. The link is reopened and the expiry applied first, so an expired
 * offer refuses the decision and is voided by the same request. Then the refusal a decided quote deserves,
 * then the seller's own session, then the body, then the evidence - and only after the evidence exists is the
 * document moved, because a document moved without evidence would be a conversion waiting for a signature
 * that never arrives.
 *
 * If the status write loses a race the evidence still stands: another decision cannot be written (the unique
 * index on `estimate_id` refuses it), and the client is told the quote changed rather than that their
 * signature was lost.
 */
export async function decidePortalEstimate(
  input: DecidePortalEstimateInput,
  dependencies: PortalEstimateDependencies,
): Promise<DecidedPortalEstimate> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const opened = await openPortalEstimate(
    { token: input.token },
    { rest: dependencies.rest, tokenKeys: dependencies.tokenKeys, now: () => nowMs },
  );
  const view = await applyPortalEstimateExpiry(
    { token: input.token, view: opened },
    {
      rest: dependencies.rest,
      audit: dependencies.audit,
      tokenKeys: dependencies.tokenKeys,
      now: () => nowMs,
    },
  );

  if (!view.open) {
    throw new AppError("CONFLICT", {
      details: [{ field: "decision", rule: closedRuleOf(view.state) }],
    });
  }

  if (input.actorCompanyId === view.estimate.companyId) {
    throw new AppError("CONFLICT", {
      details: [{ field: "decision", rule: PORTAL_ESTIMATE_RULES.selfDecision }],
    });
  }

  const parsed = parsePortalEstimateDecision(input.body);
  const signature = await captureEstimateSignature(
    {
      estimate_id: view.estimate.id,
      company_id: view.estimate.companyId,
      decision: parsed.decision,
      signer_name: parsed.signerName,
      signer_email: parsed.signerEmail,
      // The wording the page showed, read from the catalog so the stored sentence is the shown one.
      consent_text: getMessage(PORTAL_ESTIMATE_CONSENT_KEY),
      consent_accepted: true,
      ip_address: input.clientAddress,
      geo_location: parsed.geoLocation,
      device_fingerprint: parsed.deviceFingerprint,
      signature_path: null,
      user_agent: input.userAgent,
    },
    { rest: dependencies.rest, audit: dependencies.audit, now: () => nowMs },
  );

  const at = new Date(nowMs).toISOString();
  const values =
    parsed.decision === "accepted"
      ? { status: "accepted", accepted_at: at }
      : { status: "void", void_reason: "declined", voided_at: at };

  await dependencies.rest.update(
    ESTIMATE_TABLE,
    `id=eq.${view.estimate.id}&company_id=eq.${view.estimate.companyId}` +
      `&version=eq.${view.estimate.version}&deleted_at=is.null&status=in.(sent,viewed)`,
    values,
  );

  const after = await readEstimateRow(dependencies.rest, view.estimate.companyId, view.estimate.id);
  const expectedStatus = parsed.decision === "accepted" ? "accepted" : "void";

  if (after === null || after.status !== expectedStatus) {
    throw new AppError("CONFLICT", {
      details: [{ field: "decision", rule: PORTAL_ESTIMATE_RULES.staleVersion }],
    });
  }

  const state: PortalEstimateState = parsed.decision === "accepted" ? "accepted" : "declined";

  await appendTolerated(dependencies.audit, {
    action:
      parsed.decision === "accepted"
        ? PORTAL_ESTIMATE_ACCEPTED_AUDIT_ACTION
        : PORTAL_ESTIMATE_DECLINED_AUDIT_ACTION,
    // No actor: the signer is a client, and clients hold no account here. The entry belongs to the
    // merchant's chain and carries the digest, which is what makes it corroborate the evidence row rather
    // than merely mention it.
    actorUserId: null,
    entityType: PORTAL_ESTIMATE_AUDIT_ENTITY,
    entityId: view.estimate.id,
    payload: {
      number: view.estimate.number,
      decision: parsed.decision,
      signature_id: signature.id,
      document_hash: signature.documentHash,
      void_reason: parsed.decision === "accepted" ? null : "declined",
      decided_at: at,
      has_geo_location: parsed.geoLocation !== null,
      has_device_fingerprint: parsed.deviceFingerprint !== null,
    },
    companyId: view.estimate.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
  });

  return {
    estimateId: view.estimate.id,
    companyId: view.estimate.companyId,
    number: view.estimate.number,
    decision: parsed.decision,
    state,
    decidedAt: at,
    documentHash: signature.documentHash,
    signatureId: signature.id,
    signerName: parsed.signerName,
  };
}
