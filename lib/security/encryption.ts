// path: lib/security/encryption.ts
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors/app-error.ts";

/**
 * AES-256-GCM for the two things this platform encrypts: secrets and files.
 *
 * ## Why a second format beside `lib/auth/secrets.ts`
 *
 * STEP 045 sealed the Turnstile secret and the TOTP seeds in the `v1.<iv>.<tag>.<ciphertext>` shape,
 * and that module keeps working unchanged. It has one gap this STEP exists to close: its envelope
 * names no key, so the day the master key is rotated every stored value becomes unopenable with no
 * way to tell which of them the new key wrote. This module stamps a **key id** into every envelope
 * and takes a keyring, so a rotation is "add the new key as primary, keep the old one as previous,
 * re-seal at leisure" rather than a guess.
 *
 * The two formats cannot be confused: this one is `kd1.<keyId>.<iv>.<tag>.<ciphertext>` and the old
 * one is `v1.<iv>.<tag>.<ciphertext>`, and the gate asserts that no module reads one as the other.
 *
 * ## What is authenticated, and not just encrypted
 *
 * GCM gives an authentication tag, and a tag over the *context* as well as the bytes is what makes a
 * ciphertext a value of exactly one place. The additional authenticated data is
 * `kd-aad-v1|<purpose>|<scope>`, so a provider key sealed for `company:<id>:taxcloud` cannot be
 * opened as if it were an email secret, and a file sealed for one tenant's invoice cannot be opened
 * under another's. Copying a ciphertext between rows therefore fails loudly instead of returning one
 * tenant's secret in another tenant's screen.
 *
 * ## Files: one header, many records
 *
 * A file is not one GCM record. It is a header and a sequence of 64 KiB chunks, each its own
 * AEAD record, because a 50 MB KYC scan will be streamed to object storage by the storage STEPs and
 * a single record would have to exist in memory in full at both ends. Every chunk authenticates the
 * header, its own position and whether it is the last one, so editing the size, reordering two
 * chunks, dropping the last chunk or appending a chunk all fail to open. The plaintext size lives in
 * the header and the total length is checked against it, which is what makes truncation detectable
 * without a trailing sentinel.
 *
 * ## The rules this module keeps in every failure
 *
 * The key is read from the environment by the caller and passed in - never read here, never cached in
 * module state, and zeroed after use - so a test, a job and a route all use the same code with the
 * same hygiene. Every failure is `INTERNAL_ERROR` with one machine reason in `cause` and nothing
 * else: no plaintext, no key, no ciphertext, and no difference between "wrong key" and "edited
 * bytes", because telling a caller which of the two it was is telling an attacker whether the key
 * they guessed is the right one.
 */

/** A key is 32 bytes, an initialisation vector 12, an authentication tag 16 - AES-256-GCM. */
export const ENCRYPTION_KEY_BYTES = 32;
export const ENCRYPTION_IV_BYTES = 12;
export const ENCRYPTION_TAG_BYTES = 16;

/** A key id is a label, not a secret: lower snake with dashes, two to thirty-two characters. */
export const ENCRYPTION_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/u;

/** The prefix of a stored secret, and the magic of a stored file. */
export const ENCRYPTION_SECRET_PREFIX = "kd1";
export const ENCRYPTION_FILE_MAGIC = "KDF1";
export const ENCRYPTION_FILE_VERSION = 1;

/** The separator of the additional authenticated data, and its own version. */
export const ENCRYPTION_AAD_PREFIX = "kd-aad-v1";
export const ENCRYPTION_AAD_SEPARATOR = "|";

/** The two things this platform encrypts. A purpose is not a free text field. */
export const ENCRYPTION_PURPOSES = Object.freeze(["secret", "file"] as const);

export type EncryptionPurpose = (typeof ENCRYPTION_PURPOSES)[number];

/** One chunk of a file. Small enough to stream, large enough that the tag overhead stays negligible. */
export const ENCRYPTION_CHUNK_BYTES = 65_536;

/**
 * The widest plaintext this module will encrypt: the `files_size_check` ceiling of `0057`.
 *
 * A file the storage layer could not store is a file this service should not seal, so the two
 * numbers are one number, and the gate reads the migration to keep them that way.
 */
export const ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES = 52_428_800;

/** The widest secret: a setting that needs more than eight kilobytes is a file, not a setting. */
export const ENCRYPTION_MAXIMUM_SECRET_BYTES = 8_192;

/** A scope is a name for where a value belongs, not a document: one line, bounded, no separator. */
export const ENCRYPTION_MAXIMUM_SCOPE_LENGTH = 200;

const maximumChunks = Math.ceil(ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES / ENCRYPTION_CHUNK_BYTES);

/**
 * The largest envelope this module can write, and therefore the largest it will ever read: a header,
 * the plaintext, and one tag per chunk. A reader compares the actual length against the length the
 * header implies, so a buffer that is longer than this is refused by that comparison rather than by a
 * second bound that could disagree with it.
 */
export const ENCRYPTION_MAXIMUM_ENVELOPE_BYTES =
  ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES + 64 + maximumChunks * ENCRYPTION_TAG_BYTES;

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/u;
const base64UrlPartPattern = /^[A-Za-z0-9_-]*$/u;
const scopePattern = /^[\x20-\x7e]+$/u;

/** Why an encryption did not happen. Machine reasons, never a sentence a client reads. */
export type EncryptionProblem =
  | "key_invalid"
  | "key_id_invalid"
  | "key_unknown"
  | "keyring_invalid"
  | "context_invalid"
  | "envelope_invalid"
  | "envelope_version"
  | "plaintext_too_large"
  | "secret_too_large"
  | "authentication_failed";

/** One key: a label an operator can read, and the base64 of the 32 bytes it names. */
export interface EncryptionKey {
  readonly id: string;
  readonly secret: string;
}

/**
 * The keyring: what new values are sealed with, and what old ones may still be opened with.
 *
 * During a rotation the new key is the primary and every key still in the data is in `previous`.
 * Nothing is re-sealed automatically: a value is re-sealed when it is next written, which is what
 * makes a rotation a deploy rather than a migration window.
 */
export interface EncryptionKeyring {
  readonly primary: EncryptionKey;
  readonly previous?: readonly EncryptionKey[];
}

/** Where a value belongs. The purpose is a vocabulary; the scope is a name the caller owns. */
export interface EncryptionContext {
  readonly purpose: EncryptionPurpose;
  readonly scope: string;
}

/** What a file envelope says about itself, without a key. */
export interface FileEnvelopeInfo {
  readonly keyId: string;
  readonly chunkBytes: number;
  readonly chunkCount: number;
  readonly plaintextBytes: number;
  readonly ciphertextBytes: number;
}

function encryptionFailure(reason: EncryptionProblem): AppError {
  return new AppError("INTERNAL_ERROR", { cause: { rule: "encryption", reason } });
}

/**
 * The 32 bytes a key names.
 *
 * The spelling is checked as strictly as the length: `Buffer.from(x, "base64")` ignores characters it
 * does not understand, so a key that is one character wrong can still decode to 32 bytes. Re-encoding
 * and comparing is what turns "almost the right key" into a refusal at boot rather than a warehouse
 * of values that cannot be opened.
 */
function decodeKey(secret: string): Buffer {
  if (!base64Pattern.test(secret)) {
    throw encryptionFailure("key_invalid");
  }

  const key = Buffer.from(secret, "base64");

  if (key.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw encryptionFailure("key_invalid");
  }

  if (key.toString("base64").replace(/=+$/u, "") !== secret.replace(/=+$/u, "")) {
    throw encryptionFailure("key_invalid");
  }

  return key;
}

/** A key id that can be written into an envelope and read back. */
export function isEncryptionKeyId(value: string): boolean {
  return ENCRYPTION_KEY_ID_PATTERN.test(value) && value.length <= 32;
}

/** True when a value is the base64 of exactly 32 bytes, in one spelling. */
export function isEncryptionKey(secret: string): boolean {
  try {
    decodeKey(secret).fill(0);

    return true;
  } catch {
    return false;
  }
}

/**
 * The keys of a keyring, primary first.
 *
 * A repeated id is refused rather than resolved: two keys with one label means one of them will
 * silently win, and which one wins decides whether the data is readable after a rotation.
 */
function keyringKeys(keyring: EncryptionKeyring): readonly EncryptionKey[] {
  const keys = [keyring.primary, ...(keyring.previous ?? [])];

  if (keys.length > 16) {
    throw encryptionFailure("keyring_invalid");
  }

  const ids = new Set<string>();

  for (const key of keys) {
    if (!isEncryptionKeyId(key.id)) {
      throw encryptionFailure("key_id_invalid");
    }

    if (key.secret.length === 0) {
      throw encryptionFailure("key_invalid");
    }

    if (ids.has(key.id)) {
      throw encryptionFailure("keyring_invalid");
    }

    ids.add(key.id);
  }

  return keys;
}

/** The bytes of one key of the ring. The caller must zero them when it is done. */
function keyFor(keyring: EncryptionKeyring, keyId: string): Buffer {
  const key = keyringKeys(keyring).find((candidate) => candidate.id === keyId);

  if (key === undefined) {
    throw encryptionFailure("key_unknown");
  }

  return decodeKey(key.secret);
}

/** The additional authenticated data of one context. */
export function encryptionAad(context: EncryptionContext): Buffer {
  return Buffer.from(
    [
      ENCRYPTION_AAD_PREFIX,
      context.purpose,
      context.scope,
    ].join(ENCRYPTION_AAD_SEPARATOR),
    "utf8",
  );
}

function requireContext(context: EncryptionContext): Buffer {
  if (!ENCRYPTION_PURPOSES.includes(context.purpose)) {
    throw encryptionFailure("context_invalid");
  }

  const scope = context.scope;

  if (
    scope.length < 1 ||
    scope.length > ENCRYPTION_MAXIMUM_SCOPE_LENGTH ||
    !scopePattern.test(scope) ||
    scope.includes(ENCRYPTION_AAD_SEPARATOR)
  ) {
    throw encryptionFailure("context_invalid");
  }

  return encryptionAad(context);
}

/** ---- Secrets: one value, one envelope, in a text column. */

/**
 * Seal one secret for one place.
 *
 * The envelope is `kd1.<keyId>.<iv>.<tag>.<ciphertext>`, every part base64url, so it survives a text
 * column, a CSV export and a JSON round trip without a second encoding. The plaintext never leaves
 * this function: it is turned into bytes, encrypted and dropped.
 */
export function sealSecret(
  keyring: EncryptionKeyring,
  plaintext: string,
  context: EncryptionContext,
): string {
  const aad = requireContext(context);
  const plaintextBytes = Buffer.from(plaintext, "utf8");

  if (plaintextBytes.byteLength > ENCRYPTION_MAXIMUM_SECRET_BYTES) {
    throw encryptionFailure("secret_too_large");
  }

  const keyId = keyring.primary.id;

  if (!isEncryptionKeyId(keyId)) {
    throw encryptionFailure("key_id_invalid");
  }

  const key = keyFor(keyring, keyId);

  try {
    const iv = randomBytes(ENCRYPTION_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: ENCRYPTION_TAG_BYTES });

    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);

    return [
      ENCRYPTION_SECRET_PREFIX,
      keyId,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  } finally {
    key.fill(0);
  }
}

/**
 * A base64url part that decodes to exactly the bytes it claims, in the one spelling this module
 * writes.
 *
 * The re-encode is the point. A base64url decoder ignores the spare bits of a final character, so
 * sixteen bytes travel in twenty-two characters of which the last one carries two useful bits:
 * without this check, four different envelopes would decode to the same tag and three of them would
 * open. An envelope whose every character means something is an envelope where an edit is either
 * malformed or caught by the tag.
 */
function isCanonicalBase64Url(value: string, bytes: number): boolean {
  if (!base64UrlPartPattern.test(value)) {
    return false;
  }

  const decoded = Buffer.from(value, "base64url");

  return decoded.byteLength === bytes && decoded.toString("base64url") === value;
}

/** The parts of a secret envelope, or null when the text is not one this module wrote. */
function readSecretEnvelope(text: string): { readonly keyId: string; readonly parts: readonly string[] } | null {
  const parts = text.split(".");

  if (parts.length !== 5 || parts[0] !== ENCRYPTION_SECRET_PREFIX) {
    return null;
  }

  const keyId = parts[1] ?? "";
  const iv = parts[2] ?? "";
  const tag = parts[3] ?? "";
  const ciphertext = parts[4] ?? "";

  if (!isEncryptionKeyId(keyId)) {
    return null;
  }

  if (!isCanonicalBase64Url(iv, ENCRYPTION_IV_BYTES) || !isCanonicalBase64Url(tag, ENCRYPTION_TAG_BYTES)) {
    return null;
  }

  if (!base64UrlPartPattern.test(ciphertext)) {
    return null;
  }

  if (Buffer.from(ciphertext, "base64url").toString("base64url") !== ciphertext) {
    return null;
  }

  if (Buffer.from(ciphertext, "base64url").byteLength > ENCRYPTION_MAXIMUM_SECRET_BYTES) {
    return null;
  }

  return { keyId, parts: [iv, tag, ciphertext] };
}

/** True when a value is a secret envelope this module can try to open. */
export function isSecretEnvelope(text: string): boolean {
  return readSecretEnvelope(text) !== null;
}

/** The key id a secret envelope names, or null. An operator can read it; it decides nothing alone. */
export function secretEnvelopeKeyId(text: string): string | null {
  return readSecretEnvelope(text)?.keyId ?? null;
}

/**
 * Open one secret, or fail without describing what was inside it.
 *
 * A wrong key, an edited byte, an envelope moved to another scope and an envelope moved to another
 * purpose all end in the same refusal, because the difference between them is a difference an
 * attacker would like to know.
 */
export function openSecret(
  keyring: EncryptionKeyring,
  envelope: string,
  context: EncryptionContext,
): string {
  const aad = requireContext(context);
  const parsed = readSecretEnvelope(envelope);

  if (parsed === null) {
    throw encryptionFailure("envelope_invalid");
  }

  const [iv, tag, ciphertext] = parsed.parts;
  const key = keyFor(keyring, parsed.keyId);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv ?? "", "base64url"), {
      authTagLength: ENCRYPTION_TAG_BYTES,
    });

    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag ?? "", "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext ?? "", "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw encryptionFailure("authentication_failed");
  } finally {
    key.fill(0);
  }
}

/** ---- Files: a header, then one AEAD record per chunk. */

function chunkCountOf(plaintextBytes: number): number {
  return Math.max(1, Math.ceil(plaintextBytes / ENCRYPTION_CHUNK_BYTES));
}

function buildHeader(keyId: string, plaintextBytes: number, baseIv: Buffer): Buffer {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const header = Buffer.alloc(26 + keyIdBytes.byteLength);

  header.write(ENCRYPTION_FILE_MAGIC, 0, "utf8");
  header.writeUInt8(ENCRYPTION_FILE_VERSION, 4);
  header.writeUInt8(keyIdBytes.byteLength, 5);
  keyIdBytes.copy(header, 6);
  header.writeUInt32BE(ENCRYPTION_CHUNK_BYTES, 6 + keyIdBytes.byteLength);
  header.writeUInt32BE(plaintextBytes, 10 + keyIdBytes.byteLength);
  baseIv.copy(header, 14 + keyIdBytes.byteLength);

  return header;
}

interface ParsedFileHeader {
  readonly keyId: string;
  readonly chunkBytes: number;
  readonly plaintextBytes: number;
  readonly chunkCount: number;
  readonly ciphertextBytes: number;
  readonly baseIv: Buffer;
  readonly header: Buffer;
}

/**
 * The header of a file envelope, checked rather than trusted.
 *
 * Everything a reader needs to decide whether the bytes could be an envelope is here, so a foreign
 * file, a truncated header, an unknown version and a size that contradicts the length are refused
 * before a key is looked up or a buffer is allocated.
 */
function readFileEnvelope(bytes: Buffer): ParsedFileHeader | null {
  if (bytes.byteLength < 26 + 2 + ENCRYPTION_TAG_BYTES) {
    return null;
  }

  if (bytes.toString("utf8", 0, 4) !== ENCRYPTION_FILE_MAGIC) {
    return null;
  }

  if (bytes.readUInt8(4) !== ENCRYPTION_FILE_VERSION) {
    return null;
  }

  const keyIdLength = bytes.readUInt8(5);

  if (keyIdLength < 2 || keyIdLength > 32) {
    return null;
  }

  const keyId = bytes.toString("utf8", 6, 6 + keyIdLength);

  if (!isEncryptionKeyId(keyId)) {
    return null;
  }

  const chunkBytes = bytes.readUInt32BE(6 + keyIdLength);

  if (chunkBytes !== ENCRYPTION_CHUNK_BYTES) {
    return null;
  }

  const plaintextBytes = bytes.readUInt32BE(10 + keyIdLength);

  const headerLength = 26 + keyIdLength;

  if (bytes.byteLength < headerLength) {
    return null;
  }

  const chunkCount = chunkCountOf(plaintextBytes);
  const expected = headerLength + plaintextBytes + chunkCount * ENCRYPTION_TAG_BYTES;

  if (bytes.byteLength !== expected) {
    return null;
  }

  return {
    keyId,
    chunkBytes,
    plaintextBytes,
    chunkCount,
    ciphertextBytes: plaintextBytes,
    baseIv: bytes.subarray(14 + keyIdLength, 26 + keyIdLength),
    header: bytes.subarray(0, headerLength),
  };
}

/** The nonce of one chunk: the base vector with the last four bytes carrying the position. */
function chunkNonce(baseIv: Buffer, counter: number): Buffer {
  const nonce = Buffer.from(baseIv);

  nonce.writeUInt32BE((nonce.readUInt32BE(8) ^ counter) >>> 0, 8);

  return nonce;
}

/**
 * What one chunk authenticates: the context and the whole header.
 *
 * Two of the three attacks on a file of chunks are answered by the two things this function does not
 * have to name. A chunk moved to another position fails because its **nonce** carries the position,
 * and no two positions of one file share a vector. A file cut short fails first because the header
 * states the plaintext size and the length is compared against it - and, if that header is edited to
 * match, because the edited header is no longer the one every remaining chunk was sealed under. That
 * is why the size is inside the association data rather than trusted from the length alone.
 */
function chunkAad(aad: Buffer, header: Buffer): Buffer {
  return Buffer.concat([aad, header]);
}

/** True when the bytes claim to be a file envelope, without a key. */
export function isFileEnvelope(envelope: Uint8Array): boolean {
  return readFileEnvelope(Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength)) !== null;
}

/** What a file envelope says about itself, or null when it is not one. */
export function readFileEnvelopeInfo(envelope: Uint8Array): FileEnvelopeInfo | null {
  const parsed = readFileEnvelope(
    Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength),
  );

  if (parsed === null) {
    return null;
  }

  return {
    keyId: parsed.keyId,
    chunkBytes: parsed.chunkBytes,
    chunkCount: parsed.chunkCount,
    plaintextBytes: parsed.plaintextBytes,
    ciphertextBytes: parsed.ciphertextBytes,
  };
}

/**
 * Encrypt one file for one place, in the envelope the storage layer uploads.
 *
 * The plaintext is read once and copied chunk by chunk into records, so the caller's buffer is never
 * modified and the result is a new array it owns. An empty file is one chunk with no ciphertext and
 * a real tag, which is what lets the storage layer tell "empty" from "unreadable".
 */
export function encryptFile(
  keyring: EncryptionKeyring,
  plaintext: Uint8Array,
  context: EncryptionContext,
): Uint8Array {
  const aad = requireContext(context);

  if (plaintext.byteLength > ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES) {
    throw encryptionFailure("plaintext_too_large");
  }

  const keyId = keyring.primary.id;

  if (!isEncryptionKeyId(keyId)) {
    throw encryptionFailure("key_id_invalid");
  }

  const key = keyFor(keyring, keyId);

  try {
    const baseIv = randomBytes(ENCRYPTION_IV_BYTES);
    const header = buildHeader(keyId, plaintext.byteLength, baseIv);
    const chunkCount = chunkCountOf(plaintext.byteLength);
    const parts: Buffer[] = [header];
    const body = Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);

    for (let index = 0; index < chunkCount; index += 1) {
      const counter = index + 1;
      const start = index * ENCRYPTION_CHUNK_BYTES;
      const end = Math.min(start + ENCRYPTION_CHUNK_BYTES, plaintext.byteLength);
      const cipher = createCipheriv("aes-256-gcm", key, chunkNonce(baseIv, counter), {
        authTagLength: ENCRYPTION_TAG_BYTES,
      });

      cipher.setAAD(chunkAad(aad, header));

      const ciphertext = Buffer.concat([cipher.update(body.subarray(start, end)), cipher.final()]);

      parts.push(cipher.getAuthTag(), ciphertext);
    }

    return new Uint8Array(Buffer.concat(parts));
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt one file envelope, or fail without describing what was inside it.
 *
 * The output buffer is allocated at the size the header states and returned only after every chunk
 * has authenticated, so a caller never receives the first half of a file whose second half was
 * edited.
 */
export function decryptFile(
  keyring: EncryptionKeyring,
  envelope: Uint8Array,
  context: EncryptionContext,
): Uint8Array {
  const aad = requireContext(context);
  const bytes = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const parsed = readFileEnvelope(bytes);

  if (parsed === null) {
    throw encryptionFailure("envelope_invalid");
  }

  const key = keyFor(keyring, parsed.keyId);

  try {
    const plaintext = Buffer.alloc(parsed.plaintextBytes);
    let offset = parsed.header.byteLength;

    for (let index = 0; index < parsed.chunkCount; index += 1) {
      const counter = index + 1;
      const tag = bytes.subarray(offset, offset + ENCRYPTION_TAG_BYTES);
      const start = index * ENCRYPTION_CHUNK_BYTES;
      const end = Math.min(start + ENCRYPTION_CHUNK_BYTES, parsed.plaintextBytes);
      const ciphertext = bytes.subarray(
        offset + ENCRYPTION_TAG_BYTES,
        offset + ENCRYPTION_TAG_BYTES + (end - start),
      );

      offset += ENCRYPTION_TAG_BYTES + ciphertext.byteLength;

      const decipher = createDecipheriv("aes-256-gcm", key, chunkNonce(parsed.baseIv, counter), {
        authTagLength: ENCRYPTION_TAG_BYTES,
      });

      decipher.setAAD(chunkAad(aad, parsed.header));
      decipher.setAuthTag(tag);

      const opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      if (opened.byteLength !== end - start) {
        throw encryptionFailure("authentication_failed");
      }

      opened.copy(plaintext, start);
    }

    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw encryptionFailure("authentication_failed");
  } finally {
    key.fill(0);
  }
}
