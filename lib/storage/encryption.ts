// path: lib/storage/encryption.ts
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { serverEnv } from "../env/server.ts";
import { AppError } from "../errors/app-error.ts";
import { UPLOAD_PURPOSES, type UploadPurpose } from "../security/upload.ts";
import {
  decryptFile,
  encryptFile,
  isEncryptionKey,
  isFileEnvelope,
  readFileEnvelopeInfo,
  ENCRYPTION_IV_BYTES,
  ENCRYPTION_TAG_BYTES,
  type EncryptionKeyring,
} from "../security/encryption.ts";
import { MAX_OBJECT_BYTES, MIN_OBJECT_BYTES, StorageError } from "./types.ts";

/**
 * The encryption half of FEATURE_LIST section 21: "Every file is AES-256-GCM encrypted before
 * upload." The cipher itself lives in `lib/security/encryption.ts` (the `KDF1` envelope: a header
 * plus one 64 KiB AEAD record per chunk, each authenticated under the file's context); what this
 * file owns is the wiring between that module and the storage port of STEP 100:
 *
 *   - the keyring built from the environment's `ENCRYPTION_MASTER_KEY` (key id `master-v1`,
 *     version 1 - the rotation a later day adds keys to the ring and bumps the version);
 *   - the additional authenticated data scope of a file, `file:<companyId>:<purpose>`, so a
 *     ciphertext sealed for one tenant's KYC document cannot be opened as another tenant's logo -
 *     moving it between rows fails the tag instead of returning the wrong bytes;
 *   - `sealFile`, which turns plaintext into the envelope the adapter uploads plus the quartet the
 *     `0057` record stores (`aes-256-gcm`, key version, the base64 IV, the base64 first-chunk tag)
 *     and the plaintext's SHA-256, so a restore can prove the object matches the row;
 *   - `openSealedFile`, which refuses anything that is not a well formed envelope and returns the
 *     plaintext only after every chunk has authenticated.
 *
 * ## What is stored where
 *
 * The provider holds only the envelope; the database holds the quartet and the hash, never the
 * ciphertext; the master key lives only in the environment. The IV and the tag in the record are not
 * secrets - they are what lets a reader check the envelope before decrypting a byte - so they are
 * safe to write next to the row and to read back in the gate.
 */

/** The only cipher section 21 allows, and the value of `files.encryption_algorithm`. */
export const FILE_ENCRYPTION_ALGORITHM = "aes-256-gcm";

/** The key id of the one master key, and the `files.encryption_key_version` it maps to. */
export const FILE_ENCRYPTION_KEY_ID = "master-v1";
export const FILE_ENCRYPTION_KEY_VERSION = 1;

/** The version suffix of a key id, `master-v12` -> 12. Refused outside the 1..999 of `0057`. */
const KEY_ID_VERSION_PATTERN = /-v([0-9]{1,3})$/u;

/** The environment field the keyring reads. `serverEnv()` satisfies it; the gate builds a fixture. */
export interface FileEncryptionEnvironment {
  readonly ENCRYPTION_MASTER_KEY: string;
}

/** The tenant and purpose a file is sealed for; both end up in the authenticated data. */
export interface FileEncryptionScope {
  readonly companyId: string;
  readonly purpose: UploadPurpose;
}

/** The environment-scoped keyring: the master key as the primary, no previous keys yet. */
export function fileEncryptionKeyring(environment: FileEncryptionEnvironment): EncryptionKeyring {
  if (!isEncryptionKey(environment.ENCRYPTION_MASTER_KEY)) {
    throw new Error("ENCRYPTION_MASTER_KEY is not the base64 of 32 bytes");
  }

  return { primary: { id: FILE_ENCRYPTION_KEY_ID, secret: environment.ENCRYPTION_MASTER_KEY } };
}

/** The key version a key id names, refused outside the 1..999 the record allows. */
export function keyVersionOfKeyId(keyId: string): number {
  const match = KEY_ID_VERSION_PATTERN.exec(keyId);
  const version = match === null ? Number.NaN : Number(match[1]);

  if (!Number.isInteger(version) || version < 1 || version > 999) {
    throw new Error(`the key id "${keyId}" names no version in 1..999`);
  }

  return version;
}

/** The AAD scope of one file. Both parts are validated so a malformed id can never reach the tag. */
export function fileEncryptionScope(scope: FileEncryptionScope): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(scope.companyId)) {
    throw new StorageError("invalid_input", "the encryption scope needs a company id");
  }

  if (!UPLOAD_PURPOSES.includes(scope.purpose)) {
    throw new StorageError("invalid_input", "the encryption scope needs a known upload purpose");
  }

  return `file:${scope.companyId}:${scope.purpose}`;
}

/** What `sealFile` answers: the envelope for the adapter and the quartet + hash for the record. */
export interface SealedFile {
  /** The bytes the storage adapter uploads. */
  readonly envelope: Uint8Array;
  /** `aes-256-gcm`, the value of `files.encryption_algorithm`. */
  readonly algorithm: string;
  /** The version the envelope's key id names, the value of `files.encryption_key_version`. */
  readonly keyVersion: number;
  /** Base64 of the 12-byte base IV of the envelope header, the value of `files.ciphertext_iv`. */
  readonly iv: string;
  /** Base64 of the first chunk's 16-byte tag, the value of `files.ciphertext_tag`. */
  readonly tag: string;
  /** Hex SHA-256 of the plaintext, the value of `files.content_sha256`. */
  readonly plaintextSha256: string;
  /** The plaintext size, the value of `files.byte_size`. */
  readonly plaintextBytes: number;
  /** The envelope size, what the provider actually stores. */
  readonly ciphertextBytes: number;
}

/**
 * Encrypt one file for one tenant and purpose. Refuses empty and over-ceiling plaintext before any
 * key is touched, then delegates to the `KDF1` envelope writer and reads the quartet back out of the
 * header it produced.
 */
export function sealFile(
  keyring: EncryptionKeyring,
  plaintext: Uint8Array,
  scope: FileEncryptionScope,
): SealedFile {
  if (plaintext.byteLength < MIN_OBJECT_BYTES || plaintext.byteLength > MAX_OBJECT_BYTES) {
    throw new StorageError("invalid_input", "the object size is outside the allowed bounds");
  }

  const aadScope = fileEncryptionScope(scope);
  const envelope = encryptFile(keyring, plaintext, { purpose: "file", scope: aadScope });
  const info = readFileEnvelopeInfo(envelope);

  if (info === null) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "storage_encryption", reason: "envelope_invalid" } });
  }

  // The header layout of the envelope: magic(4) version(1) keyIdLength(1) keyId chunkBytes(4)
  // plaintextBytes(4) baseIv(12). The IV and the first chunk tag sit right after it.
  const keyIdLength = envelope[5] ?? 0;
  const headerLength = 26 + keyIdLength;
  const baseIv = envelope.subarray(14 + keyIdLength, 14 + keyIdLength + ENCRYPTION_IV_BYTES);
  const firstTag = envelope.subarray(headerLength, headerLength + ENCRYPTION_TAG_BYTES);

  if (baseIv.length !== ENCRYPTION_IV_BYTES || firstTag.length !== ENCRYPTION_TAG_BYTES) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "storage_encryption", reason: "envelope_invalid" } });
  }

  return {
    envelope,
    algorithm: FILE_ENCRYPTION_ALGORITHM,
    keyVersion: keyVersionOfKeyId(info.keyId),
    iv: Buffer.from(baseIv).toString("base64"),
    tag: Buffer.from(firstTag).toString("base64"),
    plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
    plaintextBytes: plaintext.byteLength,
    ciphertextBytes: envelope.byteLength,
  };
}

/**
 * Decrypt one envelope for one tenant and purpose. Refuses a non-envelope before a key is looked
 * up; the plaintext is returned only after every chunk has authenticated under the scope.
 */
export function openSealedFile(
  keyring: EncryptionKeyring,
  envelope: Uint8Array,
  scope: FileEncryptionScope,
): Uint8Array {
  if (!isFileEnvelope(envelope)) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "storage_encryption", reason: "envelope_invalid" } });
  }

  const aadScope = fileEncryptionScope(scope);

  return decryptFile(keyring, envelope, { purpose: "file", scope: aadScope });
}

/** The seal/open pair the service layer takes as one dependency. */
export interface StorageFileEncryption {
  seal(plaintext: Uint8Array, scope: FileEncryptionScope): SealedFile;
  open(envelope: Uint8Array, scope: FileEncryptionScope): Uint8Array;
}

/** Build the encryption dependency from an explicit environment. */
export function createFileEncryption(environment: FileEncryptionEnvironment): StorageFileEncryption {
  const keyring = fileEncryptionKeyring(environment);

  return {
    seal: (plaintext, scope) => sealFile(keyring, plaintext, scope),
    open: (envelope, scope) => openSealedFile(keyring, envelope, scope),
  };
}

/** Build it from the validated environment. Server only: it reads the master key. */
export function createDefaultFileEncryption(): StorageFileEncryption {
  return createFileEncryption(serverEnv());
}
