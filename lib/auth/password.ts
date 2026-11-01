// path: lib/auth/password.ts
import { Buffer } from "node:buffer";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors/app-error.ts";

/**
 * The password verifier the platform stores in `public.users.password_hash`.
 *
 * `0003_users.sql` makes `password_hash` a required column and its comment says the auth STEP
 * supplies it, and `0079` takes one from the bootstrap operator. This file is that supplier for a
 * signup: scrypt with a per person salt, parameterised and self describing, so the row records what
 * produced it and a later cost increase can verify an old row instead of invalidating it.
 *
 * ## Why scrypt
 *
 * It is in the Node standard library, it is memory hard, and it needs no dependency that
 * `package.json` would have to accept. The parameters are stored in the string, and `verify`
 * accepts only the exact cost this build writes: a stored row cannot ask the process for an
 * unbounded amount of work, which is the denial of service a "parameters come from the hash" design
 * invites.
 *
 * ## What this file does not decide
 *
 * The full policy of section 22 - the length, the character classes, the breached password check
 * against a list - is STEP 040's. What is here is the shape a signup cannot proceed without: a
 * length floor, a ceiling so a form cannot be a payload, no copy of the address, no single repeated
 * character and no surrounding whitespace. STEP 040 replaces `assertPasswordAcceptable` with the
 * full check and keeps `hashPassword` and `verifyPasswordHash` as they are.
 */

export const PASSWORD_MINIMUM_LENGTH = 12;
export const PASSWORD_MAXIMUM_LENGTH = 128;

const saltLengthBytes = 16;
const derivedKeyLengthBytes = 32;
const costParameter = 16_384;
const blockSizeParameter = 8;
const parallelizationParameter = 1;
const memoryCeilingBytes = 64 * 1024 * 1024;

const algorithm = "scrypt";

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      derivedKeyLengthBytes,
      { N: costParameter, r: blockSizeParameter, p: parallelizationParameter, maxmem: memoryCeilingBytes },
      (error, derived) => {
        if (error !== null) {
          reject(new AppError("INTERNAL_ERROR"));

          return;
        }

        resolve(Buffer.from(derived));
      },
    );
  });
}

/** A detail a validation failure may carry: a field and a rule, never a value. */
function passwordFailure(rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: "password", rule }] });
}

/**
 * The shape a password must have before it is hashed.
 *
 * Each rule names itself in the failure detail, so the form of STEP 038 can point at the field
 * without the server ever describing the value it rejected.
 */
export function assertPasswordAcceptable(password: string, email: string): void {
  if (password.length < PASSWORD_MINIMUM_LENGTH) {
    throw passwordFailure("too_short");
  }

  if (password.length > PASSWORD_MAXIMUM_LENGTH) {
    throw passwordFailure("too_long");
  }

  if (password.trim() !== password) {
    throw passwordFailure("surrounding_whitespace");
  }

  const distinct = new Set(password);

  if (distinct.size < 4) {
    throw passwordFailure("too_repetitive");
  }

  const localPart = email.split("@", 1)[0]?.toLowerCase() ?? "";

  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    throw passwordFailure("contains_email_address");
  }
}

/** Hash one password into the self describing string `password_hash` holds. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltLengthBytes);
  const derived = await deriveKey(password, salt);

  return [
    algorithm,
    String(costParameter),
    String(blockSizeParameter),
    String(parallelizationParameter),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function parseStoredHash(stored: string): { salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");

  if (parts.length !== 6) {
    return null;
  }

  const [name, cost, blockSize, parallelization, saltText, hashText] = parts;

  if (
    name !== algorithm ||
    cost !== String(costParameter) ||
    blockSize !== String(blockSizeParameter) ||
    parallelization !== String(parallelizationParameter) ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return null;
  }

  const salt = Buffer.from(saltText, "base64url");
  const hash = Buffer.from(hashText, "base64url");

  if (salt.byteLength !== saltLengthBytes || hash.byteLength !== derivedKeyLengthBytes) {
    return null;
  }

  return { salt, hash };
}

/**
 * Verify a password against a stored hash.
 *
 * A row this build cannot parse is a `false` and not an exception: a caller is deciding whether a
 * person may sign in, and a broken row must not become a different error that reveals the row is
 * broken. The comparison is constant time, because a byte by byte comparison of a hash leaks how
 * much of a guess was correct.
 */
export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);

  if (parsed === null) {
    return false;
  }

  const candidate = await deriveKey(password, parsed.salt);

  return (
    candidate.byteLength === parsed.hash.byteLength &&
    timingSafeEqual(candidate, parsed.hash)
  );
}
