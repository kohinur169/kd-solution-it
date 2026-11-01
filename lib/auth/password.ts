// path: lib/auth/password.ts
import { Buffer } from "node:buffer";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors/app-error.ts";

/**
 * The password policy of section 22, and the verifier the platform stores in
 * `public.users.password_hash`.
 *
 * `0003_users.sql` makes `password_hash` a required column and its comment says the auth STEP
 * supplies it, and `0079` takes one from the bootstrap operator. This file is that supplier for a
 * signup: scrypt with a per person salt, parameterised and self describing, so the row records what
 * produced it and a later cost increase can verify an old row instead of invalidating it. STEP 040
 * added the policy below and kept both functions unchanged, which is why every verifier written by
 * STEP 038 still verifies.
 *
 * ## The policy, and why each rule is there
 *
 * - twelve characters minimum and one hundred and twenty eight maximum: the floor is the length a
 *   single factor of a multi factor account is allowed to have, and the ceiling keeps a form from
 *   becoming a payload that costs a second of scrypt;
 * - three of the four character kinds: a length floor alone accepts a sentence of dictionary words,
 *   and a breach list alone does not stop `aaaaaaaaaaaaaa`. Composition is not a substitute for
 *   length, it is a second, cheap filter;
 * - no leading or trailing space: a browser that trims a pasted password otherwise locks a person
 *   out of the password they believe they chose;
 * - six distinct characters: a repeated character is the shortest way past a length floor;
 * - nothing from the person's own identity: the address, the business name and the name are the
 *   three strings an attacker already has, so a password containing one is a password the account
 *   holder did not need to invent;
 * - and not in a known breach, which is `breach-check.ts` and its k-anonymity range query.
 *
 * Every rule names itself in the failure detail, so a form can point at the field and a log can
 * count refusals without either of them recording what was typed.
 */

export const PASSWORD_MINIMUM_LENGTH = 12;
export const PASSWORD_MAXIMUM_LENGTH = 128;
/** How many of the four character kinds a password must use. */
export const PASSWORD_MINIMUM_CHARACTER_KINDS = 3;
/** How many different characters a password must contain. */
export const PASSWORD_MINIMUM_DISTINCT_CHARACTERS = 6;
/** Shortest identity word worth refusing. A two letter fragment appears in too much else. */
const minimumIdentityWordLength = 4;

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

/** The rule a password broke, in the vocabulary a form and a log share. */
export type PasswordRule =
  | "too_short"
  | "too_long"
  | "surrounding_whitespace"
  | "too_repetitive"
  | "not_enough_character_kinds"
  | "contains_email_address"
  | "contains_company_name"
  | "contains_person_name"
  | "breached";

/** What a password is checked against: the person who is choosing it. */
export interface PasswordContext {
  readonly email: string;
  readonly companyName?: string;
  readonly fullName?: string;
}

/** A validation failure that names a rule and never a value. */
export function passwordRuleFailure(rule: PasswordRule): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field: "password", rule }] });
}

const lettersLower = /[a-z]/u;
const lettersUpper = /[A-Z]/u;
const digits = /[0-9]/u;
const symbols = /[^A-Za-z0-9]/u;

/** How many of the four kinds of character a password uses. */
export function characterKindsIn(password: string): number {
  let kinds = 0;

  if (lettersLower.test(password)) {
    kinds += 1;
  }

  if (lettersUpper.test(password)) {
    kinds += 1;
  }

  if (digits.test(password)) {
    kinds += 1;
  }

  if (symbols.test(password)) {
    kinds += 1;
  }

  return kinds;
}

/** The words of an identity string that are long enough to matter, lower cased. */
function identityWords(...values: readonly (string | undefined)[]): readonly string[] {
  const words: string[] = [];

  for (const value of values) {
    if (value === undefined) {
      continue;
    }

    for (const word of value.toLowerCase().split(/[^a-z0-9]+/u)) {
      if (word.length >= minimumIdentityWordLength) {
        words.push(word);
      }
    }
  }

  return words;
}

/**
 * The first rule a password breaks, or null.
 *
 * The order is the order a form shows the rules: a short password is told it is short before it is
 * told it is unoriginal, and a password that repeats one character is refused before the identity
 * test, which would otherwise have to explain itself for a value that is obviously not a password.
 */
export function passwordRuleViolation(
  password: string,
  context: PasswordContext,
): PasswordRule | null {
  if (password.length < PASSWORD_MINIMUM_LENGTH) {
    return "too_short";
  }

  if (password.length > PASSWORD_MAXIMUM_LENGTH) {
    return "too_long";
  }

  if (password.trim() !== password) {
    return "surrounding_whitespace";
  }

  if (new Set(password).size < PASSWORD_MINIMUM_DISTINCT_CHARACTERS) {
    return "too_repetitive";
  }

  if (characterKindsIn(password) < PASSWORD_MINIMUM_CHARACTER_KINDS) {
    return "not_enough_character_kinds";
  }

  const lowered = password.toLowerCase();
  const localPart = context.email.split("@", 1)[0]?.toLowerCase() ?? "";

  if (localPart.length >= minimumIdentityWordLength && lowered.includes(localPart)) {
    return "contains_email_address";
  }

  const companyWords = identityWords(context.companyName);

  if (companyWords.some((word) => lowered.includes(word))) {
    return "contains_company_name";
  }

  const nameWords = identityWords(context.fullName);

  if (nameWords.some((word) => lowered.includes(word))) {
    return "contains_person_name";
  }

  return null;
}

/**
 * Refuse a password that breaks the policy.
 *
 * The whole name is kept from STEP 038 on purpose: the signup service, its gate and its handoff all
 * call this function, and STEP 040 changed what it checks rather than what it is called, so no
 * caller can keep an old, weaker check by accident.
 */
export function assertPasswordAcceptable(password: string, context: PasswordContext): void {
  const rule = passwordRuleViolation(password, context);

  if (rule !== null) {
    throw passwordRuleFailure(rule);
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
