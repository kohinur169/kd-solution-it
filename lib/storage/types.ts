// path: lib/storage/types.ts

/**
 * The storage adapter port of FEATURE_LIST section 21: "Files live in object storage through the
 * storage adapter layer. Two adapters are built in: Supabase Storage and Amazon S3. The active
 * adapter is selected by environment configuration... Server-local disk is never used for stored
 * files." and "Downloads use short-lived signed URLs. Every file access is audit logged."
 *
 * This file is the port itself. It knows nothing about buckets' credentials, buckets' regions or
 * encryption - the adapters of STEP 101 implement the operations against Supabase Storage or S3,
 * the encryption of STEP 102 wraps the bytes before `upload` sees them, and the file record
 * service of STEP 103 writes the `0057` row. What this file owns is the shape every adapter must
 * satisfy and the error vocabulary every caller can rely on, so swapping the adapter never changes
 * a caller.
 *
 * ## The five operations
 *
 * `upload` stores bytes at one object key and answers what was stored; `download` reads them back;
 * `remove` deletes the object; `createSignedUrl` mints a short-lived URL for a direct download. All
 * four take a bucket plus a key, because one platform can serve several environments through
 * several buckets while the adapter itself stays one per provider.
 *
 * ## The errors
 *
 * `StorageError` carries a closed code, so a caller can tell "the object is not there" apart from
 * "the adapter is not wired up" apart from "the provider answered with something else" without
 * parsing a message. Anything the adapter cannot classify becomes `provider_error`; nothing is
 * ever retried or swallowed here.
 */

/** The adapter names section 21 names. `config/server.ts` validates the same pair from the environment. */
export const STORAGE_ADAPTER_NAMES = ["supabase", "s3"] as const;

export type StorageAdapterName = (typeof STORAGE_ADAPTER_NAMES)[number];

/** The error codes a storage operation can answer with. */
export const STORAGE_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "unavailable",
  "conflict",
  "provider_error",
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** The error every adapter throws; the service layer adds `invalid_input` for malformed refs. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** True when the value is a `StorageError` carrying a code from the vocabulary. */
export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError && STORAGE_ERROR_CODES.includes(value.code);
}

/** One stored object's address: the bucket and the key inside it. */
export interface StorageObjectRef {
  readonly bucket: string;
  readonly key: string;
}

/** The upload input: the address, the bytes and the content type the magic byte check agreed with. */
export interface StorageUploadInput extends StorageObjectRef {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** What an upload answers: the address plus the provider that holds it. */
export interface StoredObject extends StorageObjectRef {
  readonly provider: StorageAdapterName;
  readonly byteSize: number;
}

/** The signed URL input: the address and how long the URL may live. */
export interface SignedUrlInput extends StorageObjectRef {
  readonly expiresInSeconds: number;
}

/** A minted URL and the instant it stops working. */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * The adapter port: the five operations every object storage adapter implements. Implementations
 * are server only, never use local disk, and never log the bytes or the URL's signature material.
 */
export interface StorageAdapter {
  /** Which provider this adapter serves: `supabase` or `s3`. */
  readonly name: StorageAdapterName;
  /** Store the bytes at the key. Answers the stored object. */
  upload(input: StorageUploadInput): Promise<StoredObject>;
  /** Read the object back. `not_found` when the key does not exist. */
  download(ref: StorageObjectRef): Promise<Uint8Array>;
  /** Delete the object. `not_found` when the key does not exist; idempotent is allowed. */
  remove(ref: StorageObjectRef): Promise<void>;
  /** Mint a short-lived signed URL for a direct download. */
  createSignedUrl(input: SignedUrlInput): Promise<SignedUrl>;
}

/** The largest object the platform stores: 50 MB, the same ceiling `0057` sets on the record. */
export const MAX_OBJECT_BYTES = 52_428_800;

/** The smallest object: one byte. */
export const MIN_OBJECT_BYTES = 1;

/** The default lifetime of a signed URL: five minutes. */
export const SIGNED_URL_DEFAULT_TTL_SECONDS = 300;

/** The longest lifetime a signed URL may be minted with: fifteen minutes. Section 21 says short-lived. */
export const SIGNED_URL_MAX_TTL_SECONDS = 900;

/** The shortest lifetime: one second. */
export const SIGNED_URL_MIN_TTL_SECONDS = 1;

/** The shape of a bucket name, the same rule `0057` sets on the record. */
export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;

/** The shape of an object key, the same rule `0057` sets on the record: no `..`, no empty segment. */
export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** The shape of a content type, the same rule `0057` sets on the record. */
export const CONTENT_TYPE_PATTERN = /^[a-z]+\/[A-Za-z0-9.+-]+$/u;

/**
 * The purpose vocabulary of the `files` record: the five upload kinds of section 21 (`0057`) plus
 * the `cms_image` and `compliance_document` that `0058` added. The database check is the authority;
 * this list is its code mirror, and the record service and the encryption scope both validate
 * against it.
 */
export const FILE_PURPOSES = [
  "kyc_document",
  "company_logo",
  "invoice_pdf",
  "dispute_document",
  "support_attachment",
  "cms_image",
  "compliance_document",
] as const;

export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * The bucket the category flows store in when the provider is Supabase: the same name
 * `.env.example` sets `S3_BUCKET` to, so the S3 adapter's configured-bucket pin and the default
 * agree and one deployment stores in exactly one bucket per environment.
 */
export const DEFAULT_STORAGE_BUCKET = "kd-solution-it-files";

/**
 * The storage key extension each verified content type gets. The key is generated by the platform
 * from the detected type, never from the client's file name, and a type without an extension (svg
 * and the containers are refused before this point) has no entry here.
 */
export const STORAGE_EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** The extension of a verified content type, or undefined when the type gets no key extension. */
export function storageExtensionFor(contentType: string): string | undefined {
  return STORAGE_EXTENSION_BY_CONTENT_TYPE[contentType];
}

/** The status vocabulary of the `files` record, walked forward only by the `0057` guard. */
export const FILE_STATUSES = ["pending", "ready", "quarantined", "archived"] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];
