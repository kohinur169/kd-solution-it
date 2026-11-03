// path: services/kyc/kyc-review.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { BUSINESS_PROFILE_TABLE } from "./business-profile.ts";
import {
  KYC_DOCUMENTS_TABLE,
  KYC_SUBMISSIONS_TABLE,
  SANCTIONS_SCREENINGS_TABLE,
  UBO_RECORDS_TABLE,
} from "./kyc-capture.ts";
import type { KycDocumentType } from "./kyc-document-types.ts";

/**
 * The compliance KYC review queue of section 5: the office side of the tables STEP 028 built and
 * STEPs 084-087 write from the merchant side.
 *
 * ## Who may use it
 *
 * `KYC_REVIEW_OFFICE_ROLES` - super_admin, ceo, compliance_kyc - are the only roles the queue and
 * the detail answer to; any other actor is `PERMISSION_DENIED` before a single query runs, and the
 * gate proves that. A merchant owner is deliberately not on the list: the merchant's own surface
 * is STEP 087's summary screen, which never carries the method, a provider reference, a screening
 * result or a storage key.
 *
 * ## What the office sees that the merchant never does
 *
 * The detail read selects the submission's `verification_method` and `provider_reference`, every
 * document row with its storage key and hash, and the screening rows with their result and note.
 * The bytes themselves belong to the storage layer of STEPs 100-105 (`lib/storage/`), which does
 * not exist yet, so the viewer shows the record the office needs to verify a file later - type,
 * dates, size, detected content type, tenant-scoped storage key and the SHA-256 that binds the row
 * to the bytes - and never pretends to render what is not stored in this build.
 *
 * ## The two writes
 *
 * `openKycReview` moves a `submitted` row to `in_review` with the first reviewer named,
 * `reviewKycDocument` accepts or rejects one document with the reason `0049` demands on a
 * rejection, and STEP 093's `decideKycSubmission` approves or rejects the whole submission. All
 * three are conditional updates (by id, company, current status and version) with the version
 * bumped, re-read to detect a lost race, and each appends one audit entry.
 *
 * ## Audit
 *
 * Every office read of one submission appends `kyc_review.read_by_office`, like the office reads of
 * the processor profile; an audit sink that is down never fails a read.
 */

/** The office roles that may work the KYC review queue. */
export const KYC_REVIEW_OFFICE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
] as const satisfies readonly PlatformRole[]);

/** The audit action an office read of one submission is recorded under. */
export const KYC_REVIEW_AUDIT_ACTION = "kyc_review.read_by_office";

/** The audit action opening a submission for review. */
export const KYC_REVIEW_OPEN_AUDIT_ACTION = "kyc_review.opened";

/** The audit action deciding one document. */
export const KYC_DOCUMENT_REVIEW_AUDIT_ACTION = "kyc_document.reviewed";

/** The audit action marking a submission high risk or four-eye. */
export const KYC_RISK_MARK_AUDIT_ACTION = "kyc_review.risk_marked";

/** The audit entity of the queue: the submission. */
export const KYC_REVIEW_ENTITY = "kyc_submission";

/** The audit entity of a document decision: the document row. */
export const KYC_DOCUMENT_REVIEW_ENTITY = "kyc_document";

/** The statuses that sit in the review queue: submitted and in review, never draft or decided. */
export const KYC_REVIEW_QUEUE_STATUSES = ["submitted", "in_review"] as const;

export interface KycReviewDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

function nowOf(dependencies: KycReviewDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function requireOfficeActor(actor: RequestActor): void {
  requireAnyRole(actor, KYC_REVIEW_OFFICE_ROLES);
}

/** A route parameter that must be a UUID is validated before any query runs. */
function requireUuid(value: unknown, field: string): string {
  const parsed = z.string().uuid().safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field, rule: "invalid_format" }] });
  }

  return parsed.data;
}

const queueRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  submitted_at: z.string().nullable(),
  high_risk: z.boolean(),
  four_eye_required: z.boolean(),
  created_at: z.string(),
});

const submissionFullRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  verification_method: z.string(),
  status: z.string(),
  submitted_at: z.string().nullable(),
  submitted_by: z.string().nullable(),
  first_reviewer_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  provider_reference: z.string().nullable(),
  high_risk: z.boolean(),
  four_eye_required: z.boolean(),
  version: z.coerce.number(),
  created_at: z.string(),
});

const documentFullRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  submission_id: z.string(),
  document_type: z.string(),
  storage_key: z.string(),
  content_sha256: z.string(),
  content_type: z.string(),
  byte_size: z.coerce.number(),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  status: z.string(),
  rejection_reason: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  version: z.coerce.number(),
  created_at: z.string(),
});

const uboFullRowSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  date_of_birth: z.string(),
  country: z.string(),
  ownership_bps: z.coerce.number(),
  is_significant: z.boolean(),
  is_pep: z.boolean(),
  screened_at: z.string().nullable(),
  created_at: z.string(),
});

const screeningFullRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  ofac_checked: z.boolean(),
  un_checked: z.boolean(),
  eu_checked: z.boolean(),
  us_checked: z.boolean(),
  result: z.string(),
  provider: z.string(),
  screened_at: z.string(),
  note: z.string().nullable(),
  sar_case: z.boolean(),
  created_at: z.string(),
});

const profileNameRowSchema = z.object({
  legal_name: z.string().nullable(),
  trading_name: z.string().nullable(),
  country_code: z.string().nullable(),
});

/** One queued submission with the counts the queue row shows beside it. */
export interface KycReviewQueueRow {
  readonly submissionId: string;
  readonly companyId: string;
  readonly status: string;
  readonly submittedAt: string | null;
  readonly highRisk: boolean;
  readonly fourEyeRequired: boolean;
  readonly createdAt: string;
  readonly documentCount: number;
  readonly ownerCount: number;
  readonly screenedCount: number;
}

export interface KycReviewQueue {
  readonly rows: readonly KycReviewQueueRow[];
}

/** One document as the reviewer's viewer shows it, storage key and hash included. */
export interface KycReviewDocument {
  readonly id: string;
  readonly documentType: KycDocumentType;
  readonly storageKey: string;
  readonly contentSha256: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly status: string;
  readonly rejectionReason: string | null;
  readonly reviewedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface KycReviewUbo {
  readonly id: string;
  readonly fullName: string;
  readonly dateOfBirth: string;
  readonly country: string;
  readonly ownershipBps: number;
  readonly isSignificant: boolean;
  readonly isPep: boolean;
  readonly screenedAt: string | null;
}

export interface KycReviewScreening {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly result: string;
  readonly provider: string;
  readonly screenedAt: string;
  readonly note: string | null;
  readonly sarCase: boolean;
  readonly listsCovered: readonly string[];
}

export interface KycReviewDetail {
  readonly submissionId: string;
  readonly companyId: string;
  readonly status: string;
  readonly method: string;
  readonly providerReference: string | null;
  readonly submittedAt: string | null;
  readonly submittedBy: string | null;
  readonly firstReviewerId: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly highRisk: boolean;
  readonly fourEyeRequired: boolean;
  readonly legalName: string | null;
  readonly tradingName: string | null;
  readonly countryCode: string | null;
  readonly documents: readonly KycReviewDocument[];
  readonly ubos: readonly KycReviewUbo[];
  readonly screenings: readonly KycReviewScreening[];
}

/* -------------------------------------------------------------------------------------------------
 * The queue: every open submission, newest submitted first.
 * ---------------------------------------------------------------------------------------------- */

/** The review queue: submissions in `submitted` or `in_review`, with per-row counts. */
export async function readKycReviewQueue(
  input: { readonly actor: RequestActor },
  dependencies: KycReviewDependencies,
): Promise<KycReviewQueue> {
  requireOfficeActor(input.actor);

  const rest = dependencies.rest;
  const statuses = KYC_REVIEW_QUEUE_STATUSES.map((status) => encodeURIComponent(status)).join(",");

  const [submissionRows, documentRows, uboRows, screeningRows] = await Promise.all([
    rest.select(
      KYC_SUBMISSIONS_TABLE,
      `select=id,company_id,status,submitted_at,high_risk,four_eye_required,created_at&status=in.(${statuses})&deleted_at=is.null&order=submitted_at.asc&limit=200`,
      queueRowSchema,
    ),
    rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id,submission_id&deleted_at=is.null&limit=2000`,
      z.object({ id: z.string(), submission_id: z.string() }),
    ),
    rest.select(
      UBO_RECORDS_TABLE,
      `select=id,submission_id&deleted_at=is.null&limit=2000`,
      z.object({ id: z.string(), submission_id: z.string() }),
    ),
    rest.select(
      SANCTIONS_SCREENINGS_TABLE,
      `select=id,company_id&deleted_at=is.null&limit=2000`,
      z.object({ id: z.string(), company_id: z.string() }),
    ),
  ]);

  return {
    rows: submissionRows.map((row) => ({
      submissionId: row.id,
      companyId: row.company_id,
      status: row.status,
      submittedAt: row.submitted_at,
      highRisk: row.high_risk,
      fourEyeRequired: row.four_eye_required,
      createdAt: row.created_at,
      documentCount: documentRows.filter((document) => document.submission_id === row.id).length,
      ownerCount: uboRows.filter((ubo) => ubo.submission_id === row.id).length,
      // `0051` keys a screening by company and subject, not by submission, so the count is per company.
      screenedCount: screeningRows.filter((screening) => screening.company_id === row.company_id).length,
    })),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The detail: one submission with everything the reviewer works on, audited as an office read.
 * ---------------------------------------------------------------------------------------------- */

/** Read one submission by id; null when there is no live row with that id. */
async function readSubmissionById(
  submissionId: string,
  rest: RestClient,
): Promise<z.infer<typeof submissionFullRowSchema> | null> {
  const rows = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,company_id,verification_method,status,submitted_at,submitted_by,first_reviewer_id,decided_at,decision_reason,provider_reference,high_risk,four_eye_required,version,created_at&id=eq.${encodeURIComponent(submissionId)}&deleted_at=is.null&limit=1`,
    submissionFullRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * The full review detail of one submission: the office sees the method, the provider reference,
 * the storage keys and the screening results, because this is the desk that decides. The read is
 * audited as an office read of the merchant.
 */
export async function readKycReviewDetail(
  input: { readonly actor: RequestActor; readonly submissionId: unknown },
  dependencies: KycReviewDependencies,
): Promise<KycReviewDetail> {
  requireOfficeActor(input.actor);

  const submissionId = requireUuid(input.submissionId, "submission_id");
  const rest = dependencies.rest;
  const submission = await readSubmissionById(submissionId, rest);

  if (submission === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const companyId = submission.company_id;
  const scoped = `company_id=eq.${encodeURIComponent(companyId)}`;

  const [documentRows, uboRows, screeningRows, profileRows] = await Promise.all([
    rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id,company_id,submission_id,document_type,storage_key,content_sha256,content_type,byte_size,issued_at,expires_at,status,rejection_reason,reviewed_at,reviewed_by,version,created_at&${scoped}&submission_id=eq.${encodeURIComponent(submissionId)}&deleted_at=is.null&order=created_at.asc&limit=500`,
      documentFullRowSchema,
    ),
    rest.select(
      UBO_RECORDS_TABLE,
      `select=id,full_name,date_of_birth,country,ownership_bps,is_significant,is_pep,screened_at,created_at&${scoped}&submission_id=eq.${encodeURIComponent(submissionId)}&deleted_at=is.null&order=created_at.asc&limit=500`,
      uboFullRowSchema,
    ),
    rest.select(
      SANCTIONS_SCREENINGS_TABLE,
      `select=id,company_id,subject_kind,subject_id,ofac_checked,un_checked,eu_checked,us_checked,result,provider,screened_at,note,sar_case,created_at&${scoped}&deleted_at=is.null&order=created_at.asc&limit=500`,
      screeningFullRowSchema,
    ),
    rest.select(
      BUSINESS_PROFILE_TABLE,
      `select=legal_name,trading_name,country_code&${scoped}&deleted_at=is.null&limit=1`,
      profileNameRowSchema,
    ),
  ]);

  const detail: KycReviewDetail = {
    submissionId: submission.id,
    companyId,
    status: submission.status,
    method: submission.verification_method,
    providerReference: submission.provider_reference,
    submittedAt: submission.submitted_at,
    submittedBy: submission.submitted_by,
    firstReviewerId: submission.first_reviewer_id,
    decidedAt: submission.decided_at,
    decisionReason: submission.decision_reason,
    highRisk: submission.high_risk,
    fourEyeRequired: submission.four_eye_required,
    legalName: profileRows[0]?.legal_name ?? null,
    tradingName: profileRows[0]?.trading_name ?? null,
    countryCode: profileRows[0]?.country_code ?? null,
    documents: documentRows.map((row) => ({
      id: row.id,
      documentType: row.document_type as KycDocumentType,
      storageKey: row.storage_key,
      contentSha256: row.content_sha256,
      contentType: row.content_type,
      byteSize: row.byte_size,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      status: row.status,
      rejectionReason: row.rejection_reason,
      reviewedAt: row.reviewed_at,
      version: row.version,
      createdAt: row.created_at,
    })),
    ubos: uboRows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      dateOfBirth: row.date_of_birth,
      country: row.country,
      ownershipBps: row.ownership_bps,
      isSignificant: row.is_significant,
      isPep: row.is_pep,
      screenedAt: row.screened_at,
    })),
    screenings: screeningRows.map((row) => ({
      id: row.id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      result: row.result,
      provider: row.provider,
      screenedAt: row.screened_at,
      note: row.note,
      sarCase: row.sar_case,
      listsCovered: [
        row.ofac_checked ? "ofac" : null,
        row.un_checked ? "un" : null,
        row.eu_checked ? "eu" : null,
        row.us_checked ? "us" : null,
      ].filter((list): list is string => list !== null),
    })),
  };

  try {
    await dependencies.audit.append({
      action: KYC_REVIEW_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_REVIEW_ENTITY,
      entityId: submission.id,
      companyId,
      sessionId: input.actor.sessionId,
      payload: { submission_id: submission.id, status: submission.status, documents: detail.documents.length },
    });
  } catch {
    // An audit sink that is down never fails a read.
  }

  return detail;
}

/* -------------------------------------------------------------------------------------------------
 * The two writes: open the submission for review, decide one document.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Open a `submitted` submission for review: status to `in_review` with the first reviewer named,
 * one conditional update with the version bumped, audited. Opening one's own in-review submission
 * again is the same answer, not an error; any other state is a conflict.
 */
export async function openKycReview(
  input: { readonly actor: RequestActor; readonly submissionId: unknown },
  dependencies: KycReviewDependencies,
): Promise<KycReviewDetail> {
  requireOfficeActor(input.actor);

  const submissionId = requireUuid(input.submissionId, "submission_id");
  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  const submission = await readSubmissionById(submissionId, rest);

  if (submission === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (submission.status === "in_review" && submission.first_reviewer_id === input.actor.userId) {
    return readKycReviewDetail({ actor: input.actor, submissionId }, dependencies);
  }

  if (submission.status !== "submitted") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "not_submitted" }] });
  }

  await rest.update(
    KYC_SUBMISSIONS_TABLE,
    `id=eq.${encodeURIComponent(submission.id)}&company_id=eq.${encodeURIComponent(submission.company_id)}&status=eq.submitted&deleted_at=is.null`,
    {
      status: "in_review",
      first_reviewer_id: input.actor.userId,
      updated_at: isoOf(now),
      version: submission.version + 1,
    },
  );

  const after = await readSubmissionById(submissionId, rest);

  if (after === null || after.status !== "in_review") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: KYC_REVIEW_OPEN_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_REVIEW_ENTITY,
      entityId: submission.id,
      companyId: submission.company_id,
      sessionId: input.actor.sessionId,
      payload: { submission_id: submission.id, status: "in_review", first_reviewer_id: input.actor.userId },
    });
  } catch {
    // The audit sink failing must not fail the open; the save services hold the same rule.
  }

  return readKycReviewDetail({ actor: input.actor, submissionId }, dependencies);
}

const decisionSchema = z.enum(["accept", "reject"]);

const documentInputSchema = z.object({
  document_id: z.string().uuid(),
  decision: decisionSchema,
  reason: z.string().trim().min(1).max(280).nullish(),
});

export type KycDocumentDecision = z.infer<typeof decisionSchema>;

/**
 * Accept or reject one uploaded document: status, reviewer and instant `0049` ties to the decision,
 * and the rejection reason the row's own check demands on a rejection. One conditional update, one
 * audit entry, the updated document as the answer.
 */
export async function reviewKycDocument(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: KycReviewDependencies,
): Promise<KycReviewDocument> {
  requireOfficeActor(input.actor);

  const parsed = documentInputSchema.safeParse(input.body);

  if (!parsed.success) {
    const details: ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const { document_id: documentId, decision, reason } = parsed.data;

  if (decision === "reject" && (reason === undefined || reason === null)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "reason", rule: "required" }] });
  }

  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  const companyScoped = `id=eq.${encodeURIComponent(documentId)}&deleted_at=is.null`;

  const rows = await rest.select(
    KYC_DOCUMENTS_TABLE,
    `select=id,company_id,submission_id,document_type,storage_key,content_sha256,content_type,byte_size,issued_at,expires_at,status,rejection_reason,reviewed_at,reviewed_by,version,created_at&${companyScoped}&limit=1`,
    documentFullRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (row.status !== "uploaded") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_reviewed" }] });
  }

  const nextStatus = decision === "accept" ? "accepted" : "rejected";

  await rest.update(
    KYC_DOCUMENTS_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&company_id=eq.${encodeURIComponent(row.company_id)}&status=eq.uploaded&deleted_at=is.null`,
    {
      status: nextStatus,
      reviewed_at: isoOf(now),
      reviewed_by: input.actor.userId,
      rejection_reason: decision === "reject" ? (reason ?? null) : null,
      updated_at: isoOf(now),
      version: row.version + 1,
    },
  );

  const after = await rest.select(
    KYC_DOCUMENTS_TABLE,
    `select=id,company_id,submission_id,document_type,storage_key,content_sha256,content_type,byte_size,issued_at,expires_at,status,rejection_reason,reviewed_at,reviewed_by,version,created_at&id=eq.${encodeURIComponent(row.id)}&deleted_at=is.null&limit=1`,
    documentFullRowSchema,
  );
  const updated = after[0];

  if (updated === undefined || updated.status !== nextStatus) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: KYC_DOCUMENT_REVIEW_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_DOCUMENT_REVIEW_ENTITY,
      entityId: row.id,
      companyId: row.company_id,
      sessionId: input.actor.sessionId,
      payload: { document_id: row.id, submission_id: row.submission_id, decision: nextStatus },
    });
  } catch {
    // Same rule as the other writes.
  }

  return {
    id: updated.id,
    documentType: updated.document_type as KycDocumentType,
    storageKey: updated.storage_key,
    contentSha256: updated.content_sha256,
    contentType: updated.content_type,
    byteSize: updated.byte_size,
    issuedAt: updated.issued_at,
    expiresAt: updated.expires_at,
    status: updated.status,
    rejectionReason: updated.rejection_reason,
    reviewedAt: updated.reviewed_at,
    version: updated.version,
    createdAt: updated.created_at,
  };
}

/* -------------------------------------------------------------------------------------------------
 * STEP 089: the four-eye flow. The compliance team marks a merchant high risk - or large - and
 * 0048 then requires a decided row to name a second reviewer who is not the first.
 * ---------------------------------------------------------------------------------------------- */

/** The statuses a submission can be risk-marked in: never a decided one, which 0048 locks. */
const MARKABLE_STATUSES = ["draft", "submitted", "in_review"] as const;

const riskMarkSchema = z.object({
  high_risk: z.boolean(),
  four_eye_required: z.boolean().optional(),
});

/**
 * The four-eye guard STEP 093's decision flow calls before it writes `approved` or `rejected`:
 * when the submission requires four eyes, the decision must name a second reviewer, and
 * `0048`'s `kyc_submissions_two_people_check` refuses the same person twice, so the guard refuses
 * the first reviewer as the second here, before any write.
 */
export function fourEyeProblems(
  submission: { readonly fourEyeRequired: boolean; readonly firstReviewerId: string | null },
  secondReviewerId: string | null,
): readonly ErrorDetail[] {
  if (!submission.fourEyeRequired) {
    return [];
  }

  if (secondReviewerId === null) {
    return [{ field: "second_reviewer_id", rule: "required" }];
  }

  if (secondReviewerId === submission.firstReviewerId) {
    return [{ field: "second_reviewer_id", rule: "same_reviewer" }];
  }

  return [];
}

/**
 * Mark one submission high risk and/or four-eye required. Section 5: large or high-risk merchants
 * need two reviewers. Until a volume-based "large" signal exists, the team sets the flags
 * directly; `high_risk` always forces `four_eye_required`, because a high-risk merchant is never
 * one-eyed. A decided submission is locked by `0048`'s guard, so marking it conflicts instead of
 * writing. One conditional update, one audit entry, the full detail as the answer.
 */
export async function markKycSubmissionRisk(
  input: { readonly actor: RequestActor; readonly submissionId: unknown; readonly body: unknown },
  dependencies: KycReviewDependencies,
): Promise<KycReviewDetail> {
  requireOfficeActor(input.actor);

  const submissionId = requireUuid(input.submissionId, "submission_id");
  const parsed = riskMarkSchema.safeParse(input.body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), rule: "invalid_format" })),
    });
  }

  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  const submission = await readSubmissionById(submissionId, rest);

  if (submission === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (!MARKABLE_STATUSES.includes(submission.status as (typeof MARKABLE_STATUSES)[number])) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_decided" }] });
  }

  // A high-risk merchant always needs four eyes, whatever the request says.
  const fourEyeRequired = parsed.data.high_risk || (parsed.data.four_eye_required ?? false);

  await rest.update(
    KYC_SUBMISSIONS_TABLE,
    `id=eq.${encodeURIComponent(submission.id)}&company_id=eq.${encodeURIComponent(submission.company_id)}&status=eq.${encodeURIComponent(submission.status)}&deleted_at=is.null`,
    {
      high_risk: parsed.data.high_risk,
      four_eye_required: fourEyeRequired,
      updated_at: isoOf(now),
      version: submission.version + 1,
    },
  );

  const after = await readSubmissionById(submissionId, rest);

  if (after === null || after.version !== submission.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: KYC_RISK_MARK_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_REVIEW_ENTITY,
      entityId: submission.id,
      companyId: submission.company_id,
      sessionId: input.actor.sessionId,
      payload: {
        submission_id: submission.id,
        high_risk: parsed.data.high_risk,
        four_eye_required: fourEyeRequired,
      },
    });
  } catch {
    // Same rule as the other writes.
  }

  return readKycReviewDetail({ actor: input.actor, submissionId }, dependencies);
}

/* -------------------------------------------------------------------------------------------------
 * STEP 093: the decision flow. Approve or reject the whole submission, with the reason a rejection
 * carries because the merchant reads it (0048's reason check), audited on every decision (section 5:
 * every KYC decision is audit logged).
 * ---------------------------------------------------------------------------------------------- */

/** The audit action of a final decision on a submission. */
export const KYC_DECISION_AUDIT_ACTION = "kyc_review.decided";

/**
 * The roles that may give the final approval: ceo and super_admin. Section 2 gives the ceo "KYC
 * final approval" and section 5 says final approval by CEO or super_admin is what triggers
 * sub-merchant provisioning; compliance_kyc does the review and may reject, support has no KYC
 * approval at all.
 */
export const KYC_FINAL_APPROVAL_ROLES: readonly PlatformRole[] = Object.freeze([
  "ceo",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The body of a submission decision: which submission, approve or reject, and the reason. */
export const decideKycSubmissionBodySchema = z.object({
  submission_id: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(280).nullish(),
});

/**
 * Approve or reject one in-review submission - the decision flow of section 5.
 *
 * Approval is the final approval of ceo and super_admin (`KYC_FINAL_APPROVAL_ROLES`); rejection is
 * the review work of the office roles, so compliance_kyc may reject but not approve. A rejection
 * must carry the trimmed 1..280 reason `0048` demands on a rejected row, because the merchant reads
 * it on their status screen; an approval may carry one as a note.
 *
 * The submission must be `in_review` - opened first, so `first_reviewer_id` is set, which `0048`'s
 * reviewer check requires of a decided row - and a decided row conflicts with `already_decided`,
 * because `0048`'s guard locks it as history. When the submission is four-eye, the decider is the
 * second reviewer: the guard `fourEyeProblems` refuses the first reviewer deciding alone, and
 * `0048`'s two-people check refuses the same person twice at the database.
 *
 * The write is one conditional update (id + company + `status=eq.in_review` + current version, over
 * live rows) with the status, the reason, both instants, the second reviewer and the bumped version,
 * then a re-read race check (`stale`), one `kyc_review.decided` audit entry, and the full detail as
 * the answer.
 */
export async function decideKycSubmission(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: KycReviewDependencies,
): Promise<KycReviewDetail> {
  const parsed = decideKycSubmissionBodySchema.safeParse(input.body);

  if (!parsed.success) {
    const details: ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const { submission_id: submissionId, decision, reason } = parsed.data;

  if (decision === "reject" && (reason === undefined || reason === null)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "reason", rule: "required" }] });
  }

  // Approval is the ceo's and super_admin's final approval; rejection is review work.
  if (decision === "approve") {
    requireAnyRole(input.actor, KYC_FINAL_APPROVAL_ROLES);
  } else {
    requireOfficeActor(input.actor);
  }

  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  const submission = await readSubmissionById(submissionId, rest);

  if (submission === null) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (submission.status === "approved" || submission.status === "rejected") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_decided" }] });
  }

  if (submission.status !== "in_review") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "not_in_review" }] });
  }

  // Four eyes: the decider is the second reviewer, and never the first.
  const secondReviewerId = submission.four_eye_required ? input.actor.userId : null;
  const problems = fourEyeProblems(
    { fourEyeRequired: submission.four_eye_required, firstReviewerId: submission.first_reviewer_id },
    secondReviewerId,
  );

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: [...problems] });
  }

  const nextStatus = decision === "approve" ? "approved" : "rejected";

  await rest.update(
    KYC_SUBMISSIONS_TABLE,
    `id=eq.${encodeURIComponent(submission.id)}&company_id=eq.${encodeURIComponent(submission.company_id)}&status=eq.in_review&version=eq.${submission.version}&deleted_at=is.null`,
    {
      status: nextStatus,
      decision_reason: reason ?? null,
      reviewed_at: isoOf(now),
      decided_at: isoOf(now),
      second_reviewer_id: secondReviewerId,
      updated_at: isoOf(now),
      version: submission.version + 1,
    },
  );

  const after = await readSubmissionById(submissionId, rest);

  if (after === null || after.version !== submission.version + 1 || after.status !== nextStatus) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: KYC_DECISION_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_REVIEW_ENTITY,
      entityId: submission.id,
      companyId: submission.company_id,
      sessionId: input.actor.sessionId,
      payload: {
        submission_id: submission.id,
        decision: nextStatus,
        reason: reason ?? null,
        first_reviewer_id: submission.first_reviewer_id,
        second_reviewer_id: secondReviewerId,
        four_eye_required: submission.four_eye_required,
      },
    });
  } catch {
    // Same rule as the other writes.
  }

  return readKycReviewDetail({ actor: input.actor, submissionId }, dependencies);
}
