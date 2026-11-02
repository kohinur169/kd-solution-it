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
import { KYC_DOCUMENT_TYPES, type KycDocumentType } from "./kyc-document-types.ts";
import {
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  nextOnboardingStep,
  type OnboardingStep,
} from "./onboarding-steps.ts";

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
export { KYC_DOCUMENT_TYPES };
export type { KycDocumentType };

/** The onboarding step this module completes when at least one document is recorded. */
export const KYC_DOCUMENTS_ONBOARDING_STEP: OnboardingStep = "documents";

/** The audit actions of the three writes. */
export const KYC_DOCUMENT_AUDIT_ACTION = "kyc_document.uploaded";
export const UBO_AUDIT_ACTION = "ubo.captured";
export const KYC_SCREENING_AUDIT_ACTION = "kyc_screening.ran";

/** The audit entity all three are recorded against: the submission. */
export const KYC_AUDIT_ENTITY = "kyc_submission";

/** The upload purpose of `0057`/`0058` the KYC files carry. */
export const KYC_UPLOAD_PURPOSE = "kyc_document" as const;

/** The largest KYC document, which is the row ceiling of `0057`. */
export const KYC_DOCUMENT_MAXIMUM_BYTES = UPLOAD_DATABASE_MAXIMUM_BYTES;

/** An owner of 25 percent or more is significant: 2500 basis points, as `0050`'s check ties it. */
export const SIGNIFICANT_OWNER_BPS = 2_500;

const submissionRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  status: z.string(),
  verification_method: z.string(),
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
  created_at: z.string(),
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
  readonly method: string | null;
  readonly documents: readonly KycDocumentRecord[];
  readonly ubos: readonly UboRecordView[];
  readonly countries: readonly { readonly code: string; readonly name: string }[];
  readonly screenedCount: number;
  readonly documentsComplete: boolean;
}

export interface KycCaptureDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
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
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** Parse and validate one upload. A quarantined or rejected file is refused with one rule. */
export function parseKycDocumentInput(input: KycDocumentInput): {
  readonly record: {
    readonly documentType: KycDocumentType;
    readonly fileName: string;
    readonly contentType: string;
    readonly contentSha256: string;
    readonly byteSize: number;
    readonly issuedAt: string | null;
    readonly expiresAt: string | null;
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

  for (const [field, raw] of [
    ["issued_at", input.issued_at],
    ["expires_at", input.expires_at],
  ] as const) {
    if (raw === undefined || raw === null || raw === "") {
      continue;
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

  if (documentType === "utility_bill" && issuedAt === null) {
    // `0049`'s issue check refuses the row; the service refuses it earlier, with the field named.
    problems.push({ field: "issued_at", rule: "required" });
  }

  if (issuedAt !== null && expiresAt !== null && expiresAt <= issuedAt) {
    problems.push({ field: "expires_at", rule: "invalid_format" });
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
  const parsed = parseKycDocumentInput(input.input);

  if (parsed.problems.length > 0 || parsed.record === null) {
    throw new AppError("VALIDATION_FAILED", { details: parsed.problems });
  }

  const record = parsed.record;
  const submission = await ensureDraftSubmission(companyId, input.actor.userId, rest);
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
      },
    });
  } catch {
    // The audit sink failing must not fail the record; the save services hold the same rule.
  }

  await syncDocumentsStep(companyId, input.actor.userId, true, rest);

  return readKycPack({ actor: input.actor }, dependencies);
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
  const [documents, screenings, countries] = await Promise.all([
    rest.select(
      KYC_DOCUMENTS_TABLE,
      `select=id,document_type,storage_key,content_sha256,content_type,byte_size,issued_at,expires_at,status,created_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&order=created_at.asc&limit=500`,
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
  ]);

  const uboRows = submission === null ? [] : await readUboRows(companyId, submission.id, rest);

  return {
    companyId,
    submissionId: submission?.id ?? null,
    status: submission?.status ?? null,
    method: submission?.verification_method ?? null,
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
  };
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
