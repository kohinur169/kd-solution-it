// path: lib/auth/secrets.ts
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors/app-error.ts";

/**
 * AES-256-GCM for the one secret a route has to read: the Turnstile secret key.
 *
 * `public.platform_settings` stores a secret as three base64url parts - a 12 byte initialisation
 * vector, a 16 byte authentication tag and the ciphertext - and never as plaintext, because a
 * database dump must not hand anyone the key that decides whether a signup was human. The master
 * key is `ENCRYPTION_MASTER_KEY`, which lives in the environment and never in the database, so the
 * two halves of the secret are never in one place.
 *
 * The additional authenticated data binds a box to the setting it belongs to. A ciphertext copied
 * from one row to another therefore fails to open, which turns a database write into a loud
 * failure instead of a quiet substitution.
 *
 * A malformed key or an unopenable box is an `INTERNAL_ERROR`: the caller is a route, the cause is
 * a deployment, and no part of the failure describes the secret.
 */

export const SECRET_KEY_BYTES = 32;
export const SECRET_IV_BYTES = 12;
export const SECRET_TAG_BYTES = 16;

/** The shape a secret takes once it is stored. */
export interface SecretBox {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

/** True when three stored parts could be an AES-256-GCM box, before any key is involved. */
export function isSecretBox(value: {
  readonly iv: string | null;
  readonly tag: string | null;
  readonly ciphertext: string | null;
}): value is SecretBox {
  // The lengths are part of the shape: 12 bytes is 16 base64url characters and 16 bytes is 22, so a
  // row that is truncated or padded is caught here as bad data rather than inside the cipher.
  return (
    value.iv !== null &&
    value.tag !== null &&
    value.ciphertext !== null &&
    value.iv.length === 16 &&
    value.tag.length === 22 &&
    value.ciphertext.length >= 1 &&
    value.ciphertext.length <= 8_192 &&
    base64UrlPattern.test(value.iv) &&
    base64UrlPattern.test(value.tag) &&
    base64UrlPattern.test(value.ciphertext)
  );
}

function decodeMasterKey(masterKeyBase64: string): Buffer {
  let key: Buffer;

  try {
    key = Buffer.from(masterKeyBase64, "base64");
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }

  if (key.byteLength !== SECRET_KEY_BYTES) {
    throw new AppError("INTERNAL_ERROR");
  }

  return key;
}

/** Encrypt one value for one setting. */
export function sealSecret(
  masterKeyBase64: string,
  plaintext: string,
  context: string,
): SecretBox {
  const key = decodeMasterKey(masterKeyBase64);
  const iv = randomBytes(SECRET_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: SECRET_TAG_BYTES });

  cipher.setAAD(Buffer.from(context, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/**
 * Decrypt one stored box, or fail without describing what was inside it.
 *
 * GCM authenticates as it decrypts, so a changed ciphertext, a changed tag, a changed vector or a
 * box taken from another setting all end here rather than returning a value.
 */
export function openSecret(masterKeyBase64: string, box: SecretBox, context: string): string {
  const key = decodeMasterKey(masterKeyBase64);
  const iv = Buffer.from(box.iv, "base64url");
  const tag = Buffer.from(box.tag, "base64url");

  if (iv.byteLength !== SECRET_IV_BYTES || tag.byteLength !== SECRET_TAG_BYTES) {
    throw new AppError("INTERNAL_ERROR");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: SECRET_TAG_BYTES,
    });

    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(box.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    return plaintext;
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }
}
