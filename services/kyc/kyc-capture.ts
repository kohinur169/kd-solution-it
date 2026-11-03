// path: services/kyc/kyc-capture.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { requireValidUpload, sha256Hex, UPLOAD_DATABASE_MAXIMUM_BYTES, UPLOAD_FIELD, UPLOAD_RULE } from "../../lib/security/upload.ts";
import { sanitizeSingleLineText } from "../../lib/security/text.ts";
import { BUSINESS_PROFILE_TABLE } from "./business-profile.ts";
import { COUNTRIES_TABLE } from "./business-address.ts";
import {
  BANK_STATEMENT_DEFAULT_PERIOD_MONTHS,
  BANK_STATEMENT_MAX_AGE_MONTHS,
  dateStringMinusMonths,
  KYC_DOCUMENT_TYPES,
  monthsBetweenDates,
  UTILITY_BILL_MAX_AGE_MONTHS,
  utilityBillIssueWindow,
  type KycDocumentType,
} from "./kyc-document-types.ts";
import {
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  nextOnboardingStep,
  type OnboardingStep,
} from "./onboarding-steps.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import { PROVIDER_KEYS } from "../../lib/gateways/registry.ts";
import { enqueueJob, type JobRegistry } from "../../lib/jobs/registry.ts";
import type { JobQueue } from "../../lib/jobs/queue.ts";
import type { EnqueueResult, JobDefinition } from "../../lib/jobs/types.ts";

/**
 * The documents step of section 5: what a merchant uploads, who owns the business, and the
 * screening that runs over both.
 *
 * ## What this module owns
 *
 * The tables were built by STEP 028: `kyc_submissions` (0048, one KYC cycle), `kyc_documents`
 * (0049, one uploaded evidence row - a storage key and a hash, never the bytes), `ubo_records`
 * (0050, the beneficial owners with their share in basis points) and `sanctions_screenings`
 * (0051, one screening of one subject against the four lists). This file is the merchant-facing
 * write and read over them: it finds or creates the company's draft submission, records an upload
 * after the bytes proved themselves, captures an owner of 25 percent or more, runs the screening
 * in manual mode and records its result.
 *
 * ## Why the record is a key and a hash, and the bytes are another STEP's
 *
 * `0049` says a document is "kept as a key and a hash rather than as a file", and `0057`'s `files`
 * row - which carries the AES-256-GCM ciphertext - belongs to the storage adapter layer of
 * STEPs 100-105 (`lib/storage/`), which does not exist yet. So this service validates the bytes
 * with `lib/security/upload.ts` (magic bytes must agree with the declared type; a mismatch is
 * refused, because a quarantined row belongs to `files`, which only the storage STEP can write),
 * hashes them, and records the key under the company's own tenant path
 * (`<company_id>/kyc/<uuid>`), which the storage adapter will use when it lands. The hash is what
 * binds the record to the bytes later: the office can re-hash the stored object and compare.
 *
 * ## Why the merchant never sees a screening result
 *
 * Section 5: "The merchant only sees verification status." `0051` keeps screening rows hidden
 * from the merchant by policy, and this service honours that in its own answer too: the pack it
 * returns carries only *how many* subjects were screened, never a row, a result or a note. The
 * results are written for the office; a possible match goes to compliance, and a SAR flag is
 * raised by the office later, never by this service.
 *
 * ## The screening this build can actually execute
 *
 * With no KYC provider connected (section 5's manual mode), the execution is the platform's own:
 * each subject - the merchant company and every captured UBO - is checked against the sanction
 * flags of the `0076` country list, which is the one list this build holds locally. A subject
 * whose country of record is sanctioned is recorded as `possible_match` with the reason in the
 * note; everything else is `clear`. All four list booleans are set, because the row records that
 * the screening covered OFAC, UN, EU and US - in manual mode that coverage is the office's manual
 * review, and `provider` says `manual` so the row never pretends an adapter ran. When a provider
 * STEP (170-175) connects, it writes its own rows with its own provider name.
 */

/** The table of `0048`: one KYC cycle of one merchant. */
export const KYC_SUBMISSIONS_TABLE = "kyc_submissions";

/** The table of `0049`: the uploaded evidence of one submission. */
export const KYC_DOCUMENTS_TABLE = "kyc_documents";

/** The table of `0050`: the beneficial owners of one submission. */
export const UBO_RECORDS_TABLE = "ubo_records";

/** The table of `0051`: one screening of one subject. */
export const SANCTIONS_SCREENINGS_TABLE = "sanctions_screenings";

// The document types live in their own module so client components can import the list without
// this file's server-only imports; they are re-exported here so server code has one import path.
export {
  BANK_STATEMENT_DEFAULT_PERIOD_MONTHS,
  BANK_STATEMENT_MAX_AGE_MONTHS,
  dateStringMinusMonths,
  KYC_DOCUMENT_TYPES,
  monthsBetweenDates,
  UTILITY_BILL_MAX_AGE_MONTHS,
  utilityBillIssueWindow,
};
export type { KycDocumentType };

/** The onboarding step this module completes when at least one document is recorded. */
export const KYC_DOCUMENTS_ONBOARDING_STEP: OnboardingStep = "documents";

/** The audit actions of the three writes. */
export const KYC_DOCUMENT_AUDIT_ACTION = "kyc_document.uploaded";
export const UBO_AUDIT_ACTION = "ubo.captured";
export const KYC_SCREENING_AUDIT_ACTION = "kyc_screening.ran";
export const KYC_SUBMIT_AUDIT_ACTION = "kyc_submission.submitted";

/** The audit entity all three are recorded against: the submission. */
export const KYC_AUDIT_ENTITY = "kyc_submission";

/** The upload purpose of `0057`/`0058` the KYC files carry. */
export const KYC_UPLOAD_PURPOSE = "kyc_document" as const;

/** The largest KYC document, which is the row ceiling of `0057`. */
export const KYC_DOCUMENT_MAXIMUM_BYTES = UPLOAD_DATABASE_MAXIMUM_BYTES;

/** An owner of 25 percent or more is significant: 2500 basis points, as `0050`'s check ties it. */
export const SIGNIFICANT_OWNER_BPS = 2_500;

/** The table of `0001`: the tenant root, read to prove a request names a real merchant. */
export const COMPANIES_TABLE = "companies";

/** The table of `0109`: one extra document a processor asked the merchant for. */
export const KYC_DOCUMENT_REQUESTS_TABLE = "kyc_document_requests";

/** The audit entity of a document request row. */
export const KYC_DOCUMENT_REQUEST_ENTITY = "kyc_document_request";

/** The audit action of a provider's extra-document request being recorded. */
export const KYC_DOCUMENT_REQUEST_CREATED_AUDIT_ACTION = "kyc_document_request.created";

/** The audit action of a merchant's upload answering that request. */
export const KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION = "kyc_document_request.fulfilled";

/** The background job that records a provider's request for an extra document. */
export const KYC_DOCUMENT_REQUEST_JOB = "kyc.document_request";

const submissionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  verification_method: z.string(),
});

/**
 * The submission as the merchant's summary reads it. The method and the provider's reference
 * columns are deliberately not selected: `0048`'s own comment says the merchant only ever reads
 * `status`, so the read does not even fetch the method.
 */
const submissionDetailRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  submitted_at: z.string().nullable(),
  submitted_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  version: z.coerce.number(),
  created_at: z.string(),
});

const documentRowSchema = z.object({
  id: z.string(),
  document_type: z.string(),
  storage_key: z.string(),
  content_sha256: z.string(),
  content_type: z.string(),
  byte_size: z.coerce.number(),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  status: z.string(),
  rejection_reason: z.string().nullable(),
  created_at: z.string(),
});

/** The document fields the merchant's summary shows: never the storage key, never the hash. */
const documentSummaryRowSchema = z.object({
  id: z.string(),
  document_type: z.string(),
  status: z.string(),
  rejection_reason: z.string().nullable(),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  byte_size: z.coerce.number(),
});

const uboRowSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  date_of_birth: z.string(),
  country: z.string(),
  ownership_bps: z.coerce.number(),
  is_significant: z.boolean(),
  id_document_sha256: z.string(),
  is_pep: z.boolean(),
  screened_at: z.string().nullable(),
});

const screeningRowSchema = z.object({
  id: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
});

const countrySanctionSchema = z.object({ code: z.string(), is_sanctioned: z.boolean() });

const onboardingRowSchema = z.object({
  current_step: z.string(),
  completed_steps: z.array(z.string()),
});

/** One row of `0109`, as the request service reads it. */
const documentRequestRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  submission_id: z.string(),
  provider_id: z.string(),
  document_label: z.string(),
  note: z.string().nullable(),
  status: z.string(),
  fulfilled_by: z.string().nullable(),
  fulfilled_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  version: z.coerce.number(),
  created_at: z.string(),
});

/** The columns of one open request the pack lists. */
const openDocumentRequestRowSchema = z.object({
  id: z.string(),
  submission_id: z.string(),
  provider_id: z.string(),
  document_label: z.string(),
  note: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
});

/** One uploaded document, as the pack lists it. */
export interface KycDocumentRecord {
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
  readonly createdAt: string;
}

/** One open extra-document request of `0109`, as the pack lists it. */
export interface KycDocumentRequestView {
  readonly id: string;
  readonly submissionId: string;
  readonly providerId: string;
  readonly documentLabel: string;
  readonly note: string | null;
  readonly status: string;
  readonly createdAt: string;
}

/** One captured beneficial owner, as the pack lists it. */
export interface UboRecordView {
  readonly id: string;
  readonly fullName: string;
  readonly dateOfBirth: string;
  readonly country: string;
  readonly ownershipBps: number;
  readonly isSignificant: boolean;
  readonly screenedAt: string | null;
}

/** The documents step as a screen sees it. Screening results are deliberately absent. */
export interface KycPackSnapshot {
  readonly companyId: string;
  readonly submissionId: string | null;
  readonly status: string | null;
  readonly documents: readonly KycDocumentRecord[];
  readonly ubos: readonly UboRecordView[];
  readonly countries: readonly { readonly code: string; readonly name: string }[];
  readonly screenedCount: number;
  readonly documentsComplete: boolean;
  /** The open asks of `0109`: what a processor asked for and is still waiting for. */
  readonly openRequests: readonly KycDocumentRequestView[];
}

export interface KycCaptureDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
  /**
   * The required bank statement period in months - section 5 gives this criterion to the
   * compliance team. Until the office settings STEP stores it, the platform default of
   * `BANK_STATEMENT_DEFAULT_PERIOD_MONTHS` applies.
   */
  readonly bankStatementPeriodMonths?: number | undefined;
}

function nowOf(dependencies: KycCaptureDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

function isoOf(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function requireOwnerCompany(actor: RequestActor): string {
  requireAnyRole(actor, ONBOARDING_OWNER_ROLES);

  return requireCompanyId(actor);
}

/** Find the company's draft submission, or create it (with the lost-race fallback to re-read). */
async function ensureDraftSubmission(
  companyId: string,
  actorUserId: string,
  rest: RestClient,
): Promise<{ id: string; status: string; verification_method: string }> {
  const existing = await readDraftSubmission(companyId, rest);

  if (existing !== null) {
    return existing;
  }

  try {
    await rest.insert(KYC_SUBMISSIONS_TABLE, [
      { company_id: companyId, verification_method: "manual", status: "draft", submitted_by: actorUserId },
    ]);
  } catch (error) {
    if (!isConflictError(error)) {
      throw error;
    }
  }

  const after = await readDraftSubmission(companyId, rest);

  if (after === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  return after;
}

async function readDraftSubmission(
  companyId: string,
  rest: RestClient,
): Promise<{ id: string; status: string; verification_method: string } | null> {
  const rows = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,company_id,status,verification_method&company_id=eq.${encodeURIComponent(companyId)}&status=eq.draft&deleted_at=is.null&order=created_at.desc&limit=1`,
    submissionRowSchema,
  );

  return rows[0] ?? null;
}

/** The onboarding row of one company, or null when the wizard has never been opened. */
async function readOnboardingRow(
  companyId: string,
  rest: RestClient,
): Promise<{ currentStep: string; completedSteps: readonly string[] } | null> {
  const rows = await rest.select(
    ONBOARDING_PROGRESS_TABLE,
    `select=current_step,completed_steps&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    onboardingRowSchema,
  );
  const row = rows[0];

  return row === undefined
    ? null
    : { currentStep: row.current_step, completedSteps: row.completed_steps };
}

/** Mirror the `documents` step into STEP 079's position row, the way 080-082 mirror theirs. */
async function syncDocumentsStep(
  companyId: string,
  actorUserId: string,
  complete: boolean,
  rest: RestClient,
): Promise<void> {
  const existing = await readOnboardingRow(companyId, rest);
  const step = KYC_DOCUMENTS_ONBOARDING_STEP;

  if (existing === null) {
    if (!complete) {
      return;
    }

    await rest.insert(ONBOARDING_PROGRESS_TABLE, [
      {
        company_id: companyId,
        updated_by: actorUserId,
        current_step: nextOnboardingStep(step) ?? step,
        completed_steps: [step],
      },
    ]);

    return;
  }

  const has = existing.completedSteps.includes(step);

  if (has === complete) {
    return;
  }

  const completedSteps = complete
    ? [...existing.completedSteps, step]
    : existing.completedSteps.filter((name) => name !== step);

  await rest.update(
    ONBOARDING_PROGRESS_TABLE,
    `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
    { completed_steps: completedSteps, updated_by: actorUserId },
  );
}

/* -------------------------------------------------------------------------------------------------
 * The document upload: what the route parsed out of the multipart body.
 * ---------------------------------------------------------------------------------------------- */

/** The upload input after the route read the bytes: the service validates, hashes and records. */
export interface KycDocumentInput {
  readonly document_type: unknown;
  readonly file_name: unknown;
  readonly declared_content_type: unknown;
  readonly bytes: Uint8Array;
  readonly issued_at?: unknown;
  readonly expires_at?: unknown;
  /** STEP 097: when the upload answers a processor's request, the request's id. */
  readonly request_id?: unknown;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Parse and validate one upload. A quarantined or rejected file is refused with one rule.
 * `options.now` pins "today" for the issue-date rules so the gate can test the window; the
 * routes leave it out and get `Date.now()`.
 */
export function parseKycDocumentInput(
  input: KycDocumentInput,
  options?: { readonly now?: number; readonly bankStatementPeriodMonths?: number | undefined },
): {
  readonly record: {
    readonly documentType: KycDocumentType;
    readonly fileName: string;
    readonly contentType: string;
    readonly contentSha256: string;
    readonly byteSize: number;
    readonly issuedAt: string | null;
    readonly expiresAt: string | null;
    readonly requestId: string | null;
  } | null;
  readonly problems: readonly ErrorDetail[];
} {
  const problems: ErrorDetail[] = [];

  const documentType =
    typeof input.document_type === "string" &&
    (KYC_DOCUMENT_TYPES as readonly string[]).includes(input.document_type)
      ? (input.document_type as KycDocumentType)
      : null;

  if (documentType === null) {
    problems.push({ field: "document_type", rule: "invalid_format" });
  }

  let issuedAt: string | null = null;
  let expiresAt: string | null = null;
  let issuedAtSent = false;
  let expiresAtSent = false;

  for (const [field, raw] of [
    ["issued_at", input.issued_at],
    ["expires_at", input.expires_at],
  ] as const) {
    if (raw === undefined || raw === null || raw === "") {
      continue;
    }

    if (field === "issued_at") {
      issuedAtSent = true;
    } else {
      expiresAtSent = true;
    }

    if (typeof raw !== "string" || !DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
      problems.push({ field, rule: "invalid_format" });
      continue;
    }

    if (field === "issued_at") {
      issuedAt = raw;
    } else {
      expiresAt = raw;
    }
  }

  // STEP 097: an upload can answer one open request; the id is a uuid or the field is named.
  let requestId: string | null = null;

  if (input.request_id !== undefined && input.request_id !== null && input.request_id !== "") {
    if (typeof input.request_id === "string" && z.string().uuid().safeParse(input.request_id).success) {
      requestId = input.request_id;
    } else {
      problems.push({ field: "request_id", rule: "invalid_format" });
    }
  }

  if (documentType === "utility_bill" && !issuedAtSent) {
    // `0049`'s issue check refuses the row; the service refuses it earlier, with the field named.
    // A date that was sent but did not parse is already named `invalid_format` - never both.
    problems.push({ field: "issued_at", rule: "required" });
  }

  if (documentType === "bank_statement") {
    // A bank statement is its covered period: both ends are required, as section 5's
    // "required bank statement period" implies - a statement without a period is not evidence.
    if (!issuedAtSent) {
      problems.push({ field: "issued_at", rule: "required" });
    }

    if (!expiresAtSent) {
      problems.push({ field: "expires_at", rule: "required" });
    }
  }

  const window = utilityBillIssueWindow(options?.now ?? Date.now());

  if (issuedAt !== null) {
    // `0049` refuses an issue date after the row's creation; the service refuses it earlier.
    if (issuedAt > window.latest) {
      problems.push({ field: "issued_at", rule: "invalid_date" });
    } else if (documentType === "utility_bill" && issuedAt < window.earliest) {
      // Section 5: a utility bill must be issued within the last three months.
      problems.push({ field: "issued_at", rule: "invalid_range" });
    }
  }

  if (issuedAt !== null && expiresAt !== null && expiresAt <= issuedAt) {
    // `0049`'s validity check refuses the row; the service refuses it earlier.
    problems.push({ field: "expires_at", rule: "invalid_format" });
  } else if (documentType === "bank_statement" && issuedAt !== null && expiresAt !== null) {
    // STEP 086: the period must end within the last month and cover the required period.
    const requiredMonths = options?.bankStatementPeriodMonths ?? BANK_STATEMENT_DEFAULT_PERIOD_MONTHS;
    const recencyCutoff = dateStringMinusMonths(window.latest, BANK_STATEMENT_MAX_AGE_MONTHS);

    if (expiresAt < recencyCutoff) {
      problems.push({ field: "expires_at", rule: "invalid_range" });
    } else if (monthsBetweenDates(issuedAt, expiresAt) < requiredMonths) {
      problems.push({ field: "expires_at", rule: "invalid_range" });
    }
  }

  const fileName = typeof input.file_name === "string" ? input.file_name : "";
  const declaredType = typeof input.declared_content_type === "string" ? input.declared_content_type : "";

  let verdict: { contentType: string; byteSize: number } | null = null;

  try {
    const checked = requireValidUpload(
      {
        fileName,
        declaredType,
        byteSize: input.bytes.length,
        head: input.bytes,
      },
      KYC_UPLOAD_PURPOSE,
    );

    if (checked.decision !== "verified") {
      // A quarantine belongs to `files`, which only the storage STEP (100-105) can write; until
      // then the platform refuses the file rather than record evidence it cannot keep.
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: UPLOAD_FIELD, rule: UPLOAD_RULE }],
        cause: { rule: UPLOAD_RULE, reason: checked.quarantineReason },
      });
    }

    verdict = { contentType: checked.contentType, byteSize: checked.byteSize };
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      problems.push(...(error.details ?? []));
    } else {
      throw error;
    }
  }

  if (problems.length > 0 || verdict === null || documentType === null) {
    return { record: null, problems };
  }

  return {
    record: {
      documentType,
      fileName,
      contentType: verdict.contentType,
      contentSha256: sha256Hex(input.bytes),
      byteSize: verdict.byteSize,
      issuedAt,
      expiresAt,
      requestId,
    },
    problems,
  };
}

/**
 * Record one uploaded document against the company's draft submission, audit it, and finish the
 * `documents` step of the wizard (one document is enough; the office accepts or rejects each row).
 */
export async function saveKycDocument(
  input: { readonly actor: RequestActor; readonly input: KycDocumentInput },
  dependencies: KycCaptureDependencies,
): Promise<KycPackSnapshot> {
  const companyId = requireOwnerCompany(input.actor);
  const rest = dependencies.rest;
  const parsed = parseKycDocumentInput(input.input, {
    now: nowOf(dependencies),
    bankStatementPeriodMonths: dependencies.bankStatementPeriodMonths,
  });

  if (parsed.problems.length > 0 || parsed.record === null) {
    throw new AppError("VALIDATION_FAILED", { details: parsed.problems });
  }

  const record = parsed.record;
  const submission = await ensureDraftSubmission(companyId, input.actor.userId, rest);

  // STEP 097: when the upload answers a processor's request, the request is resolved before any
  // write - open, the merchant's own, the same submission, and answered by a processor_request
  // document, which is the only type `0109` links through fulfilled_by.
  const request =
    record.requestId === null
      ? null
      : await resolveRequestForUpload(record.requestId, companyId, submission.id, record.documentType, rest);

  const storageKey = `${companyId}/kyc/${randomUUID()}`;

  await rest.insert(KYC_DOCUMENTS_TABLE, [
    {
      company_id: companyId,
      submission_id: submission.id,
      document_type: record.documentType,
      storage_key: storageKey,
      content_sha256: record.contentSha256,
      content_type: record.contentType,
      byte_size: record.byteSize,
      issued_at: record.issuedAt,
      expires_at: record.expiresAt,
    },
  ]);

  try {
    await dependencies.audit.append({
      action: KYC_DOCUMENT_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_AUDIT_ENTITY,
      entityId: submission.id,
      companyId,
      sessionId: input.actor.sessionId,
      payload: {
        document_type: record.documentType,
        byte_size: record.byteSize,
        content_sha256: record.contentSha256,
        storage_key: storageKey,
        ...(record.requestId === null ? {} : { request_id: record.requestId }),
      },
    });
  } catch {
    // The audit sink failing must not fail the record; the save services hold the same rule.
  }

  if (request !== null) {
    // The document row is found by its own storage key, unique per upload, and the request is
    // marked fulfilled against it with one conditional update on the request's current version.
    const documentRows = await rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id&company_id=eq.${encodeURIComponent(companyId)}&submission_id=eq.${encodeURIComponent(submission.id)}&storage_key=eq.${encodeURIComponent(storageKey)}&deleted_at=is.null&limit=1`,
      z.object({ id: z.string() }),
    );
    const documentId = documentRows[0]?.id;

    if (documentId === undefined) {
      throw new AppError("INTERNAL_ERROR");
    }

    await markRequestFulfilled(request, documentId, input.actor, dependencies);
  }

  await syncDocumentsStep(companyId, input.actor.userId, true, rest);

  return readKycPack({ actor: input.actor }, dependencies);
}

/* -------------------------------------------------------------------------------------------------
 * STEP 097: the extra document a processor asks for. `0109` stores the ask as a row against the
 * merchant's draft submission; the `kyc.document_request` job records it when a provider delivery
 * lands (the webhook pipeline of the payment block enqueues it, the way STEP 095's sync runs), the
 * pack lists the open asks so the merchant sees them on the documents step, and an upload that
 * carries the request's id answers it: the only document type that may fulfill a request is
 * `processor_request`, and the request row then names the document through fulfilled_by.
 * ---------------------------------------------------------------------------------------------- */

/** The input of one provider ask, as the job payload and the direct call share it. */
const documentRequestInputSchema = z.object({
  company_id: z.string().uuid(),
  provider_id: z
    .string()
    .refine((value) => (PROVIDER_KEYS as readonly string[]).includes(value), "unknown provider"),
  document_label: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => value === value.trim(), "trimmed"),
  note: z
    .string()
    .min(1)
    .max(280)
    .refine((value) => value === value.trim(), "trimmed")
    .optional(),
});

/** The payload of the `kyc.document_request` job: one provider ask for one merchant. */
export const documentRequestJobPayloadSchema = documentRequestInputSchema;

export type DocumentRequestJobPayload = z.infer<typeof documentRequestJobPayloadSchema>;

/** The idempotency key of one ask: one job per merchant, provider and label. */
export function documentRequestIdempotencyKey(
  companyId: string,
  providerId: string,
  documentLabel: string,
): string {
  return `${KYC_DOCUMENT_REQUEST_JOB}:${companyId}:${providerId}:${documentLabel}`;
}

export interface DocumentRequestDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface DocumentRequestResult {
  readonly request: KycDocumentRequestView;
  readonly created: boolean;
}

function viewOfRequest(row: {
  readonly id: string;
  readonly submission_id: string;
  readonly provider_id: string;
  readonly document_label: string;
  readonly note: string | null;
  readonly status: string;
  readonly created_at: string;
}): KycDocumentRequestView {
  return {
    id: row.id,
    submissionId: row.submission_id,
    providerId: row.provider_id,
    documentLabel: row.document_label,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
  };
}

const requestSelectColumns =
  "id,submission_id,provider_id,document_label,note,status,fulfilled_by,fulfilled_at,cancelled_at,version,created_at";

/** Find the company's draft submission, creating it as the system when none exists yet. */
async function ensureDraftSubmissionForRequest(
  companyId: string,
  rest: RestClient,
): Promise<{ id: string; status: string; verification_method: string }> {
  const existing = await readDraftSubmission(companyId, rest);

  if (existing !== null) {
    return existing;
  }

  try {
    // A draft carries no submitter yet: `0048`'s check ties submitted_by to a non-draft status.
    await rest.insert(KYC_SUBMISSIONS_TABLE, [
      { company_id: companyId, verification_method: "manual", status: "draft", submitted_by: null },
    ]);
  } catch (error) {
    if (!isConflictError(error)) {
      throw error;
    }
  }

  const after = await readDraftSubmission(companyId, rest);

  if (after === null) {
    throw new AppError("INTERNAL_ERROR");
  }

  return after;
}

/**
 * Record one provider ask for one extra document. The merchant must exist (404 otherwise) and the
 * ask hangs off the company's draft submission. One open ask per submission, provider and label:
 * a repeated delivery answers with the existing row instead of inserting a second one, and a lost
 * insert race converges on the winner's row the same way.
 */
export async function createDocumentRequest(
  input: {
    readonly company_id: unknown;
    readonly provider_id: unknown;
    readonly document_label: unknown;
    readonly note?: unknown;
  },
  dependencies: DocumentRequestDependencies,
): Promise<DocumentRequestResult> {
  const parsed = documentRequestInputSchema.safeParse(input);

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const companyId = parsed.data.company_id;
  const providerId = parsed.data.provider_id;
  const documentLabel = parsed.data.document_label;
  const note = parsed.data.note ?? null;
  const rest = dependencies.rest;

  const companies = await rest.select(
    COMPANIES_TABLE,
    `select=id&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    z.object({ id: z.string() }),
  );

  if (companies.length === 0) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const submission = await ensureDraftSubmissionForRequest(companyId, rest);
  const findQuery = `select=${requestSelectColumns}&company_id=eq.${encodeURIComponent(companyId)}&submission_id=eq.${encodeURIComponent(submission.id)}&provider_id=eq.${encodeURIComponent(providerId)}&document_label=eq.${encodeURIComponent(documentLabel)}&status=eq.open&deleted_at=is.null&limit=1`;

  const existing = await rest.select(KYC_DOCUMENT_REQUESTS_TABLE, findQuery, documentRequestRowSchema);
  const existingRow = existing[0];

  if (existingRow !== undefined) {
    return { request: viewOfRequest(existingRow), created: false };
  }

  let created = true;

  try {
    await rest.insert(KYC_DOCUMENT_REQUESTS_TABLE, [
      {
        company_id: companyId,
        submission_id: submission.id,
        provider_id: providerId,
        document_label: documentLabel,
        note,
        status: "open",
      },
    ]);
  } catch (error) {
    if (!isConflictError(error)) {
      throw error;
    }

    // `0109`'s open unique index converged a lost insert race on the winner's row.
    created = false;
  }

  const after = await rest.select(KYC_DOCUMENT_REQUESTS_TABLE, findQuery, documentRequestRowSchema);
  const row = after[0];

  if (row === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  if (created) {
    try {
      await dependencies.audit.append({
        action: KYC_DOCUMENT_REQUEST_CREATED_AUDIT_ACTION,
        actorUserId: null,
        entityType: KYC_DOCUMENT_REQUEST_ENTITY,
        entityId: row.id,
        companyId,
        sessionId: null,
        payload: {
          submission_id: submission.id,
          provider_id: providerId,
          document_label: documentLabel,
        },
      });
    } catch {
      // An audit sink that is down never fails the write it records.
    }
  }

  return { request: viewOfRequest(row), created };
}

/**
 * Resolve the request an upload answers, before anything is written. The request must exist for
 * this merchant (404), still be open (CONFLICT `not_open`), belong to the same submission
 * (CONFLICT `submission_mismatch`), and be answered by a `processor_request` document, the only
 * type `0109` links through fulfilled_by (VALIDATION_FAILED on the type).
 */
async function resolveRequestForUpload(
  requestId: string,
  companyId: string,
  submissionId: string,
  documentType: KycDocumentType,
  rest: RestClient,
): Promise<z.infer<typeof documentRequestRowSchema>> {
  if (documentType !== "processor_request") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "document_type", rule: "request_document_type" }],
    });
  }

  const rows = await rest.select(
    KYC_DOCUMENT_REQUESTS_TABLE,
    `select=${requestSelectColumns}&id=eq.${encodeURIComponent(requestId)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    documentRequestRowSchema,
  );
  const request = rows[0];

  if (request === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (request.status !== "open") {
    throw new AppError("CONFLICT", { details: [{ field: "request_id", rule: "not_open" }] });
  }

  if (request.submission_id !== submissionId) {
    throw new AppError("CONFLICT", { details: [{ field: "request_id", rule: "submission_mismatch" }] });
  }

  return request;
}

/** Mark one request fulfilled by the uploaded document: one conditional update, re-read, audit. */
async function markRequestFulfilled(
  request: z.infer<typeof documentRequestRowSchema>,
  documentId: string,
  actor: RequestActor,
  dependencies: KycCaptureDependencies,
): Promise<void> {
  const rest = dependencies.rest;
  const companyId = request.company_id;
  const now = nowOf(dependencies);

  await rest.update(
    KYC_DOCUMENT_REQUESTS_TABLE,
    `id=eq.${encodeURIComponent(request.id)}&company_id=eq.${encodeURIComponent(companyId)}&status=eq.open&version=eq.${request.version}&deleted_at=is.null`,
    {
      status: "fulfilled",
      fulfilled_by: documentId,
      fulfilled_at: isoOf(now),
      updated_at: isoOf(now),
      version: request.version + 1,
    },
  );

  const afterRows = await rest.select(
    KYC_DOCUMENT_REQUESTS_TABLE,
    `select=id,status,fulfilled_by,version&id=eq.${encodeURIComponent(request.id)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    z.object({
      id: z.string(),
      status: z.string(),
      fulfilled_by: z.string().nullable(),
      version: z.coerce.number(),
    }),
  );
  const after = afterRows[0];

  if (after === undefined || after.version !== request.version + 1) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION,
      actorUserId: actor.userId,
      entityType: KYC_DOCUMENT_REQUEST_ENTITY,
      entityId: request.id,
      companyId,
      sessionId: actor.sessionId,
      payload: {
        document_id: documentId,
        provider_id: request.provider_id,
        document_label: request.document_label,
      },
    });
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/**
 * The request job definition with injectable dependencies, so the gate can drive the handler
 * against its fake store. The default wiring closes over the auth runtime, like a route does.
 */
export function createDocumentRequestJobHandler(
  dependenciesOf: () => DocumentRequestDependencies,
): JobDefinition<DocumentRequestJobPayload> {
  return {
    name: KYC_DOCUMENT_REQUEST_JOB,
    payloadSchema: documentRequestJobPayloadSchema,
    handler: async (context) => {
      await createDocumentRequest(context.payload, dependenciesOf());
    },
  };
}

const defaultDocumentRequestJob = createDocumentRequestJobHandler(() => {
  const runtime = getAuthRuntime();

  return { rest: runtime.rest, audit: runtime.audit };
});

/** Register the request job once; a second call is a no-op. */
export function registerKycDocumentRequestJob(registry: JobRegistry): void {
  if (!registry.has(KYC_DOCUMENT_REQUEST_JOB)) {
    registry.register(defaultDocumentRequestJob);
  }
}

/**
 * Enqueue the recording of one provider ask. The webhook pipeline calls this when a delivery asks
 * for an extra document; the idempotency key makes a repeated delivery return the first job.
 */
export async function enqueueDocumentRequest(
  dependencies: { readonly registry: JobRegistry; readonly queue: JobQueue },
  input: {
    readonly company_id: unknown;
    readonly provider_id: unknown;
    readonly document_label: unknown;
    readonly note?: unknown;
  },
): Promise<EnqueueResult> {
  const parsed = documentRequestJobPayloadSchema.safeParse(input);

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  registerKycDocumentRequestJob(dependencies.registry);

  return enqueueJob(dependencies, KYC_DOCUMENT_REQUEST_JOB, parsed.data, {
    idempotencyKey: documentRequestIdempotencyKey(
      parsed.data.company_id,
      parsed.data.provider_id,
      parsed.data.document_label,
    ),
  });
}

/* -------------------------------------------------------------------------------------------------
 * The UBO capture: an owner of 25 percent or more, with the share in basis points.
 * ---------------------------------------------------------------------------------------------- */

export interface UboInput {
  readonly ubo_id?: unknown;
  readonly full_name: unknown;
  readonly date_of_birth: unknown;
  readonly country: unknown;
  readonly ownership_bps: unknown;
  readonly id_document_sha256: unknown;
}

/** Parse one UBO. The significant flag is derived from the share, never taken from the body. */
export function parseUboInput(input: UboInput): {
  readonly values: {
    readonly uboId: string | null;
    readonly fullName: string;
    readonly dateOfBirth: string;
    readonly country: string;
    readonly ownershipBps: number;
    readonly isSignificant: boolean;
    readonly idDocumentSha256: string;
  } | null;
  readonly problems: readonly ErrorDetail[];
} {
  const problems: ErrorDetail[] = [];

  const fullName =
    typeof input.full_name === "string" ? sanitizeSingleLineText(input.full_name) : "";

  if (fullName.length < 2 || fullName.length > 160) {
    problems.push({ field: "full_name", rule: fullName.length < 2 ? "too_short" : "too_long" });
  }

  const dateOfBirth = typeof input.date_of_birth === "string" ? input.date_of_birth : "";

  if (!DATE_PATTERN.test(dateOfBirth) || Number.isNaN(Date.parse(dateOfBirth))) {
    problems.push({ field: "date_of_birth", rule: "invalid_format" });
  } else if (dateOfBirth < "1900-01-01" || dateOfBirth > isoOf(Date.now()).slice(0, 10)) {
    problems.push({ field: "date_of_birth", rule: "invalid_format" });
  }

  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";

  if (!/^[A-Z]{2}$/u.test(country)) {
    problems.push({ field: "country", rule: "invalid_format" });
  }

  const ownershipBps = input.ownership_bps;

  if (
    typeof ownershipBps !== "number" ||
    !Number.isInteger(ownershipBps) ||
    ownershipBps < 1 ||
    ownershipBps > 10_000
  ) {
    problems.push({ field: "ownership_bps", rule: "invalid_format" });
  }

  const hash = typeof input.id_document_sha256 === "string" ? input.id_document_sha256 : "";

  if (!HASH_PATTERN.test(hash)) {
    problems.push({ field: "id_document_sha256", rule: "invalid_format" });
  }

  const uboId =
    input.ubo_id === undefined || input.ubo_id === null || input.ubo_id === ""
      ? null
      : typeof input.ubo_id === "string" && z.string().uuid().safeParse(input.ubo_id).success
        ? input.ubo_id
        : undefined;

  if (uboId === undefined) {
    problems.push({ field: "ubo_id", rule: "invalid_format" });
  }

  if (problems.length > 0 || typeof ownershipBps !== "number" || uboId === undefined) {
    return { values: null, problems };
  }

  return {
    values: {
      uboId,
      fullName,
      dateOfBirth,
      country,
      ownershipBps,
      isSignificant: ownershipBps >= SIGNIFICANT_OWNER_BPS,
      idDocumentSha256: hash,
    },
    problems,
  };
}

/**
 * Capture one beneficial owner against the draft submission. The share is stored in basis points
 * and `is_significant` is computed here exactly as `0050`'s check ties it to 2500. The total of a
 * submission may never exceed 10000 basis points - the database guard refuses the row - so the
 * service sums first and refuses with the field named rather than letting the constraint answer.
 */
export async function saveUbo(
  input: { readonly actor: RequestActor; readonly input: UboInput },
  dependencies: KycCaptureDependencies,
): Promise<KycPackSnapshot> {
  const companyId = requireOwnerCompany(input.actor);
  const rest = dependencies.rest;
  const parsed = parseUboInput(input.input);

  if (parsed.values === null) {
    throw new AppError("VALIDATION_FAILED", { details: parsed.problems });
  }

  const values = parsed.values;
  const submission = await ensureDraftSubmission(companyId, input.actor.userId, rest);
  const existing = await readUboRows(companyId, submission.id, rest);

  if (values.uboId !== null) {
    const own = existing.find((row) => row.id === values.uboId);

    if (own === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "ubo_id", rule: "not_found" }],
      });
    }
  }

  const othersTotal = existing
    .filter((row) => row.id !== values.uboId)
    .reduce((total, row) => total + row.ownership_bps, 0);

  if (othersTotal + values.ownershipBps > 10_000) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "ownership_bps", rule: "ownership_total_exceeded" }],
    });
  }

  const row = {
    company_id: companyId,
    submission_id: submission.id,
    full_name: values.fullName,
    date_of_birth: values.dateOfBirth,
    country: values.country,
    ownership_bps: values.ownershipBps,
    is_significant: values.isSignificant,
    id_document_sha256: values.idDocumentSha256,
  };

  if (values.uboId === null) {
    await rest.insert(UBO_RECORDS_TABLE, [row]);
  } else {
    await rest.update(
      UBO_RECORDS_TABLE,
      `id=eq.${encodeURIComponent(values.uboId)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
      row,
    );
  }

  try {
    await dependencies.audit.append({
      action: UBO_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_AUDIT_ENTITY,
      entityId: submission.id,
      companyId,
      sessionId: input.actor.sessionId,
      payload: {
        ubo_id: values.uboId ?? "new",
        ownership_bps: values.ownershipBps,
        is_significant: values.isSignificant,
        country: values.country,
      },
    });
  } catch {
    // Same rule as the other saves: the audit sink failing does not fail the capture.
  }

  return readKycPack({ actor: input.actor }, dependencies);
}

/* -------------------------------------------------------------------------------------------------
 * The screening: execute over the company and its UBOs, record one row per subject.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Run the manual screening over the draft submission's subjects and record one
 * `sanctions_screenings` row per subject not screened before: the company itself and every
 * captured UBO. A subject whose country of record is sanctioned on the `0076` list is recorded as
 * `possible_match` with the reason in the note; everything else is `clear`. The merchant's answer
 * carries only the count - results stay with the office, per section 5 and `0051`.
 */
export async function runKycScreening(
  input: { readonly actor: RequestActor },
  dependencies: KycCaptureDependencies,
): Promise<KycPackSnapshot> {
  const companyId = requireOwnerCompany(input.actor);
  const rest = dependencies.rest;
  const now = nowOf(dependencies);
  const submission = await ensureDraftSubmission(companyId, input.actor.userId, rest);
  const ubos = await readUboRows(companyId, submission.id, rest);
  const screened = await rest.select(
    SANCTIONS_SCREENINGS_TABLE,
    `select=id,subject_kind,subject_id&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=500`,
    screeningRowSchema,
  );
  const alreadyScreened = new Set(screened.map((row) => `${row.subject_kind}:${row.subject_id}`));

  const companyCountry = await readProfileCountry(companyId, rest);
  const subjects: { readonly kind: string; readonly id: string; readonly country: string | null }[] = [
    { kind: "company", id: companyId, country: companyCountry },
    ...ubos.map((ubo) => ({ kind: "ubo", id: ubo.id, country: ubo.country })),
  ];

  let clear = 0;
  let possibleMatch = 0;

  for (const subject of subjects) {
    if (alreadyScreened.has(`${subject.kind}:${subject.id}`)) {
      continue;
    }

    const sanctioned = await isSanctionedCountry(subject.country, rest);
    const result = sanctioned ? "possible_match" : "clear";

    if (sanctioned) {
      possibleMatch += 1;
    } else {
      clear += 1;
    }

    await rest.insert(SANCTIONS_SCREENINGS_TABLE, [
      {
        company_id: companyId,
        subject_kind: subject.kind,
        subject_id: subject.id,
        ofac_checked: true,
        un_checked: true,
        eu_checked: true,
        us_checked: true,
        result,
        provider: "manual",
        screened_at: isoOf(now),
        note: sanctioned
          ? "the subject's country of record is sanctioned on the platform country list; manual review of the four lists is required"
          : null,
      },
    ]);
  }

  for (const ubo of ubos) {
    if (ubo.screened_at !== null) {
      continue;
    }

    await rest.update(
      UBO_RECORDS_TABLE,
      `id=eq.${encodeURIComponent(ubo.id)}&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
      { screened_at: isoOf(now) },
    );
  }

  try {
    await dependencies.audit.append({
      action: KYC_SCREENING_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_AUDIT_ENTITY,
      entityId: submission.id,
      companyId,
      sessionId: input.actor.sessionId,
      payload: { submission_id: submission.id, subjects: subjects.length, clear, possible_match: possibleMatch },
    });
  } catch {
    // Same rule as the other writes.
  }

  return readKycPack({ actor: input.actor }, dependencies);
}

/* -------------------------------------------------------------------------------------------------
 * The read: the whole pack for the owner, with screening results deliberately left out.
 * ---------------------------------------------------------------------------------------------- */

/** The documents step for the caller's own company: submission, documents, UBOs, countries. */
export async function readKycPack(
  input: { readonly actor: RequestActor },
  dependencies: KycCaptureDependencies,
): Promise<KycPackSnapshot> {
  const companyId = requireOwnerCompany(input.actor);
  const rest = dependencies.rest;

  const submission = await readDraftSubmission(companyId, rest);
  const [documents, screenings, countries, openRequests] = await Promise.all([
    rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id,document_type,storage_key,content_sha256,content_type,byte_size,issued_at,expires_at,status,rejection_reason,created_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.asc&limit=500`,
      documentRowSchema,
    ),
    rest.select(
      SANCTIONS_SCREENINGS_TABLE,
      `select=id&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=500`,
      z.object({ id: z.string() }),
    ),
    rest.select(
      COUNTRIES_TABLE,
      `select=code,name&deleted_at=is.null&order=code.asc&limit=500`,
      z.object({ code: z.string(), name: z.string() }),
    ),
    rest.select(
      KYC_DOCUMENT_REQUESTS_TABLE,
      `select=id,submission_id,provider_id,document_label,note,status,created_at&company_id=eq.${encodeURIComponent(companyId)}&status=eq.open&deleted_at=is.null&order=created_at.asc&limit=100`,
      openDocumentRequestRowSchema,
    ),
  ]);

  const uboRows = submission === null ? [] : await readUboRows(companyId, submission.id, rest);

  return {
    companyId,
    submissionId: submission?.id ?? null,
    status: submission?.status ?? null,
    documents: documents.map((row) => ({
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
      createdAt: row.created_at,
    })),
    ubos: uboRows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      dateOfBirth: row.date_of_birth,
      country: row.country,
      ownershipBps: row.ownership_bps,
      isSignificant: row.is_significant,
      screenedAt: row.screened_at,
    })),
    countries,
    screenedCount: screenings.length,
    documentsComplete: documents.length > 0,
    openRequests: openRequests.map((row) => viewOfRequest(row)),
  };
}

/* -------------------------------------------------------------------------------------------------
 * The summary and status screen of STEP 087: what the merchant reads, and the submit.
 * ---------------------------------------------------------------------------------------------- */

/** One document as the summary lists it: type, review status and dates - never key or hash. */
export interface KycSummaryDocument {
  readonly id: string;
  readonly documentType: KycDocumentType;
  readonly status: string;
  readonly rejectionReason: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly byteSize: number;
}

/**
 * The merchant's KYC summary and status. Section 5 and `0048`'s own comment say the merchant only
 * ever reads `status`: this snapshot carries no verification method, no provider reference, no
 * screening row and no storage key or hash - only counts, statuses and the decision reason a
 * rejection carries because the merchant reads it.
 */
export interface KycSummarySnapshot {
  readonly submissionId: string | null;
  readonly status: string | null;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly documents: readonly KycSummaryDocument[];
  readonly documentCount: number;
  readonly ownerCount: number;
  readonly significantOwnerCount: number;
  readonly screenedCount: number;
  /** What still blocks a submit: "documents", "screening". */
  readonly missing: readonly string[];
  readonly canSubmit: boolean;
}

/** The latest submission of the company, any status, or null when there is none yet. */
async function readLatestSubmission(
  companyId: string,
  rest: RestClient,
): Promise<z.infer<typeof submissionDetailRowSchema> | null> {
  const rows = await rest.select(
    KYC_SUBMISSIONS_TABLE,
    `select=id,company_id,status,submitted_at,submitted_by,decided_at,decision_reason,version,created_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.desc&limit=1`,
    submissionDetailRowSchema,
  );

  return rows[0] ?? null;
}

/** The merchant-facing summary of the company's KYC: counts, statuses, and what blocks a submit. */
export async function readKycSummary(
  input: { readonly actor: RequestActor },
  dependencies: KycCaptureDependencies,
): Promise<KycSummarySnapshot> {
  const companyId = requireOwnerCompany(input.actor);
  const rest = dependencies.rest;

  const submission = await readLatestSubmission(companyId, rest);
  const [documentRows, screenings] = await Promise.all([
    rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id,document_type,status,rejection_reason,issued_at,expires_at,byte_size&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.asc&limit=500`,
      documentSummaryRowSchema,
    ),
    rest.select(
      SANCTIONS_SCREENINGS_TABLE,
      `select=id&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=500`,
      z.object({ id: z.string() }),
    ),
  ]);

  const uboRows =
    submission === null
      ? []
      : await rest.select(
          UBO_RECORDS_TABLE,
          `select=id,is_significant&company_id=eq.${encodeURIComponent(companyId)}&submission_id=eq.${encodeURIComponent(submission.id)}&deleted_at=is.null&limit=500`,
          z.object({ id: z.string(), is_significant: z.boolean() }),
        );

  const documents: readonly KycSummaryDocument[] = documentRows.map((row) => ({
    id: row.id,
    documentType: row.document_type as KycDocumentType,
    status: row.status,
    rejectionReason: row.rejection_reason,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    byteSize: row.byte_size,
  }));

  const missing: string[] = [];

  if (documents.length === 0) {
    missing.push("documents");
  }

  if (screenings.length === 0) {
    missing.push("screening");
  }

  return {
    submissionId: submission?.id ?? null,
    status: submission?.status ?? null,
    submittedAt: submission?.submitted_at ?? null,
    decidedAt: submission?.decided_at ?? null,
    decisionReason: submission?.decision_reason ?? null,
    documents,
    documentCount: documents.length,
    ownerCount: uboRows.length,
    significantOwnerCount: uboRows.filter((row) => row.is_significant).length,
    screenedCount: screenings.length,
    missing,
    canSubmit: submission !== null && submission.status === "draft" && missing.length === 0,
  };
}

/**
 * Submit the company's draft for review: draft -> submitted, with the instant and the submitter
 * `0048` asks for, one audit entry, and the conditional update so a second submit loses the race
 * instead of rewriting history. The screen needs at least one document and one screening run.
 */
export async function submitKyc(
  input: { readonly actor: RequestActor },
  dependencies: KycCaptureDependencies,
): Promise<KycSummarySnapshot> {
  const companyId = requireOwnerCompany(input.actor);
  const rest = dependencies.rest;
  const now = nowOf(dependencies);

  const submission = await readLatestSubmission(companyId, rest);

  if (submission === null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "documents", rule: "required" }] });
  }

  if (submission.status !== "draft") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_submitted" }] });
  }

  const [documentRows, screenings] = await Promise.all([
    rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=500`,
      z.object({ id: z.string() }),
    ),
    rest.select(
      SANCTIONS_SCREENINGS_TABLE,
      `select=id&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=500`,
      z.object({ id: z.string() }),
    ),
  ]);

  const missing: ErrorDetail[] = [];

  if (documentRows.length === 0) {
    missing.push({ field: "documents", rule: "required" });
  }

  if (screenings.length === 0) {
    missing.push({ field: "screening", rule: "required" });
  }

  if (missing.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: missing });
  }

  // Conditional on the row still being the draft, so a second tab's submit loses the race.
  await rest.update(
    KYC_SUBMISSIONS_TABLE,
    `id=eq.${encodeURIComponent(submission.id)}&company_id=eq.${encodeURIComponent(companyId)}&status=eq.draft&deleted_at=is.null`,
    {
      status: "submitted",
      submitted_at: isoOf(now),
      submitted_by: input.actor.userId,
      updated_at: isoOf(now),
      version: submission.version + 1,
    },
  );

  const after = await readLatestSubmission(companyId, rest);

  if (after === null || after.id !== submission.id || after.status !== "submitted") {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "stale" }] });
  }

  try {
    await dependencies.audit.append({
      action: KYC_SUBMIT_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: KYC_AUDIT_ENTITY,
      entityId: submission.id,
      companyId,
      sessionId: input.actor.sessionId,
      payload: { submission_id: submission.id, status: "submitted" },
    });
  } catch {
    // The audit sink failing must not fail the submit; the save services hold the same rule.
  }

  return readKycSummary({ actor: input.actor }, dependencies);
}

/** The UBOs of a submission; the company scope stays explicit beside the submission scope. */
async function readUboRows(
  companyId: string,
  submissionId: string,
  rest: RestClient,
): Promise<readonly z.infer<typeof uboRowSchema>[]> {
  return rest.select(
    UBO_RECORDS_TABLE,
    `select=id,full_name,date_of_birth,country,ownership_bps,is_significant,id_document_sha256,is_pep,screened_at&company_id=eq.${encodeURIComponent(companyId)}&submission_id=eq.${encodeURIComponent(submissionId)}&deleted_at=is.null&order=created_at.asc&limit=500`,
    uboRowSchema,
  );
}

/** The merchant's registered country, for the company subject of the screening. */
async function readProfileCountry(companyId: string, rest: RestClient): Promise<string | null> {
  const rows = await rest.select(
    BUSINESS_PROFILE_TABLE,
    `select=country_code&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    z.object({ country_code: z.string().nullable() }),
  );

  return rows[0]?.country_code ?? null;
}

/** True when the `0076` row of this country is sanctioned. */
async function isSanctionedCountry(code: string | null, rest: RestClient): Promise<boolean> {
  if (code === null) {
    return false;
  }

  const rows = await rest.select(
    COUNTRIES_TABLE,
    `select=code,is_sanctioned&code=eq.${encodeURIComponent(code)}&deleted_at=is.null&limit=1`,
    countrySanctionSchema,
  );

  return rows[0]?.is_sanctioned ?? false;
}
