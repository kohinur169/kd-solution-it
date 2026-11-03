// path: lib/storage/branding.ts
import { randomUUID } from "node:crypto";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError } from "../errors/app-error.ts";
import { sniffHead, uploadRejection, validateUpload, type UploadVerdict } from "../security/upload.ts";
import type { StorageFileEncryption, SealedFile } from "./encryption.ts";
import { createFileSignedUrl, uploadEncryptedObject, type FileAccessContext } from "./service.ts";
import {
  archiveFile,
  getFileRecord,
  listFileRecords,
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
 * The logo and branding asset category: the `company_logo` purpose of section 21 - "Merchants
 * can set their own logo and invoice branding" (line 184), "logos ... can be uploaded" (line 229) -
 * on the same pattern STEP 104 built for KYC documents.
 *
 * ## What makes this category its own
 *
 * A logo is an image with a small ceiling (`company_logo` policy: PNG, JPEG or WebP, at most
 * 2 MB; svg is refused like everywhere else), and a merchant has **one** current logo: every
 * verified upload archives the merchant's previous live logo rows, so the branding a person sees
 * is always the latest verified one, and the older objects stay as history under their own keys
 * until retention removes them.
 *
 * ## The path layout
 *
 * `<companyId>/logo/<uuid><ext>`: the `0057` tenant prefix by construction, the `logo` segment
 * naming the category, and a fresh UUID per upload (the unique key index means a re-upload never
 * overwrites another object). `parseBrandingStorageKey` / `assertBrandingKeyForCompany` enforce
 * the tenant on the read path exactly like the KYC category does.
 */

/** The middle segment of a branding storage key. */
export const BRANDING_KEY_SEGMENT = "logo";

const KEY_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/iu;

/**
 * Build the storage key of a new branding asset: tenant prefix, the `logo` segment, and a fresh
 * UUID with the extension of the verified type. The file name the browser sent is display only.
 */
export function brandingStorageKey(companyId: string, contentType: string): string {
  const extension = storageExtensionFor(contentType);

  if (extension === undefined) {
    throw new StorageError("invalid_input", "the content type has no storage extension");
  }

  return `${companyId}/${BRANDING_KEY_SEGMENT}/${randomUUID()}${extension}`;
}

/** What a branding storage key says about itself, or null when the key is not a branding key. */
export function parseBrandingStorageKey(key: string): { readonly companyId: string } | null {
  const segments = key.split("/");

  if (segments.length !== 3 || segments[1] !== BRANDING_KEY_SEGMENT) {
    return null;
  }

  const [companyId, , file] = segments;

  if (companyId === undefined || file === undefined || !KEY_FILE_PATTERN.test(file)) {
    return null;
  }

  return { companyId };
}

/** Refuse a branding key that does not belong to exactly this merchant. */
export function assertBrandingKeyForCompany(key: string, companyId: string): void {
  const parsed = parseBrandingStorageKey(key);

  if (parsed === null || parsed.companyId !== companyId) {
    throw new StorageError("invalid_input", "the storage key is not a branding key of this merchant");
  }
}

export interface BrandingStorageDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly adapter: StorageAdapter;
  readonly encryption: StorageFileEncryption;
  readonly now?: () => number;
}

export interface BrandingUploadInput {
  readonly companyId: string;
  readonly uploadedBy: string;
  readonly fileName: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
}

export interface BrandingUploadResult {
  readonly record: FileRecord;
  readonly stored: StoredObject;
  readonly sealed: SealedFile;
  readonly verdict: UploadVerdict;
  /** The previous live logo rows this upload archived, so the merchant has one current logo. */
  readonly archived: readonly FileRecord[];
}

function recordDepsOf(dependencies: BrandingStorageDependencies): FileRecordDependencies {
  return {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

function accessOf(input: { readonly companyId: string; readonly uploadedBy: string }): FileAccessContext {
  return { actorUserId: input.uploadedBy, companyId: input.companyId, purpose: "company_logo" };
}

/**
 * Store one branding asset end to end: magic byte verdict against the `company_logo` policy,
 * encrypted upload, the `0057` row, the verdict's status walk, and - when the upload verified -
 * the merchant's previous live logo rows are archived, so one merchant has one current logo.
 * A rejected upload is a `422` and stores nothing; a mismatched one is stored, recorded and
 * quarantined with the reason, exactly as in the KYC category.
 */
export async function uploadBrandingAsset(
  dependencies: BrandingStorageDependencies,
  input: BrandingUploadInput,
): Promise<BrandingUploadResult> {
  const decision = validateUpload(
    {
      fileName: input.fileName,
      declaredType: input.declaredType,
      byteSize: input.bytes.length,
      head: sniffHead(input.bytes),
    },
    "company_logo",
  );

  if (!decision.ok) {
    throw uploadRejection(decision.reason);
  }

  const verdict = decision.verdict;
  const key = brandingStorageKey(input.companyId, verdict.contentType);

  const { stored, sealed } = await uploadEncryptedObject(
    dependencies.adapter,
    { bucket: DEFAULT_STORAGE_BUCKET, key, bytes: input.bytes, contentType: verdict.contentType },
    accessOf(input),
    dependencies,
  );

  const recordDeps = recordDepsOf(dependencies);

  let record = await recordUploadedFile(recordDeps, {
    companyId: input.companyId,
    uploadedBy: input.uploadedBy,
    purpose: "company_logo",
    contentType: verdict.contentType,
    stored,
    sealed,
  });

  const archived: FileRecord[] = [];

  if (verdict.decision === "verified") {
    record = await markFileVerified(recordDeps, { companyId: input.companyId, fileId: record.id });

    const previous = await listFileRecords(recordDeps, { companyId: input.companyId, purpose: "company_logo" });

    for (const old of previous) {
      if (old.id !== record.id && old.status === "ready") {
        archived.push(await archiveFile(recordDeps, { companyId: input.companyId, fileId: old.id }));
      }
    }
  } else {
    record = await quarantineFile(recordDeps, {
      companyId: input.companyId,
      fileId: record.id,
      reason: verdict.quarantineReason ?? "the bytes did not match a known signature",
    });
  }

  return { record, stored, sealed, verdict, archived };
}

export interface BrandingDownloadUrl {
  readonly url: string;
  readonly expiresAt: string;
  readonly record: FileRecord;
}

/**
 * Mint the short-lived signed URL of one branding asset. Without a `fileId` it is the merchant's
 * current logo: the newest verified (or archived) `company_logo` row whose key belongs to this
 * merchant. A pending or quarantined asset is never served.
 */
export async function createBrandingDownloadUrl(
  dependencies: BrandingStorageDependencies,
  input: { readonly companyId: string; readonly fileId?: string; readonly expiresInSeconds?: number },
): Promise<BrandingDownloadUrl> {
  let record: FileRecord;

  if (input.fileId !== undefined) {
    record = await getFileRecord(recordDepsOf(dependencies), { companyId: input.companyId, fileId: input.fileId });
  } else {
    const rows = await listFileRecords(recordDepsOf(dependencies), { companyId: input.companyId, purpose: "company_logo" });
    const current = rows.find((row) => row.status === "ready") ?? rows.find((row) => row.status === "archived");

    if (current === undefined) {
      throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "branding_storage", reason: "no_logo" } });
    }

    record = current;
  }

  if (record.purpose !== "company_logo") {
    throw new AppError("VALIDATION_FAILED", { cause: { rule: "branding_storage", reason: "not_a_branding_asset" } });
  }

  assertBrandingKeyForCompany(record.storage_key, input.companyId);

  if (record.status === "pending" || record.status === "quarantined") {
    throw new AppError("PERMISSION_DENIED", { cause: { rule: "branding_storage", reason: `asset_${record.status}` } });
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
      purpose: "company_logo",
    },
    dependencies,
  );

  return { url: signed.url, expiresAt: signed.expiresAt, record };
}

/** The merchant's current logo record, or `RESOURCE_NOT_FOUND` when none is verified. */
export async function currentBrandingAsset(
  dependencies: BrandingStorageDependencies,
  input: { readonly companyId: string },
): Promise<FileRecord> {
  const rows = await listFileRecords(recordDepsOf(dependencies), { companyId: input.companyId, purpose: "company_logo" });
  const current = rows.find((row) => row.status === "ready");

  if (current === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "branding_storage", reason: "no_logo" } });
  }

  assertBrandingKeyForCompany(current.storage_key, input.companyId);

  return current;
}
