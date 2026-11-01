// path: lib/auth/cookies.ts
import { Buffer } from "node:buffer";
import { z } from "zod";
import type { AuthConfig } from "./config.ts";
import { MAXIMUM_ACCESS_TOKEN_LENGTH } from "./jwt.ts";

/**
 * The session cookie: what LR-022 means by "a session-bound cookie".
 *
 * FEATURE_LIST section 22 fixes three attributes and one behaviour, and this file is where all
 * four live so that no route can write a cookie of its own:
 *
 *   - `HttpOnly`, because a script that could read the token could replay it;
 *   - `Secure` outside a local development environment, because a token on a plain http hop is a
 *     token on the wire;
 *   - `SameSite=Strict`, because a cross site request must never carry a session;
 *   - a cookie that works only inside its own session. The first half of that is here: the
 *     payload names the user and the session it belongs to, so a cookie cannot be renamed onto
 *     another session. The second half - a server side row and a device proof key - belongs to
 *     `public.sessions` and is enforced by the STEP that rotates the token (051).
 *
 * A cookie is also limited to about 4 KiB by every browser, and a Supabase access token plus a
 * refresh token can exceed that. The payload is therefore split into numbered chunks at a
 * smaller ceiling, exactly the way Supabase's own client does, and assembling it back refuses a
 * gap: a partial cookie is a broken session, never a session with fewer bytes.
 *
 * The value is base64url of a JSON object. It is not encrypted, because it never leaves the
 * server except into an HttpOnly cookie of the same origin and it holds nothing but the tokens
 * themselves; the tokens are opaque and signed by the provider, so a tampered payload fails the
 * provider's check or this file's shape check.
 */

/**
 * The cookie name. Owned by this module, so the format and the name always change together.
 *
 * In a secure environment the name carries the `__Host-` prefix, and that prefix is a security
 * property rather than a decoration: a browser refuses to accept a `__Host-` cookie that carries
 * a `Domain` attribute, and it refuses one that is not `Secure` with `Path=/`. That closes the one
 * forgery path a signature-less claim read would otherwise leave open - a sibling subdomain
 * setting a parent domain cookie with the session name - because such a cookie is discarded by the
 * browser before this parser ever sees it.
 */
export const AUTH_COOKIE_NAME = "kd_session";

/** Prefix a browser enforces on a host-only, Secure, path-rooted cookie. */
export const AUTH_SECURE_COOKIE_PREFIX = "__Host-";

/** Chunk ceiling for one cookie value. Browsers accept about 4096 bytes including the name. */
export const AUTH_COOKIE_CHUNK_BYTES = 3_180;

/** Chunks per session. Eight chunks is 25 KiB of cookie, far beyond any real token pair. */
export const AUTH_COOKIE_MAXIMUM_CHUNKS = 8;

const cookieNamePattern = /^[A-Za-z0-9_-]{1,48}$/u;

const refreshTokenMaximumLength = 2_048;

const identifierMaximumLength = 64;

const payloadSchema = z.object({
  accessToken: z.string().min(1).max(MAXIMUM_ACCESS_TOKEN_LENGTH),
  refreshToken: z.string().min(1).max(refreshTokenMaximumLength),
  expiresAtEpochMs: z.number().int().positive(),
  userId: z.string().min(1).max(identifierMaximumLength),
  sessionId: z.string().min(1).max(identifierMaximumLength).nullable(),
});

/**
 * What one session cookie carries.
 *
 * It is the transport form of a session, not the session itself: the reader turns it back into
 * `AuthSession` by asking the provider who the user is when a call needs the identity facts.
 */
export type SessionCookiePayload = z.infer<typeof payloadSchema>;

export interface AuthCookiePolicy {
  readonly name: string;
  readonly secure: boolean;
  /** Seconds a cookie may live. Kept here so a caller cannot extend a session by writing one. */
  readonly defaultMaxAgeSeconds: number;
}

export interface AuthCookiePolicyOptions {
  readonly name?: string;
  readonly secure: boolean;
  readonly defaultMaxAgeSeconds: number;
}

/** Build the policy once per process. A name that is not cookie safe is a programming error. */
export function createCookiePolicy(options: AuthCookiePolicyOptions): AuthCookiePolicy {
  const name = options.name ?? AUTH_COOKIE_NAME;

  if (!cookieNamePattern.test(name)) {
    throw new Error("the auth cookie name must match ^[A-Za-z0-9_-]{1,48}$");
  }

  if (name.startsWith(AUTH_SECURE_COOKIE_PREFIX) && !options.secure) {
    throw new Error("a __Host- cookie name requires the Secure flag");
  }

  if (
    !Number.isInteger(options.defaultMaxAgeSeconds) ||
    options.defaultMaxAgeSeconds <= 0
  ) {
    throw new Error("the auth cookie lifetime must be a positive whole number of seconds");
  }

  return {
    name,
    secure: options.secure,
    defaultMaxAgeSeconds: options.defaultMaxAgeSeconds,
  };
}

/**
 * The policy of the configured project.
 *
 * A route must build its policy here rather than call `createCookiePolicy` itself: the prefix
 * decision belongs to one function, so a production deployment cannot end up with an unprefixed
 * cookie because a handler passed `secure: true` by hand and forgot the prefix.
 */
export function createAuthCookiePolicy(
  config: AuthConfig,
  defaultMaxAgeSeconds: number,
): AuthCookiePolicy {
  return createCookiePolicy({
    name: config.secureCookies ? `${AUTH_SECURE_COOKIE_PREFIX}${AUTH_COOKIE_NAME}` : AUTH_COOKIE_NAME,
    secure: config.secureCookies,
    defaultMaxAgeSeconds,
  });
}

function chunkName(policy: AuthCookiePolicy, index: number): string {
  return `${policy.name}.${index}`;
}

function attributes(policy: AuthCookiePolicy, maxAgeSeconds: number): string {
  const parts = [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ];

  if (policy.secure) {
    parts.push("Secure");
  }

  // No Domain attribute: the cookie stays host only, so a sibling subdomain of the project can
  // never receive a merchant's session.
  return parts.join("; ");
}

/**
 * Encode one session payload into the cookies that carry it.
 *
 * The lifetime of the cookie is the lifetime of the session, capped by the policy, so a session
 * that expires in five minutes produces a cookie that expires in five minutes. The cap matters
 * in the other direction too: a caller cannot ask for a longer lived cookie than the policy
 * allows, and the server side expiry is checked on every read regardless.
 */
export function encodeSessionCookies(
  policy: AuthCookiePolicy,
  payload: SessionCookiePayload,
  nowEpochMs: number,
): readonly string[] {
  const parsed = payloadSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error("the session payload is not a session this platform can store");
  }

  const encoded = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  const chunkCount = Math.max(1, Math.ceil(encoded.length / AUTH_COOKIE_CHUNK_BYTES));

  if (chunkCount > AUTH_COOKIE_MAXIMUM_CHUNKS) {
    throw new Error("the session payload exceeds the cookie budget");
  }

  const remainingSeconds = Math.floor((parsed.data.expiresAtEpochMs - nowEpochMs) / 1000);
  const maxAgeSeconds = Math.min(policy.defaultMaxAgeSeconds, Math.max(0, remainingSeconds));
  const suffix = attributes(policy, maxAgeSeconds);

  if (chunkCount === 1) {
    return [`${policy.name}=${encoded}; ${suffix}`];
  }

  const cookies: string[] = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * AUTH_COOKIE_CHUNK_BYTES;
    const chunk = encoded.slice(start, start + AUTH_COOKIE_CHUNK_BYTES);
    cookies.push(`${chunkName(policy, index)}=${chunk}; ${suffix}`);
  }

  return cookies;
}

interface ParsedCookies {
  readonly single: string | null;
  readonly chunks: ReadonlyMap<number, string>;
}

/**
 * Collect the cookies of one policy out of a header.
 *
 * Only the exact policy name and its numbered chunks are kept. Every other cookie in the header
 * - a theme choice, a locale, a cookie of another module - is ignored, which is what keeps a
 * similarly named cookie from being read as a session.
 */
function parseCookieHeader(policy: AuthCookiePolicy, cookieHeader: string): ParsedCookies {
  const chunks = new Map<number, string>();
  let single: string | null = null;

  for (const pair of cookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();

    if (name.length === 0 || value.length === 0) {
      continue;
    }

    if (name === policy.name) {
      single = value;
      continue;
    }

    if (!name.startsWith(`${policy.name}.`)) {
      continue;
    }

    const indexText = name.slice(policy.name.length + 1);

    if (!/^[0-9]{1,2}$/u.test(indexText)) {
      continue;
    }

    chunks.set(Number.parseInt(indexText, 10), value);
  }

  return { single, chunks };
}

/**
 * Join the chunks of one session back together.
 *
 * A gap is a refusal. Chunks are numbered from zero with no holes, so a header that carries
 * chunk 0 and chunk 2 is a cookie a proxy or a bug truncated, and reading it as a shorter token
 * would turn a transport failure into an authentication failure with the wrong cause.
 */
function assemble(policy: AuthCookiePolicy, cookieHeader: string): string | null {
  const parsed = parseCookieHeader(policy, cookieHeader);

  if (parsed.single !== null && parsed.chunks.size > 0) {
    return null;
  }

  if (parsed.single !== null) {
    return parsed.single;
  }

  if (parsed.chunks.size === 0 || parsed.chunks.size > AUTH_COOKIE_MAXIMUM_CHUNKS) {
    return null;
  }

  let encoded = "";

  for (let index = 0; index < parsed.chunks.size; index += 1) {
    const chunk = parsed.chunks.get(index);

    if (chunk === undefined) {
      return null;
    }

    encoded += chunk;
  }

  return encoded;
}

/**
 * The number of chunks this policy currently occupies in a header, for a clean sign out.
 *
 * A sign out has to expire every cookie the browser holds, including the ones a previous
 * payload needed, so the count is read from the header rather than assumed to be one.
 */
export function sessionCookieChunkCount(
  policy: AuthCookiePolicy,
  cookieHeader: string | null,
): number {
  if (cookieHeader === null) {
    return 0;
  }

  const parsed = parseCookieHeader(policy, cookieHeader);
  let count = parsed.single === null ? 0 : 1;

  for (const [index] of parsed.chunks) {
    count = Math.max(count, index + 1);
  }

  return Math.min(count, AUTH_COOKIE_MAXIMUM_CHUNKS);
}

/** Read and validate the session payload of a request, or `null` when there is no usable one. */
export function decodeSessionCookies(
  policy: AuthCookiePolicy,
  cookieHeader: string | null,
): SessionCookiePayload | null {
  if (cookieHeader === null || cookieHeader.trim().length === 0) {
    return null;
  }

  const encoded = assemble(policy, cookieHeader);

  if (encoded === null || encoded.length === 0) {
    return null;
  }

  let decoded: string;

  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(decoded);
  } catch {
    return null;
  }

  const parsed = payloadSchema.safeParse(parsedJson);

  if (!parsed.success) {
    return null;
  }

  // A base64url round trip is not guaranteed to reject every malformed input, so the payload is
  // checked against the canonical encoding of what it claims to be.
  const canonical = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");

  return canonical === encoded ? parsed.data : null;
}

/**
 * The cookies that remove a session.
 *
 * Attributes must match the ones used to write the cookie, or a browser keeps the original, so
 * the clearing cookie carries the same path, flags and name and only the lifetime differs.
 */
export function clearSessionCookies(
  policy: AuthCookiePolicy,
  chunkCount: number,
): readonly string[] {
  const suffix = attributes(policy, 0);
  const cookies: string[] = [`${policy.name}=; ${suffix}`];
  const count = Math.min(Math.max(chunkCount, 0), AUTH_COOKIE_MAXIMUM_CHUNKS);

  for (let index = 0; index < count; index += 1) {
    cookies.push(`${chunkName(policy, index)}=; ${suffix}`);
  }

  return cookies;
}
