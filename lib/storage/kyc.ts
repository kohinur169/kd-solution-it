// path: lib/storage/kyc.ts
import { randomUUID } from "node:crypto";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError } from "../errors/app-error.ts";
import {
  sniffHead,
  uploadRejection,
  validateUpload,
  type UploadVerdict,
} from "../security/upload.ts";
import type { StorageFileEncryption, SealedFile } from "./encryption.ts";
import {
  createFileSignedUrl,
  downloadEncryptedObject,
  uploadEncryptedObject,
  type FileAccessContext,
} from "./service.ts";
import {
  archiveFile,
  getFileRecord,
  markFileVerified,
  quarantineFile,
  recordUploadedFile,
  type FileRecord,
  type FileRecordDependencies,
} from "./records.ts";
import {
  DEFAULT_STORAGE_BUCKET,
  StorageError,
  storageExtensionFor,
  type StorageAdapter,
  type StoredObject,
} from "./types.ts";

/**
 * The KYC document storage category: the `kyc_document` purpose of section 21 with the tenant
 * isolation paths section 30 asks for, on top of the generic port (STEP 100), the adapters (101),
 * the encryption (102) and the record (103).
 *
 * ## The path layout
 *
 * A KYC object key is `<companyId>/kyc/<documentType>/<uuid><ext>`: the `0057` tenant check
 * (`storage_key` starts with `company_id/`) is satisfied by construction, the middle segments say
 * what the object is without reading it, and the last segment is a fresh UUID, so no upload can
 * overwrite or address another merchant's object - `parseKycStorageKey` reads the layout back and
 * `assertKycKeyForCompany` refuses a key whose first segment is not exactly the caller's company
 * id. `validateObjectKey` of the port already refused `..`, so a key cannot climb out of its
 * prefix; this module refuses the subtler case of a well formed key of *another* tenant.
 *
 * ## The category flow
 *
 * `uploadKycDocument` runs the whole category in one call: the magic byte verdict of
 * `lib/security/upload.ts` decides verified vs quarantined (a rejected upload is a 422 and stores
 * nothing), the bytes are sealed and uploaded through the audited service, the `0057` row is
 * written, and the verdict moves the row forward - `ready` when the bytes matched, `quarantined`
 * with the reason when they did not. `createKycDownloadUrl` mints the short-lived signed URL of
 * section 21 for a verified row of this merchant only, and `readKycDocument` is the server side of
 * a download: record lookup, tenant check, decrypt under the tenant scope.
 */

/** The document types of the `0049` check, mirrored here so `lib/` never imports `services/`. */
export const KYC_DOCUMENT_TYPES = [
  "identity_document",
  "business_registration",
  "utility_bill",
  "bank_statement",
  "source_of_funds",
  "processor_request",
] as const;

export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

/** The middle segment of a KYC storage key. */
export const KYC_KEY_SEGMENT = "kyc";

const KEY_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/iu;

/** True when the value is one of the `0049` document types. */
export function isKycDocumentType(value: string): value is KycDocumentType {
  return (KYC_DOCUMENT_TYPES as readonly string[]).includes(value);
}

/**
 * Build the storage key of a new KYC document: tenant prefix, the `kyc` segment, the document
 * type, and a fresh UUID with the extension of the verified type. The file name the browser sent
 * is display only - the key is generated here, never taken from the client.
 */
export function kycStorageKey(companyId: string, documentType: KycDocumentType, contentType: string): string {
  const extension = storageExtensionFor(contentType);

  if (extension === undefined) {
    throw new StorageError("invalid_input", "the content type has no storage extension");
  }

  return `${companyId}/${KYC_KEY_SEGMENT}/${documentType}/${randomUUID()}${extension}`;
}

/** What a KYC storage key says about itself, or null when the key is not a KYC key. */
export function parseKycStorageKey(key: string): { readonly companyId: string; readonly documentType: KycDocumentType } | null {
  const segments = key.split("/");

  if (segments.length !== 4 || segments[1] !== KYC_KEY_SEGMENT) {
    return null;
  }

  const [companyId, , documentType, file] = segments;

  if (
    companyId === undefined ||
    documentType === undefined ||
    file === undefined ||
    !isKycDocumentType(documentType) ||
    !KEY_FILE_PATTERN.test(file)
  ) {
    return null;
  }

  return { companyId, documentType };
}

/** Refuse a KYC key that does not belong to exactly this merchant. */
export function assertKycKeyForCompany(key: string, companyId: string): void {
  const parsed = parseKycStorageKey(key);

  if (parsed === null || parsed.companyId !== companyId) {
    throw new StorageError("invalid_input", "the storage key is not a KYC key of this merchant");
  }
}

export interface KycStorageDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly adapter: StorageAdapter;
  readonly encryption: StorageFileEncryption;
  readonly now?: () => number;
}

export interface KycUploadInput {
  readonly companyId: string;
  /** The uploader; also the audit actor of the object operations. */
  readonly uploadedBy: string;
  readonly documentType: KycDocumentType;
  readonly fileName: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
}

export interface KycUploadResult {
  readonly record: FileRecord;
  readonly stored: StoredObject;
  readonly sealed: SealedFile;
  readonly verdict: UploadVerdict;
}

function accessOf(input: KycUploadInput): FileAccessContext {
  return {
    actorUserId: input.uploadedBy,
    companyId: input.companyId,
    purpose: "kyc_document",
  };
}

/**
 * Store one KYC document end to end: magic byte verdict, encrypted upload, record, and the status
 * the verdict earns. A rejected upload (wrong type, empty, too large) is a `422` and nothing is
 * stored; a quarantined one is stored, recorded and quarantined with the reason - section 21's
 * evidence, not a refusal.
 */
export async function uploadKycDocument(
  dependencies: KycStorageDependencies,
  input: KycUploadInput,
): Promise<KycUploadResult> {
  if (!isKycDocumentType(input.documentType)) {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "kyc_storage", reason: "document_type" } });
  }

  const decision = validateUpload(
    {
      fileName: input.fileName,
      declaredType: input.declaredType,
      byteSize: input.bytes.length,
      head: sniffHead(input.bytes),
    },
    "kyc_document",
  );

  if (!decision.ok) {
    throw uploadRejection(decision.reason);
  }

  const verdict = decision.verdict;
  const key = kycStorageKey(input.companyId, input.documentType, verdict.contentType);

  const { stored, sealed } = await uploadEncryptedObject(
    dependencies.adapter,
    { bucket: DEFAULT_STORAGE_BUCKET, key, bytes: input.bytes, contentType: verdict.contentType },
    accessOf(input),
    dependencies,
  );

  let record = await recordUploadedFile(dependencies, {
    companyId: input.companyId,
    uploadedBy: input.uploadedBy,
    purpose: "kyc_document",
    contentType: verdict.contentType,
    stored,
    sealed,
  });

  const recordDeps: FileRecordDependencies = {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };

  if (verdict.decision === "verified") {
    record = await markFileVerified(recordDeps, { companyId: input.companyId, fileId: record.id });
  } else {
    record = await quarantineFile(recordDeps, {
      companyId: input.companyId,
      fileId: record.id,
      reason: verdict.quarantineReason ?? "the bytes did not match a known signature",
    });
  }

  return { record, stored, sealed, verdict };
}

export interface KycDownloadUrl {
  readonly url: string;
  readonly expiresAt: string;
  readonly record: FileRecord;
}

/**
 * Mint the short-lived signed URL of one KYC document of one merchant. The record must be a KYC
 * row, its key must belong to this merchant, and it must be verified or archived: a pending or
 * quarantined file is never served, which is what the magic byte state is for.
 */
export async function createKycDownloadUrl(
  dependencies: KycStorageDependencies,
  input: { readonly companyId: string; readonly fileId: string; readonly expiresInSeconds?: number },
): Promise<KycDownloadUrl> {
  const record = await getFileRecord(dependencies, { companyId: input.companyId, fileId: input.fileId });

  if (record.purpose !== "kyc_document") {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "kyc_storage", reason: "not_a_kyc_document" } });
  }

  assertKycKeyForCompany(record.storage_key, input.companyId);

  if (record.status === "pending" || record.status === "quarantined") {
    throw new AppError("PERMISSION_DENIED", { cause: { rule: "kyc_storage", reason: `file_${record.status}` } });
  }

  const signed = await createFileSignedUrl(
    dependencies.adapter,
    {
      bucket: record.storage_bucket,
      key: record.storage_key,
      ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }),
    },
    {
      actorUserId: null,
      companyId: input.companyId,
      fileId: record.id,
      purpose: "kyc_document",
    },
    dependencies,
  );

  return { url: signed.url, expiresAt: signed.expiresAt, record };
}

/**
 * Read one KYC document server side: the record, the tenant check on the key, the download through
 * the adapter, and the decryption under the tenant scope. Returns the plaintext bytes.
 */
export async function readKycDocument(
  dependencies: KycStorageDependencies,
  input: { readonly companyId: string; readonly fileId: string },
): Promise<{ readonly record: FileRecord; readonly bytes: Uint8Array }> {
  const record = await getFileRecord(dependencies, { companyId: input.companyId, fileId: input.fileId });

  if (record.purpose !== "kyc_document") {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "kyc_storage", reason: "not_a_kyc_document" } });
  }

  assertKycKeyForCompany(record.storage_key, input.companyId);

  const bytes = await downloadEncryptedObject(
    dependencies.adapter,
    { bucket: record.storage_bucket, key: record.storage_key },
    { actorUserId: null, companyId: input.companyId, fileId: record.id, purpose: "kyc_document" },
    dependencies,
  );

  return { record, bytes };
}

/** Retire one KYC document of one merchant: the row archives, the object stays until retention. */
export async function archiveKycDocument(
  dependencies: KycStorageDependencies,
  input: { readonly companyId: string; readonly fileId: string },
): Promise<FileRecord> {
  const record = await getFileRecord(dependencies, { companyId: input.companyId, fileId: input.fileId });

  if (record.purpose !== "kyc_document") {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "kyc_storage", reason: "not_a_kyc_document" } });
  }

  assertKycKeyForCompany(record.storage_key, input.companyId);

  const recordDeps: FileRecordDependencies = {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };

  return archiveFile(recordDeps, { companyId: input.companyId, fileId: input.fileId });
}
