// path: app/(client-portal)/portal-invoice-evidence.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import type { PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { INVOICE_MANAGE_ROLES, orderDocumentDetails } from "../../services/invoices/invoices.ts";
import {
  portalAcceptanceStatementFor,
  portalFulfilmentKindOf,
  portalStatementMatchesKind,
  PORTAL_ACCEPTANCE_CONSENT_KEY,
  PORTAL_ACCEPTANCE_FIELD_ORDER,
  PORTAL_ACCEPTANCE_STATEMENTS,
  PORTAL_ACCEPTANCE_TABLE,
  PORTAL_DEVICE_FINGERPRINT_PATTERN,
  PORTAL_EMAIL_PATTERN,
  PORTAL_EVIDENCE_LIMITS,
  PORTAL_FULFILMENT_CORRECTED_AUDIT_ACTION,
  PORTAL_FULFILMENT_EVIDENCE_TABLE,
  PORTAL_FULFILMENT_FIELD_ORDER,
  PORTAL_FULFILMENT_KINDS,
  PORTAL_FULFILMENT_MAXIMUM_PAST_DAYS,
  PORTAL_FULFILMENT_METHODS,
  PORTAL_FULFILMENT_RECORDED_AUDIT_ACTION,
  PORTAL_ACCEPTED_AUDIT_ACTION,
  PORTAL_FULFILMENT_AUDIT_ENTITY,
  PORTAL_ACCEPTANCE_AUDIT_ENTITY,
  PORTAL_INVOICE_RULES,
  type PortalAcceptanceStatement,
  type PortalFulfilmentKind,
} from "./portal-invoice-fields.ts";
import {
  openPortalInvoice,
  portalAcceptanceRowSchema,
  portalFulfilmentRowSchema,
  portalFulfilmentViewOf,
  portalInvoiceDocumentHashOf,
  type PortalFulfilmentView,
  type PortalInvoiceDependencies,
  type PortalInvoiceView,
} from "./portal-invoice.ts";

/**
 * The two writes of the tokenized invoice page.
 *
 * ## Who writes what
 *
 * A *merchant* records that the goods arrived or the service happened, and a *buyer* confirms it. They
 * are two different people with two different credentials: the merchant has a session and the `owner`
 * role, and the buyer has nothing but the link. So this module has two entry points that share one rule -
 * reopen the link and read it again before deciding anything - and never share a check.
 *
 * ## Zero trust in the caller, in five ways
 *
 *   1. The body is parsed by a strict schema, so a key nobody asked for is named rather than dropped, and
 *      a body the page did not send (a `document_hash` of its own, an `accepted_at`, an `ip`) cannot be
 *      supplied.
 *   2. Every text is measured after trimming and refused rather than repaired when the sanitizer would
 *      have changed it - the rule `services/estimates/estimate-signature.ts` writes down: evidence is
 *      stored as it was given or not at all.
 *   3. The document digest is computed on the server from a fresh read. A buyer's browser never sends a
 *      hash, so it can never send a wrong one.
 *   4. The fulfilment the confirmation points at is compared with the live record read in the same
 *      request, so a page that has been open while the merchant corrected the delivery is refused rather
 *      than stored against evidence it never showed.
 *   5. The merchant's token must name the merchant's own company, because a link is a bearer credential
 *      and a signed-in account is not a licence to write onto another account's document.
 *
 * ## What a confirmation is, once written
 *
 * Nothing may change it: `0122` refuses every update and every delete, and this module offers no route
 * that could try. The merchant's fulfilment record may be corrected until the moment it is confirmed, and
 * not afterwards, which is what makes the confirmation evidence of a specific delivery rather than of
 * whatever the merchant last typed.
 */

/** A fulfilment body, by shape only. Every semantic rule is measured below, one field at a time. */
export const portalFulfilmentInputSchema = z
  .object({
    kind: z.enum(PORTAL_FULFILMENT_KINDS),
    method: z.enum(PORTAL_FULFILMENT_METHODS),
    occurred_at: z.string().min(1).max(64),
    reference: z.string().max(400).nullish(),
    description: z.string().max(2_000).nullish(),
  })
  .strict();

/** A confirmation body, by shape only. */
export const portalAcceptanceInputSchema = z
  .object({
    statement: z.enum(PORTAL_ACCEPTANCE_STATEMENTS),
    fulfilment_evidence_id: z.string().uuid(),
    signer_name: z.string().max(400),
    signer_email: z.string().max(400),
    consent_accepted: z.boolean(),
    device_fingerprint: z.string().max(200).nullish(),
    geo_location: z.string().max(400).nullish(),
  })
  .strict();

/** A parsed fulfilment: the values, already trimmed and already measured. */
export interface ParsedPortalFulfilment {
  readonly kind: PortalFulfilmentKind;
  readonly method: string;
  readonly occurredAt: string;
  readonly reference: string | null;
  readonly description: string | null;
}

/** A parsed confirmation. */
export interface ParsedPortalAcceptance {
  readonly statement: PortalAcceptanceStatement;
  readonly fulfilmentEvidenceId: string;
  readonly signerName: string;
  readonly signerEmail: string;
  readonly deviceFingerprint: string | null;
  readonly geoLocation: string | null;
}

/**
 * The details of a zod refusal, one per field, in the form's own order.
 *
 * `0122` and the schema are both strict, so an unknown key is a mistake somebody can fix and is named as
 * itself; a missing or badly shaped key is `invalid_format` on the field it is about.
 */
function problemsOf(error: z.ZodError, fallbackField: string): readonly ErrorDetail[] {
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

    const field = String(issue.path[0] ?? fallbackField);

    if (!problems.some((problem) => problem.field === field)) {
      problems.push({ field, rule: "invalid_format" });
    }
  }

  return problems;
}

/** A single line text problem, or null: the value the sanitizer would store differs from the one sent. */
function singleLineProblem(value: string, limits: { min: number; max: number }): string | null {
  if (value.length < limits.min) {
    return "too_short";
  }

  if (value.length > limits.max) {
    return "too_long";
  }

  return sanitizeSingleLineText(value, limits.max) === value ? null : "invalid_format";
}

/** A multi line text problem, or null. */
function multiLineProblem(value: string, limits: { min: number; max: number }): string | null {
  if (value.length < limits.min) {
    return "too_short";
  }

  if (value.length > limits.max) {
    return "too_long";
  }

  return sanitizeMultilineText(value, limits.max) === value ? null : "invalid_format";
}

function reject(problems: ErrorDetail[], field: string, rule: string): void {
  if (!problems.some((problem) => problem.field === field)) {
    problems.push({ field, rule });
  }
}

/**
 * Parse a fulfilment body.
 *
 * The instant rules are the interesting ones. A delivery in the future is not evidence of anything, so
 * anything later than sixty seconds ahead is refused - the sixty covers a phone whose clock is a minute
 * fast without letting a merchant date a delivery next year. The other end is bounded by
 * `PORTAL_FULFILMENT_MAXIMUM_PAST_DAYS`, because a record older than a decade is a typo in a year, and a
 * date that cannot be parsed is not a date.
 */
export function parsePortalFulfilment(body: unknown, nowMs: number): ParsedPortalFulfilment {
  const attempt = portalFulfilmentInputSchema.safeParse(body);

  if (!attempt.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problemsOf(attempt.error, "fulfilment"), PORTAL_FULFILMENT_FIELD_ORDER, []),
    });
  }

  const data = attempt.data;
  const problems: ErrorDetail[] = [];

  if (portalFulfilmentKindOf(data.method) !== data.kind) {
    reject(problems, "method", "invalid_format");
  }

  const occurredMs = Date.parse(data.occurred_at);

  if (!Number.isFinite(occurredMs)) {
    reject(problems, "occurred_at", "invalid_format");
  } else if (occurredMs > nowMs + 60_000) {
    reject(problems, "occurred_at", "too_large");
  } else if (occurredMs < nowMs - PORTAL_FULFILMENT_MAXIMUM_PAST_DAYS * 86_400_000) {
    reject(problems, "occurred_at", "too_small");
  }

  const referenceText = data.reference?.trim() ?? "";
  const descriptionText = data.description?.trim() ?? "";
  const reference = referenceText.length === 0 ? null : referenceText;
  const description = descriptionText.length === 0 ? null : descriptionText;

  if (reference !== null) {
    const problem = singleLineProblem(reference, PORTAL_EVIDENCE_LIMITS.reference);

    if (problem !== null) {
      reject(problems, "reference", problem);
    }
  }

  if (description !== null) {
    const problem = multiLineProblem(description, PORTAL_EVIDENCE_LIMITS.description);

    if (problem !== null) {
      reject(problems, "description", problem);
    }
  }

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problems, PORTAL_FULFILMENT_FIELD_ORDER, []),
    });
  }

  return {
    kind: data.kind,
    method: data.method,
    occurredAt: new Date(occurredMs).toISOString(),
    reference,
    description,
  };
}

/**
 * Parse a confirmation body.
 *
 * The consent flag is checked here as well as by the column's `check (consent_accepted)`, because the
 * answer a buyer needs is "tick the box", not a database error. Everything else is measured rather than
 * repaired, and the fingerprint is held to printable ASCII so a value that would need escaping in a PDF
 * is refused before it is stored.
 */
export function parsePortalAcceptance(body: unknown): ParsedPortalAcceptance {
  const attempt = portalAcceptanceInputSchema.safeParse(body);

  if (!attempt.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problemsOf(attempt.error, "confirmation"), PORTAL_ACCEPTANCE_FIELD_ORDER, []),
    });
  }

  const data = attempt.data;
  const problems: ErrorDetail[] = [];

  if (!data.consent_accepted) {
    reject(problems, "consent_accepted", "required");
  }

  const signerName = data.signer_name.trim();
  const signerEmail = data.signer_email.trim();
  const fingerprint = (data.device_fingerprint ?? "").trim();
  const geoLocation = (data.geo_location ?? "").trim();

  const nameProblem = singleLineProblem(signerName, PORTAL_EVIDENCE_LIMITS.signerName);

  if (nameProblem !== null) {
    reject(problems, "signer_name", nameProblem);
  }

  const emailProblem = singleLineProblem(signerEmail, PORTAL_EVIDENCE_LIMITS.signerEmail);

  if (emailProblem !== null) {
    reject(problems, "signer_email", emailProblem);
  } else if (!PORTAL_EMAIL_PATTERN.test(signerEmail)) {
    reject(problems, "signer_email", "invalid_format");
  }

  if (fingerprint.length > 0 && !PORTAL_DEVICE_FINGERPRINT_PATTERN.test(fingerprint)) {
    reject(problems, "device_fingerprint", "invalid_format");
  }

  if (geoLocation.length > 0) {
    const geoProblem = singleLineProblem(geoLocation, PORTAL_EVIDENCE_LIMITS.geoLocation);

    if (geoProblem !== null) {
      reject(problems, "geo_location", geoProblem);
    }
  }

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problems, PORTAL_ACCEPTANCE_FIELD_ORDER, []),
    });
  }

  return {
    statement: data.statement,
    fulfilmentEvidenceId: data.fulfilment_evidence_id,
    signerName,
    signerEmail,
    deviceFingerprint: fingerprint.length === 0 ? null : fingerprint,
    geoLocation: geoLocation.length === 0 ? null : geoLocation,
  };
}

/** What both writes need: the read model's dependencies plus the audit chain. */
export interface PortalEvidenceDependencies extends PortalInvoiceDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly tokenKeys: PortalTokenKeys;
  readonly now?: () => number;
}

/** A signed-in merchant recording a fulfilment. */
export interface RecordPortalFulfilmentInput {
  readonly actor: RequestActor;
  readonly token: string;
  readonly body: unknown;
}

/** The answer of a recorded fulfilment. */
export interface RecordedPortalFulfilment {
  readonly invoiceId: string;
  readonly fulfilment: PortalFulfilmentView;
  /** True when an unconfirmed earlier record was replaced rather than a first record written. */
  readonly replaced: boolean;
}

/**
 * The live fulfilment record of one invoice, or null.
 *
 * Read again after a write, because `rest.update` answers nothing: a REST update that matched no row is
 * still a successful call, so the only way to know a correction landed is to look. This is the same
 * `writeLanded` shape `services/invoices/invoice-pdf-document.ts` uses.
 */
async function readLiveFulfilment(
  rest: RestClient,
  companyId: string,
  invoiceId: string,
): Promise<z.infer<typeof portalFulfilmentRowSchema> | null> {
  const rows = await rest.select(
    PORTAL_FULFILMENT_EVIDENCE_TABLE,
    "select=id,company_id,invoice_id,kind,method,occurred_at,reference,description,recorded_at,version" +
      `&company_id=eq.${companyId}&invoice_id=eq.${invoiceId}&deleted_at=is.null&limit=1`,
    portalFulfilmentRowSchema,
  );

  return rows[0] ?? null;
}

/** One audit entry, written or not: a chain that is down never fails the fact it records. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The evidence row is the fact; an audit sink that cannot be reached must not turn a
    // merchant's delivery into a page that never finished, which is the rule every write in this
    // repository follows.
  }
}

/**
 * Record - or correct - the fulfilment evidence of one invoice.
 *
 * The order of the checks is the order a merchant can fix them: who they are, whether the document
 * accepts a record at all, whether it has already been confirmed, and finally whether the body is
 * well formed. Reading the document before parsing the body costs one read and means a merchant who
 * sends a malformed body to a cancelled invoice is told the invoice is cancelled, which is the more
 * useful sentence.
 */
export async function recordPortalInvoiceFulfilment(
  input: RecordPortalFulfilmentInput,
  dependencies: PortalEvidenceDependencies,
): Promise<RecordedPortalFulfilment> {
  requireAnyRole(input.actor, INVOICE_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  const nowMs = dependencies.now?.() ?? Date.now();
  const view: PortalInvoiceView = await openPortalInvoice(
    { token: input.token },
    { rest: dependencies.rest, tokenKeys: dependencies.tokenKeys, now: () => nowMs },
  );

  if (view.companyId !== companyId) {
    throw new AppError("PERMISSION_DENIED");
  }

  if (view.state === "not_issued") {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.notIssued }],
    });
  }

  if (view.state === "void") {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.invoiceVoid }],
    });
  }

  if (view.acceptance !== null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.evidenceConfirmed }],
    });
  }

  const parsed = parsePortalFulfilment(input.body, nowMs);
  const at = new Date(nowMs).toISOString();

  if (view.fulfilment !== null) {
    await dependencies.rest.update(
      PORTAL_FULFILMENT_EVIDENCE_TABLE,
      `id=eq.${view.fulfilment.id}&company_id=eq.${companyId}` +
        `&version=eq.${view.fulfilment.version}&deleted_at=is.null`,
      { deleted_at: at },
    );

    const after = await readLiveFulfilment(dependencies.rest, companyId, view.invoiceId);

    if (after !== null && after.id === view.fulfilment.id) {
      throw new AppError("CONFLICT", {
        details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.staleVersion }],
      });
    }
  }

  const inserted = await dependencies.rest.insertReturning(
    PORTAL_FULFILMENT_EVIDENCE_TABLE,
    [
      {
        company_id: companyId,
        invoice_id: view.invoiceId,
        kind: parsed.kind,
        method: parsed.method,
        occurred_at: parsed.occurredAt,
        reference: parsed.reference,
        description: parsed.description,
        recorded_by_user_id: input.actor.userId,
        recorded_at: at,
      },
    ],
    portalFulfilmentRowSchema,
  );

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  await appendTolerated(dependencies.audit, {
    action:
      view.fulfilment === null
        ? PORTAL_FULFILMENT_RECORDED_AUDIT_ACTION
        : PORTAL_FULFILMENT_CORRECTED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: PORTAL_FULFILMENT_AUDIT_ENTITY,
    entityId: row.id,
    // The facts of the record, and never the words the merchant typed about their own client: a
    // reference can be a tracking number and a description can name a person, so the chain keeps the
    // shape of the evidence and the row keeps the text.
    payload: {
      invoice_id: view.invoiceId,
      kind: row.kind,
      method: row.method,
      occurred_at: row.occurred_at,
      recorded_at: row.recorded_at,
      replaced_evidence_id: view.fulfilment?.id ?? null,
      has_reference: row.reference !== null,
      has_description: row.description !== null,
    },
    companyId,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return {
    invoiceId: view.invoiceId,
    fulfilment: portalFulfilmentViewOf(row),
    replaced: view.fulfilment !== null,
  };
}

/** What a buyer's confirmation carries from the request, which no browser may set itself. */
export interface CapturePortalAcceptanceInput {
  readonly token: string;
  readonly body: unknown;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  /**
   * The company of the session that made the request, when it had one.
   *
   * A buyer has no session, so this is null for the case the page exists for. It is *not* null when the
   * merchant's own browser posts the form, and that is the case this field refuses below: a seller who
   * confirms their own delivery has produced evidence of nothing, and a release gate that took it would
   * be a gate a merchant could open for themselves.
   */
  readonly actorCompanyId: string | null;
}

/** The answer of a stored confirmation. */
export interface CapturedPortalAcceptance {
  readonly acceptanceId: string;
  readonly invoiceId: string;
  readonly companyId: string;
  readonly statement: PortalAcceptanceStatement;
  readonly signerName: string;
  readonly acceptedAt: string;
  readonly documentHash: string;
  readonly fulfilmentEvidenceId: string;
}

/**
 * Store a buyer's confirmation of a paid invoice.
 *
 * The token is reopened rather than trusted from the caller's page, and the document digest is computed
 * from that fresh read, so the evidence names the document as it stood at the moment of confirmation. The
 * address is the request's own - the route reads it from the headers and this function refuses to invent
 * one - because a confirmation without an address is weaker evidence than the column allows.
 */
export async function capturePortalInvoiceAcceptance(
  input: CapturePortalAcceptanceInput,
  dependencies: PortalEvidenceDependencies,
): Promise<CapturedPortalAcceptance> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const view = await openPortalInvoice(
    { token: input.token },
    { rest: dependencies.rest, tokenKeys: dependencies.tokenKeys, now: () => nowMs },
  );

  if (view.state === "not_issued") {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.notIssued }],
    });
  }

  if (view.state === "void") {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.invoiceVoid }],
    });
  }

  if (view.acceptance !== null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.acceptanceExists }],
    });
  }

  if (BigInt(view.totals.paidMinor) <= 0n) {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.notPaidYet }],
    });
  }

  if (input.actorCompanyId === view.companyId) {
    throw new AppError("CONFLICT", {
      details: [{ field: "confirmation", rule: PORTAL_INVOICE_RULES.selfConfirmation }],
    });
  }

  if (view.fulfilment === null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "invoice", rule: PORTAL_INVOICE_RULES.evidenceMissing }],
    });
  }

  const parsed = parsePortalAcceptance(input.body);

  if (!portalStatementMatchesKind(parsed.statement, view.fulfilment.kind)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "statement", rule: PORTAL_INVOICE_RULES.statementMismatch }],
    });
  }

  if (parsed.fulfilmentEvidenceId !== view.fulfilment.id) {
    throw new AppError("CONFLICT", {
      details: [{ field: "fulfilment_evidence_id", rule: PORTAL_INVOICE_RULES.evidenceChanged }],
    });
  }

  // The statement the page offered, recomputed from the evidence rather than taken from the body: a body
  // that names the right statement for the wrong reason is still refused above, and this is the copy the
  // response and the audit entry use.
  const statement = portalAcceptanceStatementFor(view.fulfilment.kind);
  const documentHash = portalInvoiceDocumentHashOf(view);
  const at = new Date(nowMs).toISOString();
  const inserted = await dependencies.rest.insertReturning(
    PORTAL_ACCEPTANCE_TABLE,
    [
      {
        company_id: view.companyId,
        invoice_id: view.invoiceId,
        fulfilment_evidence_id: view.fulfilment.id,
        statement,
        signer_name: parsed.signerName,
        signer_email: parsed.signerEmail,
        consent_text: getMessage(PORTAL_ACCEPTANCE_CONSENT_KEY),
        consent_accepted: true,
        accepted_at: at,
        ip: input.clientAddress,
        geo_location: parsed.geoLocation,
        device_fingerprint: parsed.deviceFingerprint,
        document_hash: documentHash,
        user_agent: input.userAgent === null ? null : sanitizeSingleLineText(input.userAgent, 400) || null,
      },
    ],
    portalAcceptanceRowSchema,
  );

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  await appendTolerated(dependencies.audit, {
    actorUserId: null,
    action: PORTAL_ACCEPTED_AUDIT_ACTION,
    entityType: PORTAL_ACCEPTANCE_AUDIT_ENTITY,
    entityId: row.id,
    // No name, no address and no fingerprint: the row holds the buyer's words, and the chain holds what
    // the platform needs to prove the row exists and what it was about.
    payload: {
      invoice_id: view.invoiceId,
      fulfilment_evidence_id: view.fulfilment.id,
      statement: row.statement,
      document_hash: row.document_hash,
      accepted_at: row.accepted_at,
      has_geo_location: parsed.geoLocation !== null,
      has_device_fingerprint: parsed.deviceFingerprint !== null,
    },
    companyId: view.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: input.userAgent,
  });

  return {
    acceptanceId: row.id,
    invoiceId: view.invoiceId,
    companyId: view.companyId,
    statement: row.statement,
    signerName: row.signer_name,
    acceptedAt: row.accepted_at,
    documentHash: row.document_hash,
    fulfilmentEvidenceId: row.fulfilment_evidence_id,
  };
}
