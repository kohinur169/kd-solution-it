// path: lib/auth/verify.ts
import { Buffer } from "node:buffer";
import process from "node:process";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { createAuthAdminClient } from "./admin-client.ts";
import {
  AUDIT_SIGNING_KEY_ID,
  createInMemoryAuditTrail,
  createRestAuditTrail,
  signAuditHash,
} from "./audit.ts";
import { isAddress, readClientAddress, readUserAgent } from "./client-address.ts";
import { emailHash, readDeviceContext } from "./device-context.ts";
import {
  createInMemoryLoginAttemptRecorder,
  createRestLoginAttemptRecorder,
} from "./login-attempts.ts";
import { encodeQr, encodeQrCodewords, qrRows, smallestVersion } from "../qr/qr.ts";
import { qrPath } from "../qr/path.ts";
import {
  base32Decode,
  base32Encode,
  formatSecretForEntry,
  generateBackupCodes,
  generateTotpSecret,
  isBackupCodeShaped,
  normalizeBackupCode,
  totpCodeForStep,
  totpStep,
  totpUri,
  verifyTotpCode,
  BACKUP_CODE_COUNT,
} from "./totp.ts";
import {
  confirmTotpEnrolment,
  hasConfirmedTwoFactor,
  openEnrolledSecret,
  startTotpEnrolment,
  twoFactorContext,
} from "./two-factor.ts";
import { readTwoFactorStatus, regenerateBackupCodes } from "./backup-codes.ts";
import {
  decideTwoFactorReset,
  listTwoFactorResetRequests,
  requestTwoFactorReset,
  resetRequestInputSchema,
  TWO_FACTOR_RESET_OFFICE_ROLES,
} from "./two-factor-reset.ts";
import {
  challengeContext,
  completeTwoFactorChallenge,
  hashChallengeToken,
  isSameChallengeToken,
  issueTwoFactorChallenge,
  TWO_FACTOR_CHALLENGE_TTL_MS,
  TWO_FACTOR_MAXIMUM_ATTEMPTS,
} from "./two-factor-login.ts";
import { signInMerchant, signinInputSchema } from "./signin.ts";
import { createAuthClient, type AuthClient } from "./client.ts";
import { authAdminUserUrl, authTokenUrl, buildAuthConfig, type AuthConfig } from "./config.ts";
import {
  AUTH_COOKIE_MAXIMUM_CHUNKS,
  clearSessionCookies,
  createAuthCookiePolicy,
  createCookiePolicy,
  decodeSessionCookies,
  encodeSessionCookies,
  sessionCookieChunkCount,
  type AuthCookiePolicy,
  type SessionCookiePayload,
} from "./cookies.ts";
import { createInMemoryActorDirectory, createSupabaseActorDirectory, liveRoles } from "./directory.ts";
import {
  classifyAuthAnswer,
  credentialRejectionError,
  readUpstreamCode,
  toAuthAppError,
} from "./failures.ts";
import { createAuthHttp, type AuthAnswer, type AuthFetch, type AuthHttp } from "./http.ts";
import {
  claimsAreCurrent,
  decodeSessionClaims,
  MAXIMUM_ACCESS_TOKEN_LENGTH,
  millisecondsUntilExpiry,
  SESSION_CLAIM_CLOCK_SKEW_MS,
} from "./jwt.ts";
import {
  hasAnyRole,
  hasRole,
  hasSatisfiedTwoFactor,
  isTwoFactorEnrolmentRequired,
  readSession,
  requireActor,
  requireAnyRole,
  requireCompanyId,
} from "./session.ts";
import {
  BREACH_CHECK_ENABLED_SETTING,
  breachHashParts,
  createBreachCheck,
  createFixedBreachCheck,
  readBreachRange,
  type BreachCheck,
} from "./breach-check.ts";
import { completeEmailVerification } from "./email-verification.ts";
import {
  assertPasswordAcceptable,
  characterKindsIn,
  hashPassword,
  PASSWORD_MAXIMUM_LENGTH,
  PASSWORD_MINIMUM_CHARACTER_KINDS,
  PASSWORD_MINIMUM_LENGTH,
  passwordRuleViolation,
  verifyPasswordHash,
} from "./password.ts";
import {
  acceptsEveryRequiredPolicy,
  catalogIsComplete,
  createInMemoryPolicyCatalog,
  POLICY_KEYS,
  policyDocumentSha256,
  REQUIRED_POLICY_KEYS,
  type PolicyPage,
} from "./policies.ts";
import { companySlug, registerMerchant } from "./registration.ts";
import type { RestClient } from "./rest.ts";
import { isSecretBox, openSecret, packSecretBox, sealSecret, unpackSecretBox } from "./secrets.ts";
import {
  createInMemorySettings,
  createRestSettings,
  secretContextFor,
} from "./settings.ts";
import {
  createTurnstileGuard,
  TURNSTILE_ENABLED_SETTING,
  TURNSTILE_SECRET_SETTING,
} from "./turnstile.ts";
import type {
  ActorRecord,
  AuthFailure,
  AuthOutcome,
  AuthSession,
  PlatformRole,
  RequestActor,
} from "./types.ts";

/**
 * The authentication gate. Run with `node lib/auth/verify.ts`.
 *
 * There is no Supabase project in this environment and there is not going to be one inside a
 * gate, so every branch below is driven through the injected transport: a scripted answer for
 * the client and the admin client, a stub `fetch` for the transport itself, and an in memory
 * directory for the session reader. That is the point of taking those seams in the first place.
 *
 * The gate proves the properties a silent regression would break, in the order they matter:
 *
 *   1. configuration refuses the four ways a project URL or a key pair can be wrong;
 *   2. an access token is read into claims, and an expired, truncated or malformed one is not;
 *   3. a session cookie round trips, chunks without losing a byte, and refuses a gap;
 *   4. an upstream answer becomes a catalogue code, and a rejected credential reveals nothing;
 *   5. the transport times out, bounds its body, refuses a redirect and sends no key in a URL;
 *   6. the directory is one primary key lookup with the service role, and a live role list;
 *   7. the session reader answers authenticated or unauthenticated, and never a third thing;
 *   8. the two clients keep their method sets, and the admin client never lists accounts.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checkCount += 1;

  if (actual !== expected) {
    failures.push(
      `${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
    );
  }
}

function expectThrows(action: () => unknown, description: string): unknown {
  checkCount += 1;

  try {
    const value = action();
    failures.push(`${description} (nothing was thrown)`);

    return value;
  } catch (error) {
    return error;
  }
}

function expectAppError(action: () => unknown, code: string, description: string): void {
  const error = expectThrows(action, description);

  expect(error instanceof AppError, `${description} (the failure must be an AppError)`);

  if (error instanceof AppError) {
    expectEqual(error.code, code, `${description} (catalogue code)`);
  }
}

async function expectRejects(
  action: () => Promise<unknown>,
  code: string,
  description: string,
): Promise<void> {
  checkCount += 1;

  try {
    await action();
    failures.push(`${description} (nothing was rejected)`);
  } catch (error) {
    if (!(error instanceof AppError)) {
      failures.push(`${description} (the rejection must be an AppError)`);
      return;
    }

    expectEqual(error.code, code, `${description} (catalogue code)`);
  }
}

async function captureRejection(
  action: () => Promise<unknown>,
  description: string,
): Promise<AppError> {
  checkCount += 1;

  try {
    await action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }

    failures.push(`${description} (the rejection must be an AppError)`);

    return new AppError("INTERNAL_ERROR");
  }

  failures.push(`${description} (nothing was rejected)`);

  return new AppError("INTERNAL_ERROR");
}

/** A password that passes the STEP 040 policy: length, three kinds, no identity word. */
const COMPLIANT_PASSWORD = "Correct-Horse-Battery-9";

const NOW = 1_800_000_000_000;

/** A 32 byte master key for the policies the gate builds. Not a secret, never a real key. */
const SESSION_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_SESSION_MASTER_KEY = Buffer.alloc(32, 8).toString("base64");
const USER_ID = "018f3b1c-1111-7c2a-9d1e-2b3c4d5e6f70";
const OTHER_USER_ID = "018f3b1c-3333-7c2a-9d1e-2b3c4d5e6f72";
const SESSION_ID = "018f3b1c-2222-7c2a-9d1e-2b3c4d5e6f71";
const FIRM_ID = "018f3b1c-4444-7c2a-9d1e-2b3c4d5e6f73";

const environment = {
  SUPABASE_URL: "https://project-ref.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-0000000000000000000000000000",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-00000000000000000000",
  NODE_ENV: "production",
};

const config: AuthConfig = buildAuthConfig(environment);

function baseClaims(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sub: USER_ID,
    exp: Math.floor(NOW / 1000) + 3_600,
    iat: Math.floor(NOW / 1000) - 60,
    session_id: SESSION_ID,
    aal: "aal1",
    amr: [{ method: "password", timestamp: Math.floor(NOW / 1000) - 60 }],
    role: "authenticated",
    email: "owner@example.com",
    ...overrides,
  };
}

function makeAccessToken(claims: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");

  return `${header}.${payload}.${Buffer.from("gate-signature", "utf8").toString("base64url")}`;
}

function okAnswer(
  status: number,
  body: unknown,
  retryAfterSeconds: number | null = null,
): AuthOutcome<AuthAnswer> {
  return { ok: true, value: { status, body, retryAfterSeconds } };
}

function failureAnswer(failure: AuthFailure): AuthOutcome<AuthAnswer> {
  return { ok: false, failure };
}

function authFailure(kind: AuthFailure["kind"], status: number | null = null): AuthFailure {
  return { kind, status, code: null, retryAfterSeconds: null };
}

interface StubHttp {
  readonly http: AuthHttp;
  readonly requests: AuthRequestRecord[];
}

interface AuthRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly apiKey: string;
  readonly bearerToken: string | undefined;
  readonly body: unknown;
  readonly form: unknown;
  readonly headers: unknown;
  readonly responseFormat: string | undefined;
}

function createStubHttp(
  ...answers: readonly AuthOutcome<AuthAnswer>[]
): StubHttp {
  const requests: AuthRequestRecord[] = [];
  let index = 0;

  return {
    requests,
    http: {
      send(request): Promise<AuthOutcome<AuthAnswer>> {
        requests.push({
          method: request.method,
          url: request.url,
          apiKey: request.apiKey,
          bearerToken: request.bearerToken,
          body: request.body,
          form: request.form,
          headers: request.headers,
          responseFormat: request.responseFormat,
        });

        const answer = answers[index] ?? okAnswer(500, { code: "gate_missing_answer" });
        index += 1;

        return Promise.resolve(answer);
      },
    },
  };
}

function firstRequest(requests: readonly AuthRequestRecord[], description: string): AuthRequestRecord | null {
  const request = requests[0];

  if (request === undefined) {
    checkCount += 1;
    failures.push(`${description} (no request was sent)`);

    return null;
  }

  return request;
}

/* ------------------------------------------------------------------ 1. config */

function checkConfig(): void {
  expectEqual(config.projectUrl, "https://project-ref.supabase.co", "the project origin is kept");
  expectEqual(
    config.endpoints.token,
    "https://project-ref.supabase.co/auth/v1/token",
    "the token endpoint is derived from the origin",
  );
  expectEqual(
    config.endpoints.usersTable,
    "https://project-ref.supabase.co/rest/v1/users",
    "the PostgREST users table URL is derived from the origin",
  );
  expectEqual(config.secureCookies, true, "production writes Secure cookies");
  expect(Object.isFrozen(config), "the configuration is frozen");
  expect(Object.isFrozen(config.endpoints), "the endpoint table is frozen");
  expectEqual(config.requestTimeoutMs, 10_000, "the timeout is the documented ten seconds");
  expectEqual(
    config.maximumResponseBytes,
    65_536,
    "the response ceiling is the documented 64 KiB",
  );

  expectEqual(
    authTokenUrl(config, "password"),
    "https://project-ref.supabase.co/auth/v1/token?grant_type=password",
    "the token URL carries the grant type",
  );
  expectEqual(
    authAdminUserUrl(config, USER_ID),
    `https://project-ref.supabase.co/auth/v1/admin/users/${USER_ID}`,
    "the admin user URL is one identifier",
  );

  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_URL: "http://project-ref.supabase.co" }),
    "an http project URL is refused in production",
  );
  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_URL: "https://project-ref.supabase.co/auth" }),
    "a project URL with a path is refused",
  );
  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_URL: "https://project-ref.supabase.co/?a=1" }),
    "a project URL with a query is refused",
  );
  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_URL: "https://key:secret@project-ref.supabase.co" }),
    "a project URL with a credential is refused",
  );
  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_URL: "not-a-url" }),
    "a project URL that is not absolute is refused",
  );
  expectThrows(
    () =>
      buildAuthConfig({
        ...environment,
        SUPABASE_SERVICE_ROLE_KEY: environment.SUPABASE_ANON_KEY,
      }),
    "the two keys must be different",
  );
  expectThrows(
    () =>
      buildAuthConfig({
        ...environment,
        SUPABASE_ANON_KEY: `sb_secret_${"0".repeat(40)}`,
      }),
    "a secret key in the anonymous slot is refused",
  );
  expectThrows(
    () =>
      buildAuthConfig({
        ...environment,
        SUPABASE_SERVICE_ROLE_KEY: `sb_publishable_${"0".repeat(40)}`,
      }),
    "a publishable key in the service role slot is refused",
  );
  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_ANON_KEY: "short" }),
    "a key below the minimum length is refused",
  );
  expectThrows(
    () => buildAuthConfig({ ...environment, SUPABASE_ANON_KEY: ` ${environment.SUPABASE_ANON_KEY}` }),
    "an untrimmed key is refused",
  );

  const development = buildAuthConfig({
    ...environment,
    NODE_ENV: "development",
    SUPABASE_URL: "http://127.0.0.1:54321",
  });

  expectEqual(development.secureCookies, false, "development over loopback may skip Secure");
  expectEqual(
    buildAuthConfig({ ...environment, NODE_ENV: "test" }).secureCookies,
    true,
    "test still requires Secure cookies",
  );
  expectEqual(
    buildAuthConfig({ ...environment, NODE_ENV: "development" }).secureCookies,
    false,
    "development does not require a Secure cookie",
  );
}

/* ------------------------------------------------------------------ 2. claims */

function checkClaims(): void {
  const claims = decodeSessionClaims(makeAccessToken(baseClaims()));

  expect(claims !== null, "a well formed access token decodes");

  if (claims === null) {
    return;
  }

  expectEqual(claims.subject, USER_ID, "the subject is read");
  expectEqual(claims.sessionId, SESSION_ID, "the session identifier is read");
  expectEqual(claims.assuranceLevel, "aal1", "the assurance level is read");
  expectEqual(claims.email, "owner@example.com", "the email claim is read");
  expectEqual(claims.methods.length, 1, "the authentication methods are read");
  expectEqual(claims.methods[0], "password", "the method name is read");
  expectEqual(claims.expiresAtEpochMs, (Math.floor(NOW / 1000) + 3_600) * 1000, "expiry in ms");
  expectEqual(
    millisecondsUntilExpiry(claims, NOW),
    3_600_000,
    "the remaining lifetime is computed from the claim",
  );
  expect(claimsAreCurrent(claims, NOW), "a fresh token is current");
  expect(
    !claimsAreCurrent(claims, NOW + 3_600_000 - SESSION_CLAIM_CLOCK_SKEW_MS / 2),
    "a token inside the clock skew window is already treated as expired",
  );

  const secondFactor = decodeSessionClaims(makeAccessToken(baseClaims({ aal: "aal2" })));

  expectEqual(secondFactor?.assuranceLevel, "aal2", "the second factor level is read");

  const withoutOptional = decodeSessionClaims(
    makeAccessToken({ sub: USER_ID, exp: Math.floor(NOW / 1000) + 600 }),
  );

  expectEqual(withoutOptional?.sessionId, null, "a token without a session id is accepted");
  expectEqual(withoutOptional?.assuranceLevel, "aal1", "a token without a level is aal1");
  expectEqual(withoutOptional?.email, null, "a token without an email has none");
  expectEqual(withoutOptional?.methods.length, 0, "a token without methods has an empty list");

  const withUnknownClaim = decodeSessionClaims(makeAccessToken(baseClaims({ is_anonymous: false })));

  expect(withUnknownClaim !== null, "an unknown claim does not break a token");

  expectEqual(decodeSessionClaims(""), null, "an empty token is rejected");
  expectEqual(decodeSessionClaims("one.two"), null, "a two segment token is rejected");
  expectEqual(decodeSessionClaims(`a.${Buffer.from("not json", "utf8").toString("base64url")}.c`), null, "a payload that is not JSON is rejected");
  expectEqual(
    decodeSessionClaims(`a.${Buffer.from(JSON.stringify({ exp: 1 }), "utf8").toString("base64url")}.c`),
    null,
    "a token without a subject is rejected",
  );
  expectEqual(
    decodeSessionClaims(
      makeAccessToken(baseClaims({ sub: "x".repeat(65) })),
    ),
    null,
    "a subject longer than an identifier is rejected",
  );
  expectEqual(
    decodeSessionClaims(
      makeAccessToken(baseClaims({ aal: "aal3" })),
    ),
    null,
    "an assurance level the platform does not know is rejected",
  );
  expectEqual(decodeSessionClaims("a".repeat(5_000)), null, "an oversized token is rejected");
  expectEqual(
    decodeSessionClaims(
      `a.${Buffer.from("{}", "utf8").toString("base64url")}.c`,
    ),
    null,
    "a token without an expiry is rejected",
  );
}

/* ------------------------------------------------------------------ 3. cookies */

const developmentConfig: AuthConfig = buildAuthConfig({
  ...environment,
  NODE_ENV: "development",
});

function cookiePolicy(secure = true): AuthCookiePolicy {
  return createAuthCookiePolicy(secure ? config : developmentConfig, 3_600, SESSION_MASTER_KEY);
}

function sessionPayload(
  overrides: Partial<SessionCookiePayload> = {},
): SessionCookiePayload {
  return {
    accessToken: makeAccessToken(baseClaims()),
    refreshToken: "refresh-token-000000000000000000",
    expiresAtEpochMs: NOW + 3_600_000,
    userId: USER_ID,
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function bareCookies(cookies: readonly string[]): string {
  return cookies.map((cookie) => cookie.split(";", 1)[0] ?? "").join("; ");
}

function checkCookies(): void {
  const policy = cookiePolicy();
  const payload = sessionPayload();
  const cookies = encodeSessionCookies(policy, payload, NOW);

  expectEqual(cookies.length, 1, "a small session fits one cookie");

  const cookie = cookies[0] ?? "";

  expectEqual(policy.name, "__Host-kd_session", "a secure environment prefixes the cookie name");
  expect(cookie.startsWith(`${policy.name}=`), "the cookie carries the documented name");
  expect(cookie.includes("HttpOnly"), "the cookie is HttpOnly");
  expect(cookie.includes("Secure"), "the cookie is Secure outside development");
  expect(cookie.includes("SameSite=Strict"), "the cookie is SameSite Strict");
  expect(cookie.includes("Path=/"), "the cookie is scoped to the whole site");
  expect(cookie.includes("Max-Age=3600"), "the cookie lifetime is the session lifetime");
  expect(!cookie.includes("Domain="), "the cookie has no Domain attribute");

  const decoded = decodeSessionCookies(policy, cookie);

  expectEqual(decoded?.userId, USER_ID, "a single cookie round trips the user");
  expectEqual(decoded?.sessionId, SESSION_ID, "a single cookie round trips the session");
  expectEqual(decoded?.accessToken, payload.accessToken, "a single cookie round trips the token");
  expectEqual(
    decoded?.refreshToken,
    payload.refreshToken,
    "a single cookie round trips the refresh token",
  );

  // A cookie a browser writes for itself is not a session. This is the whole point of the
  // signature: a payload that only has the right shape proves nothing about who wrote it.
  const forgedBody = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  expectEqual(
    decodeSessionCookies(policy, `${policy.name}=${forgedBody}`),
    null,
    "an unsigned payload is not a session",
  );
  expectEqual(
    decodeSessionCookies(policy, `${policy.name}=${forgedBody}.`),
    null,
    "an empty signature is not a session",
  );
  expectEqual(
    decodeSessionCookies(
      policy,
      `${policy.name}=${forgedBody}.${Buffer.from("0".repeat(43), "utf8").toString("base64url")}`,
    ),
    null,
    "a made up signature is not a session",
  );

  const validValue = (cookie.slice(`${policy.name}=`.length).split(";")[0] ?? "");
  const lastDot = validValue.lastIndexOf(".");
  const tamperedBody = `${(validValue.slice(0, lastDot) || "").slice(0, -1)}A${validValue.slice(lastDot)}`;
  const otherPolicy = createCookiePolicy({
    name: policy.name,
    secure: true,
    defaultMaxAgeSeconds: 3_600,
    masterKey: OTHER_SESSION_MASTER_KEY,
  });

  expectEqual(
    decodeSessionCookies(policy, `${policy.name}=${tamperedBody}`),
    null,
    "a payload changed after signing is not a session",
  );
  expectEqual(
    decodeSessionCookies(otherPolicy, cookie),
    null,
    "a cookie signed under another master key is not a session",
  );
  expectEqual(
    decodeSessionCookies(policy, `${policy.name}=${validValue}`)?.userId,
    USER_ID,
    "the untouched value is still the session",
  );

  expectThrows(
    () =>
      createCookiePolicy({
        secure: true,
        defaultMaxAgeSeconds: 3_600,
        masterKey: Buffer.alloc(16, 1).toString("base64"),
      }),
    "a master key shorter than the signing key is refused at boot",
  );
  expect(
    policy.signingKey !== OTHER_SESSION_MASTER_KEY && policy.signingKey.length > 20,
    "the policy carries a derived key, never the master key itself",
  );

  expectEqual(
    encodeSessionCookies(cookiePolicy(false), payload, NOW)[0]?.includes("Secure"),
    false,
    "a development cookie skips the Secure flag",
  );
  expectEqual(
    cookiePolicy(false).name,
    "kd_session",
    "a development environment uses the unprefixed name",
  );
  expect(
    !(encodeSessionCookies(cookiePolicy(false), payload, NOW)[0] ?? "").includes("__Host-"),
    "a development cookie never claims the secure prefix",
  );
  expectThrows(
    () =>
      createCookiePolicy({
        name: "__Host-kd_session",
        secure: false,
        defaultMaxAgeSeconds: 3_600,
        masterKey: SESSION_MASTER_KEY,
      }),
    "a secure prefix without the Secure flag is refused",
  );
  expectEqual(
    encodeSessionCookies(
      createCookiePolicy({
        secure: true,
        defaultMaxAgeSeconds: 600,
        masterKey: SESSION_MASTER_KEY,
      }),
      payload,
      NOW,
    )[0]?.includes("Max-Age=600"),
    true,
    "the policy lifetime caps the cookie lifetime",
  );
  expect(
    (encodeSessionCookies(policy, sessionPayload({ expiresAtEpochMs: NOW + 60_000 }), NOW)[0] ?? "")
      .includes("Max-Age=60"),
    "a session expiring sooner produces a shorter cookie",
  );

  const largePayload = sessionPayload({
    accessToken: "t".repeat(4_000),
    refreshToken: "r".repeat(2_000),
  });
  const chunked = encodeSessionCookies(policy, largePayload, NOW);

  expect(chunked.length > 1, "a large session is split into chunks");
  expect(chunked.length <= AUTH_COOKIE_MAXIMUM_CHUNKS, "the chunk count stays inside the budget");
  expect(
    chunked[0]?.startsWith(`${policy.name}.0=`) === true,
    "the first chunk is numbered zero",
  );
  expect(
    chunked[1]?.startsWith(`${policy.name}.1=`) === true,
    "the second chunk is numbered one",
  );

  const joined = bareCookies(chunked);
  const reassembled = decodeSessionCookies(policy, joined);

  expectEqual(reassembled?.accessToken, largePayload.accessToken, "chunking loses no byte");
  expect(chunked.length >= 3, "a large token pair needs three chunks");
  expectEqual(
    sessionCookieChunkCount(policy, joined),
    chunked.length,
    "the chunk count is read from the header",
  );

  const parts = joined.split("; ");
  const withGap = [parts[0], parts[parts.length - 1]].filter((part) => part !== undefined).join("; ");

  expectEqual(decodeSessionCookies(policy, withGap), null, "a gap in the chunks is refused");

  expectEqual(
    decodeSessionCookies(policy, `${joined}; ${policy.name}=${payload.accessToken}`),
    null,
    "a header with both a whole cookie and chunks is refused",
  );
  expectEqual(
    decodeSessionCookies(policy, "theme=dark; locale=en; __Host-x=1"),
    null,
    "a header without this cookie is not a session",
  );

  const singleValue = cookie.split(";", 1)[0] ?? "";
  const tampered = `${singleValue.slice(0, -1)}${singleValue.endsWith("A") ? "B" : "A"}`;

  expectEqual(decodeSessionCookies(policy, tampered), null, "a tampered value is refused");
  expectEqual(decodeSessionCookies(policy, null), null, "no header is no session");
  expectEqual(decodeSessionCookies(policy, ""), null, "an empty header is no session");
  expectEqual(sessionCookieChunkCount(policy, null), 0, "no header means no chunk to clear");

  expectEqual(
    decodeSessionCookies(policy, `${policy.name}=not-base64-json`),
    null,
    "a value that is not our payload is refused",
  );

  const clear = clearSessionCookies(policy, 2);

  expectEqual(clear.length, 3, "clearing expires the cookie and both chunks");
  expect(
    clear.every((value) => value.includes("Max-Age=0")),
    "a cleared cookie expires at once",
  );
  expect(
    clear.every((value) => value.includes("Path=/") && value.includes("HttpOnly")),
    "a cleared cookie carries the attributes it was written with",
  );
  expect(
    (clear[0] ?? "").startsWith(`${policy.name}=;`),
    "the whole cookie is cleared first",
  );

  expectThrows(
    () =>
      createCookiePolicy({
        secure: true,
        defaultMaxAgeSeconds: 3_600,
        name: "bad name",
        masterKey: SESSION_MASTER_KEY,
      }),
    "a cookie name that is not cookie safe is refused",
  );
  expectThrows(
    () =>
      createCookiePolicy({
        secure: true,
        defaultMaxAgeSeconds: 0,
        masterKey: SESSION_MASTER_KEY,
      }),
    "a cookie policy without a lifetime is refused",
  );
  expectThrows(
    () => encodeSessionCookies(policy, sessionPayload({ accessToken: "x".repeat(5_000) }), NOW),
    "a payload outside the schema is not written",
  );
}

/* ------------------------------------------------------------------ 4. failures */

function checkFailures(): void {
  expectEqual(classifyAuthAnswer({ status: 200, body: {}, retryAfterSeconds: null }), null, "a success is not a failure");
  expectEqual(classifyAuthAnswer({ status: 204, body: null, retryAfterSeconds: null }), null, "no content is a success");

  const invalidCredentials = classifyAuthAnswer({
    status: 400,
    body: { code: "invalid_credentials", message: "Invalid login credentials" },
    retryAfterSeconds: null,
  });
  const emailNotConfirmed = classifyAuthAnswer({
    status: 400,
    body: { code: "email_not_confirmed", msg: "Email not confirmed" },
    retryAfterSeconds: null,
  });
  const unknownUser = classifyAuthAnswer({
    status: 400,
    body: { error: "invalid_grant", error_description: "User not found" },
    retryAfterSeconds: null,
  });

  expectEqual(invalidCredentials?.kind, "rejected", "a wrong password is a rejection");
  expectEqual(emailNotConfirmed?.kind, "rejected", "an unconfirmed address is a rejection");
  expectEqual(unknownUser?.kind, "rejected", "an unknown account is a rejection");
  expectEqual(
    toAuthAppError(invalidCredentials ?? authFailure("rejected")).code,
    "AUTHENTICATION_REQUIRED",
    "a wrong password answers authentication required",
  );
  expectEqual(
    toAuthAppError(emailNotConfirmed ?? authFailure("rejected")).code,
    toAuthAppError(invalidCredentials ?? authFailure("rejected")).code,
    "an unconfirmed address answers exactly like a wrong password",
  );
  expectEqual(
    toAuthAppError(unknownUser ?? authFailure("rejected")).code,
    toAuthAppError(invalidCredentials ?? authFailure("rejected")).code,
    "an unknown account answers exactly like a wrong password",
  );
  expectEqual(
    toAuthAppError(invalidCredentials ?? authFailure("rejected"), "registration").code,
    "VALIDATION_FAILED",
    "a rejected registration is a validation failure",
  );

  const rateLimited = classifyAuthAnswer({
    status: 429,
    body: { code: "over_request_rate_limit" },
    retryAfterSeconds: 12,
  });
  const rateLimitedWithoutHeader = classifyAuthAnswer({
    status: 429,
    body: null,
    retryAfterSeconds: null,
  });

  expectEqual(rateLimited?.kind, "rate-limited", "a 429 is a rate limit");
  expectEqual(rateLimited?.retryAfterSeconds, 12, "the upstream delay is kept");
  expectEqual(
    toAuthAppError(rateLimited ?? authFailure("rate-limited")).retryAfterSeconds,
    12,
    "the catalogue answer carries the delay",
  );
  expectEqual(
    rateLimitedWithoutHeader?.retryAfterSeconds,
    60,
    "a rate limit without a delay gets the documented default",
  );

  expectEqual(
    classifyAuthAnswer({ status: 503, body: null, retryAfterSeconds: null })?.kind,
    "upstream",
    "a provider failure is an upstream failure",
  );
  expectEqual(
    classifyAuthAnswer({ status: 418, body: null, retryAfterSeconds: null })?.kind,
    "upstream",
    "an unexpected status is an upstream failure",
  );
  expectEqual(
    toAuthAppError(authFailure("upstream")).code,
    "DEPENDENCY_FAILED",
    "an upstream failure answers dependency failed",
  );
  expectEqual(
    toAuthAppError(authFailure("timeout")).code,
    "TIMEOUT",
    "a timeout answers timeout",
  );
  expectEqual(
    toAuthAppError(authFailure("network")).code,
    "DEPENDENCY_FAILED",
    "a network failure answers dependency failed",
  );
  expectEqual(
    toAuthAppError(authFailure("malformed-response")).code,
    "DEPENDENCY_FAILED",
    "an unreadable answer answers dependency failed",
  );

  expectEqual(
    readUpstreamCode({ code: "invalid_credentials" }),
    "invalid_credentials",
    "an upstream code is read",
  );
  expectEqual(
    readUpstreamCode({ error: "invalid_grant" }),
    "invalid_grant",
    "the legacy error field is read",
  );
  expectEqual(
    readUpstreamCode({ code: "Invalid login credentials for the supplied address" }),
    null,
    "a sentence is not accepted as a code",
  );
  expectEqual(readUpstreamCode("a string body"), null, "a string body has no code");
  expectEqual(readUpstreamCode([{ code: "x" }]), null, "an array body has no code");

  const rejection = credentialRejectionError();

  expectEqual(rejection.code, "AUTHENTICATION_REQUIRED", "the sign in rejection is the generic one");
  expectEqual(rejection.status, 401, "the sign in rejection answers 401");
  expectEqual(
    rejection.message,
    "AUTHENTICATION_REQUIRED",
    "the rejection carries a code and never a sentence",
  );
  expectEqual(
    credentialRejectionError().message,
    credentialRejectionError().message,
    "two sign in rejections are identical",
  );

  const withCode = toAuthAppError({
    kind: "rejected",
    status: 400,
    code: "invalid_credentials",
    retryAfterSeconds: null,
  });

  expect(
    !JSON.stringify({ code: withCode.code, message: withCode.message }).includes("invalid_credentials"),
    "no upstream code reaches the failure a caller sees",
  );
}

/* ------------------------------------------------------------------ 5. transport */

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function checkTransport(): Promise<void> {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchStub: AuthFetch = (url, init) => {
    seen.push({ url, init });

    return Promise.resolve(jsonResponse({ ok: true }, 200, { "retry-after": "30" }));
  };
  const http = createAuthHttp({ fetch: fetchStub });

  const answer = await http.send({
    method: "POST",
    url: config.endpoints.token,
    apiKey: config.anonymousKey,
    bearerToken: "access-token",
    body: { email: "owner@example.com" },
  });

  expect(answer.ok, "a successful answer is returned");

  const call = seen[0];

  expect(call !== undefined, "the transport performed one request");

  if (call === undefined || !answer.ok) {
    return;
  }

  expectEqual(call.init.method, "POST", "the method reaches fetch");
  expectEqual(call.init.redirect, "error", "a redirect is an error, never a hop");
  expectEqual(call.init.credentials, "omit", "no process cookie jar reaches the provider");
  expectEqual(answer.value.status, 200, "the status is returned");

  const headers = new Headers(call.init.headers);

  expectEqual(headers.get("apikey"), config.anonymousKey, "the key travels as the apikey header");
  expectEqual(headers.get("authorization"), "Bearer access-token", "a bearer token is sent when given");
  expectEqual(headers.get("content-type"), "application/json", "a body is JSON");
  expectEqual(headers.get("x-client-info"), "kd-solution-it", "the client identifies the platform");
  expect(!call.url.includes("anon-key"), "no key is placed in a URL");
  expectEqual(answer.value.retryAfterSeconds, 30, "the retry-after header is read");

  const emptyBody = await createAuthHttp({
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
  }).send({ method: "POST", url: config.endpoints.logout, apiKey: config.anonymousKey });

  expect(emptyBody.ok && emptyBody.value.body === null, "an answer without a body is null");

  const timeout = await createAuthHttp({
    fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(!timeout.ok && timeout.failure.kind === "timeout", "a timeout is a timeout failure");

  const network = await createAuthHttp({
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(!network.ok && network.failure.kind === "network", "a socket failure is a network failure");

  const controller = new AbortController();
  const cancelled = await createAuthHttp({
    fetch: () => {
      controller.abort();

      return Promise.reject(new DOMException("aborted", "AbortError"));
    },
  }).send({
    method: "GET",
    url: config.endpoints.user,
    apiKey: config.anonymousKey,
    signal: controller.signal,
  });

  expect(
    !cancelled.ok && cancelled.failure.kind === "network",
    "a call the caller cancelled is not reported as a timeout",
  );

  const malformed = await createAuthHttp({
    fetch: () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(
    !malformed.ok && malformed.failure.kind === "malformed-response",
    "a body that is not JSON is a malformed answer",
  );

  const oversizedDeclared = await createAuthHttp({
    fetch: () =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-length": "70000" } }),
      ),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(
    !oversizedDeclared.ok && oversizedDeclared.failure.kind === "malformed-response",
    "a declared length over the ceiling is refused before reading",
  );

  const oversizedBody = await createAuthHttp({
    maximumResponseBytes: 16,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ value: "x".repeat(64) }))),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(
    !oversizedBody.ok && oversizedBody.failure.kind === "malformed-response",
    "a body over the ceiling is refused after reading",
  );

  const noBody = await createAuthHttp({
    fetch: (_url, init) => {
      expect(new Headers(init.headers).get("content-type") === null, "no body means no content type");

      return Promise.resolve(jsonResponse({}));
    },
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(noBody.ok, "a GET without a body is accepted");
}

/* ------------------------------------------------------------------ 6. directory */

const activeOwner: ActorRecord = {
  userId: USER_ID,
  companyId: FIRM_ID,
  status: "active",
  roles: ["owner"],
  emailVerifiedAtEpochMs: NOW - 86_400_000,
  totpConfirmedAtEpochMs: NOW - 86_400_000,
  deletedAtEpochMs: null,
};

async function checkDirectory(): Promise<void> {
  expectEqual(liveRoles([{ role: "owner" }]).length, 1, "a live grant is kept");

  const filtered = liveRoles([
    { role: "support" },
    { role: "owner" },
    { role: "support" },
    { role: "ceo" },
    { role: "not_a_role" },
  ]);

  expectEqual(filtered.length, 3, "duplicate and unknown roles are dropped");
  expectEqual(filtered[0], "ceo", "roles are sorted");
  expectEqual(filtered[1], "owner", "roles are sorted");
  expectEqual(filtered[2], "support", "roles are sorted");

  const memoryDirectory = createInMemoryActorDirectory([activeOwner]);

  expectEqual((await memoryDirectory.findActor(USER_ID))?.userId, USER_ID, "memory finds an actor");
  expectEqual(await memoryDirectory.findActor(OTHER_USER_ID), null, "memory misses an unknown actor");

  const stub = createStubHttp(
    okAnswer(200, [
      {
        id: USER_ID,
        company_id: FIRM_ID,
        status: "active",
        email_verified_at: "2026-01-01T00:00:00.000Z",
        totp_confirmed_at: "2026-01-02T00:00:00.000Z",
        deleted_at: null,
        role_assignments: [
          { role: "owner", revoked_at: null, deleted_at: null },
          { role: "support", revoked_at: "2026-01-03T00:00:00.000Z", deleted_at: null },
          { role: "ceo", revoked_at: null, deleted_at: "2026-01-04T00:00:00.000Z" },
        ],
      },
    ]),
  );
  const directory = createSupabaseActorDirectory(config, stub.http);
  const actor = await directory.findActor(USER_ID);
  const request = firstRequest(stub.requests, "the directory asked the database");

  if (request !== null) {
    expect(request.url.startsWith(`${config.endpoints.usersTable}?select=`), "the lookup names its columns");
    expect(request.url.includes(`id=eq.${USER_ID}`), "the lookup filters on the primary key");
    expect(request.url.includes("limit=1"), "the lookup asks for one row");
    expect(!request.url.includes("select=*"), "the lookup never selects every column");
    expect(!request.url.includes("password"), "the lookup never reads a credential");
    expectEqual(request.apiKey, config.serviceRoleKey, "the lookup uses the service role key");
    expectEqual(request.bearerToken, config.serviceRoleKey, "the lookup authenticates as service role");
  }

  expectEqual(actor?.userId, USER_ID, "the directory maps the row");
  expectEqual(actor?.companyId, FIRM_ID, "the directory maps the company");
  expectEqual(actor?.roles.length, 1, "only live grants become roles");
  expectEqual(actor?.roles[0], "owner", "the live grant is the owner role");
  expectEqual(
    actor?.totpConfirmedAtEpochMs,
    Date.parse("2026-01-02T00:00:00.000Z"),
    "the TOTP instant is mapped",
  );
  expectEqual(actor?.deletedAtEpochMs, null, "a live account has no deletion instant");

  const emptyStub = createStubHttp(okAnswer(200, []));

  expectEqual(
    await createSupabaseActorDirectory(config, emptyStub.http).findActor(USER_ID),
    null,
    "no row is no actor",
  );

  const invalidStub = createStubHttp(okAnswer(200, []));

  expectEqual(
    await createSupabaseActorDirectory(config, invalidStub.http).findActor("not-a-uuid"),
    null,
    "a subject that is not a uuid is not looked up",
  );
  expectEqual(invalidStub.requests.length, 0, "a subject that is not a uuid sends no query");

  const duplicatedStub = createStubHttp(
    okAnswer(200, [
      {
        id: USER_ID,
        company_id: null,
        status: "active",
        email_verified_at: null,
        totp_confirmed_at: null,
        deleted_at: null,
        role_assignments: [],
      },
      {
        id: USER_ID,
        company_id: null,
        status: "active",
        email_verified_at: null,
        totp_confirmed_at: null,
        deleted_at: null,
        role_assignments: [],
      },
    ]),
  );

  await expectRejects(
    () => createSupabaseActorDirectory(config, duplicatedStub.http).findActor(USER_ID),
    "DEPENDENCY_FAILED",
    "two rows for one primary key are a platform failure",
  );

  const brokenStub = createStubHttp(failureAnswer(authFailure("upstream", 503)));

  await expectRejects(
    () => createSupabaseActorDirectory(config, brokenStub.http).findActor(USER_ID),
    "DEPENDENCY_FAILED",
    "a directory outage is not an empty role list",
  );

  const unauthorisedStub = createStubHttp(okAnswer(401, { message: "no" }));

  await expectRejects(
    () => createSupabaseActorDirectory(config, unauthorisedStub.http).findActor(USER_ID),
    "DEPENDENCY_FAILED",
    "a rejected service key is a deployment failure, not a merchant problem",
  );

  const malformedStub = createStubHttp(okAnswer(200, [{ id: USER_ID, status: "unknown_status" }]));

  await expectRejects(
    () => createSupabaseActorDirectory(config, malformedStub.http).findActor(USER_ID),
    "DEPENDENCY_FAILED",
    "a status the schema does not allow is a platform failure",
  );

  const badTimestampStub = createStubHttp(
    okAnswer(200, [
      {
        id: USER_ID,
        company_id: null,
        status: "active",
        email_verified_at: "not-a-date",
        totp_confirmed_at: null,
        deleted_at: null,
        role_assignments: [],
      },
    ]),
  );

  await expectRejects(
    () => createSupabaseActorDirectory(config, badTimestampStub.http).findActor(USER_ID),
    "DEPENDENCY_FAILED",
    "a timestamp that cannot be parsed is a platform failure",
  );
}

/* ------------------------------------------------------------------ 7. session */

function sessionCookie(
  policy: AuthCookiePolicy,
  claims: Readonly<Record<string, unknown>>,
  overrides: Partial<SessionCookiePayload> = {},
): string {
  const payload = sessionPayload({
    accessToken: makeAccessToken(claims),
    expiresAtEpochMs: Number(claims["exp"] ?? 0) * 1000,
    ...overrides,
  });

  return bareCookies(encodeSessionCookies(policy, payload, NOW));
}

async function checkSession(): Promise<void> {
  const policy = cookiePolicy();
  const directory = createInMemoryActorDirectory([
    activeOwner,
    {
      userId: OTHER_USER_ID,
      companyId: null,
      status: "active",
      roles: ["support"],
      emailVerifiedAtEpochMs: NOW,
      totpConfirmedAtEpochMs: null,
      deletedAtEpochMs: null,
    },
  ]);

  const authenticated = await readSession(sessionCookie(policy, baseClaims()), {
    directory,
    cookiePolicy: policy,
    nowEpochMs: NOW,
  });

  expectEqual(authenticated.kind, "authenticated", "a valid session authenticates");

  if (authenticated.kind === "authenticated") {
    expectEqual(authenticated.actor.userId, USER_ID, "the actor is the cookie subject");
    expectEqual(authenticated.actor.companyId, FIRM_ID, "the actor carries the company");
    expectEqual(authenticated.actor.sessionId, SESSION_ID, "the actor carries the session");
    expectEqual(authenticated.actor.roles[0], "owner", "the actor carries the roles");
    expectEqual(authenticated.actor.emailVerified, true, "a verified account is marked verified");
    expectEqual(authenticated.actor.twoFactorSatisfied, false, "an aal1 session is one factor short");
    expect(
      !authenticated.actor.twoFactorEnrolmentRequired,
      "an account with a confirmed TOTP needs no enrolment",
    );
    expectEqual(hasRole(authenticated.actor, "owner"), true, "the actor holds its role");
    expectEqual(hasRole(authenticated.actor, "ceo"), false, "the actor does not hold another role");
    expectEqual(
      hasAnyRole(authenticated.actor, ["ceo", "owner"]),
      true,
      "any of the listed roles is enough",
    );
    expectEqual(
      requireAnyRole(authenticated.actor, ["ceo", "owner"]).userId,
      USER_ID,
      "a required role is returned",
    );
    expectAppError(
      () => requireAnyRole(authenticated.actor, ["ceo", "support"]),
      "PERMISSION_DENIED",
      "a missing role is a permission failure, not an authentication failure",
    );
    expectEqual(
      requireCompanyId(authenticated.actor),
      FIRM_ID,
      "an owner acts for one company",
    );
    expectEqual(
      hasSatisfiedTwoFactor(authenticated.actor),
      false,
      "one factor is not enough for a role holder",
    );
  }

  const secondFactor = await readSession(
    sessionCookie(policy, baseClaims({ aal: "aal2" })),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  if (secondFactor.kind === "authenticated") {
    expectEqual(secondFactor.actor.twoFactorSatisfied, true, "aal2 satisfies the second factor");
    expectEqual(hasSatisfiedTwoFactor(secondFactor.actor), true, "aal2 with TOTP is complete");
  } else {
    failures.push("an aal2 session must authenticate");
    checkCount += 1;
  }

  const unenrolled = await readSession(
    sessionCookie(policy, baseClaims({ sub: OTHER_USER_ID, session_id: null }), {
      userId: OTHER_USER_ID,
      sessionId: null,
    }),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  if (unenrolled.kind === "authenticated") {
    expectEqual(unenrolled.actor.companyId, null, "a platform account has no company");
    expectEqual(
      unenrolled.actor.twoFactorEnrolmentRequired,
      true,
      "a role holder without a TOTP must enrol",
    );
    expectEqual(
      hasSatisfiedTwoFactor(unenrolled.actor),
      false,
      "an unenrolled role holder may not act",
    );
    expectAppError(
      () => requireCompanyId(unenrolled.actor),
      "PERMISSION_DENIED",
      "a platform account has no company to act for",
    );
  } else {
    failures.push("a platform account session must authenticate");
    checkCount += 1;
  }

  const withoutCookie = await readSession(null, {
    directory,
    cookiePolicy: policy,
    nowEpochMs: NOW,
  });

  expectEqual(withoutCookie.kind, "unauthenticated", "no cookie is no session");
  expectEqual(
    withoutCookie.kind === "unauthenticated" ? withoutCookie.reason : "authenticated",
    "no-cookie",
    "no cookie is the documented reason",
  );
  expectAppError(
    () => requireActor(withoutCookie),
    "AUTHENTICATION_REQUIRED",
    "a missing session answers authentication required",
  );

  const malformed = await readSession(`${policy.name}=not-our-payload`, {
    directory,
    cookiePolicy: policy,
    nowEpochMs: NOW,
  });

  expectEqual(
    malformed.kind === "unauthenticated" ? malformed.reason : "authenticated",
    "malformed-cookie",
    "a broken cookie is a malformed cookie",
  );

  const badToken = await readSession(
    bareCookies(
      encodeSessionCookies(policy, sessionPayload({ accessToken: "not-a-token" }), NOW),
    ),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  expectEqual(
    badToken.kind === "unauthenticated" ? badToken.reason : "authenticated",
    "malformed-token",
    "a token that is not a token is a malformed token",
  );

  const expired = await readSession(
    sessionCookie(policy, baseClaims({ exp: Math.floor(NOW / 1000) - 600 })),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  expectEqual(
    expired.kind === "unauthenticated" ? expired.reason : "authenticated",
    "expired-token",
    "an expired token is refused",
  );

  const substituted = await readSession(
    sessionCookie(policy, baseClaims(), {
      accessToken: makeAccessToken(baseClaims({ sub: OTHER_USER_ID })),
      userId: USER_ID,
    }),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  expectEqual(
    substituted.kind === "unauthenticated" ? substituted.reason : "authenticated",
    "malformed-cookie",
    "a cookie naming one user cannot carry the token of another",
  );

  const foreignSession = await readSession(
    sessionCookie(policy, baseClaims(), { sessionId: "018f3b1c-5555-7c2a-9d1e-2b3c4d5e6f74" }),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  expectEqual(
    foreignSession.kind === "unauthenticated" ? foreignSession.reason : "authenticated",
    "malformed-cookie",
    "a cookie naming another session is refused",
  );

  const unknownAccount = await readSession(
    sessionCookie(
      policy,
      baseClaims({ sub: "018f3b1c-9999-7c2a-9d1e-2b3c4d5e6f75" }),
      { userId: "018f3b1c-9999-7c2a-9d1e-2b3c4d5e6f75" },
    ),
    { directory, cookiePolicy: policy, nowEpochMs: NOW },
  );

  expectEqual(
    unknownAccount.kind === "unauthenticated" ? unknownAccount.reason : "authenticated",
    "unknown-account",
    "a subject with no platform row has no session",
  );

  for (const status of ["suspended", "closed"] as const) {
    const suspendedDirectory = createInMemoryActorDirectory([
      { ...activeOwner, status },
    ]);
    const state = await readSession(sessionCookie(policy, baseClaims()), {
      directory: suspendedDirectory,
      cookiePolicy: policy,
      nowEpochMs: NOW,
    });

    expectEqual(
      state.kind === "unauthenticated" ? state.reason : "authenticated",
      status === "suspended" ? "suspended-account" : "closed-account",
      `a ${status} account is refused`,
    );
    expectAppError(
      () => requireActor(state),
      "AUTHENTICATION_REQUIRED",
      `a ${status} account answers authentication required`,
    );
  }

  const deletedDirectory = createInMemoryActorDirectory([
    { ...activeOwner, deletedAtEpochMs: NOW - 1_000 },
  ]);
  const deleted = await readSession(sessionCookie(policy, baseClaims()), {
    directory: deletedDirectory,
    cookiePolicy: policy,
    nowEpochMs: NOW,
  });

  expectEqual(
    deleted.kind === "unauthenticated" ? deleted.reason : "authenticated",
    "deleted-account",
    "a deleted account is refused",
  );

  const failingDirectory = {
    findActor: (): Promise<ActorRecord | null> => Promise.reject(new AppError("TIMEOUT")),
  };

  await expectRejects(
    () =>
      readSession(sessionCookie(policy, baseClaims()), {
        directory: failingDirectory,
        cookiePolicy: policy,
        nowEpochMs: NOW,
      }),
    "TIMEOUT",
    "a directory failure propagates instead of signing the merchant out",
  );

  expectEqual(
    isTwoFactorEnrolmentRequired({
      ...activeOwner,
      roles: [],
    }),
    false,
    "an account with no role needs no second factor",
  );
  expectEqual(
    isTwoFactorEnrolmentRequired({ ...activeOwner, totpConfirmedAtEpochMs: null }),
    true,
    "a role holder without a TOTP needs one",
  );

  const roles: readonly PlatformRole[] = ["owner", "ceo"];

  expectEqual(roles.length, 2, "the gate's role fixture is two roles");
}

/* ------------------------------------------------------------------ 8. client */

function sessionBody(): Record<string, unknown> {
  return {
    access_token: makeAccessToken(baseClaims()),
    refresh_token: "refresh-token-000000000000000000",
    expires_in: 3_600,
    token_type: "bearer",
    user: {
      id: USER_ID,
      email: "owner@example.com",
      email_confirmed_at: "2026-01-01T00:00:00.000Z",
      phone: null,
      last_sign_in_at: "2026-01-05T00:00:00.000Z",
      user_metadata: { full_name: "Owner Name" },
    },
  };
}

async function checkClient(): Promise<void> {
  const signInStub = createStubHttp(okAnswer(200, sessionBody()));
  const client = createAuthClient(config, signInStub.http);
  const signedIn = await client.signInWithPassword({
    email: "owner@example.com",
    password: "a-long-password",
  });
  const signInRequest = firstRequest(signInStub.requests, "the client asked for a token");

  if (signInRequest !== null) {
    expectEqual(
      signInRequest.url,
      `${config.endpoints.token}?grant_type=password`,
      "the password grant is the token endpoint",
    );
    expectEqual(signInRequest.apiKey, config.anonymousKey, "a browser path call uses the anonymous key");
    expectEqual(signInRequest.bearerToken, undefined, "a sign in carries no bearer token");
    expectEqual(
      JSON.stringify(signInRequest.body),
      JSON.stringify({ email: "owner@example.com", password: "a-long-password" }),
      "the credentials are the request body",
    );
  }

  expect(signedIn.ok, "a successful sign in returns a session");

  if (signedIn.ok) {
    expectEqual(signedIn.value.user.id, USER_ID, "the session names the user");
    expectEqual(signedIn.value.user.email, "owner@example.com", "the session carries the address");
    expectEqual(signedIn.value.user.fullName, "Owner Name", "the session carries the name");
    expectEqual(
      signedIn.value.user.emailConfirmedAtEpochMs,
      Date.parse("2026-01-01T00:00:00.000Z"),
      "the confirmation instant is mapped",
    );
    expectEqual(signedIn.value.refreshToken, "refresh-token-000000000000000000", "the refresh token is kept");
    expectEqual(signedIn.value.expiresInSeconds, 3_600, "the lifetime is kept");
    expect(
      signedIn.value.expiresAtEpochMs > Date.now() + 3_000_000,
      "the expiry is computed from the lifetime when the provider omits it",
    );
  }

  const wrongPassword = await createAuthClient(
    config,
    createStubHttp(okAnswer(400, { code: "invalid_credentials", message: "Invalid login" })).http,
  ).signInWithPassword({ email: "owner@example.com", password: "wrong" });
  const unknownEmail = await createAuthClient(
    config,
    createStubHttp(okAnswer(400, { code: "user_not_found", message: "User not found" })).http,
  ).signInWithPassword({ email: "stranger@example.com", password: "wrong" });

  expect(!wrongPassword.ok, "a wrong password is not a session");
  expect(!unknownEmail.ok, "an unknown address is not a session");
  expectEqual(
    !wrongPassword.ok ? wrongPassword.failure.kind : "ok",
    !unknownEmail.ok ? unknownEmail.failure.kind : "different",
    "a wrong password and an unknown address fail identically",
  );
  expectEqual(
    !wrongPassword.ok ? wrongPassword.failure.code : null,
    "invalid_credentials",
    "the upstream reason is kept as a machine code for the log",
  );
  expect(
    !toAuthAppError(!wrongPassword.ok ? wrongPassword.failure : authFailure("rejected"))
      .message.includes("invalid_credentials"),
    "the upstream reason never reaches the failure a caller reads",
  );

  if (!wrongPassword.ok && !unknownEmail.ok) {
    expectEqual(
      toAuthAppError(wrongPassword.failure).code,
      toAuthAppError(unknownEmail.failure).code,
      "both failures map to one catalogue code",
    );
  }

  const rateLimitedSignIn = await createAuthClient(
    config,
    createStubHttp(okAnswer(429, { code: "over_request_rate_limit" }, 12)).http,
  ).signInWithPassword({ email: "owner@example.com", password: "wrong" });

  expect(
    !rateLimitedSignIn.ok && rateLimitedSignIn.failure.kind === "rate-limited",
    "a rate limited sign in is reported as a rate limit",
  );

  const refreshStub = createStubHttp(okAnswer(200, sessionBody()));
  const refreshed = await createAuthClient(config, refreshStub.http).refreshSession("refresh-token");
  const refreshRequest = firstRequest(refreshStub.requests, "the client refreshed a session");

  if (refreshRequest !== null) {
    expectEqual(
      refreshRequest.url,
      `${config.endpoints.token}?grant_type=refresh_token`,
      "the refresh grant is the token endpoint",
    );
    expectEqual(
      JSON.stringify(refreshRequest.body),
      JSON.stringify({ refresh_token: "refresh-token" }),
      "the refresh token is the body",
    );
  }

  expect(refreshed.ok, "a refresh returns a session");

  const signUpStub = createStubHttp(
    okAnswer(200, {
      id: USER_ID,
      email: "owner@example.com",
      email_confirmed_at: null,
      user_metadata: { full_name: "Owner Name" },
    }),
  );
  const signUp = await createAuthClient(config, signUpStub.http).signUpWithPassword({
    email: "owner@example.com",
    password: "a-long-password",
    fullName: "Owner Name",
    redirectTo: "https://app.example.com/verify",
  });
  const signUpRequest = firstRequest(signUpStub.requests, "the client registered an account");

  if (signUpRequest !== null) {
    expectEqual(
      signUpRequest.url,
      `${config.endpoints.signUp}?redirect_to=${encodeURIComponent("https://app.example.com/verify")}`,
      "the confirmation link returns to the platform",
    );
    expect(
      JSON.stringify(signUpRequest.body).includes('"full_name":"Owner Name"'),
      "the name is stored as user metadata",
    );
    expect(
      !JSON.stringify(signUpRequest.body).includes("redirect"),
      "the redirect is never placed in the body",
    );
  }

  expect(signUp.ok, "a registration is accepted");

  if (signUp.ok) {
    expectEqual(signUp.value.userId, USER_ID, "the registration names the platform account id");
    expectEqual(signUp.value.session, null, "an unconfirmed registration has no session yet");
  }

  const signUpWithSession = await createAuthClient(
    config,
    createStubHttp(
      okAnswer(200, {
        ...sessionBody(),
        user: { id: USER_ID, email: "owner@example.com" },
      }),
    ).http,
  ).signUpWithPassword({
    email: "owner@example.com",
    password: "a-long-password",
    fullName: "Owner Name",
  });

  expect(
    signUpWithSession.ok && signUpWithSession.value.session !== null,
    "a project without confirmation returns a session on sign up",
  );

  const malformedSignUp = await createAuthClient(
    config,
    createStubHttp(okAnswer(200, {})).http,
  ).signUpWithPassword({
    email: "owner@example.com",
    password: "a-long-password",
    fullName: "Owner Name",
  });

  expect(!malformedSignUp.ok, "a registration answer without an id is a failure");

  const verifyStub = createStubHttp(okAnswer(200, sessionBody()));
  const verified = await createAuthClient(config, verifyStub.http).verifyEmailToken({
    tokenHash: "token-hash-value",
    type: "signup",
  });
  const verifyRequest = firstRequest(verifyStub.requests, "the client verified an email token");

  if (verifyRequest !== null) {
    expectEqual(verifyRequest.url, config.endpoints.verify, "the verify endpoint is used");
    expectEqual(
      JSON.stringify(verifyRequest.body),
      JSON.stringify({ token_hash: "token-hash-value", type: "signup" }),
      "the token hash and type are the body",
    );
  }

  expect(verified.ok, "a verified token returns a session");

  const resendAccepted = await createAuthClient(
    config,
    createStubHttp(okAnswer(422, { code: "email_exists" })).http,
  ).resendVerificationEmail("stranger@example.com");

  expect(resendAccepted.ok, "a resend never discloses whether the address exists");

  const recoverAccepted = await createAuthClient(
    config,
    createStubHttp(okAnswer(400, { code: "user_not_found" })).http,
  ).requestPasswordReset("stranger@example.com");

  expect(recoverAccepted.ok, "a recovery never discloses whether the address exists");

  const recoverRateLimited = await createAuthClient(
    config,
    createStubHttp(okAnswer(429, { code: "over_request_rate_limit" }, 30)).http,
  ).requestPasswordReset("owner@example.com");

  expect(
    !recoverRateLimited.ok && recoverRateLimited.failure.kind === "rate-limited",
    "a rate limit still reaches the caller",
  );

  const alreadySignedOut = await createAuthClient(
    config,
    createStubHttp(okAnswer(401, { code: "session_not_found" })).http,
  ).signOut("expired-token");

  expect(alreadySignedOut.ok, "signing out an expired session is a successful sign out");

  const signOutStub = createStubHttp(okAnswer(204, null));
  const signedOut = await createAuthClient(config, signOutStub.http).signOut("access-token");
  const signOutRequest = firstRequest(signOutStub.requests, "the client ended a session");

  if (signOutRequest !== null) {
    expectEqual(signOutRequest.url, config.endpoints.logout, "the logout endpoint is used");
    expectEqual(signOutRequest.bearerToken, "access-token", "the session token names the session");
    expectEqual(signOutRequest.apiKey, config.anonymousKey, "logout stays on the anonymous key");
  }

  expect(signedOut.ok, "a sign out succeeds");

  const userStub = createStubHttp(
    okAnswer(200, {
      id: USER_ID,
      email: "owner@example.com",
      email_confirmed_at: "2026-01-01T00:00:00.000Z",
      user_metadata: { full_name: "Owner Name" },
    }),
  );
  const user = await createAuthClient(config, userStub.http).getUser("access-token");
  const userRequest = firstRequest(userStub.requests, "the client read the user of a token");

  if (userRequest !== null) {
    expectEqual(userRequest.method, "GET", "the user endpoint is read with GET");
    expectEqual(userRequest.bearerToken, "access-token", "the token is presented as a bearer");
  }

  expect(user.ok, "a token with a user returns the user");
  expectEqual(user.ok ? user.value.id : null, USER_ID, "the user is mapped");

  const phoneOnly = await createAuthClient(
    config,
    createStubHttp(okAnswer(200, { id: USER_ID, email: null })).http,
  ).getUser("access-token");

  expect(!phoneOnly.ok, "an account without an email is not a platform account");

  const methodNames = Object.keys(client).sort();

  expectEqual(methodNames.length, 8, "the client exposes eight operations");
  expect(
    methodNames.includes("signInWithPassword") &&
      methodNames.includes("signUpWithPassword") &&
      methodNames.includes("verifyEmailToken") &&
      methodNames.includes("resendVerificationEmail") &&
      methodNames.includes("requestPasswordReset") &&
      methodNames.includes("refreshSession") &&
      methodNames.includes("signOut") &&
      methodNames.includes("getUser"),
    "the client exposes exactly the documented operations",
  );
}

/* ------------------------------------------------------------------ 9. admin client */

async function checkAdminClient(): Promise<void> {
  const stub = createStubHttp(okAnswer(200, { id: USER_ID, email: "owner@example.com" }));
  const admin = createAuthAdminClient(config, stub.http);
  const created = await admin.createUser({
    email: "owner@example.com",
    password: "a-long-password",
    fullName: "Owner Name",
    userId: USER_ID,
    emailConfirmed: true,
  });
  const createRequest = firstRequest(stub.requests, "the admin client created an account");

  if (createRequest !== null) {
    const body = createRequest.body as Readonly<Record<string, unknown>>;

    expectEqual(createRequest.method, "POST", "a creation is a POST");
    expectEqual(createRequest.url, config.endpoints.adminUsers, "the admin endpoint is used");
    expectEqual(createRequest.apiKey, config.serviceRoleKey, "an admin call uses the service role key");
    expectEqual(
      createRequest.bearerToken,
      config.serviceRoleKey,
      "an admin call authenticates as the service role",
    );
    expectEqual(body["id"], USER_ID, "the account id is chosen by the platform");
    expectEqual(body["email_confirm"], true, "the bootstrap account is confirmed");
    expectEqual(
      JSON.stringify(body["user_metadata"]),
      JSON.stringify({ full_name: "Owner Name" }),
      "the name is metadata",
    );
    expect(!createRequest.url.includes("anon"), "an admin call never carries a key in the URL");
  }

  expect(created.ok, "a creation returns the account identifier");
  expectEqual(created.ok ? created.value.userId : null, USER_ID, "the created account is mapped");

  const updateStub = createStubHttp(okAnswer(200, { id: USER_ID, email: "new@example.com" }));
  const updated = await createAuthAdminClient(config, updateStub.http).updateUser(USER_ID, {
    email: "new@example.com",
  });
  const updateRequest = firstRequest(updateStub.requests, "the admin client updated an account");

  if (updateRequest !== null) {
    expectEqual(updateRequest.method, "PUT", "an update is a PUT");
    expectEqual(updateRequest.url, authAdminUserUrl(config, USER_ID), "the update names one account");
    expectEqual(
      JSON.stringify(updateRequest.body),
      JSON.stringify({ email: "new@example.com" }),
      "only the changed field is sent",
    );
  }

  expect(updated.ok, "an update returns the account");

  const noChange = createAuthAdminClient(config, createStubHttp().http);

  await expectRejects(
    () => noChange.updateUser(USER_ID, {}),
    "VALIDATION_FAILED",
    "an update with no change is refused",
  );
  await expectRejects(
    () => noChange.updateUser("not-a-uuid", { password: "a-long-password" }),
    "INTERNAL_ERROR",
    "an update of something that is not an account identifier is refused",
  );

  const deleteStub = createStubHttp(okAnswer(204, null));
  const deleted = await createAuthAdminClient(config, deleteStub.http).deleteUser(USER_ID);
  const deleteRequest = firstRequest(deleteStub.requests, "the admin client deleted an account");

  if (deleteRequest !== null) {
    expectEqual(deleteRequest.method, "DELETE", "a deletion is a DELETE");
    expectEqual(deleteRequest.url, authAdminUserUrl(config, USER_ID), "the deletion names one account");
  }

  expect(deleted.ok, "a deletion succeeds");

  const revokeStub = createStubHttp(okAnswer(204, null));
  const revoked = await createAuthAdminClient(config, revokeStub.http).revokeUserSessions(USER_ID);
  const revokeRequest = firstRequest(revokeStub.requests, "the admin client revoked every session");

  if (revokeRequest !== null) {
    expectEqual(revokeRequest.method, "POST", "a revocation is a POST");
    expect(
      revokeRequest.url.endsWith(`/logout?scope=global`),
      "a revocation ends every session of the account",
    );
    expect(
      revokeRequest.url.startsWith(authAdminUserUrl(config, USER_ID)),
      "a revocation names one account",
    );
  }

  expect(revoked.ok, "a revocation succeeds");

  const getStub = createStubHttp(okAnswer(200, { id: USER_ID, email: "owner@example.com" }));
  const fetched = await createAuthAdminClient(config, getStub.http).getUser(USER_ID);
  const getRequest = firstRequest(getStub.requests, "the admin client read one account");

  if (getRequest !== null) {
    expectEqual(getRequest.method, "GET", "a read is a GET");
    expectEqual(getRequest.url, authAdminUserUrl(config, USER_ID), "a read names one account");
  }

  expect(fetched.ok, "a read returns the account");

  const rejectedRead = await createAuthAdminClient(
    config,
    createStubHttp(okAnswer(404, { code: "user_not_found" })).http,
  ).getUser(USER_ID);

  expect(
    !rejectedRead.ok && rejectedRead.failure.kind === "rejected",
    "a missing account is reported as a rejection",
  );

  const adminMethodNames = Object.keys(admin).sort();

  expectEqual(adminMethodNames.length, 5, "the admin client exposes five operations");
  expect(
    adminMethodNames.every((name) => name !== "listUsers"),
    "the admin client can never page through every account",
  );
  expect(
    adminMethodNames.includes("revokeUserSessions") && adminMethodNames.includes("createUser"),
    "the admin client exposes the documented operations",
  );
}


/* ------------------------------------------------------------------ 10. secrets */

const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
const OTHER_MASTER_KEY = Buffer.alloc(32, 6).toString("base64");
const TURNSTILE_CONTEXT = secretContextFor("turnstile.secret_key");

function checkSecrets(): void {
  const box = sealSecret(MASTER_KEY, "turnstile-secret-value", TURNSTILE_CONTEXT);

  expect(isSecretBox(box), "a sealed secret has the three stored parts");
  expectEqual(box.iv.length, 16, "the vector is twelve bytes of base64url");
  expectEqual(box.tag.length, 22, "the tag is sixteen bytes of base64url");
  expectEqual(
    openSecret(MASTER_KEY, box, TURNSTILE_CONTEXT),
    "turnstile-secret-value",
    "a sealed secret opens with the same key and context",
  );
  expectAppError(
    () => openSecret(OTHER_MASTER_KEY, box, TURNSTILE_CONTEXT),
    "INTERNAL_ERROR",
    "a different master key cannot open a secret",
  );
  expectAppError(
    () => openSecret(MASTER_KEY, box, secretContextFor("turnstile.other")),
    "INTERNAL_ERROR",
    "a secret copied to another setting cannot open",
  );
  expectAppError(
    () =>
      openSecret(
        MASTER_KEY,
        {
          ...box,
          // The first character, because the last one carries bits a base64 decoder discards.
          ciphertext: `${box.ciphertext.startsWith("A") ? "B" : "A"}${box.ciphertext.slice(1)}`,
        },
        TURNSTILE_CONTEXT,
      ),
    "INTERNAL_ERROR",
    "a changed ciphertext cannot open",
  );
  expectAppError(
    () =>
      openSecret(
        MASTER_KEY,
        { ...box, tag: `${box.tag.startsWith("A") ? "B" : "A"}${box.tag.slice(1)}` },
        TURNSTILE_CONTEXT,
      ),
    "INTERNAL_ERROR",
    "a changed tag cannot open",
  );
  expectAppError(
    () => openSecret(Buffer.alloc(16, 1).toString("base64"), box, TURNSTILE_CONTEXT),
    "INTERNAL_ERROR",
    "a master key of the wrong length is refused",
  );
  expect(!isSecretBox({ iv: null, tag: "a", ciphertext: "b" }), "a box without a vector is not a box");
  expect(!isSecretBox({ iv: "a", tag: "b", ciphertext: "not base64!" }), "a box with a bad part is not a box");
  expect(
    sealSecret(MASTER_KEY, "same value", TURNSTILE_CONTEXT).ciphertext !==
      sealSecret(MASTER_KEY, "same value", TURNSTILE_CONTEXT).ciphertext,
    "two seals of one value differ because the vector is random",
  );
}

/* ------------------------------------------------------------------ 11. settings */

async function checkSettings(): Promise<void> {
  const memory = createInMemorySettings(
    { "turnstile.enabled": true, "other.value": 42 },
    { "turnstile.secret_key": "stored-secret" },
  );

  expectEqual(
    await memory.readValue("turnstile.enabled", z.boolean()),
    true,
    "a plain setting is read",
  );
  expectEqual(await memory.readValue("missing.key", z.boolean()), null, "a missing setting is null");
  await expectRejects(
    () => memory.readValue("turnstile.enabled", z.string()),
    "DEPENDENCY_FAILED",
    "a setting of the wrong type is refused rather than coerced",
  );
  expectEqual(await memory.readSecret("turnstile.secret_key"), "stored-secret", "a secret is read");
  expectEqual(await memory.readSecret("turnstile.missing"), null, "a missing secret is null");

  const stub = createStubHttp(
    okAnswer(200, [
      {
        setting_key: "turnstile.secret_key",
        value: null,
        is_secret: true,
        secret_iv: "1",
        secret_tag: "2",
        secret_ciphertext: "3",
      },
    ]),
  );
  const restSettings = createRestSettings(config, stub.http, () => MASTER_KEY);

  await expectRejects(
    () => restSettings.readSecret("turnstile.secret_key"),
    "DEPENDENCY_FAILED",
    "a stored secret whose parts are not a box is a platform failure",
  );

  const request = firstRequest(stub.requests, "the settings reader asked the database");

  if (request !== null) {
    expect(
      request.url.includes("setting_key=eq.turnstile.secret_key"),
      "the settings reader asks for one key",
    );
    expect(request.url.includes("deleted_at=is.null"), "the settings reader ignores a removed row");
    expect(request.url.includes("select=*") === false, "the settings reader names its columns");
    expectEqual(request.apiKey, config.serviceRoleKey, "the settings reader uses the server key");
  }

  const sealed = sealSecret(MASTER_KEY, "cloudflare-secret", TURNSTILE_CONTEXT);
  const secretStub = createStubHttp(
    okAnswer(200, [
      {
        setting_key: "turnstile.secret_key",
        value: null,
        is_secret: true,
        secret_iv: sealed.iv,
        secret_tag: sealed.tag,
        secret_ciphertext: sealed.ciphertext,
      },
    ]),
  );

  expectEqual(
    await createRestSettings(config, secretStub.http, () => MASTER_KEY).readSecret(
      "turnstile.secret_key",
    ),
    "cloudflare-secret",
    "a stored secret opens with the deployment key",
  );

  const valueStub = createStubHttp(
    okAnswer(200, [
      {
        setting_key: "turnstile.enabled",
        value: true,
        is_secret: false,
        secret_iv: null,
        secret_tag: null,
        secret_ciphertext: null,
      },
    ]),
  );

  expectEqual(
    await createRestSettings(config, valueStub.http, () => MASTER_KEY).readValue(
      "turnstile.enabled",
      z.boolean(),
    ),
    true,
    "a plain setting is read through the database",
  );
}

/* ------------------------------------------------------------------ 12. turnstile */

async function checkTurnstile(): Promise<void> {
  const endpoint = "https://turnstile.gate/siteverify";
  const enabledSettings = createInMemorySettings(
    { "turnstile.enabled": true },
    { "turnstile.secret_key": "cloudflare-secret" },
  );

  const verifiedStub = createStubHttp(okAnswer(200, { success: true }));
  const verified = await createTurnstileGuard({
    settings: enabledSettings,
    http: verifiedStub.http,
    isProduction: true,
    endpoint,
  }).check({ token: "widget-token", remoteIp: "203.0.113.9" });

  expect(verified.ok && verified.value === "verified", "an accepted challenge is verified");

  const request = firstRequest(verifiedStub.requests, "the guard asked Cloudflare");

  if (request !== null) {
    expectEqual(request.url, endpoint, "the guard calls siteverify");
    expectEqual(request.apiKey, "", "siteverify needs no project key");
    expectEqual(request.bearerToken, undefined, "siteverify needs no bearer");
    const form = request.form as Readonly<Record<string, string>>;
    expectEqual(form["secret"], "cloudflare-secret", "the secret travels in the form");
    expectEqual(form["response"], "widget-token", "the widget token travels in the form");
    expectEqual(form["remoteip"], "203.0.113.9", "the address travels when it is known");
    expect(
      JSON.stringify(request.headers ?? {}).includes("accept"),
      "the guard asks for JSON",
    );
  }

  const rejected = await createTurnstileGuard({
    settings: enabledSettings,
    http: createStubHttp(okAnswer(200, { success: false, "error-codes": ["invalid-input-response"] }))
      .http,
    isProduction: true,
    endpoint,
  }).check({ token: "widget-token", remoteIp: null });

  expect(
    !rejected.ok && rejected.failure.kind === "rejected" && rejected.failure.code === "invalid-input-response",
    "a refused challenge is a rejection with the Cloudflare code",
  );

  const withoutToken = await createTurnstileGuard({
    settings: enabledSettings,
    http: createStubHttp().http,
    isProduction: true,
    endpoint,
  }).check({ token: null, remoteIp: null });

  expect(!withoutToken.ok && withoutToken.failure.kind === "rejected", "a missing token is a rejection");

  const withoutSecret = await createTurnstileGuard({
    settings: createInMemorySettings({ "turnstile.enabled": true }),
    http: createStubHttp().http,
    isProduction: true,
    endpoint,
  }).check({ token: "widget-token", remoteIp: null });

  expect(
    !withoutSecret.ok && withoutSecret.failure.kind === "upstream",
    "an enabled switch without a secret is a deployment failure",
  );

  const disabledDevelopment = await createTurnstileGuard({
    settings: createInMemorySettings({ "turnstile.enabled": false }),
    http: createStubHttp().http,
    isProduction: false,
    endpoint,
  }).check({ token: null, remoteIp: null });

  expect(
    disabledDevelopment.ok && disabledDevelopment.value === "skipped",
    "a closed switch in development is skipped",
  );

  const disabledProduction = await createTurnstileGuard({
    settings: createInMemorySettings({ "turnstile.enabled": false }),
    http: createStubHttp().http,
    isProduction: true,
    endpoint,
  }).check({ token: "widget-token", remoteIp: null });

  expect(
    !disabledProduction.ok && disabledProduction.failure.kind === "upstream",
    "a closed switch in production refuses instead of skipping",
  );

  const providerDown = await createTurnstileGuard({
    settings: enabledSettings,
    http: createStubHttp(okAnswer(503, { success: false })).http,
    isProduction: true,
    endpoint,
  }).check({ token: "widget-token", remoteIp: null });

  expect(!providerDown.ok && providerDown.failure.kind === "upstream", "a 503 is an upstream failure");

  const malformed = await createTurnstileGuard({
    settings: enabledSettings,
    http: createStubHttp(okAnswer(200, { verdict: "yes" })).http,
    isProduction: true,
    endpoint,
  }).check({ token: "widget-token", remoteIp: null });

  expect(
    !malformed.ok && malformed.failure.kind === "malformed-response",
    "an answer without a verdict is malformed",
  );

  expectEqual(TURNSTILE_ENABLED_SETTING, "turnstile.enabled", "the switch key is documented");
  expectEqual(TURNSTILE_SECRET_SETTING, "turnstile.secret_key", "the secret key is documented");
}

/* ------------------------------------------------------------------ 13. audit */

const AUDIT_HASH = "b".repeat(64);
const AUDIT_PREV_HASH = "a".repeat(64);

function checkAudit(): void {
  const signingKey = Buffer.alloc(32, 9).toString("base64");
  const signature = signAuditHash(signingKey, AUDIT_HASH);

  expectEqual(signature.length, 86, "an Ed25519 signature is 86 base64url characters");
  expect(/^[A-Za-z0-9_-]{86}$/u.test(signature), "the signature matches the column check");
  expectEqual(
    signAuditHash(signingKey, AUDIT_HASH),
    signature,
    "Ed25519 signing is deterministic for one key and one hash",
  );
  expect(
    signAuditHash(signingKey, "c".repeat(64)) !== signature,
    "a different hash produces a different signature",
  );
  expectAppError(
    () => signAuditHash(signingKey, "not-a-hash"),
    "INTERNAL_ERROR",
    "a hash that is not 64 hex characters is refused",
  );
  expectAppError(
    () => signAuditHash(Buffer.alloc(16, 1).toString("base64"), AUDIT_HASH),
    "INTERNAL_ERROR",
    "a signing key of the wrong length is refused",
  );

  const trail = createInMemoryAuditTrail();

  void trail.append({
    action: "merchant.signed_up",
    actorUserId: USER_ID,
    entityType: "company",
    entityId: FIRM_ID,
    payload: { policies: [] },
    companyId: FIRM_ID,
  });

  expectEqual(trail.entries.length, 1, "the in memory trail keeps the entry");
  expectEqual(trail.entries[0]?.action, "merchant.signed_up", "the entry keeps its action");
}

async function checkRestAuditTrail(): Promise<void> {
  const signingKey = Buffer.alloc(32, 9).toString("base64");
  const stub = createStubHttp(
    okAnswer(200, [{ next_sequence: 5, prev_hash: AUDIT_PREV_HASH }]),
    okAnswer(200, AUDIT_HASH),
    okAnswer(201, null),
  );
  const trail = createRestAuditTrail({
    config,
    http: stub.http,
    signingKey: () => signingKey,
    now: () => NOW,
  });

  await trail.append({
    action: "merchant.signed_up",
    actorUserId: USER_ID,
    entityType: "company",
    entityId: FIRM_ID,
    payload: { policies: [{ key: "kyc_kyb", version: "2" }] },
    companyId: FIRM_ID,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });

  expectEqual(stub.requests.length, 3, "an audit entry is two functions and one insert");

  const linkCall = stub.requests[0];
  const hashCall = stub.requests[1];
  const insertCall = stub.requests[2];

  if (linkCall !== undefined) {
    expect(linkCall.url.endsWith("/rest/v1/rpc/audit_next_link"), "the chain head is asked first");
    expectEqual(
      (linkCall.body as Readonly<Record<string, unknown>>)["p_chain"],
      FIRM_ID,
      "the head is asked for the tenant chain",
    );
  }

  if (hashCall !== undefined) {
    const body = hashCall.body as Readonly<Record<string, unknown>>;

    expect(hashCall.url.endsWith("/rest/v1/rpc/audit_hash_v1"), "the canonical hash is computed");
    expectEqual(body["sequence"], 5, "the hash is computed for the next sequence");
    expectEqual(body["prev_hash"], AUDIT_PREV_HASH, "the hash links to the head");
    expectEqual(body["action"], "merchant.signed_up", "the hash covers the action");
    expectEqual(body["actor_user_id"], USER_ID, "the hash covers the actor");
  }

  if (insertCall !== undefined) {
    expectEqual(insertCall.method, "POST", "the row is inserted");
    expect(insertCall.url.endsWith("/rest/v1/audit_logs"), "the row goes to the audit table");

    const row = (insertCall.body as readonly Readonly<Record<string, unknown>>[])[0];

    if (row === undefined) {
      failures.push("the audit row must be inserted");
      checkCount += 1;
    } else {
      expectEqual(row["sequence"], 5, "the inserted row carries the sequence");
      expectEqual(row["prev_hash"], AUDIT_PREV_HASH, "the inserted row links to the head");
      expectEqual(row["hash"], AUDIT_HASH, "the inserted row carries the canonical hash");
      expectEqual(row["signing_key_id"], AUDIT_SIGNING_KEY_ID, "the row names the signing key");
      expectEqual(
        (row["signature"] as string).length,
        86,
        "the row carries the signature over the hash",
      );
      expectEqual(row["company_id"], FIRM_ID, "the row is on the tenant chain");
      expectEqual(row["created_at"], new Date(NOW).toISOString(), "the row carries its instant");
    }
  }

  const badAction = createRestAuditTrail({ config, http: createStubHttp().http, signingKey: () => signingKey });

  await expectRejects(
    () =>
      badAction.append({
        action: "Not An Action",
        actorUserId: null,
        entityType: null,
        entityId: null,
        payload: {},
        companyId: null,
      }),
    "INTERNAL_ERROR",
    "an action name that is not dotted lower case is refused",
  );
  await expectRejects(
    () =>
      badAction.append({
        action: "merchant.signed_up",
        actorUserId: null,
        entityType: "company",
        entityId: null,
        payload: {},
        companyId: null,
      }),
    "INTERNAL_ERROR",
    "an entity type without an identifier is refused",
  );
  await expectRejects(
    () =>
      badAction.append({
        action: "merchant.signed_up",
        actorUserId: null,
        entityType: null,
        entityId: null,
        payload: { padding: "x".repeat(9_000) },
        companyId: null,
      }),
    "INTERNAL_ERROR",
    "a payload over the column ceiling is refused",
  );
}

/* ------------------------------------------------------------------ 14. policies */

function policyPages(count: number = POLICY_KEYS.length): readonly PolicyPage[] {
  return POLICY_KEYS.slice(0, count).map((key, index) => ({
    key,
    slug: `policy-${index}`,
    title: `Policy ${index}`,
    body: `Policy body ${index}`,
    version: 2,
  }));
}

async function checkPolicies(): Promise<void> {
  expectEqual(
    policyDocumentSha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "the document hash is the SHA-256 of the text",
  );
  expectEqual(POLICY_KEYS.length, 12, "the platform closes twelve policy keys");
  expectEqual(REQUIRED_POLICY_KEYS.length, 12, "every policy is required at signup");

  const catalog = createInMemoryPolicyCatalog(policyPages());
  const published = await catalog.published(REQUIRED_POLICY_KEYS);

  expectEqual(published.length, 12, "a complete catalog answers twelve policies");
  expectEqual(published[0]?.key, "kyc_kyb", "the catalog keeps the request order");
  expectEqual(published[0]?.version, "2", "the version is the page row version");
  expectEqual(
    published[0]?.documentSha256,
    policyDocumentSha256("Policy body 0"),
    "the hash is the hash of the page body",
  );
  expect(catalogIsComplete(published), "twelve policies are a complete catalog");

  const partial = await createInMemoryPolicyCatalog(policyPages(11)).published(REQUIRED_POLICY_KEYS);

  expectEqual(partial.length, 11, "an incomplete catalog answers eleven policies");
  expect(!catalogIsComplete(partial), "an incomplete catalog is not complete");

  expect(
    acceptsEveryRequiredPolicy(REQUIRED_POLICY_KEYS),
    "accepting every required policy is enough",
  );
  expect(
    !acceptsEveryRequiredPolicy(REQUIRED_POLICY_KEYS.slice(0, 11)),
    "a missing policy is not enough",
  );
  expect(
    !acceptsEveryRequiredPolicy([...REQUIRED_POLICY_KEYS, "kyc_kyb"]),
    "accepting one policy twice is not enough",
  );
}

/* ------------------------------------------------------------------ 15. password */

async function checkPassword(): Promise<void> {
  const context = { email: "owner@example.com", companyName: "Acme Payments", fullName: "Owner Name" };

  assertPasswordAcceptable(COMPLIANT_PASSWORD, context);
  checkCount += 1;

  expectEqual(PASSWORD_MINIMUM_LENGTH, 12, "the policy floor is twelve characters");
  expectEqual(PASSWORD_MAXIMUM_LENGTH, 128, "the policy ceiling is one hundred and twenty eight");
  expectEqual(PASSWORD_MINIMUM_CHARACTER_KINDS, 3, "three of four kinds are required");
  expectEqual(characterKindsIn("aA1!"), 4, "four kinds are counted");
  expectEqual(characterKindsIn("abc"), 1, "one kind is counted");
  expectEqual(characterKindsIn("ab1"), 2, "two kinds are counted");
  expectEqual(
    passwordRuleViolation(COMPLIANT_PASSWORD, context),
    null,
    "a compliant password breaks no rule",
  );

  for (const [password, rule, label] of [
    ["short-pass1", "too_short", "a short password"],
    [` ${"a".repeat(20)}`, "surrounding_whitespace", "a password with a leading space"],
    ["aaaaaaaaaaaa", "too_repetitive", "a password of one character"],
    ["alllowercaseletters", "not_enough_character_kinds", "a password of one kind"],
    ["owner-is-my-password1", "contains_email_address", "a password containing the address"],
    ["acme-payments-2026", "contains_company_name", "a password containing the business name"],
    ["my-name-is-here-1", "contains_person_name", "a password containing the person"],
    [`${"A".repeat(128)}b1!`, "too_long", "a password above the ceiling"],
  ] as const) {
    const error = await expectRejects(
      () => Promise.resolve().then(() => assertPasswordAcceptable(password, context)),
      "VALIDATION_FAILED",
      `${label} is refused`,
    );

    expectEqual(error, undefined, `${label} is a validation failure`);
    expectEqual(passwordRuleViolation(password, context), rule, `${label} names its rule`);
  }

  await expectRejects(
    () => Promise.resolve().then(() => assertPasswordAcceptable("short-pass1", context)),
    "VALIDATION_FAILED",
    "the detail names the password field",
  );

  const stored = await hashPassword(COMPLIANT_PASSWORD);

  expect(stored.startsWith("scrypt$16384$8$1$"), "the stored hash names its parameters");
  expect(stored.length >= 20 && stored.length <= 255, "the stored hash fits the column");
  expect(await verifyPasswordHash(COMPLIANT_PASSWORD, stored), "the right password verifies");
  expect(!(await verifyPasswordHash(`${COMPLIANT_PASSWORD}x`, stored)), "a wrong password fails");
  expect(!(await verifyPasswordHash(COMPLIANT_PASSWORD, "not-a-hash")), "a broken row fails");
  expect(!(await verifyPasswordHash(COMPLIANT_PASSWORD, "scrypt$1$8$1$a$b")), "an unknown cost fails");
  expect((await hashPassword(COMPLIANT_PASSWORD)) !== stored, "two hashes of one password differ");
}

/* ------------------------------------------------------------------ 15b. breach check */

async function checkBreachCheck(): Promise<void> {
  const parts = breachHashParts("password");

  expectEqual(parts.prefix, "5BAA6", "the range prefix is the first five hex characters");
  expectEqual(parts.prefix.length + parts.suffix.length, 40, "the two halves are one SHA-1");
  expectEqual(breachHashParts("Password").prefix === parts.prefix, false, "the hash is case sensitive");

  const suffix = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";
  const answer = [
    "003D68EB55068C33ACE09247EE4C639306B:3",
    `${suffix}:3303003`,
    "1E4C9B93F3F0682250B6CF8331B7EE68FD9:0",
  ].join("\r\n");

  expectEqual(readBreachRange(answer, suffix), "breached", "a counted suffix is a breach");
  expectEqual(readBreachRange(answer, "0000000000000000000000000000000000F"), "clear", "a padded suffix is clear");
  expectEqual(readBreachRange("", suffix), "clear", "an empty range is clear");
  expectEqual(readBreachRange("not a range at all", suffix), null, "a body that is not a range is refused");

  const endpoint = "https://range.gate/range/";
  const enabledSettings = createInMemorySettings({ "password.breach_check.enabled": true });
  const foundStub = createStubHttp(okAnswer(200, answer));
  const found = await createBreachCheck({
    settings: enabledSettings,
    http: foundStub.http,
    isProduction: true,
    endpoint,
  }).check("password");

  expect(found.ok && found.value === "breached", "a corpus hit is a breach");

  const request = firstRequest(foundStub.requests, "the check asked the corpus");

  if (request !== null) {
    expectEqual(request.method, "GET", "the range is a GET");
    expectEqual(request.url, `${endpoint}${parts.prefix}`, "only the five character prefix leaves");
    expect(
      request.url.includes(suffix) === false,
      "the rest of the hash never appears in the request",
    );
    expectEqual(request.apiKey, "", "the corpus takes no key");
    expectEqual(request.responseFormat, "text", "the range is read as text");
    expectEqual(
      (request.headers as Readonly<Record<string, string>>)["add-padding"],
      "true",
      "the answer is padded",
    );
  }

  const clear = await createBreachCheck({
    settings: enabledSettings,
    http: createStubHttp(okAnswer(200, "003D68EB55068C33ACE09247EE4C639306B:3")).http,
    isProduction: true,
    endpoint,
  }).check("password");

  expect(clear.ok && clear.value === "clear", "a suffix outside the range is clear");

  const skipped = await createBreachCheck({
    settings: createInMemorySettings({ "password.breach_check.enabled": false }),
    http: createStubHttp().http,
    isProduction: false,
    endpoint,
  }).check("password");

  expect(skipped.ok && skipped.value === "skipped", "a closed switch outside production is skipped");

  const refused = await createBreachCheck({
    settings: createInMemorySettings({ "password.breach_check.enabled": false }),
    http: createStubHttp().http,
    isProduction: true,
    endpoint,
  }).check("password");

  expect(!refused.ok && refused.failure.kind === "upstream", "a closed switch in production refuses");

  const down = await createBreachCheck({
    settings: enabledSettings,
    http: createStubHttp(okAnswer(503, "")).http,
    isProduction: true,
    endpoint,
  }).check("password");

  expect(!down.ok && down.failure.kind === "upstream", "a corpus outage is an upstream failure");

  const garbage = await createBreachCheck({
    settings: enabledSettings,
    http: createStubHttp(okAnswer(200, "<html>nope</html>")).http,
    isProduction: true,
    endpoint,
  }).check("password");

  expect(!garbage.ok && garbage.failure.kind === "malformed-response", "an answer that is not a range is malformed");

  expectEqual(BREACH_CHECK_ENABLED_SETTING, "password.breach_check.enabled", "the switch key is documented");
}

/* ------------------------------------------------------------------ 16. registration */

interface RestCall {
  readonly kind: "select" | "insert" | "insertReturning" | "update" | "rpc";
  readonly table: string;
  readonly query: string | null;
  readonly rows: unknown;
}

interface StubRest {
  readonly rest: RestClient;
  readonly calls: readonly RestCall[];
}

function createStubRest(options: { readonly failInsertTable?: string } = {}): StubRest {
  const calls: RestCall[] = [];

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      calls.push({ kind: "select", table, query, rows: null });

      return Promise.resolve([]);
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      calls.push({ kind: "insert", table, query: null, rows });

      if (table === options.failInsertTable) {
        return Promise.reject(new AppError("DEPENDENCY_FAILED"));
      }

      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
    ): Promise<readonly TRow[]> {
      calls.push({ kind: "insertReturning", table, query: null, rows });

      if (table === options.failInsertTable) {
        return Promise.reject(new AppError("DEPENDENCY_FAILED"));
      }

      return Promise.resolve([{ id: FIRM_ID } as unknown as TRow]);
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      calls.push({ kind: "update", table, query, rows: values });

      return Promise.resolve();
    },
    rpc(table: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
      calls.push({ kind: "rpc", table, query: null, rows: body });

      return Promise.resolve(null);
    },
  };

  return { rest, calls };
}

const unavailableFailure: AuthFailure = {
  kind: "upstream",
  status: 503,
  code: null,
  retryAfterSeconds: null,
};

function stubAuthClient(overrides: Partial<AuthClient> = {}): AuthClient {
  const unavailable = <TValue>(): Promise<AuthOutcome<TValue>> =>
    Promise.resolve({ ok: false, failure: unavailableFailure });

  return {
    signInWithPassword: unavailable,
    signUpWithPassword: unavailable,
    verifyEmailToken: unavailable,
    resendVerificationEmail: unavailable,
    requestPasswordReset: unavailable,
    refreshSession: unavailable,
    signOut: unavailable,
    getUser: unavailable,
    ...overrides,
  };
}

interface StubAdmin {
  readonly admin: ReturnType<typeof createAuthAdminClient>;
  readonly deleted: string[];
}

function createStubAdmin(): StubAdmin {
  const deleted: string[] = [];

  return {
    deleted,
    admin: {
      createUser: () => Promise.resolve({ ok: false, failure: unavailableFailure }),
      updateUser: () => Promise.resolve({ ok: false, failure: unavailableFailure }),
      deleteUser: (userId: string) => {
        deleted.push(userId);

        return Promise.resolve({ ok: true, value: undefined });
      },
      revokeUserSessions: () => Promise.resolve({ ok: false, failure: unavailableFailure }),
      getUser: () => Promise.resolve({ ok: false, failure: unavailableFailure }),
    },
  };
}

interface RegistrationFixture {
  readonly dependencies: Parameters<typeof registerMerchant>[1];
  readonly rest: StubRest;
  readonly newAdmin: StubAdmin;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
}

function registrationFixture(options: {
  readonly pages?: readonly PolicyPage[];
  readonly failInsertTable?: string;
  readonly turnstileEnabled?: boolean;
  readonly breachCheck?: BreachCheck;
  readonly provider?: AuthOutcome<{ readonly userId: string; readonly session: AuthSession | null }>;
}): RegistrationFixture {
  const rest = createStubRest(
    options.failInsertTable === undefined ? {} : { failInsertTable: options.failInsertTable },
  );
  const newAdmin = createStubAdmin();
  const audit = createInMemoryAuditTrail();
  const provider: AuthOutcome<{ readonly userId: string; readonly session: AuthSession | null }> =
    options.provider ?? { ok: true, value: { userId: USER_ID, session: null } };
  const breachCheck = options.breachCheck ?? createFixedBreachCheck("clear");

  return {
    rest,
    newAdmin,
    audit,
    dependencies: {
      auth: stubAuthClient({ signUpWithPassword: () => Promise.resolve(provider) }),
      admin: newAdmin.admin,
      rest: rest.rest,
      policies: createInMemoryPolicyCatalog(options.pages ?? policyPages()),
      turnstile: createTurnstileGuard({
        settings: createInMemorySettings({
          "turnstile.enabled": options.turnstileEnabled ?? false,
        }),
        http: createStubHttp().http,
        isProduction: false,
        endpoint: "https://turnstile.gate/siteverify",
      }),
      breachCheck,
      audit,
      now: () => NOW,
    },
  };
}

function signupRequest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    fullName: "Owner Name",
    email: "owner@example.com",
    password: COMPLIANT_PASSWORD,
    companyName: "Acme Payments",
    acceptedPolicies: [...REQUIRED_POLICY_KEYS],
    turnstileToken: null,
    ...overrides,
  };
}

async function checkRegistration(): Promise<void> {
  expectEqual(companySlug("Acme Payments"), "acme-payments", "a company name becomes a slug");
  expectEqual(companySlug("  ***  "), "merchant", "an unusable name still produces a slug");

  const fixture = registrationFixture({});
  const result = await registerMerchant(
    { request: signupRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
    fixture.dependencies,
  );

  expectEqual(result.userId, USER_ID, "the platform account keeps the provider identifier");
  expectEqual(result.companyId, FIRM_ID, "the signup creates a company");
  expectEqual(result.verificationRequired, true, "an unconfirmed signup awaits the mail link");

  const companyCall = fixture.rest.calls.find((call) => call.kind === "insertReturning");
  const companyRows = (companyCall?.rows ?? []) as readonly Readonly<Record<string, unknown>>[];

  expectEqual(companyRows[0]?.["slug"], "acme-payments", "the company is created with its slug");
  expectEqual(companyRows[0]?.["name"], "Acme Payments", "the company keeps its name");

  const userCall = fixture.rest.calls.find(
    (call) => call.kind === "insert" && call.table === "users",
  );
  const userRows = (userCall?.rows ?? []) as readonly Readonly<Record<string, unknown>>[];
  const userRow = userRows[0];

  if (userRow === undefined) {
    failures.push("the signup must insert the platform account");
    checkCount += 1;
  } else {
    expectEqual(userRow["id"], USER_ID, "the account id is the provider identifier");
    expectEqual(userRow["company_id"], FIRM_ID, "the account belongs to the new company");
    expectEqual(userRow["email"], "owner@example.com", "the account keeps the address");
    expectEqual(userRow["full_name"], "Owner Name", "the account keeps the name");
    expectEqual(userRow["status"], "active", "the account starts active");
    expectEqual(userRow["email_verified_at"], null, "an unconfirmed address has no instant");
    expect(
      typeof userRow["password_hash"] === "string" &&
        userRow["password_hash"].startsWith("scrypt$"),
      "the account stores a scrypt verifier",
    );
  }

  const roleCall = fixture.rest.calls.find(
    (call) => call.kind === "insert" && call.table === "role_assignments",
  );
  const roleRows = (roleCall?.rows ?? []) as readonly Readonly<Record<string, unknown>>[];

  expectEqual(roleRows[0]?.["role"], "owner", "the first person of a company is its owner");
  expectEqual(roleRows[0]?.["company_id"], FIRM_ID, "the owner grant names the company");
  expectEqual(roleRows[0]?.["user_id"], USER_ID, "the owner grant names the person");

  const acceptanceCall = fixture.rest.calls.find(
    (call) => call.kind === "insert" && call.table === "policy_acceptances",
  );
  const acceptanceRows = (acceptanceCall?.rows ?? []) as readonly Readonly<
    Record<string, unknown>
  >[];

  expectEqual(acceptanceRows.length, 12, "twelve acceptances are recorded");
  expectEqual(acceptanceRows[0]?.["policy_version"], "2", "the acceptance names the version");
  expectEqual(
    acceptanceRows[0]?.["document_sha256"],
    policyDocumentSha256("Policy body 0"),
    "the acceptance carries the hash of the text",
  );
  expectEqual(acceptanceRows[0]?.["accepted_by"], USER_ID, "the acceptance names the person");
  expectEqual(acceptanceRows[0]?.["company_id"], FIRM_ID, "the acceptance belongs to the company");

  expectEqual(fixture.audit.entries.length, 1, "the signup writes one audit entry");
  expectEqual(fixture.audit.entries[0]?.action, "merchant.signed_up", "the entry names the action");
  expectEqual(
    fixture.audit.entries[0]?.payload["breach_check"],
    "clear",
    "the entry records the breach verdict",
  );
  expectEqual(fixture.audit.entries[0]?.entityType, "company", "the entry names the company");
  expectEqual(fixture.audit.entries[0]?.ipAddress, "203.0.113.9", "the entry carries the address");

  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest({ extra: "field" }), remoteIp: null, userAgent: null },
        registrationFixture({}).dependencies,
      ),
    "VALIDATION_FAILED",
    "an unknown field is refused",
  );
  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest({ password: "short" }), remoteIp: null, userAgent: null },
        registrationFixture({}).dependencies,
      ),
    "VALIDATION_FAILED",
    "a password below the policy is refused",
  );
  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest({ acceptedPolicies: ["kyc_kyb"] }), remoteIp: null, userAgent: null },
        registrationFixture({}).dependencies,
      ),
    "VALIDATION_FAILED",
    "a partial policy acceptance is refused",
  );
  await expectRejects(
    () =>
      registerMerchant(
        {
          request: signupRequest({ acceptedPolicies: [...REQUIRED_POLICY_KEYS, "unknown"] }),
          remoteIp: null,
          userAgent: null,
        },
        registrationFixture({}).dependencies,
      ),
    "VALIDATION_FAILED",
    "an unknown policy key is refused",
  );
  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest(), remoteIp: null, userAgent: null },
        registrationFixture({ pages: policyPages(11) }).dependencies,
      ),
    "SERVICE_UNAVAILABLE",
    "an incomplete policy catalog stops the signup",
  );
  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest({ turnstileToken: null }), remoteIp: null, userAgent: null },
        registrationFixture({ turnstileEnabled: true }).dependencies,
      ),
    "VALIDATION_FAILED",
    "an enabled challenge without a token is refused",
  );
  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest(), remoteIp: null, userAgent: null },
        registrationFixture({
          provider: { ok: false, failure: { kind: "rejected", status: 400, code: "user_already_exists", retryAfterSeconds: null } },
        }).dependencies,
      ),
    "VALIDATION_FAILED",
    "a provider rejection at signup is a generic validation failure",
  );

  const compensated = registrationFixture({ failInsertTable: "users" });

  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest(), remoteIp: null, userAgent: null },
        compensated.dependencies,
      ),
    "DEPENDENCY_FAILED",
    "a write failure after the provider account is a platform failure",
  );
  expectEqual(compensated.newAdmin.deleted.length, 1, "the provider account is removed");
  expect(
    compensated.rest.calls.some(
      (call) => call.kind === "update" && call.table === "companies",
    ),
    "the company created by the failed signup is soft deleted",
  );

  const confirmed = registrationFixture({
    provider: { ok: true, value: { userId: USER_ID, session: fixtureSession() } },
  });
  const confirmedResult = await registerMerchant(
    { request: signupRequest(), remoteIp: null, userAgent: null },
    confirmed.dependencies,
  );

  expectEqual(
    confirmedResult.verificationRequired,
    false,
    "a provider that confirms the address needs no mail",
  );

  const confirmedUser = (
    (confirmed.rest.calls.find((call) => call.kind === "insert" && call.table === "users")?.rows ??
      []) as readonly Readonly<Record<string, unknown>>[]
  )[0];

  expectEqual(
    confirmedUser?.["email_verified_at"],
    new Date(NOW).toISOString(),
    "a confirmed signup records the verification instant",
  );

  const breached = registrationFixture({ breachCheck: createFixedBreachCheck("breached") });
  const breachedError = await captureRejection(
    () =>
      registerMerchant(
        { request: signupRequest(), remoteIp: null, userAgent: null },
        breached.dependencies,
      ),
    "a breached password stops the signup",
  );

  expectEqual(breachedError.code, "VALIDATION_FAILED", "a breach is a form failure");
  expectEqual(breachedError.details[0]?.field, "password", "the breach names the password field");
  expectEqual(breachedError.details[0]?.rule, "breached", "the breach names its rule");
  expectEqual(breached.rest.calls.length, 0, "a breached password writes no row");

  const skippedBreach = registrationFixture({ breachCheck: createFixedBreachCheck("skipped") });
  const skippedResult = await registerMerchant(
    { request: signupRequest(), remoteIp: null, userAgent: null },
    skippedBreach.dependencies,
  );

  expectEqual(skippedResult.userId, USER_ID, "a skipped check still signs the merchant up");
  expectEqual(
    skippedBreach.audit.entries[0]?.payload["breach_check"],
    "skipped",
    "the audit entry records that the corpus was not asked",
  );

  const storage = await hashPassword(COMPLIANT_PASSWORD);

  expect(
    !storage.includes(COMPLIANT_PASSWORD),
    "the stored verifier never contains the password",
  );
}

/* ------------------------------------------------------------------ 17. verification */

function fixtureSession(): AuthSession {
  return {
    accessToken: makeAccessToken(baseClaims()),
    refreshToken: "refresh-token-000000000000000000",
    expiresAtEpochMs: NOW + 3_600_000,
    expiresInSeconds: 3_600,
    user: {
      id: USER_ID,
      email: "owner@example.com",
      emailConfirmedAtEpochMs: NOW,
      phone: null,
      lastSignInAtEpochMs: NOW,
      fullName: "Owner Name",
    },
  };
}

async function checkEmailVerification(): Promise<void> {
  const updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[] = [];
  const rest: RestClient = {
    select<TRow>(): Promise<readonly TRow[]> {
      return Promise.resolve([
        { id: USER_ID, company_id: FIRM_ID, email_verified_at: null } as unknown as TRow,
      ]);
    },
    insert: () => Promise.resolve(),
    insertReturning: () => Promise.resolve([]),
    update: (table: string, query: string, values: Readonly<Record<string, unknown>>) => {
      updates.push({ table, query, values });

      return Promise.resolve();
    },
    rpc: () => Promise.resolve(null),
  };
  const audit = createInMemoryAuditTrail();
  const dependencies = {
    auth: stubAuthClient({
      verifyEmailToken: () => Promise.resolve({ ok: true, value: fixtureSession() }),
    }),
    rest,
    audit,
    cookiePolicy: cookiePolicy(),
    now: () => NOW,
  };

  const result = await completeEmailVerification(
    { tokenHash: "token-hash-value", type: "signup", remoteIp: "203.0.113.9", userAgent: "gate" },
    dependencies,
  );

  expectEqual(result.userId, USER_ID, "the verification answers the person");
  expectEqual(result.companyId, FIRM_ID, "the verification answers the company");
  expectEqual(result.cookies.length, 1, "the verification writes one session cookie");
  expect(
    (result.cookies[0] ?? "").startsWith("__Host-kd_session="),
    "the verification cookie is the secure one",
  );
  expectEqual(audit.entries.length, 1, "the verification writes one audit entry");
  expectEqual(audit.entries[0]?.action, "user.email_verified", "the entry names the action");
  expectEqual(audit.entries[0]?.sessionId, SESSION_ID, "the entry names the session");
  expectEqual(updates.length, 1, "the verification writes one row");
  expectEqual(updates[0]?.table, "users", "the verification writes the account row");
  expect(
    (updates[0]?.query ?? "").includes(`id=eq.${USER_ID}`),
    "the verification names the account it updates",
  );
  expectEqual(
    updates[0]?.values["email_verified_at"],
    new Date(NOW).toISOString(),
    "the verification records the instant",
  );

  await expectRejects(
    () =>
      completeEmailVerification(
        { tokenHash: "token-hash-value", type: "email_change", remoteIp: null, userAgent: null },
        dependencies,
      ),
    "VALIDATION_FAILED",
    "a token type the signup route does not accept is refused",
  );
  await expectRejects(
    () =>
      completeEmailVerification(
        { tokenHash: "short", type: "signup", remoteIp: null, userAgent: null },
        dependencies,
      ),
    "VALIDATION_FAILED",
    "a malformed token is refused before the provider is asked",
  );
  await expectRejects(
    () =>
      completeEmailVerification(
        { tokenHash: "token-hash-value", type: "signup", remoteIp: null, userAgent: null },
        {
          ...dependencies,
          auth: stubAuthClient({
            verifyEmailToken: () =>
              Promise.resolve({
                ok: false,
                failure: { kind: "rejected", status: 403, code: "token_expired", retryAfterSeconds: null },
              }),
          }),
        },
      ),
    "VALIDATION_FAILED",
    "an expired link is a validation failure",
  );
  await expectRejects(
    () =>
      completeEmailVerification(
        { tokenHash: "token-hash-value", type: "signup", remoteIp: null, userAgent: null },
        {
          ...dependencies,
          rest: {
            ...rest,
            select: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
          },
        },
      ),
    "AUTHENTICATION_REQUIRED",
    "a provider identity with no platform row is not an account",
  );
}

/* ------------------------------------------------------------------ 18. client address */

function checkClientAddress(): void {
  expect(isAddress("203.0.113.9"), "an IPv4 address is an address");
  expect(isAddress("2001:db8::1"), "an IPv6 address is an address");
  expect(!isAddress("203.0.113.9:443"), "an address with a port is not an address");
  expect(!isAddress("[2001:db8::1]"), "a bracketed address is not an address");
  expect(!isAddress("fe80::1%eth0"), "an address with a zone is not an address");
  expect(!isAddress("not-an-address"), "a word is not an address");
  expect(!isAddress("999.1.1.1"), "an out of range IPv4 address is not an address");

  const headers = new Headers({
    "x-forwarded-for": "203.0.113.9, 70.41.3.18",
    "user-agent": "gate",
  });

  expectEqual(readClientAddress(headers), "203.0.113.9", "the first forwarded address is used");
  expectEqual(readUserAgent(headers), "gate", "the user agent is read");
  expectEqual(readClientAddress(new Headers({ "x-real-ip": "198.51.100.7" })), "198.51.100.7", "a real ip header is used");
  expectEqual(readClientAddress(new Headers()), null, "a request without headers has no address");
  expectEqual(readUserAgent(new Headers()), null, "a request without an agent has none");
  expectEqual(readUserAgent(new Headers({ "user-agent": "x".repeat(600) })), null, "an oversized agent is refused");
}


/* ------------------------------------------------------------------ 19. device context */

function checkDeviceContext(): void {
  const chromeOnMac = readDeviceContext(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  );

  expectEqual(chromeOnMac.browser, "Chrome", "Chrome is named before Safari, which it claims");
  expectEqual(chromeOnMac.platform, "macOS", "a Macintosh agent is macOS");
  expectEqual(chromeOnMac.label, "Chrome on macOS", "the label is one readable sentence fragment");

  const edge = readDeviceContext(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  );

  expectEqual(edge.browser, "Edge", "Edge is named before the Chrome it also claims");
  expectEqual(edge.platform, "Windows", "a Windows agent is Windows");

  const opera = readDeviceContext("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 OPR/91.0 Safari/537.36");

  expectEqual(opera.browser, "Opera", "Opera is named before Chrome");
  expectEqual(opera.platform, "Linux", "an X11 agent is Linux");

  const chromeOnPhone = readDeviceContext(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1",
  );

  expectEqual(chromeOnPhone.browser, "Chrome", "Chrome on iOS is named from CriOS");
  expectEqual(chromeOnPhone.platform, "iOS", "an iPhone agent is iOS");

  const unknown = readDeviceContext("curl/8.7.1");

  expectEqual(unknown.label, "an unknown browser on an unknown platform", "an unnamed agent stays unnamed");
  expect(readDeviceContext(null).label.length > 0, "a request without an agent still has a label");
  expect(
    readDeviceContext(`Mozilla/5.0 ${"x".repeat(400)} Chrome/126`).label.length <= 80,
    "a label never exceeds the device column ceiling",
  );

  const hash = emailHash("Owner@Example.com");

  expectEqual(hash.length, 64, "an address hash is 64 characters");
  expect(/^[a-f0-9]{64}$/u.test(hash), "an address hash matches the column check");
  expectEqual(hash, emailHash(" owner@example.com "), "the hash ignores case and surrounding space");
  expect(hash !== emailHash("other@example.com"), "two addresses have two hashes");
}

/* ------------------------------------------------------------------ 20. login attempts */

async function checkLoginAttempts(): Promise<void> {
  const recorded: { table: string; rows: readonly Readonly<Record<string, unknown>>[] }[] = [];
  const rest: RestClient = {
    select: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      recorded.push({ table, rows });

      return Promise.resolve();
    },
    insertReturning: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    update: (): Promise<void> => Promise.resolve(),
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };
  const recorder = createRestLoginAttemptRecorder(rest);

  const stored = await recorder.record({
    factor: "password",
    outcome: "failed",
    userId: null,
    companyId: null,
    emailHash: emailHash("owner@example.com"),
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });

  expect(stored, "an attempt with an address is written");

  const row = recorded[0]?.rows[0];

  expectEqual(recorded[0]?.table, "login_attempts", "the attempt goes to the attempt table");
  expectEqual(row?.["outcome"], "failed", "the row records the outcome");
  expectEqual(row?.["factor"], "password", "the row records the factor");
  expectEqual(row?.["user_id"], null, "an unknown account has no user id");
  expectEqual(row?.["company_id"], null, "an unknown account has no company");
  expect((row?.["email_hash"] as string).length === 64, "an unknown account is counted by address hash");
  expectEqual(row?.["ip_address"], "203.0.113.9", "the row records the address");
  expectEqual(row?.["user_agent"], "gate", "the row records the agent");

  const skipped = await recorder.record({
    factor: "password",
    outcome: "failed",
    userId: null,
    companyId: null,
    emailHash: emailHash("owner@example.com"),
    ipAddress: null,
    userAgent: null,
  });

  expect(!skipped, "an attempt without an address cannot be recorded");
  expectEqual(recorded.length, 1, "an attempt without an address writes nothing");

  await recorder.record({
    factor: "password",
    outcome: "succeeded",
    userId: USER_ID,
    companyId: FIRM_ID,
    emailHash: emailHash("owner@example.com"),
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });

  const known = recorded[1]?.rows[0];

  expectEqual(known?.["user_id"], USER_ID, "a known account is counted by user id");
  expectEqual(known?.["email_hash"], null, "a known account stores no address hash");
  expectEqual(known?.["company_id"], FIRM_ID, "a known account carries its tenant");

  const memory = createInMemoryLoginAttemptRecorder();

  await memory.record({
    factor: "password",
    outcome: "succeeded",
    userId: USER_ID,
    companyId: FIRM_ID,
    emailHash: null,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });

  expectEqual(memory.attempts.length, 1, "the in memory recorder keeps the attempt");
}

/* ------------------------------------------------------------------ 21. sign in */

interface SigninRestOptions {
  readonly user?: Readonly<Record<string, unknown>> | null;
  readonly proofKeys?: number;
  readonly claims?: Readonly<Record<string, unknown>>;
}

interface SigninFixture {
  readonly dependencies: Parameters<typeof signInMerchant>[1];
  readonly attempts: ReturnType<typeof createInMemoryLoginAttemptRecorder>;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
  readonly inserts: { table: string; rows: readonly Readonly<Record<string, unknown>>[] }[];
}

function signinFixture(options: SigninRestOptions & {
  readonly signIn?: AuthOutcome<AuthSession>;
  readonly turnstileEnabled?: boolean;
} = {}): SigninFixture {
  const inserts: { table: string; rows: readonly Readonly<Record<string, unknown>>[] }[] = [];
  const user =
    options.user === undefined
      ? {
          id: USER_ID,
          company_id: FIRM_ID,
          status: "active",
          email_verified_at: new Date(NOW).toISOString(),
          deleted_at: null,
          totp_confirmed_at: null,
        }
      : options.user;
  const proofKeys = options.proofKeys ?? 0;
  const session: AuthSession = {
    ...fixtureSession(),
    accessToken: makeAccessToken(baseClaims(options.claims ?? {})),
  };

  const rest: RestClient = {
    select<TRow>(table: string): Promise<readonly TRow[]> {
      if (table === "users") {
        return Promise.resolve(user === null ? [] : ([{ ...user }] as unknown as readonly TRow[]));
      }

      if (table === "device_proof_keys") {
        return Promise.resolve(
          Array.from({ length: proofKeys }, (_unused, index) => ({
            id: `device-${index}`,
          })) as unknown as readonly TRow[],
        );
      }

      return Promise.resolve([]);
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      inserts.push({ table, rows });

      return Promise.resolve();
    },
    insertReturning: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    update: (): Promise<void> => Promise.resolve(),
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };
  const attempts = createInMemoryLoginAttemptRecorder();
  const audit = createInMemoryAuditTrail();

  return {
    inserts,
    attempts,
    audit,
    dependencies: {
      auth: stubAuthClient({ signInWithPassword: () => Promise.resolve(options.signIn ?? { ok: true, value: session }) }),
      rest,
      turnstile: createTurnstileGuard({
        settings: createInMemorySettings({ "turnstile.enabled": options.turnstileEnabled ?? false }),
        http: createStubHttp().http,
        isProduction: false,
        endpoint: "https://turnstile.gate/siteverify",
      }),
      attempts,
      audit,
      cookiePolicy: cookiePolicy(),
      masterKey: () => MASTER_KEY,
      now: () => NOW,
    },
  };
}

function signinRequest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    email: "owner@example.com",
    password: COMPLIANT_PASSWORD,
    turnstileToken: null,
    ...overrides,
  };
}

async function checkSignin(): Promise<void> {
  const fixture = signinFixture();
  const result = await signInMerchant(
    { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36" },
    fixture.dependencies,
  );

  expectEqual(result.outcome, "signed_in", "an account with no second factor is signed in");

  if (result.outcome !== "signed_in") {
    failures.push("an account with no second factor must produce a session");
    checkCount += 1;

    return;
  }

  expectEqual(result.userId, USER_ID, "a correct password answers the account");
  expectEqual(result.companyId, FIRM_ID, "the answer names the company");
  expectEqual(result.deviceProofRequired, true, "an account with no proof key must enrol this browser");
  expectEqual(result.device.label, "Chrome on macOS", "the answer names the device");
  expectEqual(result.cookies.length, 1, "one session cookie is written");
  expect(
    (result.cookies[0] ?? "").startsWith("__Host-kd_session="),
    "the sign in cookie is the secure name",
  );
  expect(
    (result.cookies[0] ?? "").toLowerCase().includes("httponly"),
    "the sign in cookie is HttpOnly",
  );
  expectEqual(fixture.attempts.attempts.length, 1, "the sign in records one attempt");
  expectEqual(fixture.attempts.attempts[0]?.outcome, "succeeded", "the attempt is a success");
  expectEqual(fixture.attempts.attempts[0]?.userId, USER_ID, "the attempt names the account");
  expectEqual(fixture.audit.entries.length, 1, "the sign in writes one audit entry");
  expectEqual(fixture.audit.entries[0]?.action, "user.signed_in", "the entry names the action");
  expectEqual(fixture.audit.entries[0]?.payload["device"], "Chrome on macOS", "the entry names the device");
  expectEqual(
    fixture.audit.entries[0]?.payload["device_proof_present"],
    false,
    "the entry records that no proof key exists yet",
  );

  const enrolled = signinFixture({ proofKeys: 1 });
  const enrolledResult = await signInMerchant(
    { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
    enrolled.dependencies,
  );

  expectEqual(enrolledResult.deviceProofRequired, false, "an enrolled device needs no new key");

  const claimsMismatch = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: null, userAgent: null },
        signinFixture({
          signIn: {
            ok: true,
            value: {
              ...fixtureSession(),
              accessToken: makeAccessToken(baseClaims({ sub: "11111111-1111-4111-8111-111111111111" })),
            },
          },
        }).dependencies,
      ),
    "a token whose subject is not the account it names is a provider fault",
  );

  expectEqual(claimsMismatch.code, "DEPENDENCY_FAILED", "a provider fault is a platform failure");
  expectEqual(
    claimsMismatch.details.length,
    0,
    "a provider fault carries no detail about the account",
  );

  const rejectedProvider = (outcome: AuthOutcome<AuthSession>, label: string, code: string): Promise<void> =>
    expectRejects(
      () =>
        signInMerchant(
          { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
          signinFixture({ signIn: outcome }).dependencies,
        ),
      code,
      label,
    );

  await rejectedProvider(
    { ok: false, failure: { kind: "rejected", status: 400, code: "invalid_credentials", retryAfterSeconds: null } },
    "a wrong password is the generic rejection",
    "AUTHENTICATION_REQUIRED",
  );
  await rejectedProvider(
    { ok: false, failure: { kind: "rejected", status: 400, code: "email_not_confirmed", retryAfterSeconds: null } },
    "an unconfirmed address is the generic rejection",
    "AUTHENTICATION_REQUIRED",
  );
  await rejectedProvider(
    { ok: false, failure: { kind: "timeout", status: null, code: null, retryAfterSeconds: null } },
    "a provider timeout is not a credential answer",
    "TIMEOUT",
  );
  await rejectedProvider(
    { ok: false, failure: { kind: "upstream", status: 503, code: null, retryAfterSeconds: null } },
    "a provider outage is not a credential answer",
    "DEPENDENCY_FAILED",
  );
  await rejectedProvider(
    { ok: false, failure: { kind: "rate-limited", status: 429, code: null, retryAfterSeconds: 30 } },
    "a provider rate limit keeps its delay",
    "RATE_LIMITED",
  );

  const unknownAddress = signinFixture({
    user: null,
    signIn: { ok: true, value: fixtureSession() },
  });
  const unknownError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest({ email: "stranger@example.com" }), remoteIp: "203.0.113.9", userAgent: "gate" },
        unknownAddress.dependencies,
      ),
    "a provider account with no platform row is the generic rejection",
  );

  expectEqual(unknownError.code, "AUTHENTICATION_REQUIRED", "the refusal is the generic code");
  expectEqual(unknownError.status, 401, "the generic rejection is a 401");
  expectEqual(unknownAddress.attempts.attempts.length, 1, "the refusal is recorded");
  expectEqual(unknownAddress.attempts.attempts[0]?.outcome, "failed", "the refusal is a failure");
  expectEqual(
    unknownAddress.attempts.attempts[0]?.emailHash,
    emailHash("stranger@example.com"),
    "an unknown account is counted by address hash",
  );
  expect(unknownAddress.audit.entries.length === 0, "a refusal writes no audit entry");

  for (const [label, user] of [
    [
      "an unconfirmed address is refused",
      { id: USER_ID, company_id: FIRM_ID, status: "active", email_verified_at: null, deleted_at: null },
    ],
    [
      "a suspended account is refused",
      {
        id: USER_ID,
        company_id: FIRM_ID,
        status: "suspended",
        email_verified_at: new Date(NOW).toISOString(),
        deleted_at: null,
      },
    ],
    [
      "a soft deleted account is refused",
      {
        id: USER_ID,
        company_id: FIRM_ID,
        status: "active",
        email_verified_at: new Date(NOW).toISOString(),
        deleted_at: new Date(NOW).toISOString(),
      },
    ],
  ] as const) {
    const refusal = signinFixture({ user });

    const error = await captureRejection(
      () =>
        signInMerchant(
          { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
          refusal.dependencies,
        ),
      label,
    );

    expectEqual(error.code, "AUTHENTICATION_REQUIRED", `${label} (catalogue code)`);
    expectEqual(error.status, unknownError.status, "every account refusal shares one status");
    expectEqual(
      error.details.length,
      unknownError.details.length,
      "every account refusal carries one detail set",
    );
    expectEqual(refusal.attempts.attempts.length, 1, "the account refusal is recorded");
    expectEqual(refusal.attempts.attempts[0]?.userId, USER_ID, "the refusal names the account");
    expectEqual(
      refusal.attempts.attempts[0]?.emailHash,
      null,
      "a known account is never counted by address hash",
    );
  }

  const malformed = await captureRejection(
    () =>
      signInMerchant(
        { request: { email: "owner@example.com" }, remoteIp: null, userAgent: null },
        signinFixture().dependencies,
      ),
    "a form without a password is the generic rejection",
  );

  expectEqual(malformed.code, unknownError.code, "a malformed form is not distinguishable");
  expectEqual(malformed.status, unknownError.status, "a malformed form shares the same status");

  await expectRejects(
    () =>
      signInMerchant(
        { request: signinRequest({ extra: "field" }), remoteIp: null, userAgent: null },
        signinFixture().dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "an unknown field is the generic rejection",
  );

  const challenged = signinFixture({ turnstileEnabled: true });
  const challengeError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        challenged.dependencies,
      ),
    "a missing challenge token is a form failure",
  );

  expectEqual(challengeError.code, "VALIDATION_FAILED", "the challenge refusal is a form failure");
  expectEqual(
    challengeError.details?.[0]?.field,
    "turnstileToken",
    "the challenge failure names the widget field",
  );
  expectEqual(challenged.attempts.attempts[0]?.outcome, "challenged", "the challenge refusal is recorded");

  const parsed = signinInputSchema.safeParse({ email: "Owner@Example.com", password: "x" });

  expect(parsed.success && parsed.data.email === "owner@example.com", "the form lowercases the address");
}

/** True when a stored value is not a box this build wrote. */
function unpackableCiphertextRefused(text: string): boolean {
  return unpackSecretBox(text) === null;
}

/** Assert that a stored enrolment secret is sealed, opens, and is not the secret in clear. */
function expectStartSealed(value: unknown, secret: string): void {
  const stored = typeof value === "string" ? value : "";

  expect(stored.length > 40, "the stored secret is a sealed box");
  expect(stored.startsWith("v1."), "the stored secret carries a version prefix");
  expect(!stored.includes(secret), "the stored secret does not contain the secret in clear");
}

/* --------------------------------------------------- STEP 041: TOTP and QR */

/**
 * The RFC vectors.
 *
 * The secret is the ASCII string "12345678901234567890", which is the key every published test
 * vector of RFC 6238 uses, and the answers below are the six digit forms of the numbers in the
 * RFC's appendix. A vector that fails here means the platform would reject every code a real
 * authenticator app shows, which is a total lockout, so the arithmetic is checked before anything
 * is written to a database.
 */
function checkTotp(): void {
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890", "ascii"));

  expectEqual(rfcSecret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "base32 encodes the RFC key");
  expectEqual(
    Buffer.from(base32Decode(rfcSecret) ?? new Uint8Array()).toString("ascii"),
    "12345678901234567890",
    "base32 decodes back to the RFC key",
  );
  expectEqual(base32Decode("0189"), null, "a base32 digit outside the alphabet is refused");
  expectEqual(base32Decode(""), null, "an empty base32 secret is refused");

  const key = base32Decode(rfcSecret) ?? new Uint8Array();

  // RFC 6238, appendix B: SHA-1 codes at 59s, 1111111109s and 1111111111s, six digits.
  expectEqual(totpCodeForStep(key, 1), "287082", "the code of step 1 is the RFC's");
  expectEqual(
    totpCodeForStep(key, Math.floor(1111111109 / 30)),
    "081804",
    "the code of the RFC's 2005 instant is the RFC's",
  );
  expectEqual(
    totpCodeForStep(key, Math.floor(1111111111 / 30)),
    "050471",
    "the code of the RFC's late 2005 instant is the RFC's",
  );
  expectEqual(totpStep(59_000), 1, "a step is thirty seconds");

  const secret = generateTotpSecret();

  expectEqual(secret.length, 32, "a generated secret is 160 bits in base32");
  expect(/^[A-Z2-7]+$/u.test(secret), "a generated secret is base32");
  expect(generateTotpSecret() !== secret, "two enrolments never share a secret");
  expectEqual(
    formatSecretForEntry("ABCDEFGH"),
    "ABCD EFGH",
    "the manual entry form groups the secret in fours",
  );

  const instant = 1_700_000_000_000;
  const current = totpCodeForStep(key, totpStep(instant));

  expectEqual(verifyTotpCode(rfcSecret, current, instant), totpStep(instant), "the current code is accepted");
  expectEqual(
    verifyTotpCode(rfcSecret, totpCodeForStep(key, totpStep(instant) - 1), instant),
    totpStep(instant) - 1,
    "the previous step is accepted inside the window",
  );
  expectEqual(
    verifyTotpCode(rfcSecret, totpCodeForStep(key, totpStep(instant) + 1), instant),
    totpStep(instant) + 1,
    "the next step is accepted inside the window",
  );
  expectEqual(
    verifyTotpCode(rfcSecret, totpCodeForStep(key, totpStep(instant) + 2), instant),
    null,
    "a code two steps ahead is refused",
  );
  expectEqual(
    verifyTotpCode(rfcSecret, totpCodeForStep(key, totpStep(instant) - 2), instant),
    null,
    "a code two steps behind is refused",
  );
  expectEqual(verifyTotpCode(rfcSecret, "000000", instant), null, "an unrelated code is refused");
  expectEqual(verifyTotpCode(rfcSecret, "28708", instant), null, "a five digit code is refused");
  expectEqual(verifyTotpCode(rfcSecret, "2870821", instant), null, "a seven digit code is refused");
  expectEqual(verifyTotpCode(rfcSecret, "abcdef", instant), null, "a code of letters is refused");
  expectEqual(verifyTotpCode("not base32!", current, instant), null, "a broken stored secret is refused");
  expectEqual(
    verifyTotpCode(rfcSecret, ` ${current} `, instant),
    totpStep(instant),
    "surrounding spaces around a typed code are forgiven",
  );

  const uri = totpUri("KD Solution IT", "owner@example.com", "ABCDEFGHIJKLMNOP");

  expect(uri.startsWith("otpauth://totp/KD%20Solution%20IT:owner%40example.com?"), "the URI names issuer and account");
  expect(uri.includes("secret=ABCDEFGHIJKLMNOP"), "the URI carries the secret");
  expect(uri.includes("algorithm=SHA1"), "the URI names the algorithm");
  expect(uri.includes("digits=6"), "the URI names the digits");
  expect(uri.includes("period=30"), "the URI names the period");
  expect(uri.includes("issuer=KD+Solution+IT"), "the URI repeats the issuer as a parameter");

  const codes = generateBackupCodes(BACKUP_CODE_COUNT);

  expectEqual(codes.length, 10, "an enrolment writes ten backup codes");
  expectEqual(new Set(codes).size, 10, "the ten backup codes are distinct");
  expect(codes.every((code) => /^[a-z2-9]{5}-[a-z2-9]{5}$/u.test(code)), "a backup code is xxxxx-xxxxx");
  expect(
    codes.every((code) => !/[01lo]/u.test(code)),
    "a backup code has no character that is read as a digit",
  );
  expectEqual(normalizeBackupCode("ABCDE-FGHJK"), "abcdefghjk", "a typed code is normalised before hashing");
  expectEqual(normalizeBackupCode(" abcde fghjk "), "abcdefghjk", "spaces do not change a backup code");
  expect(isBackupCodeShaped("abcde-fghjk"), "a typed backup code has the right shape");
  expect(!isBackupCodeShaped("abcde"), "a short string is not a backup code");
  expect(!isBackupCodeShaped(totpCodeForStep(key, 1)), "a six digit code is not shaped like a backup code");
  expect(!isBackupCodeShaped("abcde-123"), "a code of the wrong length is not shaped like a backup code");
}

/** The QR encoder, against the structure the specification defines rather than against an image. */
function checkQr(): void {
  expectEqual(smallestVersion(14), 1, "fourteen bytes fit version 1 at level M");
  expectEqual(smallestVersion(15), 2, "fifteen bytes need version 2");
  expectEqual(smallestVersion(106), 6, "the version boundaries follow the capacity table");
  expectEqual(smallestVersion(213), 10, "the largest payload this build encodes is 213 bytes");
  expectEqual(smallestVersion(214), null, "a payload beyond version 10 is refused, not truncated");

  const text = totpUri("KD Solution IT", "owner@example.com", generateTotpSecret());
  const matrix = encodeQr(text);
  const codewords = encodeQrCodewords(text);

  expect(matrix !== null, "an enrolment URI is encodable");
  expect(codewords !== null, "an enrolment URI has codewords");

  if (matrix === null || codewords === null) {
    return;
  }

  expectEqual(matrix.size, 17 + matrix.version * 4, "the symbol is the size its version prescribes");
  expectEqual(matrix.modules.length, matrix.size, "the matrix is square");
  expectEqual(matrix.modules[0]?.length, matrix.size, "every row is the full width");

  const rows = qrRows(matrix);

  expectEqual(rows.length, matrix.size, "the row view has one line per module row");

  const finder = [
    "1111111",
    "1000001",
    "1011101",
    "1011101",
    "1011101",
    "1000001",
    "1111111",
  ];
  const corner = (top: number, left: number): string[] =>
    Array.from({ length: 7 }, (_, index) => (rows[top + index] ?? "").slice(left, left + 7));

  expectEqual(corner(0, 0).join("/"), finder.join("/"), "the top left finder is the finder pattern");
  expectEqual(corner(0, matrix.size - 7).join("/"), finder.join("/"), "the top right finder is the finder pattern");
  expectEqual(corner(matrix.size - 7, 0).join("/"), finder.join("/"), "the bottom left finder is the finder pattern");

  const separatorRow = rows[7] ?? "";
  const separatorColumn = Array.from({ length: 8 }, (_, index) => (rows[index] ?? "").charAt(7)).join("");

  expect(!separatorRow.slice(0, 8).includes("1"), "the top left separator is light");
  expect(!separatorColumn.includes("1"), "the separator above it is light");

  let timingOk = true;

  for (let index = 8; index < matrix.size - 8; index += 1) {
    if ((rows[6] ?? "").charAt(index) !== (index % 2 === 0 ? "1" : "0")) {
      timingOk = false;
    }

    if ((rows[index] ?? "").charAt(6) !== (index % 2 === 0 ? "1" : "0")) {
      timingOk = false;
    }
  }

  expect(timingOk, "the timing patterns alternate on row 6 and column 6");
  expectEqual((rows[matrix.size - 8] ?? "").charAt(8), "1", "the dark module is set");

  // Read both format copies back: they must agree with each other and with the value this build
  // says it wrote. Level M and mask 0 is 0x5412, the row the specification's table publishes.
  const verticalCopy = Array.from({ length: 15 }, (_, index) => {
    const bit =
      index < 6
        ? (rows[index] ?? "").charAt(8)
        : index < 8
          ? (rows[(index + 1)] ?? "").charAt(8)
          : (rows[matrix.size - 15 + index] ?? "").charAt(8);

    return bit === "1" ? 1 : 0;
  });
  const horizontalCopy = Array.from({ length: 15 }, (_, index) => {
    const bit =
      index < 8
        ? (rows[8] ?? "").charAt(matrix.size - 1 - index)
        : index < 9
          ? (rows[8] ?? "").charAt(7)
          : (rows[8] ?? "").charAt(14 - index);

    return bit === "1" ? 1 : 0;
  });
  const asNumber = (bits: readonly number[]): number =>
    bits.reduce((total, bit, index) => total + bit * 2 ** index, 0);

  expectEqual(asNumber(verticalCopy), 0x5412, "the vertical format copy carries level M and mask 0");
  expectEqual(asNumber(horizontalCopy), 0x5412, "the horizontal format copy carries the same value");

  const drawing = qrPath(matrix);

  expectEqual(drawing.extent, (matrix.size + 8) * 4, "the drawing is the symbol plus a four module quiet zone");
  expect(drawing.data.startsWith("M"), "the drawing is one path of runs");
  expect(/^[Mhvz0-9 .-]+$/u.test(drawing.data), "a drawing holds only path instructions and numbers");
  expect(!drawing.data.includes("NaN"), "every coordinate of the drawing is a number");

  const rowsWithDark = rows.filter((row) => row.includes("1")).length;

  expect(rowsWithDark > 0, "the symbol has dark modules");
  expect(
    drawing.data.split("M").length - 1 >= rowsWithDark,
    "each row that has a dark module contributes at least one run",
  );
  expectEqual(encodeQr("x".repeat(214)), null, "an oversized payload is refused rather than truncated");
}

/** The enrolment state machine, against a REST double. */
async function checkTwoFactor(): Promise<void> {
  const now = NOW + 12_000;
  const updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[] = [];
  const rows: { totp_secret_ciphertext: string | null; totp_confirmed_at: string | null } = {
    totp_secret_ciphertext: null,
    totp_confirmed_at: null,
  };
  let missing = false;
  const rest: RestClient = {
    select<TRow>(): Promise<readonly TRow[]> {
      if (missing) {
        return Promise.resolve([]);
      }

      return Promise.resolve([
        {
          id: USER_ID,
          email: "owner@example.com",
          company_id: FIRM_ID,
          totp_secret_ciphertext: rows.totp_secret_ciphertext,
          totp_confirmed_at: rows.totp_confirmed_at,
        } as unknown as TRow,
      ]);
    },
    insert: () => Promise.resolve(),
    insertReturning: () => Promise.resolve([]),
    update: (table: string, query: string, values: Readonly<Record<string, unknown>>) => {
      updates.push({ table, query, values });

      if ("totp_secret_ciphertext" in values) {
        rows.totp_secret_ciphertext = values["totp_secret_ciphertext"] as string;
      }

      if ("totp_confirmed_at" in values) {
        rows.totp_confirmed_at = values["totp_confirmed_at"] as string | null;
      }

      return Promise.resolve();
    },
    rpc: () => Promise.resolve(null),
  };
  const audit = createInMemoryAuditTrail();
  const dependencies = {
    rest,
    audit,
    masterKey: () => MASTER_KEY,
    issuer: "KD Solution IT",
    now: () => now,
  };

  const started = await startTotpEnrolment({ userId: USER_ID }, dependencies);

  expectEqual(updates.length, 1, "starting an enrolment writes one row");
  expectEqual(updates[0]?.table, "users", "starting an enrolment writes the account");
  expectEqual(updates[0]?.values["totp_confirmed_at"], null, "starting an enrolment confirms nothing");
  expectStartSealed(updates[0]?.values["totp_secret_ciphertext"], started.secret);

  expect(started.secret.length === 32, "the answered secret is base32");
  expectEqual(started.secretForEntry, formatSecretForEntry(started.secret), "the answered key is the grouped secret");
  expect(started.uri.startsWith("otpauth://totp/"), "the answer carries the account URI");
  expect(started.uri.includes(`secret=${started.secret}`), "the URI carries the answered secret");
  expect(started.qr !== null, "the answer carries a symbol");
  expect(started.symbol !== null, "the answer carries a drawing");
  expectEqual(audit.entries.length, 1, "starting an enrolment is audited");
  expectEqual(audit.entries[0]?.action, "user.totp_enrolment_started", "the audit entry names the start");
  expectEqual(audit.entries[0]?.companyId, FIRM_ID, "the audit entry joins the tenant chain");

  const secret = openEnrolledSecret(
    rows.totp_secret_ciphertext ?? "",
    USER_ID,
    MASTER_KEY,
  );

  expectEqual(secret, started.secret, "the stored secret opens to the answered secret");
  expectThrows(
    () => openEnrolledSecret(rows.totp_secret_ciphertext ?? "", OTHER_USER_ID, MASTER_KEY),
    "a secret of one account does not open for another",
  );
  expectThrows(
    () => openEnrolledSecret(rows.totp_secret_ciphertext ?? "", USER_ID, OTHER_MASTER_KEY),
    "a secret does not open under another key",
  );
  expectEqual(unpackableCiphertextRefused(rows.totp_secret_ciphertext ?? ""), false, "the stored secret unpacks");

  const wrongCode = await captureRejection(
    () => confirmTotpEnrolment({ userId: USER_ID, code: "000000" }, dependencies),
    "a wrong code is refused",
  );

  expectEqual(wrongCode.code, "VALIDATION_FAILED", "a wrong code is a form failure");
  expectEqual(wrongCode.details?.[0]?.field, "code", "the wrong code names the code field");
  expectEqual(updates.length, 1, "a wrong code writes nothing");
  expectEqual(audit.entries.length, 1, "a wrong code audits nothing");

  const shortCode = await captureRejection(
    () => confirmTotpEnrolment({ userId: USER_ID, code: "12" }, dependencies),
    "a malformed code is refused",
  );

  expectEqual(shortCode.details?.[0]?.rule, "invalid_format", "a malformed code is refused before any query");

  const key = base32Decode(secret) ?? new Uint8Array();
  const confirmed = await confirmTotpEnrolment(
    { userId: USER_ID, code: totpCodeForStep(key, totpStep(now)) },
    dependencies,
  );

  expectEqual(confirmed.backupCodes.length, 10, "confirming writes ten backup codes");
  expectEqual(updates.length, 2, "confirming writes one row");
  expectEqual(updates[1]?.values["totp_confirmed_at"], new Date(now).toISOString(), "confirming stamps the instant");
  expect(Array.isArray(updates[1]?.values["backup_code_hashes"]), "confirming stores hashes");
  expectEqual(
    (updates[1]?.values["backup_code_hashes"] as readonly string[]).length,
    10,
    "one hash per code",
  );
  expect(
    (updates[1]?.values["backup_code_hashes"] as readonly string[]).every(
      (hash) => !confirmed.backupCodes.includes(hash) && hash.length > 40,
    ),
    "the stored values are verifiers, not the codes",
  );
  expectEqual(audit.entries.length, 2, "confirming is audited");
  expectEqual(audit.entries[1]?.action, "user.totp_enrolled", "the audit entry names the enrolment");
  expectEqual(audit.entries[1]?.payload["backup_codes"], 10, "the audit entry counts the codes");

  const stored = (updates[1]?.values["backup_code_hashes"] as readonly string[])[0] ?? "";
  const storedCode = normalizeBackupCode(confirmed.backupCodes[0] ?? "");

  expect(await verifyPasswordHash(storedCode, stored), "a hash of the first code verifies that code");
  expect(
    !(await verifyPasswordHash(normalizeBackupCode(confirmed.backupCodes[1] ?? ""), stored)),
    "a hash verifies only its code",
  );
  expectEqual(hasConfirmedTwoFactor({ totp_confirmed_at: rows.totp_confirmed_at }), true, "a confirmed account holds a second factor");
  expectEqual(hasConfirmedTwoFactor({ totp_confirmed_at: null }), false, "an unconfirmed account does not");

  await expectRejects(
    () => startTotpEnrolment({ userId: USER_ID }, dependencies),
    "CONFLICT",
    "a confirmed account cannot start a second enrolment",
  );
  await expectRejects(
    () => confirmTotpEnrolment({ userId: USER_ID, code: "123456" }, dependencies),
    "CONFLICT",
    "a confirmed account cannot confirm again",
  );

  rows.totp_confirmed_at = null;
  rows.totp_secret_ciphertext = null;

  await expectRejects(
    () => confirmTotpEnrolment({ userId: USER_ID, code: "123456" }, dependencies),
    "CONFLICT",
    "a confirmation without a started enrolment is out of order",
  );

  missing = true;

  await expectRejects(
    () => startTotpEnrolment({ userId: USER_ID }, dependencies),
    "AUTHENTICATION_REQUIRED",
    "an account that no longer exists cannot enrol",
  );

  missing = false;
  rows.totp_secret_ciphertext = "v1.not-a-box";

  await expectRejects(
    () => confirmTotpEnrolment({ userId: USER_ID, code: "123456" }, dependencies),
    "INTERNAL_ERROR",
    "a stored value this build did not write is refused",
  );
  expectEqual(twoFactorContext(USER_ID), `users.totp:${USER_ID}`, "the associated data names the account");
}

/* ------------------------------------- STEP 042: the second factor at sign in */

interface ChallengeState {
  challenge:
    | {
        id: string;
        user_id: string;
        company_id: string | null;
        secret_ciphertext: string;
        attempt_count: number;
        expires_at: string;
        consumed_at: string | null;
      }
    | null;
  user: {
    id: string;
    company_id: string | null;
    status: string;
    email_verified_at: string | null;
    deleted_at: string | null;
    totp_secret_ciphertext: string | null;
    totp_confirmed_at: string | null;
    backup_code_hashes: readonly string[];
  };
}

/**
 * A REST double for the challenge table and the account beside it.
 *
 * The gate has no database, and a second factor that is only proved against a mock of the service
 * proves nothing about the order the service works in. This double therefore keeps the state a
 * database would keep - the sealed challenge row, its attempt counter, the consumed instant and the
 * account's backup code verifiers - and the checks below read it back after every call.
 */
function twoFactorLoginFixture(options: {
  readonly totpConfirmed?: boolean;
  readonly secret?: string;
  readonly backupCodeHashes?: readonly string[];
} = {}): {
  readonly state: ChallengeState;
  readonly updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[];
  readonly attempts: ReturnType<typeof createInMemoryLoginAttemptRecorder>;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
  readonly dependencies: Parameters<typeof completeTwoFactorChallenge>[1];
} {
  const secret = options.secret ?? generateTotpSecret();
  const state: ChallengeState = {
    challenge: null,
    user: {
      id: USER_ID,
      company_id: FIRM_ID,
      status: "active",
      email_verified_at: new Date(NOW).toISOString(),
      deleted_at: null,
      totp_secret_ciphertext:
        options.totpConfirmed === false
          ? null
          : packSecretBox(sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID))),
      totp_confirmed_at:
        options.totpConfirmed === false ? null : new Date(NOW - 86_400_000).toISOString(),
      backup_code_hashes: options.backupCodeHashes ?? [],
    },
  };
  const updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[] = [];

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      if (table === "auth_challenges") {
        const wanted = /token_hash=eq\.([0-9a-f]{64})/u.exec(query)?.[1] ?? "";
        const row = state.challenge;

        return Promise.resolve(
          row !== null && row.id === wanted ? ([{ ...row }] as unknown as readonly TRow[]) : [],
        );
      }

      if (table === "users") {
        return Promise.resolve([{ ...state.user }] as unknown as readonly TRow[]);
      }

      return Promise.resolve([]);
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      if (table !== "auth_challenges") {
        return Promise.resolve();
      }

      const row = rows[0] ?? {};

      state.challenge = {
        id: String(row["token_hash"] ?? ""),
        user_id: String(row["user_id"] ?? ""),
        company_id: (row["company_id"] as string | null | undefined) ?? null,
        secret_ciphertext: String(row["secret_ciphertext"] ?? ""),
        attempt_count: 0,
        expires_at: String(row["expires_at"] ?? ""),
        consumed_at: null,
      };

      return Promise.resolve();
    },
    insertReturning: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      updates.push({ table, query, values });

      if (table === "auth_challenges" && state.challenge !== null) {
        if ("attempt_count" in values) {
          state.challenge.attempt_count = Number(values["attempt_count"]);
        }

        if ("consumed_at" in values) {
          state.challenge.consumed_at = values["consumed_at"] as string | null;
        }
      }

      if (table === "users" && "backup_code_hashes" in values) {
        state.user.backup_code_hashes = values["backup_code_hashes"] as readonly string[];
      }

      return Promise.resolve();
    },
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };
  const attempts = createInMemoryLoginAttemptRecorder();
  const audit = createInMemoryAuditTrail();

  return {
    state,
    updates,
    attempts,
    audit,
    dependencies: {
      rest,
      audit,
      attempts,
      cookiePolicy: cookiePolicy(),
      masterKey: () => MASTER_KEY,
      now: () => NOW,
    },
  };
}

async function checkTwoFactorLogin(): Promise<void> {
  const handle = "handle-" + "x".repeat(30);
  const hashed = hashChallengeToken(handle);

  expect(/^[0-9a-f]{64}$/u.test(hashed), "a handle hashes to sixty four hexadecimal characters");
  expectEqual(hashChallengeToken("other-handle-value"), hashChallengeToken("other-handle-value"), "the same handle hashes the same way");
  expect(hashChallengeToken("other-handle-value") !== hashed, "two handles do not share a hash");
  expect(isSameChallengeToken("abc", "abc"), "the comparison accepts equal values");
  expect(!isSameChallengeToken("abc", "abd"), "the comparison refuses different values");
  expectEqual(challengeContext(hashed), `auth.challenge:${hashed}`, "the associated data names the challenge");

  // ---- a correct code produces the session, and only then
  const fixture = twoFactorLoginFixture();

  const issued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0"),
      remoteIp: "203.0.113.9",
      userAgent: "gate",
    },
    fixture.dependencies,
  );

  expectEqual(typeof issued.token, "string", "the challenge answers a handle");
  expectEqual(issued.expiresAtEpochMs, NOW + TWO_FACTOR_CHALLENGE_TTL_MS, "the challenge lives ten minutes");
  expect(fixture.state.challenge !== null, "the challenge is stored");
  expectEqual(
    fixture.state.challenge?.id,
    hashChallengeToken(issued.token),
    "the stored row is keyed by the hash of the handle, never the handle",
  );
  expect(
    !JSON.stringify(fixture.state.challenge).includes(issued.token),
    "the handle itself is not stored anywhere in the row",
  );
  expect(
    !JSON.stringify(fixture.state.challenge).includes("refresh-token-000000000000000000"),
    "the provider pair is sealed, not stored in clear",
  );

  const reopened = openEnrolledSecret(
    fixture.state.user.totp_secret_ciphertext ?? "",
    USER_ID,
    MASTER_KEY,
  );
  const key = base32Decode(reopened) ?? new Uint8Array();
  const goodCode = totpCodeForStep(key, totpStep(NOW));

  const unknownHandle = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: `unknown-${"y".repeat(30)}`, code: goodCode, remoteIp: null, userAgent: null },
        fixture.dependencies,
      ),
    "an unknown handle is refused",
  );

  expectEqual(unknownHandle.code, "AUTHENTICATION_REQUIRED", "an unknown handle answers the generic refusal");

  const wrongCode = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: issued.token, code: "000000", remoteIp: "203.0.113.9", userAgent: "gate" },
        fixture.dependencies,
      ),
    "a wrong code is refused",
  );

  expectEqual(wrongCode.code, "AUTHENTICATION_REQUIRED", "a wrong code answers the generic refusal");
  expectEqual(fixture.state.challenge?.attempt_count, 1, "a wrong code counts one attempt");
  expectEqual(fixture.state.challenge?.consumed_at, null, "a wrong code does not consume the challenge");
  expectEqual(fixture.attempts.attempts.length, 1, "a wrong code records one attempt row");
  expectEqual(fixture.attempts.attempts[0]?.factor, "totp", "the attempt row names the totp factor");
  expectEqual(fixture.attempts.attempts[0]?.outcome, "failed", "the attempt row is a failure");
  expectEqual(fixture.audit.entries.length, 0, "a wrong code writes no audit entry");

  const completed = await completeTwoFactorChallenge(
    { challengeToken: issued.token, code: goodCode, remoteIp: "203.0.113.9", userAgent: "gate" },
    fixture.dependencies,
  );

  expectEqual(completed.userId, USER_ID, "the accepted code answers the account");
  expectEqual(completed.method, "totp", "the accepted code names the method");
  expectEqual(completed.cookies.length, 1, "the accepted code writes one session cookie");
  expectEqual(fixture.state.challenge?.consumed_at, new Date(NOW).toISOString(), "the challenge is consumed");
  expectEqual(fixture.audit.entries.length, 1, "the accepted code writes one audit entry");
  expectEqual(fixture.audit.entries[0]?.action, "user.signed_in", "the entry names the sign in");
  expectEqual(fixture.audit.entries[0]?.payload["assurance_level"], "aal2", "the sign in records the stronger assurance");
  expectEqual(fixture.audit.entries[0]?.payload["method"], "totp", "the sign in records the method");
  expectEqual(fixture.attempts.attempts.length, 2, "the accepted code records its attempt");
  expectEqual(fixture.attempts.attempts[1]?.outcome, "succeeded", "the accepted attempt is a success");

  const policy = cookiePolicy();
  const sessionState = await readSession(completed.cookies[0] ?? "", {
    directory: createInMemoryActorDirectory([
      {
        userId: USER_ID,
        companyId: FIRM_ID,
        roles: ["owner"],
        status: "active",
        emailVerifiedAtEpochMs: NOW - 86_400_000,
        deletedAtEpochMs: null,
        twoFactorConfirmedAtEpochMs: NOW - 86_400_000,
      } as never,
    ]),
    cookiePolicy: policy,
    nowEpochMs: NOW,
  });

  expectEqual(sessionState.kind, "authenticated", "the cookie minted by the code is a session");
  expect(
    sessionState.kind === "authenticated" && sessionState.actor.twoFactorSatisfied,
    "the session says the second factor was satisfied",
  );
  expectEqual(
    decodeSessionCookies(policy, completed.cookies[0] ?? "")?.assuranceLevel,
    "aal2",
    "the payload carries the assurance this platform established",
  );

  const replay = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: issued.token, code: goodCode, remoteIp: null, userAgent: null },
        fixture.dependencies,
      ),
    "a consumed challenge is refused",
  );

  expectEqual(replay.code, "AUTHENTICATION_REQUIRED", "a consumed challenge answers the generic refusal");

  // ---- five rejected codes retire the challenge
  const limited = twoFactorLoginFixture();
  const limitedIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: null,
      userAgent: null,
    },
    limited.dependencies,
  );

  for (let attempt = 0; attempt < TWO_FACTOR_MAXIMUM_ATTEMPTS; attempt += 1) {
    const refused = await captureRejection(
      () =>
        completeTwoFactorChallenge(
          { challengeToken: limitedIssued.token, code: "111111", remoteIp: "203.0.113.9", userAgent: "gate" },
          limited.dependencies,
        ),
      "a rejected code is refused",
    );

    expectEqual(refused.code, "AUTHENTICATION_REQUIRED", "every rejected code answers the same refusal");
  }

  expectEqual(limited.state.challenge?.attempt_count, TWO_FACTOR_MAXIMUM_ATTEMPTS, "the counter reaches the ceiling");
  expect(limited.state.challenge?.consumed_at !== null, "the challenge retires when the ceiling is reached");

  const afterCeiling = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: limitedIssued.token, code: goodCode, remoteIp: null, userAgent: null },
        limited.dependencies,
      ),
    "a retired challenge is refused even with the right code",
  );

  expectEqual(afterCeiling.code, "AUTHENTICATION_REQUIRED", "a retired challenge cannot be completed");

  // ---- an expired challenge, and an account that is no longer signable
  const expired = twoFactorLoginFixture();
  const expiredIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: null,
      userAgent: null,
    },
    { ...expired.dependencies, now: () => NOW - TWO_FACTOR_CHALLENGE_TTL_MS - 1_000 },
  );

  expectEqual(
    expiredIssued.expiresAtEpochMs,
    NOW - 1_000,
    "a challenge issued in the past has already expired",
  );

  const refusedExpired = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: expiredIssued.token, code: goodCode, remoteIp: null, userAgent: null },
        expired.dependencies,
      ),
    "an expired challenge is refused",
  );

  expectEqual(refusedExpired.code, "AUTHENTICATION_REQUIRED", "an expired challenge answers the generic refusal");

  const closed = twoFactorLoginFixture();
  const closedIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: null,
      userAgent: null,
    },
    closed.dependencies,
  );

  closed.state.user.status = "suspended";

  await expectRejects(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: closedIssued.token, code: goodCode, remoteIp: null, userAgent: null },
        closed.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "an account suspended between the password and the code cannot complete",
  );

  const unenrolled = twoFactorLoginFixture({ totpConfirmed: false });
  const unenrolledIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: null,
      userAgent: null,
    },
    unenrolled.dependencies,
  );

  await expectRejects(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: unenrolledIssued.token, code: goodCode, remoteIp: null, userAgent: null },
        unenrolled.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "a challenge whose account lost its second factor cannot complete",
  );

  await expectRejects(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: "short", code: goodCode, remoteIp: null, userAgent: null },
        fixture.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "a malformed handle is refused before any query",
  );

  // ---- a backup code is one sign in
  const backupPlain = "abcde-fghjk";
  const otherPlain = "mnpqr-stuvw";
  const hashes = [
    await hashPassword(normalizeBackupCode(backupPlain)),
    await hashPassword(normalizeBackupCode(otherPlain)),
  ];
  const backup = twoFactorLoginFixture({ backupCodeHashes: hashes });
  const backupIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: "203.0.113.9",
      userAgent: "gate",
    },
    backup.dependencies,
  );

  const withBackup = await completeTwoFactorChallenge(
    { challengeToken: backupIssued.token, code: "ABCDE FGHJK", remoteIp: "203.0.113.9", userAgent: "gate" },
    backup.dependencies,
  );

  expectEqual(withBackup.method, "backup_code", "a backup code is accepted at the second factor");
  expectEqual(withBackup.cookies.length, 1, "a backup code writes a session cookie");
  expectEqual(backup.state.user.backup_code_hashes.length, 1, "using a backup code leaves the others");
  expectEqual(
    backup.state.user.backup_code_hashes[0],
    hashes[1],
    "the verifier of the used code is the one removed",
  );
  expectEqual(backup.audit.entries.length, 2, "a backup code writes two audit entries");
  expectEqual(backup.audit.entries[0]?.action, "user.backup_code_used", "the first entry names the code use");
  expectEqual(backup.audit.entries[0]?.payload["remaining"], 1, "the entry counts the codes left");
  expectEqual(backup.audit.entries[1]?.action, "user.signed_in", "the second entry names the sign in");
  expectEqual(backup.audit.entries[1]?.payload["method"], "backup_code", "the sign in records the backup code");

  const secondBackup = twoFactorLoginFixture({ backupCodeHashes: [hashes[0] as string] });
  const secondIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: null,
      userAgent: null,
    },
    secondBackup.dependencies,
  );

  await expectRejects(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: secondIssued.token, code: otherPlain, remoteIp: null, userAgent: null },
        secondBackup.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "a backup code that was already used is refused",
  );
  expectEqual(secondBackup.state.challenge?.attempt_count, 1, "a used backup code counts an attempt");
  expectEqual(secondBackup.audit.entries.length, 0, "a used backup code writes no audit entry");

  // ---- a pair at the documented maxima must fit the column it is sealed into
  const largest = twoFactorLoginFixture();
  const largestSecret = generateTotpSecret();
  largest.state.user.totp_secret_ciphertext = packSecretBox(
    sealSecret(MASTER_KEY, largestSecret, twoFactorContext(USER_ID)),
  );

  const largestIssued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: "a".repeat(MAXIMUM_ACCESS_TOKEN_LENGTH),
        refreshToken: "r".repeat(2_048),
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: null,
      userAgent: null,
    },
    largest.dependencies,
  );
  const packed = largest.state.challenge?.secret_ciphertext ?? "";

  expect(packed.length > 4_096, "a pair at the documented maxima is larger than the 0082 ceiling");
  expect(packed.length < 16_384, "a pair at the documented maxima fits the ceiling 0083 sets");

  const largestKey = base32Decode(largestSecret) ?? new Uint8Array();
  const largestCompleted = await completeTwoFactorChallenge(
    {
      challengeToken: largestIssued.token,
      code: totpCodeForStep(largestKey, totpStep(NOW)),
      remoteIp: null,
      userAgent: null,
    },
    largest.dependencies,
  );

  expect(
    largestCompleted.cookies.length > 1,
    "a pair at the documented maxima is split across several cookies",
  );
  expect(
    largestCompleted.cookies.length <= AUTH_COOKIE_MAXIMUM_CHUNKS,
    "the split stays inside the chunk ceiling",
  );
  expectEqual(
    decodeSessionCookies(cookiePolicy(), bareCookies(largestCompleted.cookies))?.assuranceLevel,
    "aal2",
    "the chunked cookies assemble back into the signed payload",
  );
  expectEqual(
    largestCompleted.userId,
    USER_ID,
    "the largest pair answers the account it belongs to",
  );

  // ---- the password step stops when the account has a second factor
  const challenged = signinFixture({
    user: {
      id: USER_ID,
      company_id: FIRM_ID,
      status: "active",
      email_verified_at: new Date(NOW).toISOString(),
      deleted_at: null,
      totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    },
  });
  const challengedResult = await signInMerchant(
    {
      request: signinRequest(),
      remoteIp: "203.0.113.9",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0",
    },
    challenged.dependencies,
  );

  expectEqual(challengedResult.outcome, "two_factor_required", "a password alone does not sign an enrolled account in");

  if (challengedResult.outcome === "two_factor_required") {
    expect(
      !("cookies" in challengedResult),
      "the challenge result has no cookie field at all",
    );
    expect(challengedResult.challengeToken.length > 20, "the challenge answers a handle");
  }

  expectEqual(challenged.inserts.length, 1, "the challenge writes one row");
  expectEqual(challenged.inserts[0]?.table, "auth_challenges", "the row is a challenge");
  expectEqual(challenged.audit.entries.length, 1, "the password step writes one audit entry");
  expectEqual(challenged.audit.entries[0]?.action, "user.two_factor_challenged", "the entry names the challenge");
  expect(
    challenged.audit.entries.every((entry) => entry.action !== "user.signed_in"),
    "the password step never audits a sign in it did not complete",
  );
  expectEqual(challenged.attempts.attempts.length, 1, "the password step records its own attempt");
  expectEqual(challenged.attempts.attempts[0]?.outcome, "succeeded", "the password attempt is a success");
  expectEqual(challenged.attempts.attempts[0]?.factor, "password", "the attempt names the password factor");
}

/* ------------------------------------------ STEP 043: fresh backup codes */

/**
 * The settings action that replaces a set of backup codes.
 *
 * The double here keeps what a database keeps: the account row with its verifiers, and the single
 * update the action writes. The checks read the row back afterwards, so "the old codes stopped
 * working" is proved by verifying the old code against the new column rather than by trusting the
 * call that replaced it.
 */
async function checkBackupCodeRegeneration(): Promise<void> {
  const secret = generateTotpSecret();
  const oldPlain = "abcde-fghjk";
  const oldHashes: string[] = [
    await hashPassword(normalizeBackupCode(oldPlain)),
    await hashPassword(normalizeBackupCode("mnpqr-stuvw")),
  ];
  const updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[] = [];
  const account = {
    id: USER_ID,
    company_id: FIRM_ID,
    status: "active",
    deleted_at: null as string | null,
    totp_secret_ciphertext: packSecretBox(sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID))),
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString() as string | null,
    backup_code_hashes: oldHashes as readonly string[],
  };
  const rest: RestClient = {
    select<TRow>(): Promise<readonly TRow[]> {
      return Promise.resolve([{ ...account }] as unknown as readonly TRow[]);
    },
    insert: () => Promise.resolve(),
    insertReturning: () => Promise.resolve([]),
    update(table: string, query: string, values: Readonly<Record<string, unknown>>) {
      updates.push({ table, query, values });
      account.backup_code_hashes = values["backup_code_hashes"] as readonly string[];

      return Promise.resolve();
    },
    rpc: () => Promise.resolve(null),
  };
  const audit = createInMemoryAuditTrail();
  const dependencies = { rest, audit, masterKey: () => MASTER_KEY, now: () => NOW };
  const key = base32Decode(secret) ?? new Uint8Array();
  const goodCode = totpCodeForStep(key, totpStep(NOW));

  const before = await readTwoFactorStatus({ userId: USER_ID }, dependencies);

  expectEqual(before.enrolled, true, "a confirmed account reads as enrolled");
  expectEqual(before.backupCodesRemaining, 2, "the status counts the verifiers, not the codes");
  expectEqual(
    before.confirmedAt,
    new Date(NOW - 86_400_000).toISOString(),
    "the status answers when the factor was confirmed",
  );

  const regenerated = await regenerateBackupCodes({ userId: USER_ID, code: goodCode }, dependencies);

  expectEqual(regenerated.backupCodes.length, 10, "a regeneration issues ten codes");
  expectEqual(new Set(regenerated.backupCodes).size, 10, "the ten codes are distinct");
  expectEqual(regenerated.replaced, 2, "the answer says how many were replaced");
  expectEqual(updates.length, 1, "a regeneration writes one row");
  expectEqual(updates[0]?.table, "users", "the write is the account row");
  expect(
    (updates[0]?.query ?? "").includes(`id=eq.${USER_ID}`),
    "the write names the account it belongs to",
  );
  expectEqual(account.backup_code_hashes.length, 10, "the column now holds ten verifiers");
  expect(
    !(await verifyPasswordHash(normalizeBackupCode(oldPlain), account.backup_code_hashes[0] ?? "")),
    "an old code no longer verifies against the first new verifier",
  );
  expect(
    !(await verifyPasswordHash(normalizeBackupCode(oldPlain), account.backup_code_hashes[9] ?? "")),
    "an old code no longer verifies against the last new verifier",
  );

  let matchedNew = false;

  for (const hash of account.backup_code_hashes) {
    if (await verifyPasswordHash(normalizeBackupCode(regenerated.backupCodes[0] ?? ""), hash)) {
      matchedNew = true;
    }
  }

  expect(matchedNew, "a code from the new set verifies against the stored column");
  expectEqual(audit.entries.length, 1, "a regeneration writes one audit entry");
  expectEqual(audit.entries[0]?.action, "user.backup_codes_regenerated", "the entry names the action");
  expectEqual(audit.entries[0]?.payload["issued"], 10, "the entry counts the codes issued");
  expectEqual(audit.entries[0]?.payload["replaced"], 2, "the entry counts the codes replaced");
  expectEqual(audit.entries[0]?.companyId, FIRM_ID, "the entry joins the tenant chain");

  const after = await readTwoFactorStatus({ userId: USER_ID }, dependencies);

  expectEqual(after.backupCodesRemaining, 10, "the status reflects the fresh set");

  const wrongCode = await captureRejection(
    () => regenerateBackupCodes({ userId: USER_ID, code: "000000" }, dependencies),
    "a wrong authenticator code is refused",
  );

  expectEqual(wrongCode.code, "VALIDATION_FAILED", "a wrong code is a form failure");
  expectEqual(wrongCode.details?.[0]?.field, "code", "the refusal names the code field");
  expectEqual(updates.length, 1, "a wrong code writes nothing");
  expectEqual(audit.entries.length, 1, "a wrong code audits nothing");

  const malformed = await captureRejection(
    () => regenerateBackupCodes({ userId: USER_ID, code: "12" }, dependencies),
    "a malformed code is refused",
  );

  expectEqual(malformed.details?.[0]?.rule, "invalid_format", "a malformed code fails on its shape");

  account.totp_confirmed_at = null;

  await expectRejects(
    () => regenerateBackupCodes({ userId: USER_ID, code: goodCode }, dependencies),
    "CONFLICT",
    "an account without a confirmed factor has nothing to regenerate",
  );

  const notEnrolled = await readTwoFactorStatus({ userId: USER_ID }, dependencies);

  expectEqual(notEnrolled.enrolled, false, "the status says the factor is not on");
  expectEqual(notEnrolled.backupCodesRemaining, 0, "an unenrolled account holds no codes");
  expectEqual(notEnrolled.confirmedAt, null, "an unenrolled account has no confirmation instant");

  account.totp_confirmed_at = new Date(NOW - 86_400_000).toISOString();
  account.status = "suspended";

  await expectRejects(
    () => regenerateBackupCodes({ userId: USER_ID, code: goodCode }, dependencies),
    "AUTHENTICATION_REQUIRED",
    "a closed account cannot regenerate codes",
  );
  await expectRejects(
    () => readTwoFactorStatus({ userId: USER_ID }, dependencies),
    "AUTHENTICATION_REQUIRED",
    "a closed account cannot read the status",
  );

  account.status = "active";
  account.deleted_at = new Date(NOW).toISOString();

  await expectRejects(
    () => regenerateBackupCodes({ userId: USER_ID, code: goodCode }, dependencies),
    "AUTHENTICATION_REQUIRED",
    "a deleted account cannot regenerate codes",
  );

  account.deleted_at = null;

  const emptyRest: RestClient = {
    select: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    insert: () => Promise.resolve(),
    insertReturning: () => Promise.resolve([]),
    update: () => Promise.resolve(),
    rpc: () => Promise.resolve(null),
  };

  await expectRejects(
    () =>
      readTwoFactorStatus(
        { userId: USER_ID },
        { rest: emptyRest, audit, masterKey: () => MASTER_KEY, now: () => NOW },
      ),
    "AUTHENTICATION_REQUIRED",
    "an account the platform has no row for cannot read the status",
  );

  // The fresh set works where the account needs it: at the second factor of a sign in.
  const login = twoFactorLoginFixture({ backupCodeHashes: account.backup_code_hashes });
  login.state.user.totp_secret_ciphertext = account.totp_secret_ciphertext;
  login.state.user.totp_confirmed_at = account.totp_confirmed_at;

  const issued = await issueTwoFactorChallenge(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      session: {
        accessToken: makeAccessToken(baseClaims()),
        refreshToken: "refresh-token-000000000000000000",
        expiresAtEpochMs: NOW + 3_600_000,
        sessionId: SESSION_ID,
      },
      device: readDeviceContext(null),
      remoteIp: "203.0.113.9",
      userAgent: "gate",
    },
    login.dependencies,
  );
  const signedIn = await completeTwoFactorChallenge(
    {
      challengeToken: issued.token,
      code: regenerated.backupCodes[3] ?? "",
      remoteIp: "203.0.113.9",
      userAgent: "gate",
    },
    login.dependencies,
  );

  expectEqual(signedIn.method, "backup_code", "a code from the fresh set signs in");
  expectEqual(
    login.state.user.backup_code_hashes.length,
    9,
    "using one of the fresh codes leaves nine",
  );
}

/* ------------------------------------------------- two factor reset (044) */

interface ResetRequestRow {
  id: string;
  user_id: string;
  company_id: string | null;
  status: string;
  reason: string;
  document_reference: string | null;
  requested_ip: string | null;
  requested_user_agent: string | null;
  contacted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
}

interface ResetStore {
  readonly rest: RestClient;
  readonly requests: ResetRequestRow[];
  readonly queries: string[];
  readonly writes: { table: string; values: Readonly<Record<string, unknown>> }[];
  readonly account: {
    id: string;
    company_id: string | null;
    email: string;
    status: string;
    deleted_at: string | null;
    totp_confirmed_at: string | null;
    totp_secret_ciphertext: string | null;
    backup_code_hashes: readonly string[];
  };
}

/** The one value of a `key=eq.value` predicate, decoded. */
function queryEquals(query: string, key: string): string | null {
  const match = new RegExp(`(?:^|[&?])${key}=eq\\.([^&]*)`, "u").exec(query);

  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/**
 * A miniature PostgREST for the reset tables.
 *
 * It answers the four shapes the module uses - an address lookup, a row lookup by id, an insert and an
 * update - and it enforces the one database rule the service has to survive: the partial unique index
 * that allows a single live request per account. Everything else it records, so a check can prove what
 * was written without a database.
 */
function createResetStore(): ResetStore {
  const requests: ResetRequestRow[] = [];
  const queries: string[] = [];
  const writes: { table: string; values: Readonly<Record<string, unknown>> }[] = [];
  const account: ResetStore["account"] = {
    id: USER_ID,
    company_id: FIRM_ID,
    email: "owner@firm.test",
    status: "active",
    deleted_at: null,
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    totp_secret_ciphertext: "sealed-secret",
    backup_code_hashes: ["scrypt$1$16384$8$c2FsdA$aGFzaA"],
  };
  let sequence = 70;

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      queries.push(`${table}?${query}`);

      if (table === "users") {
        const email = queryEquals(query, "email");

        return Promise.resolve(
          (email === null || email !== account.email ? [] : [{ ...account }]) as unknown as readonly TRow[],
        );
      }

      if (table !== "two_factor_reset_requests") {
        return Promise.resolve([] as readonly TRow[]);
      }

      const id = queryEquals(query, "id");

      if (id !== null) {
        return Promise.resolve(
          requests.filter((row) => row.id === id).map((row) => ({ ...row })) as unknown as readonly TRow[],
        );
      }

      const live = query.includes("status=in.(pending,contacted)");

      return Promise.resolve(
        requests
          .filter((row) => !live || row.status === "pending" || row.status === "contacted")
          .map((row) => ({ ...row })) as unknown as readonly TRow[],
      );
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      if (table !== "two_factor_reset_requests") {
        return Promise.resolve();
      }

      for (const row of rows) {
        const userId = String(row["user_id"]);
        const live = requests.some(
          (existing) =>
            existing.user_id === userId &&
            (existing.status === "pending" || existing.status === "contacted"),
        );

        if (live) {
          return Promise.reject(new AppError("CONFLICT"));
        }

        sequence += 1;
        requests.push({
          id: `018f3b1c-5555-7c2a-9d1e-2b3c4d5e6f${String(sequence)}`,
          user_id: userId,
          company_id: (row["company_id"] as string | null) ?? null,
          status: String(row["status"]),
          reason: String(row["reason"]),
          document_reference: (row["document_reference"] as string | null) ?? null,
          requested_ip: (row["requested_ip"] as string | null) ?? null,
          requested_user_agent: (row["requested_user_agent"] as string | null) ?? null,
          contacted_at: null,
          decided_at: null,
          decided_by: null,
          decision_note: null,
          created_at: "2027-01-15T08:00:00.000Z",
        });
      }

      return Promise.resolve();
    },
    insertReturning<TRow>(): Promise<readonly TRow[]> {
      return Promise.resolve([] as readonly TRow[]);
    },
    update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      writes.push({ table, values });

      if (table === "users") {
        Object.assign(account, values);

        return Promise.resolve();
      }

      const id = queryEquals(query, "id");
      const row = requests.find((candidate) => candidate.id === id);

      if (row !== undefined) {
        Object.assign(row, values);
      }

      return Promise.resolve();
    },
    rpc: () => Promise.resolve(null),
  };

  return { rest, requests, queries, writes, account };
}

/** An office worker: a session that satisfied the second factor, with the roles of a support desk. */
function resetActor(options: { readonly roles?: readonly PlatformRole[] } = {}): RequestActor {
  return {
    userId: USER_ID,
    companyId: null,
    roles: options.roles ?? ["support"],
    sessionId: SESSION_ID,
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW - 60_000,
    expiresAtEpochMs: NOW + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
  };
}

async function checkTwoFactorReset(): Promise<void> {
  const longReason = "The phone with the authenticator app was lost and the backup codes with it.";

  // The form is strict and normalises the address, so one mailbox is one account.
  const normalised = resetRequestInputSchema.safeParse({
    email: "  Owner@Firm.TEST ",
    reason: longReason,
  });

  expectEqual(
    normalised.success ? normalised.data.email : null,
    "owner@firm.test",
    "the form lowercases and trims the address",
  );
  expectEqual(
    resetRequestInputSchema.safeParse({ email: "owner@firm.test", reason: "lost" }).success,
    false,
    "a reason shorter than ten characters is refused",
  );
  expectEqual(
    resetRequestInputSchema.safeParse({
      email: "owner@firm.test",
      reason: longReason,
      status: "approved",
    }).success,
    false,
    "the form refuses a field the merchant must not set",
  );

  const store = createResetStore();
  const audit = createInMemoryAuditTrail();
  const dependencies = { rest: store.rest, audit, now: () => NOW };
  const askInput = {
    request: { email: "owner@firm.test", reason: longReason },
    remoteIp: "203.0.113.7",
    userAgent: "gate",
  };

  const first = await requestTwoFactorReset(askInput, dependencies);

  expectEqual(first.accepted, true, "a request for an enrolled account is accepted");
  expectEqual(store.requests.length, 1, "the request writes exactly one row");
  expectEqual(store.requests[0]?.status, "pending", "a new request waits for the office");
  expectEqual(store.requests[0]?.user_id, USER_ID, "the row names the account it is about");
  expectEqual(store.requests[0]?.company_id, FIRM_ID, "the row joins the tenant chain");
  expectEqual(store.requests[0]?.requested_ip, "203.0.113.7", "the row keeps the address it came from");
  expectEqual(audit.entries.length, 1, "the request writes one audit entry");
  expectEqual(
    audit.entries[0]?.action,
    "user.two_factor_reset_requested",
    "the entry names the action",
  );
  expectEqual(audit.entries[0]?.actorUserId, null, "the entry has no actor: nobody was signed in");
  expectEqual(
    audit.entries[0]?.payload["reason_length"],
    longReason.length,
    "the entry records the length of the reason, not the reason",
  );
  expectEqual(
    Object.keys(audit.entries[0]?.payload ?? {}).includes("email"),
    false,
    "the entry carries no address",
  );

  // A second ask is the live-key index doing its job, and it reads as the same answer.
  const second = await requestTwoFactorReset(askInput, dependencies);

  expectEqual(second.accepted, true, "a second request answers the same sentence");
  expectEqual(store.requests.length, 1, "a second request writes no second row");
  expectEqual(audit.entries.length, 1, "a second request writes no second audit entry");

  // The four addresses the platform must answer without saying why.
  const unknownAddress = await requestTwoFactorReset(
    { ...askInput, request: { email: "stranger@firm.test", reason: longReason } },
    dependencies,
  );

  expectEqual(unknownAddress.accepted, true, "an address with no account gets the same answer");

  store.account.status = "suspended";

  const closedAddress = await requestTwoFactorReset(askInput, dependencies);

  expectEqual(closedAddress.accepted, true, "a closed account gets the same answer");

  store.account.status = "active";
  store.account.deleted_at = new Date(NOW).toISOString();

  const deletedAddress = await requestTwoFactorReset(askInput, dependencies);

  expectEqual(deletedAddress.accepted, true, "a deleted account gets the same answer");

  store.account.deleted_at = null;
  store.account.totp_confirmed_at = null;

  const neverEnrolled = await requestTwoFactorReset(askInput, dependencies);

  expectEqual(neverEnrolled.accepted, true, "an account with no second factor gets the same answer");
  expectEqual(store.requests.length, 1, "none of the four wrote a row");
  expectEqual(audit.entries.length, 1, "none of the four wrote an audit entry");

  store.account.totp_confirmed_at = new Date(NOW - 86_400_000).toISOString();

  const malformed = await captureRejection(
    () => requestTwoFactorReset({ ...askInput, request: { email: "owner@firm.test", reason: "no" } }, dependencies),
    "a too short reason is refused",
  );

  expectEqual(malformed.code, "VALIDATION_FAILED", "a too short reason is a form failure");
  expectEqual(malformed.details?.[0]?.field, "reason", "the refusal names the reason field");

  // The queue: who may read it, and what it holds.
  const support = resetActor({ roles: ["support"] });
  const finance = resetActor({ roles: ["finance_ops"] });

  const queue = await listTwoFactorResetRequests({ actor: support, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: 100 }, { rest: store.rest });

  expectEqual(queue.length, 1, "the queue shows the one live request");
  expectEqual(queue[0]?.status, "pending", "the queue keeps the status the database holds");
  expectEqual(queue[0]?.reason, longReason, "the queue shows what the merchant reported");
  expectEqual(queue[0]?.documentReference, null, "a pending request has no document yet");
  expectEqual(
    store.queries.at(-1)?.includes("status=in.(pending,contacted)"),
    true,
    "the queue reads only the two live statuses",
  );
  expectEqual(
    store.queries.at(-1)?.includes("email"),
    false,
    "the queue selects no address",
  );

  await listTwoFactorResetRequests({ actor: support, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: 5_000 }, { rest: store.rest });

  expectEqual(store.queries.at(-1)?.endsWith("limit=200"), true, "a large limit is clamped to the ceiling");

  await listTwoFactorResetRequests({ actor: support, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: 0 }, { rest: store.rest });

  expectEqual(store.queries.at(-1)?.endsWith("limit=1"), true, "a limit below one is raised to one");

  await expectRejects(
    () => listTwoFactorResetRequests({ actor: finance, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: 50 }, { rest: store.rest }),
    "PERMISSION_DENIED",
    "a role outside the office list cannot read the queue",
  );

  const requestId = store.requests[0]?.id ?? "";

  // The decisions, in the order the database allows them.
  await expectRejects(
    () =>
      decideTwoFactorReset(
        { actor: finance, requestId, action: "approve", documentReference: null, note: null },
        dependencies,
      ),
    "PERMISSION_DENIED",
    "a role outside the office list cannot decide a request",
  );

  await expectRejects(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId: "not-a-uuid", action: "approve", documentReference: null, note: null },
        dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    "a malformed request id is not found, not a crash",
  );

  await expectRejects(
    () =>
      decideTwoFactorReset(
        {
          actor: support,
          requestId: "018f3b1c-6666-7c2a-9d1e-2b3c4d5e6f75",
          action: "approve",
          documentReference: null,
          note: null,
        },
        dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    "an unknown request id is not found",
  );

  await expectRejects(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId, action: "approve", documentReference: null, note: null },
        dependencies,
      ),
    "CONFLICT",
    "a reset cannot skip the record of the contact",
  );

  const noDocument = await captureRejection(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId, action: "contacted", documentReference: "  ", note: null },
        dependencies,
      ),
    "a contact without a document is refused",
  );

  expectEqual(noDocument.code, "VALIDATION_FAILED", "a contact without a document is a form failure");
  expectEqual(
    noDocument.details?.[0]?.field,
    "documentReference",
    "the refusal names the document field",
  );
  expectEqual(store.requests[0]?.status, "pending", "a refused contact changes nothing");

  const contacted = await decideTwoFactorReset(
    {
      actor: support,
      requestId,
      action: "contacted",
      documentReference: "Passport and utility bill checked against the company record on 15 January.",
      note: null,
    },
    dependencies,
  );

  expectEqual(contacted.status, "contacted", "the contact moves the request on");
  expectEqual(store.requests[0]?.status, "contacted", "the row records the contact");
  expectEqual(store.requests[0]?.contacted_at, new Date(NOW).toISOString(), "the row records when");
  expectEqual(
    store.requests[0]?.document_reference,
    "Passport and utility bill checked against the company record on 15 January.",
    "the row records what was verified",
  );
  expectEqual(
    audit.entries.at(-1)?.action,
    "user.two_factor_reset_contacted",
    "the contact is audited",
  );
  expectEqual(audit.entries.at(-1)?.actorUserId, USER_ID, "the entry names the office worker");

  await expectRejects(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId, action: "contacted", documentReference: "again", note: null },
        dependencies,
      ),
    "CONFLICT",
    "a contact cannot be recorded twice",
  );

  const approved = await decideTwoFactorReset(
    { actor: support, requestId, action: "approve", documentReference: null, note: null },
    dependencies,
  );

  expectEqual(approved.status, "approved", "an approval after the contact is accepted");
  expectEqual(approved.userId, USER_ID, "the answer names the account that was reset");
  expectEqual(store.requests[0]?.status, "approved", "the row records the decision");
  expectEqual(store.requests[0]?.decided_by, USER_ID, "the row records who decided");
  expectEqual(store.account.totp_secret_ciphertext, null, "the approval clears the authenticator secret");
  expectEqual(store.account.totp_confirmed_at, null, "the approval clears the confirmation instant");
  expectEqual(store.account.backup_code_hashes.length, 0, "the approval clears every backup code");
  expectEqual(store.account.status, "active", "the approval leaves the account open");
  expectEqual(audit.entries.at(-1)?.action, "user.two_factor_reset", "the approval is audited");
  expectEqual(
    audit.entries.at(-1)?.payload["method"],
    "office_reset",
    "the entry says the second factor was cleared by the office",
  );
  expectEqual(
    audit.entries.at(-1)?.payload["document_reference_present"],
    true,
    "the entry records that documents were seen, not what they were",
  );

  await expectRejects(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId, action: "approve", documentReference: null, note: null },
        dependencies,
      ),
    "CONFLICT",
    "an approved request cannot be approved again",
  );
  await expectRejects(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId, action: "reject", documentReference: null, note: "late" },
        dependencies,
      ),
    "CONFLICT",
    "an approved request cannot be rejected afterwards",
  );

  const emptyQueue = await listTwoFactorResetRequests(
    { actor: support, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: 50 },
    { rest: store.rest },
  );

  expectEqual(emptyQueue.length, 0, "a decided request leaves the queue");

  // A reset account has no factor left to reset: asking again is answered and forgotten until the
  // merchant enrols, which is exactly the second sentence of section 22.
  const beforeEnrolment = await requestTwoFactorReset(
    { ...askInput, request: { email: "owner@firm.test", reason: longReason } },
    dependencies,
  );

  expectEqual(beforeEnrolment.accepted, true, "an account with a cleared factor gets the same answer");
  expectEqual(store.requests.length, 1, "an account with a cleared factor writes no row");

  // Once the merchant enrols again the slot is free and a rejection ends in the same place.
  store.account.totp_confirmed_at = new Date(NOW).toISOString();

  const afterReset = await requestTwoFactorReset(
    { ...askInput, request: { email: "owner@firm.test", reason: longReason } },
    dependencies,
  );

  expectEqual(afterReset.accepted, true, "an approved reset does not block a later request");
  expectEqual(store.requests.length, 2, "the later request writes a new row");

  const secondId = store.requests[1]?.id ?? "";

  const noNote = await captureRejection(
    () =>
      decideTwoFactorReset(
        { actor: support, requestId: secondId, action: "reject", documentReference: null, note: " " },
        dependencies,
      ),
    "a rejection without a reason is refused",
  );

  expectEqual(noNote.code, "VALIDATION_FAILED", "a rejection without a reason is a form failure");
  expectEqual(noNote.details?.[0]?.field, "note", "the refusal names the note field");

  const rejected = await decideTwoFactorReset(
    {
      actor: support,
      requestId: secondId,
      action: "reject",
      documentReference: null,
      note: "The documents did not match the company record.",
    },
    dependencies,
  );

  expectEqual(rejected.status, "rejected", "a rejection is accepted");
  expectEqual(store.requests[1]?.status, "rejected", "the row records the rejection");
  expectEqual(store.requests[1]?.decided_by, USER_ID, "the row records who rejected it");
  expectEqual(
    store.requests[1]?.decision_note,
    "The documents did not match the company record.",
    "the row records why",
  );
  expectEqual(
    audit.entries.at(-1)?.action,
    "user.two_factor_reset_rejected",
    "the rejection is audited",
  );
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  checkConfig();
  checkClaims();
  checkCookies();
  checkFailures();
  await checkTransport();
  await checkDirectory();
  await checkSession();
  await checkClient();
  await checkAdminClient();
  checkSecrets();
  await checkSettings();
  await checkTurnstile();
  checkAudit();
  await checkRestAuditTrail();
  await checkPolicies();
  await checkPassword();
  await checkBreachCheck();
  await checkRegistration();
  await checkEmailVerification();
  checkClientAddress();
  checkDeviceContext();
  await checkLoginAttempts();
  await checkSignin();
  checkTotp();
  checkQr();
  await checkTwoFactor();
  await checkTwoFactorLogin();
  await checkBackupCodeRegeneration();
  await checkTwoFactorReset();

  if (failures.length > 0) {
    process.stderr.write(`auth gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `auth gate passed: ${checkCount} checks, cookie "${cookiePolicy().name}", ` +
      `${AUTH_COOKIE_MAXIMUM_CHUNKS} chunk ceiling\n`,
  );
}

await main();
