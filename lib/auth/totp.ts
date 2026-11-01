// path: lib/auth/totp.ts
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time based one time passwords, RFC 6238, and the backup codes beside them.
 *
 * Section 22 makes 2FA mandatory for every account holding a role, and `0003` already gives the
 * account three columns for it: the sealed secret, the confirmation instant and the hashes of the
 * backup codes. This file is the arithmetic of that feature and nothing else: no database, no
 * request, no policy. A service decides when a code is checked and what a refusal means.
 *
 * ## The parameters, and why they are not tunable
 *
 * SHA-1, six digits, thirty seconds - the profile Google Authenticator, Authy, 1Password and every
 * other authenticator app default to. A deployment with different parameters would be a deployment
 * where the QR code works only in the app that made it, so the parameters travel in the
 * `otpauth://` URI as well and are still these.
 *
 * ## The window
 *
 * A code is accepted for one step on either side of the current one, because a phone's clock drifts
 * and a person types for a few seconds. Three steps is the usual compromise for a 30 second step:
 * wide enough for a slow typist, narrow enough that a code cannot be replayed a minute later. The
 * function returns which step matched so a caller can refuse to accept the same step twice, which is
 * STEP 042's business.
 *
 * ## Backup codes
 *
 * Ten single use codes of ten characters from an alphabet without look-alikes, generated from the
 * same random source as the secret. Only their hashes are stored, by `password.ts`'s scrypt
 * verifier, so a database dump does not yield a usable code. A code is normalised before it is
 * hashed, so a person who types it without the separator, in lower case or with a stray space still
 * gets in.
 */

/** Thirty second step, the value every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;

/** Six digits, the value every authenticator app assumes. */
export const TOTP_DIGITS = 6;

/** Steps on either side of the current one that are accepted. */
export const TOTP_ACCEPTED_WINDOW = 1;

/** Entropy of the shared secret: 160 bits, the RFC's recommended length for SHA-1. */
const secretBytes = 20;

/** Codes a person is given once, at enrolment. */
export const BACKUP_CODE_COUNT = 10;

/** Characters of one backup code, before the separator. */
const backupCodeLength = 5;

/** An alphabet with no 0/O or 1/I/L, because these are read off a screen and typed by hand. */
const backupAlphabet = "23456789abcdefghjkmnpqrstuvwxyz";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const codePattern = /^[0-9]{6}$/u;

/** A new shared secret, base32 encoded without padding, as an authenticator app expects it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(secretBytes));
}

export function base32Encode(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let output = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += base32Alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += base32Alphabet[(buffer << (5 - bits)) & 31];
  }

  return output;
}

/** Decode base32, or null when the text is not a base32 secret. */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/u, "").toUpperCase();

  if (clean.length === 0 || !/^[A-Z2-7]+$/u.test(clean)) {
    return null;
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of clean) {
    const value = base32Alphabet.indexOf(character);

    if (value < 0) {
      return null;
    }

    buffer = (buffer << 5) | value;
    bits += 5;

    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Uint8Array.from(bytes);
}

/** The step number of an instant. */
export function totpStep(epochMs: number): number {
  return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code of one step, six digits, zero padded. */
export function totpCodeForStep(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    ((digest[offset] as number) & 0x7f) * 0x1000000 +
    ((digest[offset + 1] as number) << 16) +
    ((digest[offset + 2] as number) << 8) +
    (digest[offset + 3] as number);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Check a code and answer the step it belongs to, or null.
 *
 * `null` covers three things on purpose: a code that is not six digits, a secret this build cannot
 * decode, and a code that matches no step in the window. A caller must not tell them apart, because
 * the first is a typo, the second is a broken row and the third is a wrong code, and only one of
 * those is the person's business.
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  epochMs: number,
  window: number = TOTP_ACCEPTED_WINDOW,
): number | null {
  const trimmed = code.trim();

  if (!codePattern.test(trimmed)) {
    return null;
  }

  const key = base32Decode(secret);

  if (key === null || key.byteLength === 0) {
    return null;
  }

  const current = totpStep(epochMs);
  const candidate = Buffer.from(trimmed, "utf8");
  let matched: number | null = null;

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;

    if (step < 0) {
      continue;
    }

    const expected = Buffer.from(totpCodeForStep(key, step), "utf8");

    // Constant time, and no early exit: the loop reads every step it says it reads.
    if (expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate)) {
      matched = step;
    }
  }

  return matched;
}

/** The URI an authenticator app reads out of the QR code. */
export function totpUri(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/** The secret in the four character groups a person types, for the manual entry path. */
export function formatSecretForEntry(secret: string): string {
  return secret.replace(/(.{4})/gu, "$1 ").trim();
}

/** One backup code, `xxxxx-xxxxx`. */
export function generateBackupCode(): string {
  let code = "";

  for (let index = 0; index < backupCodeLength * 2; index += 1) {
    code += backupAlphabet[randomBytes(1)[0] as number % backupAlphabet.length];
  }

  return `${code.slice(0, backupCodeLength)}-${code.slice(backupCodeLength)}`;
}

/** The codes of a fresh enrolment, in the order they are shown. */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): readonly string[] {
  return Array.from({ length: count }, () => generateBackupCode());
}

/**
 * Normalise a code a person typed.
 *
 * Lower case, spaces and the separator are forgiven, because none of them change which code was
 * meant, and a code that is refused for its punctuation is a support ticket. Anything else is left
 * as it is and will simply not match a stored hash.
 */
export function normalizeBackupCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/**
 * True when a typed value has the shape of a backup code, so a hash is never computed for junk.
 *
 * The separator is optional because a person reading a code off a screen often types it without
 * one; the length is not, because the hash comparison is against a ten character code and a value
 * of another length can only waste a scrypt run.
 */
export function isBackupCodeShaped(code: string): boolean {
  return /^[a-z0-9]{5}-?[a-z0-9]{5}$/u.test(code.trim().toLowerCase()) &&
    normalizeBackupCode(code).length === backupCodeLength * 2;
}
