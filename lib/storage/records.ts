// path: lib/storage/records.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../auth/audit.ts";
import { isConflictError, type RestClient } from "../auth/rest.ts";
import { AppError } from "../errors/app-error.ts";
import type { SealedFile } from "./encryption.ts";
import { validateBucket, validateObjectKey } from "./service.ts";
import {
  FILE_PURPOSES,
  FILE_STATUSES,
  STORAGE_ADAPTER_NAMES,
  type FilePurpose,
  type FileStatus,
  type StoredObject,
} from "./types.ts";

/**
 * The file record service: the database half of FEATURE_LIST section 21 - "Every file record
 * stores storage_provider, hash, size, type and company." The bytes live in object storage through
 * the adapters; this service writes the `0057` `files` row that says where they live and what they
 * hash to, and walks the row's status forward as the upload is verified, quarantined, archived or
 * retired.
 *
 * ## What the record stores, and why each field is there
 *
 * `storage_provider`, `storage_bucket`, `storage_key` (not a URL: a signed URL expires and a stored
 * one would rot - STEP 104 signs a fresh one per download), `content_type`, `byte_size` and
 * `content_sha256` of the *plaintext*, and the encryption quartet from the `SealedFile` of STEP 102.
 * The ciphertext itself never reaches the database.
 *
 * ## The tenant rule, enforced twice
 *
 * The `0057` check refuses a key that does not start with `company_id/`, and this service refuses
 * one too, before the insert is sent: `recordUploadedFile` checks the prefix itself, and every
 * read and update is scoped by `company_id=eq.<id>` in the query, so even a service-role call
 * (which bypasses RLS) cannot read another merchant's rows. `newStorageKey` builds keys that
 * satisfy the rule by construction.
 *
 * ## The status walk
 *
 * The `0057` guard walks `pending -> ready | quarantined`, `ready -> quarantined | archived`,
 * `quarantined -> archived` (only when verified), and freezes the bytes' identity columns on every
 * update. This service mirrors the walk before it sends the update, so a bad transition is a
 * `VALIDATION_FAILED` here rather than a database error there, and every transition re-reads the
 * row (a conditional update that matches nothing reports success in PostgREST, so the re-read is
 * what turns a missing row into `RESOURCE_NOT_FOUND`).
 */

/** The audit action of the row write. */
export const FILE_RECORDED_AUDIT_ACTION = "file.recorded";
/** The audit action of a verification verdict. */
export const FILE_VERIFIED_AUDIT_ACTION = "file.verified";
/** The audit action of a quarantine. */
export const FILE_QUARANTINED_AUDIT_ACTION = "file.quarantined";
/** The audit action of an archive. */
export const FILE_ARCHIVED_AUDIT_ACTION = "file.archived";
/** The audit action of a soft delete. */
export const FILE_SOFT_DELETED_AUDIT_ACTION = "file.soft_deleted";

/** The audit entity type of every record entry. */
export const FILE_RECORD_ENTITY = "file";

const FILES_TABLE = "files";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The row shape of `0057`, validated on every read so a schema drift fails here, not in a route. */
export const fileRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  uploaded_by: z.string().uuid().nullable(),
  purpose: z.enum(FILE_PURPOSES),
  storage_provider: z.enum(STORAGE_ADAPTER_NAMES),
  storage_bucket: z.string().min(3).max(63),
  storage_key: z.string().min(3).max(512),
  content_type: z.string().min(1).max(120),
  byte_size: z.number().int().min(1).max(52_428_800),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  encryption_algorithm: z.literal("aes-256-gcm"),
  encryption_key_version: z.number().int().min(1).max(999),
  ciphertext_iv: z.string().min(12).max(64),
  ciphertext_tag: z.string().min(16).max(64),
  magic_byte_verified: z.boolean(),
  verified_at: z.string().nullable(),
  status: z.enum(FILE_STATUSES),
  quarantined_reason: z.string().max(280).nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

/** One row of `public.files`, as this service returns it. */
export type FileRecord = z.infer<typeof fileRowSchema>;

export interface FileRecordDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

function requireCompanyId(companyId: string): string {
  if (!uuidPattern.test(companyId)) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "company_id" } });
  }

  return companyId;
}

function requirePurpose(purpose: string): FilePurpose {
  if (!FILE_PURPOSES.includes(purpose as FilePurpose)) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "purpose" } });
  }

  return purpose as FilePurpose;
}

/**
 * Build the storage key of a new object: the tenant prefix the `0057` check demands, the purpose,
 * and a random UUID, so two uploads of the same document never fork the unique key index.
 */
export function newStorageKey(companyId: string, purpose: FilePurpose): string {
  requireCompanyId(companyId);
  requirePurpose(purpose);

  return `${companyId}/${purpose}/${randomUUID()}`;
}

export interface RecordUploadedFileInput {
  readonly companyId: string;
  readonly uploadedBy: string | null;
  readonly purpose: FilePurpose;
  readonly contentType: string;
  /** Where the adapter put the envelope: provider, bucket, key. */
  readonly stored: StoredObject;
  /** The quartet and hashes of STEP 102. */
  readonly sealed: SealedFile;
}

async function appendRecordTolerated(
  audit: AuditTrail,
  entry: Parameters<AuditTrail["append"]>[0],
): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the record it describes.
  }
}

/**
 * Write the `0057` row of an uploaded file. The key must sit under the merchant's own prefix - the
 * same rule the database check enforces - and a duplicate key answers `CONFLICT`, because one
 * object is one row forever, soft delete included.
 */
export async function recordUploadedFile(
  dependencies: FileRecordDependencies,
  input: RecordUploadedFileInput,
): Promise<FileRecord> {
  const companyId = requireCompanyId(input.companyId);
  const purpose = requirePurpose(input.purpose);

  if (input.uploadedBy !== null && !uuidPattern.test(input.uploadedBy)) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "uploaded_by" } });
  }

  let bucket: string;
  let key: string;

  try {
    bucket = validateBucket(input.stored.bucket);
    key = validateObjectKey(input.stored.key);
  } catch {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "storage_ref" } });
  }

  if (!key.startsWith(`${companyId}/`)) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "storage_key_tenant_prefix" } });
  }

  const row = {
    company_id: companyId,
    uploaded_by: input.uploadedBy,
    purpose,
    storage_provider: input.stored.provider,
    storage_bucket: bucket,
    storage_key: key,
    content_type: input.contentType,
    byte_size: input.sealed.plaintextBytes,
    content_sha256: input.sealed.plaintextSha256,
    encryption_algorithm: input.sealed.algorithm,
    encryption_key_version: input.sealed.keyVersion,
    ciphertext_iv: input.sealed.iv,
    ciphertext_tag: input.sealed.tag,
    status: "pending",
  };

  let record: FileRecord;

  try {
    const [inserted] = await dependencies.rest.insertReturning(FILES_TABLE, [row], fileRowSchema);

    if (inserted === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "file_record", reason: "insert_returned_no_row" } });
    }

    record = inserted;
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError("CONFLICT", { cause: { rule: "file_record", reason: "storage_key_taken" } });
    }

    throw error;
  }

  await appendRecordTolerated(dependencies.audit, {
    action: FILE_RECORDED_AUDIT_ACTION,
    actorUserId: input.uploadedBy,
    entityType: FILE_RECORD_ENTITY,
    entityId: record.id,
    companyId,
    sessionId: null,
    payload: {
      purpose: record.purpose,
      provider: record.storage_provider,
      bucket: record.storage_bucket,
      key: record.storage_key,
      content_type: record.content_type,
      byte_size: record.byte_size,
      content_sha256: record.content_sha256,
      encryption_key_version: record.encryption_key_version,
      status: record.status,
    },
  });

  return record;
}

/** Read one live row of one merchant, or `RESOURCE_NOT_FOUND`. */
export async function getFileRecord(
  dependencies: FileRecordDependencies,
  input: { readonly companyId: string; readonly fileId: string },
): Promise<FileRecord> {
  const companyId = requireCompanyId(input.companyId);

  if (!uuidPattern.test(input.fileId)) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "file_id" } });
  }

  const rows = await dependencies.rest.select(
    FILES_TABLE,
    `id=eq.${input.fileId}&company_id=eq.${companyId}&deleted_at=is.null`,
    fileRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "file_record", reason: "not_found" } });
  }

  return row;
}

/** List the live rows of one merchant, newest first, optionally of one purpose. */
export async function listFileRecords(
  dependencies: FileRecordDependencies,
  input: { readonly companyId: string; readonly purpose?: FilePurpose },
): Promise<readonly FileRecord[]> {
  const companyId = requireCompanyId(input.companyId);
  const purpose = input.purpose === undefined ? "" : `&purpose=eq.${requirePurpose(input.purpose)}`;

  return dependencies.rest.select(
    FILES_TABLE,
    `company_id=eq.${companyId}&deleted_at=is.null${purpose}&order=created_at.desc`,
    fileRowSchema,
  );
}

/** The forward walk of the `0057` guard, mirrored before the update is sent. */
const FORWARD: Readonly<Record<FileStatus, readonly FileStatus[]>> = {
  pending: ["ready", "quarantined"],
  ready: ["quarantined", "archived"],
  quarantined: ["archived"],
  archived: [],
};

interface TransitionInput {
  readonly companyId: string;
  readonly fileId: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly to: FileStatus;
  readonly auditAction: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function transition(dependencies: FileRecordDependencies, input: TransitionInput): Promise<FileRecord> {
  const current = await getFileRecord(dependencies, { companyId: input.companyId, fileId: input.fileId });

  if (!FORWARD[current.status]?.includes(input.to)) {
    throw new AppError("VALIDATION_FAILED", {
      cause: { rule: "file_record", reason: "status_walk", from: current.status, to: input.to },
    });
  }

  // A quarantined-to-archived walk requires the verdict the guard demands.
  if (input.to === "archived" && current.status === "quarantined" && !current.magic_byte_verified) {
    throw new AppError("VALIDATION_FAILED", {
      cause: { rule: "file_record", reason: "archive_requires_verification" },
    });
  }

  await dependencies.rest.update(
    FILES_TABLE,
    `id=eq.${input.fileId}&company_id=eq.${requireCompanyId(input.companyId)}`,
    input.values,
  );

  // PostgREST reports success for an update that matched nothing, so the re-read is the check.
  const updated = await getFileRecord(dependencies, { companyId: input.companyId, fileId: input.fileId });

  await appendRecordTolerated(dependencies.audit, {
    action: input.auditAction,
    actorUserId: null,
    entityType: FILE_RECORD_ENTITY,
    entityId: updated.id,
    companyId: input.companyId,
    sessionId: null,
    payload: { from: current.status, to: updated.status, ...input.payload },
  });

  return updated;
}

/** Record the magic byte verdict: the file becomes `ready`, verified once and never cleared. */
export async function markFileVerified(
  dependencies: FileRecordDependencies,
  input: { readonly companyId: string; readonly fileId: string },
): Promise<FileRecord> {
  const now = dependencies.now?.() ?? Date.now();

  return transition(dependencies, {
    companyId: input.companyId,
    fileId: input.fileId,
    to: "ready",
    values: {
      magic_byte_verified: true,
      verified_at: new Date(now).toISOString(),
      status: "ready",
    },
    auditAction: FILE_VERIFIED_AUDIT_ACTION,
    payload: { verified_at: new Date(now).toISOString() },
  });
}

/** Quarantine the file with the reason a person needs (1..280, trimmed, recorded once). */
export async function quarantineFile(
  dependencies: FileRecordDependencies,
  input: { readonly companyId: string; readonly fileId: string; readonly reason: string },
): Promise<FileRecord> {
  const reason = input.reason.trim();

  if (reason.length < 1 || reason.length > 280) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "file_record", reason: "quarantined_reason" } });
  }

  return transition(dependencies, {
    companyId: input.companyId,
    fileId: input.fileId,
    to: "quarantined",
    values: { status: "quarantined", quarantined_reason: reason },
    auditAction: FILE_QUARANTINED_AUDIT_ACTION,
    payload: { quarantined_reason: reason },
  });
}

/** Archive a verified file: `ready -> archived`, or a verified quarantine's history. */
export async function archiveFile(
  dependencies: FileRecordDependencies,
  input: { readonly companyId: string; readonly fileId: string },
): Promise<FileRecord> {
  return transition(dependencies, {
    companyId: input.companyId,
    fileId: input.fileId,
    to: "archived",
    values: { status: "archived" },
    auditAction: FILE_ARCHIVED_AUDIT_ACTION,
    payload: {},
  });
}

/** Soft delete the row: `deleted_at` is set once and never cleared; the retention job removes the object. */
export async function softDeleteFile(
  dependencies: FileRecordDependencies,
  input: { readonly companyId: string; readonly fileId: string },
): Promise<FileRecord> {
  const now = dependencies.now?.() ?? Date.now();
  const deletedAt = new Date(now).toISOString();

  const current = await getFileRecord(dependencies, { companyId: input.companyId, fileId: input.fileId });

  await dependencies.rest.update(
    FILES_TABLE,
    `id=eq.${input.fileId}&company_id=eq.${requireCompanyId(input.companyId)}&deleted_at=is.null`,
    { deleted_at: deletedAt },
  );

  const rows = await dependencies.rest.select(
    FILES_TABLE,
    `id=eq.${input.fileId}&company_id=eq.${requireCompanyId(input.companyId)}`,
    fileRowSchema,
  );
  const updated = rows[0];

  if (updated === undefined || updated.deleted_at === null) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "file_record", reason: "not_found" } });
  }

  await appendRecordTolerated(dependencies.audit, {
    action: FILE_SOFT_DELETED_AUDIT_ACTION,
    actorUserId: null,
    entityType: FILE_RECORD_ENTITY,
    entityId: updated.id,
    companyId: input.companyId,
    sessionId: null,
    payload: { from: current.status, deleted_at: deletedAt },
  });

  return updated;
}
