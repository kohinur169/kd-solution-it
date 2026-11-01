// path: lib/auth/proof-key.ts
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The device proof key: the half that both the browser and the server may run.
 *
 * Section 22 (LR-022) asks for "per-device proof key" beside a session bound cookie, and
 * `0009_device_proof_keys.sql` is the row it becomes. What was missing was the key itself: a key
 * pair the browser generates, a private half no script can export, a public half the platform
 * stores, and one value - the fingerprint - that both sides agree on without ever sending the
 * private half anywhere.
 *
 * ## Why this module has no `node:crypto` and no DOM
 *
 * The same code has to run in three places and agree with itself in all three:
 *
 *   - the browser, which generates the pair and keeps it in IndexedDB;
 *   - the server, which recomputes the fingerprint from the public key before it stores it;
 *   - the gate, which runs *this* file under Node and compares its answers with the browser's.
 *
 * A second implementation on any of those three is a fingerprint that disagrees with the one in the
 * database, so the module is written against WebCrypto alone: `crypto.subtle` exists in every
 * browser the platform supports and in Node, and `btoa`/`atob` exist in both. The one thing that
 * cannot be shared - parsing DER with `createPublicKey` - lives in `device-enrolment.ts`, because a
 * browser must never be asked to decide whether a key is well formed.
 *
 * ## Why the fingerprint is over the canonical encoding
 *
 * The fingerprint `0009` stores is the base64url of the SHA-256 of the SPKI document. A key can
 * have more than one DER encoding of the same point, so the server re-exports the key it parsed and
 * hashes the bytes it produced, not the bytes it received. A client that sends a padded or
 * non-canonical string still ends up with the same row as the client that sent the canonical one.
 *
 * The digest is always SHA-256, whatever the algorithm, so the fingerprint is always 43 characters
 * of base64url - inside the `^[A-Za-z0-9_-]{43,128}$` check `0009` puts on the column.
 */

/** The proof key algorithms `0009`'s `device_proof_keys_algorithm_check` allows. */
export const PROOF_KEY_ALGORITHMS = deepFreeze(["ES256", "ES384", "EdDSA"] as const);

export type ProofKeyAlgorithm = (typeof PROOF_KEY_ALGORITHMS)[number];

/**
 * What a browser generates today.
 *
 * ES256 (ECDSA over P-256 with SHA-256) is the one every browser the platform supports can do
 * without a flag, and it is the one that costs least on a phone. The other two are accepted by the
 * server so a key generated elsewhere - a future native client - is not refused for its algorithm,
 * not because a browser is expected to choose them.
 */
export const DEFAULT_PROOF_KEY_ALGORITHM: ProofKeyAlgorithm = "ES256";

/** `0009`'s `device_proof_keys_public_key_check` bounds, restated so a caller can refuse early. */
export const PROOF_KEY_MINIMUM_LENGTH = 32;
export const PROOF_KEY_MAXIMUM_LENGTH = 512;

/** `0009`'s `device_proof_keys_label_check` bound, which is also the device label's ceiling. */
export const PROOF_KEY_LABEL_MAXIMUM_LENGTH = 80;

/** The `fingerprint` check of `0009`, written here so the client can refuse an answer it cannot use. */
export const PROOF_KEY_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const proofKeyAlgorithmSet: ReadonlySet<string> = new Set<string>(PROOF_KEY_ALGORITHMS);

/** True when a value is one of the three algorithms the column accepts. */
export function isProofKeyAlgorithm(value: unknown): value is ProofKeyAlgorithm {
  return typeof value === "string" && proofKeyAlgorithmSet.has(value);
}

/** True when a value has the shape `0009` accepts for a public key or a fingerprint. */
export function isPublicKeyShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= PROOF_KEY_MINIMUM_LENGTH &&
    value.length <= PROOF_KEY_MAXIMUM_LENGTH &&
    base64UrlPattern.test(value)
  );
}

/**
 * Base64url without padding, as `0009` and the fingerprint pattern both require.
 *
 * `btoa` is fed in chunks because the spread form overflows the call stack on a large input, and
 * this helper is also the one a later STEP will use for a signature. The padding is stripped rather
 * than kept: base64url in a URL, a header and a `check (… ~ '^[A-Za-z0-9_-]+$')` all agree only
 * without it.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The strict inverse of `encodeBase64Url`.
 *
 * Returns null rather than guessing: padding, `+`, `/`, whitespace and a length that cannot be
 * base64 are all answers the platform must not "repair", because a repaired key is a key it never
 * checked. A caller compares the re-encoded result with its input to know the string was canonical.
 */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (text.length === 0 || !base64UrlPattern.test(text) || text.length % 4 === 1) {
    return null;
  }

  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const withPadding = `${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`;

  let binary: string;

  try {
    binary = atob(withPadding);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * The fingerprint of a public key: base64url of the SHA-256 of its canonical SPKI bytes.
 *
 * The server feeds it the bytes it re-exported after parsing; the browser feeds it the bytes it
 * exported. Both are canonical SPKI, so both produce the row `0009`'s unique index compares.
 */
export async function proofKeyFingerprint(spkiBytes: Uint8Array): Promise<string> {
  // Copied into a plain buffer first: a view over a shared or pooled array is not a `BufferSource`
  // in every runtime, and a fingerprint is 32 bytes of copy.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(spkiBytes));

  return encodeBase64Url(new Uint8Array(digest));
}

/** A generated pair, plus the two values the platform stores and compares. */
export interface GeneratedProofKey {
  /** Non-extractable: the private half cannot be read out of the key object it lives in. */
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicKeyBase64Url: string;
  readonly fingerprint: string;
  readonly algorithm: ProofKeyAlgorithm;
}

/** The WebCrypto parameters of one algorithm, in the vocabulary `crypto.subtle` uses. */
interface AlgorithmParameters {
  readonly generate: AlgorithmIdentifier | EcKeyGenParams;
  readonly sign: AlgorithmIdentifier | EcdsaParams;
}

function algorithmParameters(algorithm: ProofKeyAlgorithm): AlgorithmParameters {
  switch (algorithm) {
    case "ES256":
      return {
        generate: { name: "ECDSA", namedCurve: "P-256" },
        sign: { name: "ECDSA", hash: "SHA-256" },
      };
    case "ES384":
      return {
        generate: { name: "ECDSA", namedCurve: "P-384" },
        sign: { name: "ECDSA", hash: "SHA-384" },
      };
    case "EdDSA":
      return { generate: { name: "Ed25519" }, sign: { name: "Ed25519" } };
  }
}

/** `generateKey` answers a pair for an asymmetric algorithm; this narrows the two in one answer. */
function isKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return "privateKey" in value;
}

/**
 * Generate a proof key pair for this device.
 *
 * `extractable: false` is the point of the function: the private key is created inside WebCrypto and
 * can never be exported, so a script that reaches the page - or a copy of the IndexedDB database -
 * finds a key it can use only through the same origin's WebCrypto, not bytes it can carry away. The
 * public key of an asymmetric pair is always extractable, which is why the export below works on a
 * non-extractable pair.
 *
 * A browser without WebCrypto, with an insecure context, or without the curve throws: the caller
 * treats that as "this device cannot prove itself yet", which is why STEP 049 lets a sign in finish
 * without a key instead of failing.
 */
export async function generateProofKeyPair(
  algorithm: ProofKeyAlgorithm = DEFAULT_PROOF_KEY_ALGORITHM,
): Promise<GeneratedProofKey> {
  const parameters = algorithmParameters(algorithm);
  const generated = await crypto.subtle.generateKey(parameters.generate, false, ["sign", "verify"]);

  if (!isKeyPair(generated)) {
    throw new TypeError("the provider answered a single key, not a pair");
  }

  const pair = generated;

  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));

  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyBase64Url: encodeBase64Url(spki),
    fingerprint: await proofKeyFingerprint(spki),
    algorithm,
  };
}

/**
 * A proof key pair as the browser keeps it: the pair, the two agreed values, and what the platform
 * said about the device.
 *
 * `deviceId` and `trusted` are null and false until the server has answered, because a device is not
 * enrolled until a row exists, and section 22 makes it not trusted until STEP 052's confirmation.
 */
export interface StoredProofKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicKeyBase64Url: string;
  readonly fingerprint: string;
  readonly algorithm: ProofKeyAlgorithm;
  readonly deviceId: string | null;
  readonly trusted: boolean;
  readonly createdAtEpochMs: number;
}

/**
 * A device label the column will accept.
 *
 * `0009` requires `label = btrim(label)` and a length of 1 to 80, and the derived label from a user
 * agent is already inside that - but the trim and the cut are here because a later STEP lets the
 * owner name a device, and one function that both writes obey is one place the constraint can be
 * broken. Trimming again after the cut matters: a cut that lands on a space would leave one.
 */
export function proofKeyLabel(label: string): string {
  const trimmed = label.trim().slice(0, PROOF_KEY_LABEL_MAXIMUM_LENGTH).trim();

  return trimmed.length === 0 ? "an unknown device" : trimmed;
}

/** The value the platform stores and the browser sends: the public half and its algorithm. */
export interface PublicProofKey {
  readonly publicKey: string;
  readonly algorithm: ProofKeyAlgorithm;
}

/** The public half of a pair, in the shape the enrolment endpoint accepts. */
export function publicProofKeyOf(
  key: Pick<StoredProofKey, "publicKeyBase64Url" | "algorithm">,
): PublicProofKey {
  return { publicKey: key.publicKeyBase64Url, algorithm: key.algorithm };
}

/**
 * True when a value read back from storage is still the record this module wrote.
 *
 * Storage is a place another version of the platform, or a person with developer tools, may have
 * written to. A record that fails this check is discarded and a new pair is generated: refusing to
 * sign with a half understood key is the safer of the two mistakes.
 */
export function isStoredProofKey(value: unknown): value is StoredProofKey {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<Record<keyof StoredProofKey, unknown>>;

  return (
    candidate.privateKey instanceof Object &&
    "usages" in candidate.privateKey &&
    candidate.publicKey instanceof Object &&
    "usages" in candidate.publicKey &&
    isPublicKeyShape(candidate.publicKeyBase64Url) &&
    typeof candidate.fingerprint === "string" &&
    PROOF_KEY_FINGERPRINT_PATTERN.test(candidate.fingerprint) &&
    isProofKeyAlgorithm(candidate.algorithm) &&
    (candidate.deviceId === null || typeof candidate.deviceId === "string") &&
    typeof candidate.trusted === "boolean" &&
    typeof candidate.createdAtEpochMs === "number"
  );
}
