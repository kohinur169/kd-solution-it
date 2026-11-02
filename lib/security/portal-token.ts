// path: lib/security/portal-token.ts
import { Buffer } from "node:buffer";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { deepFreeze } from "../utils/freeze.ts";
import { decodeCanonicalBase64Url, isEncryptionKey } from "./encryption.ts";

/**
 * The signed link a client follows: `kdpt1.<payload>.<signature>`.
 *
 * ## What a portal link is
 *
 * FEATURE_LIST section 2 says a client has "tokenized link access only under i/[token] and
 * e/[token], no login", and section 16 says tokenized links open invoices and estimates for
 * clients. So the link itself is the whole credential: whoever holds it reads one invoice or one
 * estimate, and nobody is signed in by following it. This module is the only place that mints and
 * reads such a link, so the claims, the clock and the revocation rule are one implementation
 * rather than three route-level opinions.
 *
 * ## Signed, not encrypted
 *
 * The link is handed to a client and travels in a mail and a browser history, so it holds nothing
 * secret: an invoice id is not a password. What it must not allow is *invention* - a client who
 * edits `invoice` to `payment_link`, or one company's id to another's, would otherwise reach a
 * document it was never sent. The signature over the whole payload is what makes every claim
 * unforgeable, and the payload is readable so the portal route can route on it without a database
 * round trip.
 *
 * ## Expiry is a ceiling, not a field
 *
 * A caller asks for a link that lives a number of seconds, never one that expires on a date, so no
 * call site can mint a link that outlives this platform's patience. The lifetime is bounded on the
 * way in *and* on the way out: a token whose signed span is longer than the ceiling is refused when
 * it is read even if the signature verifies, because the rule has to survive a future caller with a
 * different copy of it. Expiry is compared against a clock the caller passes in - never `Date.now()`
 * inside this module - so the gate can stand exactly on the boundary, and a job that re-issues a
 * link can be tested without waiting.
 *
 * ## Revocation is a lookup, not a list in memory
 *
 * A link is revoked when a merchant voids an invoice, reissues one, or a client asks for a fresh
 * one, and the record of that belongs in the database of the STEP that owns the document, not here.
 * This module therefore takes a predicate. It is called *after* the signature verifies and after the
 * token is known to be in date, so a forged id, an edited id and an expired id never reach a store,
 * which is what keeps a public route from being a free query oracle. The store this platform keeps
 * will hold `portalTokenDigest()` and the id, never the token itself, because a database that holds
 * the token is a database that can be used to read the invoice it names.
 *
 * ## The key
 *
 * `ENCRYPTION_MASTER_KEY` is the only long lived secret this platform puts in the environment, so
 * the signing key is derived from it with HKDF-SHA-256 and its own info string - the same pattern
 * STEP 037 used for the session cookie, with a different info string so one secret cannot stand in
 * for the purpose of the other. The key ring accepts the previous master key during a rotation: a
 * link minted a minute before a key change still opens, and nothing is re-signed in the database
 * because a link is not stored.
 *
 * There is deliberately no reader that returns claims without verifying a signature. A shape only
 * reader is the kind of convenience that later becomes an authorization decision.
 */

/** The header a portal token starts with, and the version inside it. */
export const PORTAL_TOKEN_PREFIX = "kdpt";
export const PORTAL_TOKEN_VERSION = 1;

/** A signature is HMAC-SHA-256: thirty-two bytes. */
export const PORTAL_TOKEN_SIGNATURE_BYTES = 32;

/** A link id is sixteen random bytes, which is 22 base64url characters. */
export const PORTAL_TOKEN_ID_BYTES = 16;

/** The versioned prefix of a stored digest, so a digest column and a token cannot be confused. */
export const PORTAL_TOKEN_DIGEST_PREFIX = "kdpd1";

/** The HKDF info string of the signing key, exported so the gate can derive the same key. */
export const PORTAL_TOKEN_SIGNING_INFO = "kd-portal-token:v1";

/** Bytes of derived key the HMAC uses. */
export const PORTAL_TOKEN_KEY_BYTES = 32;

/**
 * The payload ceiling, and therefore the ceiling on a token.
 *
 * A header, a payload of at most 683 base64url characters and a signature of 43 is 732 characters,
 * so bounding the payload bounds the link - a second constant for the whole string would be a bound
 * that can never be the one that refuses anything. The reason is its own, distinct from a malformed
 * token, because it is a different fact about what arrived.
 */
export const PORTAL_TOKEN_MAXIMUM_PAYLOAD_BYTES = 512;

/** The shortest link this platform will mint: five minutes is a mail that is still being written. */
export const PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS = 300;

/** The longest: thirty days. A link a client forgot about is a link that should have expired. */
export const PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS = 2_592_000;

/** How far ahead of the caller's clock a token may claim to have been issued. */
export const PORTAL_TOKEN_CLOCK_SKEW_SECONDS = 60;

/** Master keys tried during a rotation: the current one and at most three retired ones. */
export const PORTAL_TOKEN_MAXIMUM_KEYS = 4;

/** The newest instant a claim may name: 2100-01-01, far past any lifetime this module allows. */
const maximumEpochSeconds = 4_102_444_800;

/** What a link opens. A kind is a vocabulary, never a free text field. */
export const PORTAL_TOKEN_KINDS = deepFreeze(["invoice", "estimate", "payment_link"] as const);

export type PortalTokenKind = (typeof PORTAL_TOKEN_KINDS)[number];

/** What the holder may do. `pay` is money, `sign` is a signature, `view` is reading. */
export const PORTAL_TOKEN_CAPABILITIES = deepFreeze(["view", "pay", "sign"] as const);

export type PortalTokenCapability = (typeof PORTAL_TOKEN_CAPABILITIES)[number];

/**
 * Which capability belongs to which kind.
 *
 * An estimate is signed, an invoice is paid, a payment link is paid. A token that pairs one kind
 * with another kind's capability is refused when it is minted and again when it is read, so a
 * future mint path cannot widen the table by forgetting it.
 */
export const PORTAL_TOKEN_CAPABILITIES_BY_KIND = deepFreeze({
  invoice: ["view", "pay"],
  estimate: ["view", "sign"],
  payment_link: ["view", "pay"],
} as const);

/** Why a portal token cannot be minted or read. Machine reasons, never a sentence a client reads. */
export const PORTAL_TOKEN_PROBLEMS = deepFreeze([
  "key_invalid",
  "keyring_invalid",
  "request_invalid",
  "token_invalid",
  "payload_too_large",
  "token_version",
  "signature_invalid",
  "lifetime_invalid",
  "token_not_yet_valid",
  "token_expired",
  "token_revoked",
  "audience_mismatch",
] as const);

export type PortalTokenProblem = (typeof PORTAL_TOKEN_PROBLEMS)[number];

/** The master keys a token may have been signed with. `primary` mints, all of them verify. */
export interface PortalTokenKeys {
  readonly primary: string;
  readonly previous?: readonly string[];
}

/** What a caller asks for. It names a lifetime, never an expiry date. */
export interface PortalTokenRequest {
  readonly kind: PortalTokenKind;
  readonly companyId: string;
  readonly resourceId: string;
  readonly capability: PortalTokenCapability;
  readonly lifetimeSeconds: number;
}

export interface PortalTokenMintOptions {
  readonly keys: PortalTokenKeys;
  /** Epoch seconds. Passed in so the module has no clock of its own. */
  readonly now: number;
  /**
   * The link id, when the caller must know it before the link exists.
   *
   * A portal row is written first and shared afterwards, so the id is generated by the route that
   * writes the row. When it is absent this module generates one.
   */
  readonly tokenId?: string;
}

/** What the reader requires of the token it was given. Every field is compared exactly. */
export interface PortalTokenExpectation {
  readonly kind?: PortalTokenKind;
  readonly companyId?: string;
  readonly resourceId?: string;
  readonly capability?: PortalTokenCapability;
}

/** The revocation lookup. Called only after the signature and the clock have passed. */
export interface PortalTokenRevocations {
  readonly isRevoked: (tokenId: string) => boolean;
}

export interface PortalTokenOpenOptions {
  readonly keys: PortalTokenKeys;
  /** Epoch seconds. */
  readonly now: number;
  readonly expect?: PortalTokenExpectation;
  readonly revocations?: PortalTokenRevocations;
}

/** The claims of a link whose signature verified. */
export interface PortalTokenClaim {
  readonly version: number;
  readonly kind: PortalTokenKind;
  readonly companyId: string;
  readonly resourceId: string;
  readonly capability: PortalTokenCapability;
  readonly tokenId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const base64UrlPartPattern = /^[A-Za-z0-9_-]*$/u;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const tokenIdPattern = /^[A-Za-z0-9_-]{22}$/u;

const headerPattern = new RegExp(`^${PORTAL_TOKEN_PREFIX}[0-9]+$`, "u");

const currentHeader = `${PORTAL_TOKEN_PREFIX}${PORTAL_TOKEN_VERSION}`;

/**
 * The payload schema, strict.
 *
 * Strict because an extra field is a field the signature covers and no reader uses - exactly the
 * shape of a claim someone is trying to smuggle past a later reader. Every field is bounded here as
 * well as by the rule that uses it, so a token that decodes to a well formed but impossible claim is
 * refused before it reaches a comparison.
 */
const claimSchema = z
  .object({
    version: z.literal(PORTAL_TOKEN_VERSION),
    kind: z.enum(PORTAL_TOKEN_KINDS),
    companyId: z.string().regex(uuidPattern),
    resourceId: z.string().regex(uuidPattern),
    capability: z.enum(PORTAL_TOKEN_CAPABILITIES),
    tokenId: z.string().regex(tokenIdPattern),
    issuedAt: z.number().int().min(0).max(maximumEpochSeconds),
    expiresAt: z.number().int().min(0).max(maximumEpochSeconds),
  })
  .strict();

const kindSet: ReadonlySet<string> = new Set<string>(PORTAL_TOKEN_KINDS);
const capabilitySet: ReadonlySet<string> = new Set<string>(PORTAL_TOKEN_CAPABILITIES);

/** True when a value names a kind of link this platform mints. */
export function isPortalTokenKind(value: unknown): value is PortalTokenKind {
  return typeof value === "string" && kindSet.has(value);
}

/** True when a value names a capability this platform grants. */
export function isPortalTokenCapability(value: unknown): value is PortalTokenCapability {
  return typeof value === "string" && capabilitySet.has(value);
}

/**
 * A token failure: the link the visitor presented is not one this platform will honour.
 *
 * Every failure of an open is `RESOURCE_NOT_FOUND`, whatever the reason, because a visitor who can
 * tell "wrong signature" from "expired" from "revoked" by the response alone has a probe for which
 * ids exist. The reason travels in `cause` for the log and for the route that renders "this link
 * has expired" once the claim is trusted.
 */
function tokenFailure(reason: PortalTokenProblem): AppError {
  return new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "portal_token", reason } });
}

/** A configuration failure: a key, a key ring or a mint request this platform wrote wrongly. */
function configurationFailure(reason: PortalTokenProblem): AppError {
  return new AppError("INTERNAL_ERROR", { cause: { rule: "portal_token", reason } });
}

/**
 * One signing key, derived from one master key.
 *
 * A short key, a key that is not base64 and a key with a second spelling are the same failure: this
 * module never says which master key was wrong, because at boot the operator knows and at request
 * time nobody should.
 */
function deriveSigningKey(master: string): Buffer {
  if (!isEncryptionKey(master)) {
    throw configurationFailure("key_invalid");
  }

  const bytes = Buffer.from(master, "base64");

  try {
    return Buffer.from(
      hkdfSync("sha256", bytes, Buffer.alloc(0), PORTAL_TOKEN_SIGNING_INFO, PORTAL_TOKEN_KEY_BYTES),
    );
  } finally {
    bytes.fill(0);
  }
}

/** The keys of one call: what mints, and everything that may still verify a link. */
interface PortalTokenSigningKeys {
  readonly primary: Buffer;
  readonly all: readonly Buffer[];
}

/**
 * The signing keys of one call: the primary that mints, and every key that may still verify.
 *
 * A ring with more masters than a rotation needs, or with one master twice, is refused rather than
 * resolved: two copies of one key means a rotation that quietly verifies with the wrong one. Every
 * derived key is wiped in the `finally`, so a thrown token failure leaves no key material behind.
 */
function withSigningKeys<TValue>(
  keys: PortalTokenKeys,
  action: (signing: PortalTokenSigningKeys) => TValue,
): TValue {
  const previous = keys.previous ?? [];

  const masters = [keys.primary, ...previous];

  if (masters.length > PORTAL_TOKEN_MAXIMUM_KEYS || new Set(masters).size !== masters.length) {
    throw configurationFailure("keyring_invalid");
  }

  const derived: Buffer[] = [];

  try {
    const primary = deriveSigningKey(keys.primary);

    derived.push(primary);

    for (const master of previous) {
      derived.push(deriveSigningKey(master));
    }

    return action({ primary, all: derived });
  } finally {
    for (const key of derived) {
      key.fill(0);
    }
  }
}

/** The clock, from whichever side of the call it came. A caller that passes nonsense is a bug. */
function requireClock(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximumEpochSeconds) {
    throw configurationFailure("request_invalid");
  }

  return value;
}

interface ParsedPortalToken {
  readonly header: string;
  readonly payloadText: string;
  readonly signature: Buffer;
  readonly signed: Buffer;
}

/**
 * The three parts of a token, before any key is involved.
 *
 * The order of the checks is the order of the cost: a string that is not a token at all is refused
 * by length and by its three parts, a token of another version is refused as such, and only a token
 * of this version is decoded. Nothing here is an authorization decision - the signature is.
 */
function parsePortalToken(token: string): ParsedPortalToken {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw tokenFailure("token_invalid");
  }

  const header = parts[0] ?? "";

  if (!headerPattern.test(header)) {
    throw tokenFailure("token_invalid");
  }

  if (header !== currentHeader) {
    throw tokenFailure("token_version");
  }

  const payloadPart = parts[1] ?? "";
  const signaturePart = parts[2] ?? "";

  if (!base64UrlPartPattern.test(payloadPart) || !base64UrlPartPattern.test(signaturePart)) {
    throw tokenFailure("token_invalid");
  }

  const payload = decodeCanonicalBase64Url(payloadPart);

  if (payload === null || payload.byteLength === 0) {
    throw tokenFailure("token_invalid");
  }

  if (payload.byteLength > PORTAL_TOKEN_MAXIMUM_PAYLOAD_BYTES) {
    throw tokenFailure("payload_too_large");
  }

  const payloadText = payload.toString("utf8");

  // A buffer that decodes to invalid UTF-8 becomes replacement characters, which no payload this
  // module writes can contain, so re-encoding and comparing is the validity check.
  if (!Buffer.from(payloadText, "utf8").equals(payload)) {
    throw tokenFailure("token_invalid");
  }

  const signature = decodeCanonicalBase64Url(signaturePart);

  if (signature === null || signature.byteLength !== PORTAL_TOKEN_SIGNATURE_BYTES) {
    throw tokenFailure("token_invalid");
  }

  return {
    header,
    payloadText,
    signature,
    signed: Buffer.from(`${header}.${payloadPart}`, "utf8"),
  };
}

/** The HMAC of one token over one key: the header and the payload exactly as they travel. */
function sign(signed: string | Buffer, key: Buffer): Buffer {
  return createHmac("sha256", key).update(signed).digest();
}

/** The claims of a token whose signature has already verified. */
function readClaim(payloadText: string): PortalTokenClaim {
  let raw: unknown;

  try {
    raw = JSON.parse(payloadText);
  } catch {
    throw tokenFailure("token_invalid");
  }

  const parsed = claimSchema.safeParse(raw);

  if (!parsed.success) {
    throw tokenFailure("token_invalid");
  }

  const claim: PortalTokenClaim = {
    version: parsed.data.version,
    kind: parsed.data.kind,
    companyId: parsed.data.companyId,
    resourceId: parsed.data.resourceId,
    capability: parsed.data.capability,
    tokenId: parsed.data.tokenId,
    issuedAt: parsed.data.issuedAt,
    expiresAt: parsed.data.expiresAt,
  };

  // One payload, one spelling. The signature covers the bytes that arrived, so a second spelling of
  // the same claims would be a second token for one link - and the store that revokes a digest would
  // then revoke one of them. Rebuilding the object in the schema's order and comparing turns any
  // reordering, any `1e3` for `1000` and any whitespace into the refusal it is.
  if (JSON.stringify(claim) !== payloadText) {
    throw tokenFailure("token_invalid");
  }

  if (decodeCanonicalBase64Url(claim.tokenId) === null) {
    throw tokenFailure("token_invalid");
  }

  const allowed: readonly string[] = PORTAL_TOKEN_CAPABILITIES_BY_KIND[claim.kind];

  if (!allowed.includes(claim.capability)) {
    throw tokenFailure("token_invalid");
  }

  const lifetime = claim.expiresAt - claim.issuedAt;

  if (lifetime < PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS || lifetime > PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS) {
    throw tokenFailure("lifetime_invalid");
  }

  return claim;
}

/**
 * Mint one link.
 *
 * The claim is built here field by field so its serialisation is a property of this module and not
 * of the object literal a caller passed, and the signature is over the exact header and payload that
 * travel. The request is a programming error when it is wrong - a route validates a merchant's
 * chosen lifetime with Zod first - so a bad request here is `INTERNAL_ERROR` rather than a message
 * to a client.
 */
export function mintPortalToken(request: PortalTokenRequest, options: PortalTokenMintOptions): string {
  const now = requireClock(options.now);

  if (!isPortalTokenKind(request.kind)) {
    throw configurationFailure("request_invalid");
  }

  const allowed: readonly string[] = PORTAL_TOKEN_CAPABILITIES_BY_KIND[request.kind];

  if (!allowed.includes(request.capability)) {
    throw configurationFailure("request_invalid");
  }

  if (!uuidPattern.test(request.companyId) || !uuidPattern.test(request.resourceId)) {
    throw configurationFailure("request_invalid");
  }

  const lifetime = request.lifetimeSeconds;

  if (
    !Number.isInteger(lifetime) ||
    lifetime < PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS ||
    lifetime > PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS
  ) {
    throw configurationFailure("request_invalid");
  }

  const expiresAt = now + lifetime;

  if (expiresAt > maximumEpochSeconds) {
    throw configurationFailure("request_invalid");
  }

  const tokenId = options.tokenId ?? randomBytes(PORTAL_TOKEN_ID_BYTES).toString("base64url");

  // Twenty-two base64url characters carry four spare bits, so one id has sixteen spellings. Only
  // the canonical one is written, because the id is the key a revocation row is found by.
  if (!tokenIdPattern.test(tokenId) || decodeCanonicalBase64Url(tokenId) === null) {
    throw configurationFailure("request_invalid");
  }

  const claim: PortalTokenClaim = {
    version: PORTAL_TOKEN_VERSION,
    kind: request.kind,
    companyId: request.companyId,
    resourceId: request.resourceId,
    capability: request.capability,
    tokenId,
    issuedAt: now,
    expiresAt,
  };

  const payloadPart = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");

  return withSigningKeys(options.keys, (signing) => {
    const signature = sign(`${currentHeader}.${payloadPart}`, signing.primary);

    return `${currentHeader}.${payloadPart}.${signature.toString("base64url")}`;
  });
}

/**
 * Read one link.
 *
 * The order is the security property: the key ring, then the shape, then the signature, then the
 * claim. Nothing a client sent is believed before the HMAC verifies - not the kind, not the company,
 * not the id, and not the expiry - and the revocation lookup runs last, so a public route cannot be
 * used to ask a database about tokens that were never signed by this platform.
 */
export function openPortalToken(token: string, options: PortalTokenOpenOptions): PortalTokenClaim {
  return withSigningKeys(options.keys, (signing) => {
    const now = requireClock(options.now);
    const parsed = parsePortalToken(token);
    let verified = false;

    for (const key of signing.all) {
      if (timingSafeEqual(sign(parsed.signed, key), parsed.signature)) {
        verified = true;
        break;
      }
    }

    if (!verified) {
      throw tokenFailure("signature_invalid");
    }

    const claim = readClaim(parsed.payloadText);

    if (claim.issuedAt > now + PORTAL_TOKEN_CLOCK_SKEW_SECONDS) {
      throw tokenFailure("token_not_yet_valid");
    }

    if (claim.expiresAt <= now) {
      throw tokenFailure("token_expired");
    }

    if (options.revocations?.isRevoked(claim.tokenId) === true) {
      throw tokenFailure("token_revoked");
    }

    const expected = options.expect;

    if (
      (expected?.kind !== undefined && expected.kind !== claim.kind) ||
      (expected?.companyId !== undefined && expected.companyId !== claim.companyId) ||
      (expected?.resourceId !== undefined && expected.resourceId !== claim.resourceId) ||
      (expected?.capability !== undefined && expected.capability !== claim.capability)
    ) {
      throw tokenFailure("audience_mismatch");
    }

    return claim;
  });
}

/**
 * The digest a store keeps instead of the token.
 *
 * A revocation row, a "link was opened" event and a support ticket all need to name one link
 * without becoming a second copy of it: SHA-256 of the exact token text is that name. The shape is
 * checked first, so a digest is only ever computed for something this platform could have minted.
 */
export function portalTokenDigest(token: string): string {
  parsePortalToken(token);

  return `${PORTAL_TOKEN_DIGEST_PREFIX}.${createHash("sha256").update(Buffer.from(token, "utf8")).digest("base64url")}`;
}
