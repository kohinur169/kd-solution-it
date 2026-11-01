// path: lib/auth/jwt.ts
import { Buffer } from "node:buffer";
import { z } from "zod";
import type { AssuranceLevel, SessionClaims } from "./types.ts";

/**
 * Reading the claims of an access token this server issued.
 *
 * The token is a JWS. Its signature is checked by the party that accepts it as an assertion of
 * identity, which is Supabase, on every call that carries it; this module does not hold the
 * project's signing key and does not pretend to verify. What it does do is read the payload into
 * a typed value so that a request handler never parses base64, so that a claim the platform does
 * not expect is treated as a broken cookie rather than as data, and so that one place states the
 * rule below.
 *
 * ## Why reading a claim is not a permission decision
 *
 * The token reaches this server in an HttpOnly cookie that this server wrote after a verified
 * exchange, so a browser cannot mint one, but "cannot" is not "must not check". A decision about
 * what an actor may do is taken from the actor record, read from the platform database on the
 * server (`directory.ts`), never from a claim. The claims are used for three things only:
 *
 *   - the subject, as the key of that lookup;
 *   - the expiry, so an expired session is rejected before a query is made;
 *   - the assurance level, so section 22's mandatory second factor can be enforced.
 *
 * Everything else in the token is either absent from this type or recorded for the log.
 */

/** Longest access token this module will parse. A Supabase token is well under 2 KiB. */
export const MAXIMUM_ACCESS_TOKEN_LENGTH = 4_096;

/** Longest claim segment this module will decode, before any JSON work happens. */
const maximumClaimSegmentLength = 2_048;

/** Tolerance applied to `exp` and `iat`, because two clocks are never equal. */
export const SESSION_CLAIM_CLOCK_SKEW_MS = 30_000;

const claimSegmentCount = 3;

const assuranceLevelSchema = z.enum(["aal1", "aal2"]);

const authenticationMethodSchema = z.looseObject({
  method: z.string().min(1).max(32),
  timestamp: z.number().int().nonnegative().optional(),
});

/**
 * The claims this platform understands.
 *
 * Unknown claims are dropped rather than rejected: Supabase adds claims over time, and a new one
 * is not a reason to sign a merchant out. A claim that is present but malformed is a different
 * case and fails the parse, because that is a token this server did not issue in the shape it
 * expects.
 */
const claimsSchema = z.looseObject({
  sub: z.string().min(1).max(64),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative().optional(),
  session_id: z.string().min(1).max(64).nullable().optional(),
  aal: assuranceLevelSchema.optional(),
  amr: z.array(authenticationMethodSchema).max(20).optional(),
  email: z.string().min(3).max(254).nullable().optional(),
});

function decodeClaimSegment(segment: string): string | null {
  if (segment.length > maximumClaimSegmentLength) {
    return null;
  }

  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function toEpochMs(seconds: number): number {
  return seconds * 1000;
}

/**
 * Decode the payload of an access token into typed claims, or `null`.
 *
 * Every rejection is the same value, deliberately: a handler has one branch for "this cookie is
 * not a session this server understands", and the reason a particular cookie failed is not
 * something a response may describe.
 */
export function decodeSessionClaims(accessToken: string): SessionClaims | null {
  if (accessToken.length === 0 || accessToken.length > MAXIMUM_ACCESS_TOKEN_LENGTH) {
    return null;
  }

  const segments = accessToken.split(".");

  if (segments.length !== claimSegmentCount) {
    return null;
  }

  const payloadSegment = segments[1];

  if (payloadSegment === undefined || payloadSegment.length === 0) {
    return null;
  }

  const decoded = decodeClaimSegment(payloadSegment);

  if (decoded === null) {
    return null;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(decoded);
  } catch {
    return null;
  }

  const parsedClaims = claimsSchema.safeParse(parsedJson);

  if (!parsedClaims.success) {
    return null;
  }

  const claims = parsedClaims.data;
  const methods =
    claims.amr === undefined ? [] : claims.amr.map((entry) => entry.method);
  const assuranceLevel: AssuranceLevel = claims.aal ?? "aal1";

  return {
    subject: claims.sub,
    sessionId: claims.session_id ?? null,
    assuranceLevel,
    issuedAtEpochMs: toEpochMs(claims.iat ?? claims.exp),
    expiresAtEpochMs: toEpochMs(claims.exp),
    methods,
    email: claims.email ?? null,
  };
}

/** The number of milliseconds until the token expires. Negative once it has. */
export function millisecondsUntilExpiry(claims: SessionClaims, nowEpochMs: number): number {
  return claims.expiresAtEpochMs - nowEpochMs;
}

/**
 * True while the token is inside its validity window, allowing for clock skew.
 *
 * The skew is subtracted rather than added, so a token is treated as expired slightly before its
 * `exp` rather than slightly after: the cost of a needless refresh is a request, the cost of a
 * token that expired in flight is a merchant seeing a failure.
 */
export function claimsAreCurrent(claims: SessionClaims, nowEpochMs: number): boolean {
  if (millisecondsUntilExpiry(claims, nowEpochMs) <= SESSION_CLAIM_CLOCK_SKEW_MS) {
    return false;
  }

  return claims.issuedAtEpochMs - nowEpochMs <= SESSION_CLAIM_CLOCK_SKEW_MS;
}
