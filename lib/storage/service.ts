// path: lib/storage/service.ts
import type { AuditTrail } from "../auth/audit.ts";
import { readFileEnvelopeInfo } from "../security/encryption.ts";
import { UPLOAD_PURPOSES } from "../security/upload.ts";
import type { UploadPurpose } from "../security/upload.ts";
import type {
  FileEncryptionScope,
  SealedFile,
  StorageFileEncryption,
} from "./encryption.ts";
import {
  BUCKET_NAME_PATTERN,
  CONTENT_TYPE_PATTERN,
  MAX_OBJECT_BYTES,
  MIN_OBJECT_BYTES,
  OBJECT_KEY_PATTERN,
  SIGNED_URL_DEFAULT_TTL_SECONDS,
  SIGNED_URL_MAX_TTL_SECONDS,
  SIGNED_URL_MIN_TTL_SECONDS,
  StorageError,
  type SignedUrl,
  type SignedUrlInput,
  type StorageAdapter,
  type StorageObjectRef,
  type StorageUploadInput,
  type StoredObject,
} from "./types.ts";

/**
 * The audited operations of the storage port: `uploadObject`, `downloadObject`, `deleteObject` and
 * `createFileSignedUrl` are the only ways feature code touches object storage, and each one
 * validates its input, runs the adapter operation and appends one audit entry - FEATURE_LIST
 * section 21: "Every file access is audit logged."
 *
 * ## Why validation lives here and not in each adapter
 *
 * A bucket or key is an address, and a malformed address is an injection attempt before it is a
 * provider error: `..` segments, empty segments and leading slashes are refused here, with the same
 * rules `0057` puts on the record, so no adapter ever has to defend itself and no key reaches a
 * provider that the database would refuse to store. (The tenant prefix rule - a key starts with
 * the company id - is the KYC category of STEP 104, which builds on this layer.)
 *
 * ## Why the audit never fails the operation
 *
 * An audit sink that is down must not stop a download the office needs; the entry is appended
 * best-effort and the operation answers. The access is still recorded in the provider's own logs;
 * what this layer guarantees is that it tried, exactly like the audit appends of the KYC services.
 *
 * ## The signed URL lifetime
 *
 * Section 21 says short-lived: the default is five minutes and the ceiling fifteen, and a caller
 * asking outside the bounds is refused rather than clamped, so a stale form is told it is stale.
 */

/** The audit action of an upload. */
export const FILE_UPLOADED_AUDIT_ACTION = "file.uploaded";

/** The audit action of a read access: a download or a minted signed URL. */
export const FILE_ACCESSED_AUDIT_ACTION = "file.accessed";

/** The audit action of a deletion. */
export const FILE_DELETED_AUDIT_ACTION = "file.deleted";

/** The audit entity type of every file access entry. */
export const FILE_AUDIT_ENTITY = "file";

/** The read operations the `file.accessed` entry records. */
export const FILE_ACCESS_OPERATIONS = ["download", "signed_url"] as const;

export type FileAccessOperation = (typeof FILE_ACCESS_OPERATIONS)[number];

/** Who the access is recorded for, and the `0057` row when the caller knows it. */
export interface FileAccessContext {
  readonly actorUserId: string | null;
  readonly companyId: string | null;
  readonly fileId?: string | null;
  readonly purpose?: string | null;
}

export interface StorageOperationDependencies {
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

function invalidInput(message: string): StorageError {
  return new StorageError("invalid_input", message);
}

/** Validate a bucket name against the `0057` rule. */
export function validateBucket(bucket: unknown): string {
  if (typeof bucket !== "string" || !BUCKET_NAME_PATTERN.test(bucket) || bucket.length < 3 || bucket.length > 63) {
    throw invalidInput("the bucket name is not a valid bucket name");
  }

  return bucket;
}

/** Validate an object key against the `0057` rule, plus the traversal refusals: no `..`, no empty segment. */
export function validateObjectKey(key: unknown): string {
  if (
    typeof key !== "string" ||
    key.length < 3 ||
    key.length > 512 ||
    !OBJECT_KEY_PATTERN.test(key) ||
    key.includes("..") ||
    key.includes("//") ||
    key.endsWith("/")
  ) {
    throw invalidInput("the object key is not a valid storage key");
  }

  return key;
}

/** Validate an object reference: bucket and key. */
export function validateObjectRef(ref: StorageObjectRef): StorageObjectRef {
  return { bucket: validateBucket(ref.bucket), key: validateObjectKey(ref.key) };
}

/** Validate the signed URL lifetime: within the bounds, or the default when absent. */
export function signedUrlTtlSeconds(expiresInSeconds: number | undefined): number {
  const ttl = expiresInSeconds === undefined ? SIGNED_URL_DEFAULT_TTL_SECONDS : expiresInSeconds;

  if (!Number.isInteger(ttl) || ttl < SIGNED_URL_MIN_TTL_SECONDS || ttl > SIGNED_URL_MAX_TTL_SECONDS) {
    throw invalidInput("the signed URL lifetime is outside the allowed bounds");
  }

  return ttl;
}

async function appendAccessTolerated(
  audit: AuditTrail,
  entry: Parameters<AuditTrail["append"]>[0],
): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the access it records.
  }
}

function accessPayload(
  ref: StorageObjectRef,
  access: FileAccessContext,
  extra: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    bucket: ref.bucket,
    key: ref.key,
    purpose: access.purpose ?? null,
    ...extra,
  };
}

/** Store the bytes through the adapter, audited `file.uploaded`. */
export async function uploadObject(
  adapter: StorageAdapter,
  input: StorageUploadInput,
  access: FileAccessContext,
  dependencies: StorageOperationDependencies,
): Promise<StoredObject> {
  const ref = validateObjectRef(input);

  if (!(input.bytes instanceof Uint8Array) || input.bytes.length < MIN_OBJECT_BYTES || input.bytes.length > MAX_OBJECT_BYTES) {
    throw invalidInput("the object size is outside the allowed bounds");
  }

  if (typeof input.contentType !== "string" || !CONTENT_TYPE_PATTERN.test(input.contentType)) {
    throw invalidInput("the content type is not a valid mime type");
  }

  const stored = await adapter.upload({ ...ref, bytes: input.bytes, contentType: input.contentType });

  await appendAccessTolerated(dependencies.audit, {
    action: FILE_UPLOADED_AUDIT_ACTION,
    actorUserId: access.actorUserId,
    entityType: FILE_AUDIT_ENTITY,
    entityId: access.fileId ?? null,
    companyId: access.companyId,
    sessionId: null,
    payload: accessPayload(ref, access, {
      provider: stored.provider,
      byte_size: stored.byteSize,
      content_type: input.contentType,
    }),
  });

  return stored;
}

/** Read the object back through the adapter, audited `file.accessed` with operation `download`. */
export async function downloadObject(
  adapter: StorageAdapter,
  ref: StorageObjectRef,
  access: FileAccessContext,
  dependencies: StorageOperationDependencies,
): Promise<Uint8Array> {
  const valid = validateObjectRef(ref);
  const bytes = await adapter.download(valid);

  await appendAccessTolerated(dependencies.audit, {
    action: FILE_ACCESSED_AUDIT_ACTION,
    actorUserId: access.actorUserId,
    entityType: FILE_AUDIT_ENTITY,
    entityId: access.fileId ?? null,
    companyId: access.companyId,
    sessionId: null,
    payload: accessPayload(valid, access, { operation: "download", byte_size: bytes.length }),
  });

  return bytes;
}

/** Mint a short-lived signed URL through the adapter, audited `file.accessed` with operation `signed_url`. */
export async function createFileSignedUrl(
  adapter: StorageAdapter,
  input: Omit<SignedUrlInput, "expiresInSeconds"> & { readonly expiresInSeconds?: number },
  access: FileAccessContext,
  dependencies: StorageOperationDependencies,
): Promise<SignedUrl> {
  const ref = validateObjectRef(input);
  const ttl = signedUrlTtlSeconds(input.expiresInSeconds);
  const signed = await adapter.createSignedUrl({ ...ref, expiresInSeconds: ttl });

  await appendAccessTolerated(dependencies.audit, {
    action: FILE_ACCESSED_AUDIT_ACTION,
    actorUserId: access.actorUserId,
    entityType: FILE_AUDIT_ENTITY,
    entityId: access.fileId ?? null,
    companyId: access.companyId,
    sessionId: null,
    payload: accessPayload(ref, access, { operation: "signed_url", expires_in_seconds: ttl, expires_at: signed.expiresAt }),
  });

  return signed;
}

/** The content type the encrypted envelope is uploaded as: the bytes are an envelope, not a document. */
export const ENCRYPTED_ENVELOPE_CONTENT_TYPE = "application/octet-stream";

function encryptionScopeOf(access: FileAccessContext): FileEncryptionScope {
  if (access.companyId === null || access.purpose === null || !UPLOAD_PURPOSES.includes(access.purpose as UploadPurpose)) {
    throw invalidInput("the encrypted operation needs the tenant id and a known upload purpose");
  }

  return { companyId: access.companyId, purpose: access.purpose as UploadPurpose };
}

export interface EncryptedUploadResult {
  /** What the adapter stored: provider, bucket, key, ciphertext size. */
  readonly stored: StoredObject;
  /** The quartet and hash STEP 103 writes into the `0057` record. */
  readonly sealed: SealedFile;
}

export interface EncryptedOperationDependencies extends StorageOperationDependencies {
  readonly encryption: StorageFileEncryption;
}

/**
 * Store the encrypted form of a file: the bytes are sealed with AES-256-GCM for the tenant and
 * purpose (section 21: "Every file is AES-256-GCM encrypted before upload") and only the envelope
 * reaches the adapter, uploaded as `application/octet-stream`. The audit entry carries the quartet
 * and the plaintext hash, so the access log says what was stored without ever holding the bytes.
 */
export async function uploadEncryptedObject(
  adapter: StorageAdapter,
  input: StorageUploadInput,
  access: FileAccessContext,
  dependencies: EncryptedOperationDependencies,
): Promise<EncryptedUploadResult> {
  const ref = validateObjectRef(input);

  if (typeof input.contentType !== "string" || !CONTENT_TYPE_PATTERN.test(input.contentType)) {
    throw invalidInput("the content type is not a valid mime type");
  }

  const scope = encryptionScopeOf(access);
  const sealed = dependencies.encryption.seal(input.bytes, scope);
  const stored = await adapter.upload({
    ...ref,
    bytes: sealed.envelope,
    contentType: ENCRYPTED_ENVELOPE_CONTENT_TYPE,
  });

  await appendAccessTolerated(dependencies.audit, {
    action: FILE_UPLOADED_AUDIT_ACTION,
    actorUserId: access.actorUserId,
    entityType: FILE_AUDIT_ENTITY,
    entityId: access.fileId ?? null,
    companyId: access.companyId,
    sessionId: null,
    payload: accessPayload(ref, access, {
      provider: stored.provider,
      byte_size: sealed.ciphertextBytes,
      content_type: input.contentType,
      encrypted: true,
      encryption_algorithm: sealed.algorithm,
      encryption_key_version: sealed.keyVersion,
      ciphertext_iv: sealed.iv,
      ciphertext_tag: sealed.tag,
      plaintext_sha256: sealed.plaintextSha256,
      plaintext_bytes: sealed.plaintextBytes,
    }),
  });

  return { stored, sealed };
}

/**
 * Read a stored file back and decrypt it. The object must be a well formed envelope whose plaintext
 * size is within the ceiling, and it is opened under the same tenant and purpose it was sealed for -
 * a ciphertext moved to another row fails the tag here, before any byte is returned. The access is
 * audited with the plaintext size, never the bytes.
 */
export async function downloadEncryptedObject(
  adapter: StorageAdapter,
  ref: StorageObjectRef,
  access: FileAccessContext,
  dependencies: EncryptedOperationDependencies,
): Promise<Uint8Array> {
  const valid = validateObjectRef(ref);
  const scope = encryptionScopeOf(access);
  const envelope = await adapter.download(valid);
  const info = readFileEnvelopeInfo(envelope);

  if (info === null || info.plaintextBytes > MAX_OBJECT_BYTES) {
    throw new StorageError("provider_error", "the stored object is not a readable encrypted envelope");
  }

  const plaintext = dependencies.encryption.open(envelope, scope);

  await appendAccessTolerated(dependencies.audit, {
    action: FILE_ACCESSED_AUDIT_ACTION,
    actorUserId: access.actorUserId,
    entityType: FILE_AUDIT_ENTITY,
    entityId: access.fileId ?? null,
    companyId: access.companyId,
    sessionId: null,
    payload: accessPayload(valid, access, {
      operation: "download",
      byte_size: plaintext.length,
      encrypted: true,
      encryption_key_version: info.keyId,
    }),
  });

  return plaintext;
}

/** Delete the object through the adapter, audited `file.deleted`. */
export async function deleteObject(
  adapter: StorageAdapter,
  ref: StorageObjectRef,
  access: FileAccessContext,
  dependencies: StorageOperationDependencies,
): Promise<void> {
  const valid = validateObjectRef(ref);

  await adapter.remove(valid);

  await appendAccessTolerated(dependencies.audit, {
    action: FILE_DELETED_AUDIT_ACTION,
    actorUserId: access.actorUserId,
    entityType: FILE_AUDIT_ENTITY,
    entityId: access.fileId ?? null,
    companyId: access.companyId,
    sessionId: null,
    payload: accessPayload(valid, access, {}),
  });
}
