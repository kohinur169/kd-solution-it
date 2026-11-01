// path: lib/auth/config.ts
import { serverEnv } from "../env/server.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The endpoint table and the key policy of the Supabase Auth client.
 *
 * Everything this module needs to talk to the identity provider is derived here, once, from the
 * environment STEP 004 already validated at boot. No later file reads `process.env`, builds a
 * URL by concatenation or decides for itself whether a key is the anonymous one.
 *
 * Three refusals are worth naming, because each of them is a mistake that would otherwise be
 * discovered by a browser:
 *
 *   1. a project URL that is not https in production, or that carries a path, a query or a
 *      credential, is a configuration error and not something to trim;
 *   2. the service role key bypasses row level security, so it is never the anonymous key and
 *      the anonymous key is never the service role key;
 *   3. the two keys are never the same value, because that would silently give the browser path
 *      the privileges of the server path.
 *
 * The module is server only. It imports `lib/env/server.ts`, which reads secrets, so importing
 * it from a client component is a build error and not a runtime surprise.
 */

/** Minimum length of an API key. The environment schema already enforces it; this is a second gate. */
const minimumKeyLength = 32;

/** Timeout for one Auth request. Long enough for a password hash, short enough to fail a request. */
export const AUTH_REQUEST_TIMEOUT_MS = 10_000;

/** Ceiling for one Auth response body. A session payload is a few kilobytes, not a document. */
export const AUTH_MAXIMUM_RESPONSE_BYTES = 65_536;

/** The two grant types the token endpoint accepts for this platform. */
export const AUTH_PASSWORD_GRANT = "password";
export const AUTH_REFRESH_GRANT = "refresh_token";

export type AuthGrantType = typeof AUTH_PASSWORD_GRANT | typeof AUTH_REFRESH_GRANT;

/**
 * The environment fields this module consumes.
 *
 * It is a narrower view of `ServerEnvironment`, so a validated environment satisfies it without
 * a cast, and the gate can build the same configuration from a fixture without a real process.
 */
export interface AuthEnvironment {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly NODE_ENV: string;
}

/** Absolute URLs of the Auth and PostgREST surfaces. Built once, never concatenated later. */
export interface AuthEndpoints {
  readonly token: string;
  readonly signUp: string;
  readonly user: string;
  readonly logout: string;
  readonly recover: string;
  readonly verify: string;
  readonly resend: string;
  readonly adminUsers: string;
  readonly usersTable: string;
}

export interface AuthConfig {
  /** The project origin, without a trailing slash, path, query or fragment. */
  readonly projectUrl: string;
  readonly anonymousKey: string;
  readonly serviceRoleKey: string;
  /** False only for a development environment served over plain http on loopback. */
  readonly secureCookies: boolean;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
  readonly endpoints: AuthEndpoints;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function requireKey(value: string, name: string): string {
  if (value.trim().length < minimumKeyLength || value !== value.trim()) {
    throw new Error(`${name} must be a trimmed key of at least ${minimumKeyLength} characters`);
  }

  return value;
}

/**
 * Validate the project URL and return its origin.
 *
 * A Supabase project URL is an origin. A path, a query, a fragment or an embedded user and
 * password would all be silently dropped by `URL.origin`, which would hide a typo in a secret
 * store rather than report it, so each of them is an error.
 */
function requireProjectUrl(value: string, environment: AuthEnvironment): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SUPABASE_URL must be an absolute URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SUPABASE_URL must use http or https");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("SUPABASE_URL must not carry a user or a password");
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("SUPABASE_URL must not carry a query or a fragment");
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("SUPABASE_URL must be an origin without a path");
  }

  const plainHttpAllowed =
    environment.NODE_ENV !== "production" && isLoopbackHost(parsed.hostname);

  if (parsed.protocol !== "https:" && !plainHttpAllowed) {
    throw new Error("SUPABASE_URL must use https outside a local development environment");
  }

  return parsed.origin;
}

/**
 * Build the configuration from a validated environment.
 *
 * `secureCookies` is false only for a development environment, where the platform is served over
 * plain http on loopback and a Secure cookie would never be stored. Every other environment,
 * including test, writes the cookie with the Secure flag that LR-022 requires.
 */
export function buildAuthConfig(environment: AuthEnvironment): AuthConfig {
  const projectUrl = requireProjectUrl(environment.SUPABASE_URL, environment);
  const anonymousKey = requireKey(environment.SUPABASE_ANON_KEY, "SUPABASE_ANON_KEY");
  const serviceRoleKey = requireKey(
    environment.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );

  if (anonymousKey === serviceRoleKey) {
    throw new Error("SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be different keys");
  }

  if (anonymousKey.startsWith("sb_secret_")) {
    throw new Error("SUPABASE_ANON_KEY must not hold a secret key");
  }

  if (serviceRoleKey.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must not hold a publishable key");
  }

  const authBase = `${projectUrl}/auth/v1`;
  const restBase = `${projectUrl}/rest/v1`;

  return deepFreeze({
    projectUrl,
    anonymousKey,
    serviceRoleKey,
    secureCookies: environment.NODE_ENV !== "development",
    requestTimeoutMs: AUTH_REQUEST_TIMEOUT_MS,
    maximumResponseBytes: AUTH_MAXIMUM_RESPONSE_BYTES,
    endpoints: {
      token: `${authBase}/token`,
      signUp: `${authBase}/signup`,
      user: `${authBase}/user`,
      logout: `${authBase}/logout`,
      recover: `${authBase}/recover`,
      verify: `${authBase}/verify`,
      resend: `${authBase}/resend`,
      adminUsers: `${authBase}/admin/users`,
      usersTable: `${restBase}/users`,
    },
  });
}

let configuredAuth: AuthConfig | undefined;

/**
 * The configuration of this process, built once from the validated environment.
 *
 * Lazy and memoised for the same reason `config/server.ts` is: a module level read would run
 * during `next build`, and a build machine does not hold the runtime secrets.
 */
export function getAuthConfig(): AuthConfig {
  if (configuredAuth === undefined) {
    configuredAuth = buildAuthConfig(serverEnv());
  }

  return configuredAuth;
}

/** The token endpoint URL of one grant type. */
export function authTokenUrl(config: AuthConfig, grantType: AuthGrantType): string {
  return `${config.endpoints.token}?grant_type=${encodeURIComponent(grantType)}`;
}

/**
 * The admin endpoint of one user.
 *
 * The identifier is encoded, so a value that is not a UUID cannot change the path. Every caller
 * passes the identifier of a user this server created, and the encoding is what keeps a future
 * caller from turning a bug into a different request.
 */
export function authAdminUserUrl(config: AuthConfig, userId: string): string {
  return `${config.endpoints.adminUsers}/${encodeURIComponent(userId)}`;
}
