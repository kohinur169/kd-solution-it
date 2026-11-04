// path: lib/auth/verify.ts
import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { ERROR_CODES } from "../errors/codes.ts";
import { buildErrorEnvelope } from "../errors/respond.ts";
import { createAuthAdminClient } from "./admin-client.ts";
import {
  AUDIT_SIGNING_KEY_ID,
  createInMemoryAuditTrail,
  createRestAuditTrail,
  signAuditHash,
} from "./audit.ts";
import { isAddress, readClientAddress, readUserAgent } from "./client-address.ts";
import { deviceEnrolmentSchema, enrolDeviceProofKey, inspectProofKey } from "./device-enrolment.ts";
import {
  decodeBase64Url,
  encodeBase64Url,
  generateProofKeyPair,
  isPublicKeyShape,
  isStoredProofKey,
  PROOF_KEY_FINGERPRINT_PATTERN,
  PROOF_KEY_LABEL_MAXIMUM_LENGTH,
  proofKeyLabel,
  publicProofKeyOf,
  requestBodyDigest,
  requestProofMessage,
  REQUEST_PROOF_HEADERS,
  REQUEST_PROOF_VERSION,
  REQUEST_PROOF_WINDOW_MS,
  sha256Base64Url,
  signProofMessage,
  verifyProofMessage,
  type ProofKeyAlgorithm,
} from "./proof-key.ts";
import {
  createRawSessionToken,
  hashSessionToken,
  isSessionToken,
  issueSessionToken,
  resolveSessionToken,
  createRestSessionTokenStore,
  revokeDeviceSessions,
  revokeSession,
  SESSION_REVOCATION_REASONS,
  SESSION_ABSOLUTE_WINDOW_MS,
  SESSION_ROTATION_GRACE_MS,
  SESSION_ROTATION_INTERVAL_MS,
  SESSION_ROTATION_WINDOW_MS,
  SESSION_TOKEN_PATTERN,
  type NewSessionRow,
  type SessionRow,
  type SessionTokenStore,
} from "./session-rotation.ts";
import { readBoundSession, readRequestActor } from "./request-actor.ts";
import {
  isSensitivePath,
  requireTrustedDevice,
  SENSITIVE_ENDPOINTS,
  verifySensitiveRequest,
} from "./request-proof.ts";
import {
  readStepUpState,
  REAUTHENTICATION_REQUIRED_RULE,
  reauthenticateSession,
  requireFreshReauthentication,
  STEP_UP_WINDOW_MS,
} from "./step-up.ts";
import {
  challengeDeviceTrust,
  confirmDeviceTrust,
  DEVICE_TRUST_MAXIMUM_ATTEMPTS,
  DEVICE_TRUST_WINDOW_MS,
  NEW_DEVICE_TEMPLATE_KEY,
  readDeviceTrust,
} from "./device-trust.ts";
import {
  ANONYMOUS_AUTH_SURFACES,
  ANONYMOUS_REFUSAL,
  FORBIDDEN_ON_ANONYMOUS_SURFACES,
  SIGNUP_ACCEPTANCE,
  SESSION_AUTH_SURFACES,
  TWO_FACTOR_RESET_ACCEPTANCE,
  anonymousRejection,
  anonymousSurfaceCodes,
  classifiedPaths,
  isAllowedOnSurface,
  isCatalogCode,
  isDisclosingDetail,
} from "./disclosure.ts";
import {
  listAccountSessions,
  listOwnSessions,
  revokeAccountSession,
  revokeOtherOwnSessions,
  revokeOwnSession,
  SESSION_LIST_LIMIT,
  SESSION_MANAGEMENT_OFFICE_ROLES,
} from "./session-list.ts";
import {
  canonicalClientAddress,
  consumeRateLimit,
  enforceRateLimit,
  isRateLimitKeyHash,
  RATE_LIMIT_AUDIT_ACTION,
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_SCOPES,
  RATE_LIMITED_PATHS,
  rateLimitKeyHash,
  rateLimitScopeForPath,
} from "./rate-limit.ts";
import {
  csrfCookie,
  csrfPolicy,
  csrfTokensMatch,
  createCsrfToken,
  CSRF_FIELD,
  CSRF_PROTECTED_PATHS,
  CSRF_RULE,
  CSRF_TOKEN_PATH,
  CSRF_TOKEN_PATTERN,
  readCsrfCookie,
  requireCsrfToken,
  verifyCsrfRequest,
} from "../security/csrf.ts";
import { getMessage } from "../i18n/messages.ts";
import type { Logger } from "../logger/logger.ts";
import {
  createLockAlertNotifier,
  LOCK_ALERT_MAX_ATTEMPTS,
  LOCK_ALERT_TEMPLATE_KEY,
  type LockAlertFacts,
  type LockAlertNotifier,
  type LockAlertOutcome,
} from "./lock-alert.ts";
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
import {
  ACCOUNT_UNLOCK_MAIL_MAX_ATTEMPTS,
  ACCOUNT_UNLOCK_NOTE_MAX_LENGTH,
  ACCOUNT_UNLOCK_OFFICE_ROLES,
  ACCOUNT_UNLOCK_TEMPLATE_KEY,
  unlockAccountLock,
} from "./account-unlock.ts";
import { signInMerchant, signinInputSchema } from "./signin.ts";
import { createAuthClient, type AuthClient, type SignUpIdentity } from "./client.ts";
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
import {
  createAuthHttp,
  type AuthAnswer,
  type AuthFetch,
  type AuthHttp,
  type AuthHttpOptions,
} from "./http.ts";
import {
  createOutboundResolver,
  OUTBOUND_PROVIDER_HOSTS,
  outboundPolicy,
  policyAllowsHost,
} from "../security/ssrf.ts";
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
  BREACH_RANGE_ENDPOINT,
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
import {
  companySlug,
  registerMerchant,
  signupInputSchema,
  type RegistrationResult,
} from "./registration.ts";
import {
  accountLockError,
  assertAccountUnlocked,
  countConsecutiveFailures,
  LOGIN_LOCK_DURATION_MS,
  LOGIN_LOCK_FAILURE_THRESHOLD,
  readAccountLock,
  recordFailedSignIn,
} from "./locks.ts";
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
  TURNSTILE_SITEVERIFY_URL,
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
/** One lock row of `account_locks`, as the office unlock of STEP 047 addresses it. */
const LOCK_ID = "018f3b1c-6666-7c2a-9d1e-2b3c4d5e6f75";

/** The owner of FIRM_ID in the gate: the address the section 22 alert is addressed to. */
const OWNER_USER_ID = "018f3b1c-5555-7c2a-9d1e-2b3c4d5e6f74";

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

/**
 * The transport the gate builds, with the options the production transport is required to state.
 *
 * Every proof below sends its request to a real configured endpoint on an allowlisted host, resolved
 * by a stub: the SSRF guard of STEP 058 is part of the transport, so a test that skipped it would be
 * testing a different object.
 */
const gateResolver = createOutboundResolver({ lookup: () => Promise.resolve(["1.1.1.1"]) });

function gateHttp(options: Omit<AuthHttpOptions, "outbound" | "resolve">): AuthHttp {
  return createAuthHttp({ ...options, outbound: config.outbound, resolve: gateResolver });
}

async function checkTransport(): Promise<void> {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchStub: AuthFetch = (url, init) => {
    seen.push({ url, init });

    return Promise.resolve(jsonResponse({ ok: true }, 200, { "retry-after": "30" }));
  };
  const http = gateHttp({ fetch: fetchStub });

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

  const emptyBody = await gateHttp({
    fetch: () => Promise.resolve(new Response(null, { status: 204 })),
  }).send({ method: "POST", url: config.endpoints.logout, apiKey: config.anonymousKey });

  expect(emptyBody.ok && emptyBody.value.body === null, "an answer without a body is null");

  const timeout = await gateHttp({
    fetch: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(!timeout.ok && timeout.failure.kind === "timeout", "a timeout is a timeout failure");

  const network = await gateHttp({
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(!network.ok && network.failure.kind === "network", "a socket failure is a network failure");

  const controller = new AbortController();
  const cancelled = await gateHttp({
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

  const malformed = await gateHttp({
    fetch: () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(
    !malformed.ok && malformed.failure.kind === "malformed-response",
    "a body that is not JSON is a malformed answer",
  );

  const oversizedDeclared = await gateHttp({
    fetch: () =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-length": "70000" } }),
      ),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(
    !oversizedDeclared.ok && oversizedDeclared.failure.kind === "malformed-response",
    "a declared length over the ceiling is refused before reading",
  );

  const oversizedBody = await gateHttp({
    maximumResponseBytes: 16,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ value: "x".repeat(64) }))),
  }).send({ method: "GET", url: config.endpoints.user, apiKey: config.anonymousKey });

  expect(
    !oversizedBody.ok && oversizedBody.failure.kind === "malformed-response",
    "a body over the ceiling is refused after reading",
  );

  const noBody = await gateHttp({
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

function createStubRest(
  options: {
    readonly failInsertTable?: string;
    /** Addresses the fake `public.users` table already holds. */
    readonly registeredEmails?: readonly string[];
    /** A table whose insert is refused with `CONFLICT`, the way a unique index refuses. */
    readonly conflictInsertTable?: string;
  } = {},
): StubRest {
  const calls: RestCall[] = [];
  const registeredEmails = options.registeredEmails ?? [];

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      calls.push({ kind: "select", table, query, rows: null });

      const found =
        table === "users" &&
        registeredEmails.some((email) => query.includes(`email=eq.${encodeURIComponent(email)}`));

      return Promise.resolve(found ? ([{ id: USER_ID }] as unknown as readonly TRow[]) : []);
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      calls.push({ kind: "insert", table, query: null, rows });

      if (table === options.failInsertTable) {
        return Promise.reject(new AppError("DEPENDENCY_FAILED"));
      }

      if (table === options.conflictInsertTable) {
        return Promise.reject(new AppError("CONFLICT"));
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

/**
 * What a fake provider answers a signup with.
 *
 * `identity` defaults to `"new"`: the ordinary answer, in which the provider lists the identity it
 * just created. A test that wants the obfuscated duplicate says `"existing"`, and the third value
 * exists so the compensation guard can be asked what it does when the provider says nothing.
 */
interface ProviderSignupAnswer {
  readonly userId: string;
  readonly session: AuthSession | null;
  readonly identity?: SignUpIdentity;
}

function registrationFixture(options: {
  readonly pages?: readonly PolicyPage[];
  readonly failInsertTable?: string;
  readonly conflictInsertTable?: string;
  readonly registeredEmails?: readonly string[];
  readonly turnstileEnabled?: boolean;
  readonly breachCheck?: BreachCheck;
  readonly provider?: AuthOutcome<ProviderSignupAnswer>;
}): RegistrationFixture {
  const rest = createStubRest({
    ...(options.failInsertTable === undefined ? {} : { failInsertTable: options.failInsertTable }),
    ...(options.conflictInsertTable === undefined
      ? {}
      : { conflictInsertTable: options.conflictInsertTable }),
    ...(options.registeredEmails === undefined ? {} : { registeredEmails: options.registeredEmails }),
  });
  const newAdmin = createStubAdmin();
  const audit = createInMemoryAuditTrail();
  const provider: AuthOutcome<ProviderSignupAnswer> = options.provider ?? {
    ok: true,
    value: { userId: USER_ID, session: null },
  };
  const breachCheck = options.breachCheck ?? createFixedBreachCheck("clear");

  return {
    rest,
    newAdmin,
    audit,
    dependencies: {
      auth: stubAuthClient({
        signUpWithPassword: () =>
          Promise.resolve(
            provider.ok
              ? {
                  ok: true,
                  value: { ...provider.value, identity: provider.value.identity ?? "new" },
                }
              : provider,
          ),
      }),
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

/**
 * The account a signup created.
 *
 * A result is a union because "indistinguishable" carries no identifier, so a check that wants the
 * identifier has to say which answer it expected. The throw is unreachable while the gate is green
 * and exists so a regression names itself instead of failing later with a `undefined` comparison.
 */
function expectCreated(
  result: RegistrationResult,
  description: string,
): Extract<RegistrationResult, { status: "created" }> {
  expect(result.status === "created", description);

  if (result.status !== "created") {
    throw new Error(`${description}: the signup answered indistinguishably`);
  }

  return result;
}

/**
 * The value of a call that must not throw.
 *
 * A gate that dies on a stack trace tells the reader less than a line saying which promise was
 * supposed to answer and what it did instead, and it hides every check after it.
 */
async function expectAnswer<TValue>(
  action: () => Promise<TValue>,
  description: string,
): Promise<TValue | null> {
  checkCount += 1;

  try {
    return await action();
  } catch (error) {
    failures.push(`${description}: it answered ${error instanceof AppError ? error.code : "an unexpected failure"}`);

    return null;
  }
}

async function checkRegistration(): Promise<void> {
  expectEqual(companySlug("Acme Payments"), "acme-payments", "a company name becomes a slug");
  expectEqual(companySlug("  ***  "), "merchant", "an unusable name still produces a slug");

  const fixture = registrationFixture({});
  const result = await registerMerchant(
    { request: signupRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
    fixture.dependencies,
  );

  const account = expectCreated(result, "a new address creates the account");

  expectEqual(account.userId, USER_ID, "the platform account keeps the provider identifier");
  expectEqual(account.companyId, FIRM_ID, "the signup creates a company");
  expectEqual(account.verificationRequired, true, "an unconfirmed signup awaits the mail link");

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
  // A refusal that is *not* about the address still reports itself; one that is, does not. The
  // second half is `checkDisclosure()`'s, because it is a statement about what a stranger may learn
  // rather than about how this service unwinds a write.
  await expectRejects(
    () =>
      registerMerchant(
        { request: signupRequest(), remoteIp: null, userAgent: null },
        registrationFixture({
          provider: { ok: false, failure: { kind: "rejected", status: 400, code: "signup_disabled", retryAfterSeconds: null } },
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

  const confirmedAccount = expectCreated(
    confirmedResult,
    "a provider that confirms the address creates the account",
  );

  expectEqual(
    confirmedAccount.verificationRequired,
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

  const skippedAccount = expectCreated(
    skippedResult,
    "a skipped breach check still signs the merchant up",
  );

  expectEqual(skippedAccount.userId, USER_ID, "a skipped check still signs the merchant up");
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

/**
 * The `account_locks` table of `0012`, in memory, with its two rules.
 *
 * A second open lock for one account is refused (`account_locks_live_key`) and a lock may not outlive
 * two hours (`account_locks_window_check`), so the service is asked to survive the same refusals a
 * database would give it. The rows are readable, which is how a check proves what was written without
 * a database.
 */
interface LockRow {
  id: string;
  user_id: string;
  company_id: string | null;
  triggered_by: "password" | "totp";
  locked_at: string;
  expires_at: string;
  unlocked_at: string | null;
  unlocked_by: string | null;
  expired_at: string | null;
  version: number;
}

interface LockTable {
  readonly rows: LockRow[];
  readonly insertCount: number;
  select(query: string): readonly Readonly<Record<string, unknown>>[];
  insert(rows: readonly Readonly<Record<string, unknown>>[]): void;
  update(query: string, values: Readonly<Record<string, unknown>>): void;
}

function createLockTable(): LockTable {
  const rows: LockRow[] = [];
  let inserts = 0;
  const table: LockTable = {
    rows,
    get insertCount(): number {
      return inserts;
    },
    select(query: string): readonly Readonly<Record<string, unknown>>[] {
      const userId = /user_id=eq\.([^&]+)/u.exec(query)?.[1] ?? "";
      const live = query.includes("unlocked_at=is.null")
        ? rows.filter((row) => row.unlocked_at === null && row.expired_at === null)
        : rows;

      return live
        .filter((row) => row.user_id === decodeURIComponent(userId))
        .sort((left, right) => Date.parse(right.locked_at) - Date.parse(left.locked_at))
        .map((row) => ({ ...row }));
    },
    insert(batch: readonly Readonly<Record<string, unknown>>[]): void {
      inserts += 1;

      for (const values of batch) {
        const userId = String(values["user_id"]);
        const lockedAt = String(values["locked_at"]);
        const expiresAt = String(values["expires_at"]);

        // account_locks_window_check: never later than locked_at plus two hours.
        if (Date.parse(expiresAt) - Date.parse(lockedAt) > LOGIN_LOCK_DURATION_MS) {
          throw new AppError("VALIDATION_FAILED");
        }

        // account_locks_live_key: one open lock per account.
        if (rows.some((row) => row.user_id === userId && row.unlocked_at === null && row.expired_at === null)) {
          throw new AppError("CONFLICT");
        }

        rows.push({
          id: `lock-${String(rows.length + 1)}`,
          user_id: userId,
          company_id: (values["company_id"] as string | null | undefined) ?? null,
          triggered_by: String(values["triggered_by"]) as "password" | "totp",
          locked_at: lockedAt,
          expires_at: expiresAt,
          unlocked_at: null,
          unlocked_by: null,
          expired_at: null,
          version: 1,
        });
      }
    },
    update(query: string, values: Readonly<Record<string, unknown>>): void {
      const userId = /user_id=eq\.([^&]+)/u.exec(query)?.[1];
      const deadline = /expires_at=lte\.([^&]+)/u.exec(query)?.[1];
      const targets = rows.filter(
        (row) =>
          (userId === undefined || row.user_id === decodeURIComponent(userId)) &&
          (deadline === undefined || Date.parse(row.expires_at) <= Date.parse(decodeURIComponent(deadline))) &&
          (row.unlocked_at === null && row.expired_at === null),
      );

      for (const row of targets) {
        Object.assign(row, values);
        row.version += 1;
      }
    },
  };

  return table;
}

/** The streak query of `lib/auth/locks.ts`, answered from the attempt rows the fixture kept. */
function streakRows(
  attempts: readonly { readonly userId: string | null; readonly factor: string; readonly outcome: string }[],
  query: string,
): readonly { outcome: string }[] {
  const userId = decodeURIComponent(/user_id=eq\.([^&]+)/u.exec(query)?.[1] ?? "");
  const factor = decodeURIComponent(/factor=eq\.([^&]+)/u.exec(query)?.[1] ?? "");

  return [...attempts]
    .filter((attempt) => attempt.userId === userId && attempt.factor === factor)
    .reverse()
    .map((attempt) => ({ outcome: attempt.outcome }));
}

interface SigninRestOptions {
  readonly user?: Readonly<Record<string, unknown>> | null;
  readonly proofKeys?: number;
  readonly claims?: Readonly<Record<string, unknown>>;
}

interface SigninFixture {
  readonly dependencies: Parameters<typeof signInMerchant>[1];
  /** The account row the fixture answers with, mutable so a check can change a column. */
  readonly user: Record<string, unknown> | null;
  readonly attempts: ReturnType<typeof createInMemoryLoginAttemptRecorder>;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
  /** The owner alerts the sign in service asked for, with the facts it asked about. */
  readonly alerts: ReturnType<typeof createInMemoryLockAlerts>;
  readonly inserts: { table: string; rows: readonly Readonly<Record<string, unknown>>[] }[];
  /** Access tokens whose provider session the service ended, because no sign in happened. */
  readonly signOuts: readonly string[];
}

function signinFixture(options: SigninRestOptions & {
  readonly signIn?: AuthOutcome<AuthSession>;
  readonly turnstileEnabled?: boolean;
  /** The lock table of `0012`. Omitted means an account that has never been locked. */
  readonly locks?: LockTable;
} = {}): SigninFixture {
  const inserts: { table: string; rows: readonly Readonly<Record<string, unknown>>[] }[] = [];
  const attempts = createInMemoryLoginAttemptRecorder();
  const locks = options.locks ?? null;
  const signOuts: string[] = [];
  const user: Record<string, unknown> | null =
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
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      if (table === "users") {
        return Promise.resolve(user === null ? [] : ([{ ...user }] as unknown as readonly TRow[]));
      }

      if (table === "account_locks") {
        return Promise.resolve(
          (locks === null ? [] : locks.select(query)) as unknown as readonly TRow[],
        );
      }

      if (table === "login_attempts") {
        return Promise.resolve(streakRows(attempts.attempts, query) as unknown as readonly TRow[]);
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

      if (table === "account_locks" && locks !== null) {
        locks.insert(rows);
      }

      return Promise.resolve();
    },
    insertReturning: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      if (table === "account_locks" && locks !== null) {
        locks.update(query, values);
      }

      return Promise.resolve();
    },
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };
  const audit = createInMemoryAuditTrail();
  const alerts = createInMemoryLockAlerts();

  return {
    inserts,
    attempts,
    audit,
    alerts,
    signOuts,
    user,
    dependencies: {
      auth: stubAuthClient({
        signInWithPassword: () => Promise.resolve(options.signIn ?? { ok: true, value: session }),
        signOut: (accessToken: string) => {
          signOuts.push(accessToken);

          return Promise.resolve({ ok: true, value: undefined });
        },
      }),
      rest,
      turnstile: createTurnstileGuard({
        settings: createInMemorySettings({ "turnstile.enabled": options.turnstileEnabled ?? false }),
        http: createStubHttp().http,
        isProduction: false,
        endpoint: "https://turnstile.gate/siteverify",
      }),
      attempts,
      audit,
      alerts: alerts.notifier,
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
  /** The lock table of `0012`. Omitted means an account that has never been locked. */
  readonly locks?: LockTable;
} = {}): {
  readonly state: ChallengeState;
  readonly updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[];
  readonly attempts: ReturnType<typeof createInMemoryLoginAttemptRecorder>;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
  readonly dependencies: Parameters<typeof completeTwoFactorChallenge>[1];
  /** The owner alerts the challenge asked for, with the facts it asked about. */
  readonly alerts: ReturnType<typeof createInMemoryLockAlerts>;
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
  const attempts = createInMemoryLoginAttemptRecorder();
  const locks = options.locks ?? null;

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      if (table === "account_locks") {
        return Promise.resolve(
          (locks === null ? [] : locks.select(query)) as unknown as readonly TRow[],
        );
      }

      if (table === "login_attempts") {
        return Promise.resolve(streakRows(attempts.attempts, query) as unknown as readonly TRow[]);
      }

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
      if (table === "account_locks" && locks !== null) {
        locks.insert(rows);

        return Promise.resolve();
      }

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

      if (table === "account_locks" && locks !== null) {
        locks.update(query, values);
      }

      if (table === "users" && "backup_code_hashes" in values) {
        state.user.backup_code_hashes = values["backup_code_hashes"] as readonly string[];
      }

      return Promise.resolve();
    },
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };
  const audit = createInMemoryAuditTrail();
  const alerts = createInMemoryLockAlerts();

  return {
    state,
    updates,
    attempts,
    audit,
    alerts,
    dependencies: {
      rest,
      audit,
      attempts,
      alerts: alerts.notifier,
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
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: null,
    reauthenticatedAtEpochMs: null,
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

/* ------------------------------------------------------- login lock (045) */

/** A failed sign in the way a route would see it: the provider rejected the credentials. */
const rejectedSignIn: AuthOutcome<AuthSession> = {
  ok: false,
  failure: { kind: "rejected", status: 400, code: "invalid_credentials", retryAfterSeconds: null },
};

/**
 * The owner alert, as the sign in services see it: one call per lock that starts.
 *
 * The notifier itself is proved below against a rest double that keeps the tables `lib/auth/lock-alert.ts`
 * writes. This double exists so the sign in services and the lock service can be asked a different
 * question - how many times they ask for an alert, and about what - without a database in the way.
 */
function createInMemoryLockAlerts(): {
  readonly notifier: LockAlertNotifier;
  readonly calls: LockAlertFacts[];
  /** Makes the next call reject, to prove a broken mail path cannot break a lock. */
  failNext(): void;
  /** Makes the next call answer with a status other than `queued`. */
  answerNext(status: LockAlertOutcome["status"]): void;
} {
  const calls: LockAlertFacts[] = [];
  const control = { fails: false, answer: null as LockAlertOutcome["status"] | null };

  return {
    calls,
    failNext(): void {
      control.fails = true;
    },
    answerNext(status: LockAlertOutcome["status"]): void {
      control.answer = status;
    },
    notifier: {
      alertOnLock(facts: LockAlertFacts): Promise<LockAlertOutcome> {
        calls.push(facts);

        if (control.fails) {
          control.fails = false;

          return Promise.reject(new Error("the alert service is down"));
        }

        const status = control.answer ?? "queued";

        control.answer = null;

        return Promise.resolve({ status, sendId: status === "queued" ? `send-${calls.length}` : null });
      },
    },
  };
}

/**
 * The rest client of the lock service alone: two tables, both in memory.
 *
 * The lock module reads and writes `account_locks` and `login_attempts` and nothing else, so the gate
 * gives it exactly those two and records every other name it is asked for. A select on any other
 * table is a check that forgot what this service is allowed to touch, and the recorded writes are how
 * the "changing the password cannot clear the lock" sentence of section 22 is proven.
 */
function lockRest(
  table: LockTable,
  attempts: ReturnType<typeof createInMemoryLoginAttemptRecorder>,
  touched: string[] = [],
): RestClient {
  return {
    select<TRow>(name: string, query: string): Promise<readonly TRow[]> {
      touched.push(`select:${name}`);

      if (name === "account_locks") {
        return Promise.resolve(table.select(query) as unknown as readonly TRow[]);
      }

      if (name === "login_attempts") {
        return Promise.resolve(streakRows(attempts.attempts, query) as unknown as readonly TRow[]);
      }

      return Promise.resolve([] as readonly TRow[]);
    },
    insert(name: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      touched.push(`insert:${name}`);

      if (name === "account_locks") {
        table.insert(rows);
      }

      return Promise.resolve();
    },
    insertReturning: <TRow>(): Promise<readonly TRow[]> => Promise.resolve([]),
    update(name: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      touched.push(`update:${name}`);

      if (name === "account_locks") {
        table.update(query, values);
      }

      return Promise.resolve();
    },
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };
}

async function checkLoginLock(): Promise<void> {
  expectEqual(LOGIN_LOCK_FAILURE_THRESHOLD, 2, "the lock starts at two consecutive failures");
  expectEqual(LOGIN_LOCK_DURATION_MS, 7_200_000, "the lock lasts two hours");

  // ---- an account that was never locked
  const empty = createLockTable();
  const emptyRest = lockRest(empty, createInMemoryLoginAttemptRecorder());
  const neverLocked = await readAccountLock(emptyRest, USER_ID, NOW);

  expectEqual(neverLocked.locked, false, "an account with no lock row is not locked");
  expectEqual(neverLocked.remainingSeconds, null, "an unlocked account has no remaining time");
  expectEqual(neverLocked.triggeredBy, null, "an unlocked account names no triggering factor");
  expectEqual(empty.insertCount, 0, "reading a lock writes nothing");

  // ---- one failure is not a lock, and it is attributed to the account
  const table = createLockTable();
  const audit = createInMemoryAuditTrail();
  const attempts = createInMemoryLoginAttemptRecorder();
  const touched: string[] = [];
  const rest = lockRest(table, attempts, touched);
  let instant = NOW;
  const alerts = createInMemoryLockAlerts();
  const dependencies = {
    rest,
    attempts,
    audit,
    alerts: alerts.notifier,
    now: (): number => instant,
  };
  const failure = {
    userId: USER_ID,
    companyId: FIRM_ID,
    factor: "password" as const,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  };

  const first = await recordFailedSignIn(failure, dependencies);

  expectEqual(first.opened, false, "one failed password does not open a lock");
  expectEqual(first.recorded, true, "the failure is recorded as an attempt");
  expectEqual(alerts.calls.length, 0, "one failure alerts nobody, because there is no lock yet");
  expectEqual(table.rows.length, 0, "one failed password writes no lock row");
  expectEqual(attempts.attempts.length, 1, "the failure is one attempt row");
  expectEqual(attempts.attempts[0]?.userId, USER_ID, "the attempt names the account it failed on");
  expectEqual(attempts.attempts[0]?.outcome, "failed", "the attempt is a failure");
  expectEqual(attempts.attempts[0]?.factor, "password", "the attempt names the password factor");
  expectEqual(attempts.attempts[0]?.emailHash, null, "a known account is not recorded by its hash");

  // ---- the second consecutive failure opens the lock
  const second = await recordFailedSignIn(failure, dependencies);

  expectEqual(second.opened, true, "the second consecutive failure opens the lock");
  expectEqual(alerts.calls.length, 1, "the lock that starts alerts the owner exactly once");
  expectEqual(alerts.calls[0]?.userId, USER_ID, "the alert names the locked account");
  expectEqual(alerts.calls[0]?.companyId, FIRM_ID, "the alert names the company whose owner is told");
  expectEqual(alerts.calls[0]?.factor, "password", "the alert says which factor reached two");
  expectEqual(alerts.calls[0]?.failedAttempts, 2, "the alert counts the failures that caused it");
  expectEqual(alerts.calls[0]?.lockedAt, table.rows[0]?.locked_at, "the alert carries the lock instant");
  expectEqual(alerts.calls[0]?.expiresAt, table.rows[0]?.expires_at, "the alert carries the deadline");
  expectEqual(second.lock.locked, true, "the answer reports the account as locked");
  expectEqual(table.rows.length, 1, "one lock row exists");
  expectEqual(table.rows[0]?.triggered_by, "password", "the lock names the factor that reached two");
  expectEqual(
    Date.parse(table.rows[0]?.expires_at ?? "") - Date.parse(table.rows[0]?.locked_at ?? ""),
    LOGIN_LOCK_DURATION_MS,
    "the lock ends exactly two hours after it starts",
  );
  expectEqual(audit.entries.at(-1)?.action, "user.login_locked", "the lock start is audited");
  expectEqual(audit.entries.at(-1)?.payload["failed_attempts"], 2, "the entry counts the failures");
  expectEqual(audit.entries.at(-1)?.payload["triggered_by"], "password", "the entry names the factor");
  expectEqual(audit.entries.at(-1)?.actorUserId, null, "nobody was signed in when the lock started");

  const locked = await readAccountLock(rest, USER_ID, NOW);

  expectEqual(locked.locked, true, "the lock is readable");
  expectEqual(locked.remainingSeconds, 7_200, "a fresh lock has two hours left");
  expectEqual(locked.triggeredBy, "password", "the state names the triggering factor");

  // ---- a third failure does not create a second lock
  const third = await recordFailedSignIn(failure, dependencies);

  expectEqual(third.opened, false, "a third failure opens no second lock");
  expectEqual(alerts.calls.length, 1, "a lock that was already there does not alert the owner again");
  expectEqual(table.rows.length, 1, "the live key keeps one lock row");
  expectEqual(
    audit.entries.filter((entry) => entry.action === "user.login_locked").length,
    1,
    "the lock start is audited once",
  );

  // ---- a success ends the streak
  const broken = createLockTable();
  const brokenAttempts = createInMemoryLoginAttemptRecorder();
  const brokenDependencies = {
    rest: lockRest(broken, brokenAttempts),
    attempts: brokenAttempts,
    audit: createInMemoryAuditTrail(),
    alerts: createInMemoryLockAlerts().notifier,
    now: () => NOW,
  };

  await recordFailedSignIn(failure, brokenDependencies);
  await brokenAttempts.record({
    factor: "password",
    outcome: "succeeded",
    userId: USER_ID,
    companyId: FIRM_ID,
    emailHash: null,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });
  const afterSuccess = await recordFailedSignIn(failure, brokenDependencies);

  expectEqual(afterSuccess.opened, false, "a success between two failures keeps the account open");
  expectEqual(broken.rows.length, 0, "a broken streak writes no lock row");

  // ---- a Turnstile refusal is not a credential check, so it neither counts nor resets
  const challengedTable = createLockTable();
  const challengedAttempts = createInMemoryLoginAttemptRecorder();
  const challengedDependencies = {
    rest: lockRest(challengedTable, challengedAttempts),
    attempts: challengedAttempts,
    audit: createInMemoryAuditTrail(),
    alerts: createInMemoryLockAlerts().notifier,
    now: () => NOW,
  };

  await recordFailedSignIn(failure, challengedDependencies);
  await challengedAttempts.record({
    factor: "password",
    outcome: "challenged",
    userId: USER_ID,
    companyId: FIRM_ID,
    emailHash: null,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });
  const afterChallenge = await recordFailedSignIn(failure, challengedDependencies);

  expectEqual(afterChallenge.opened, true, "a challenge between two failures does not break the streak");

  // ---- a blocked attempt does not erase the streak that caused the block
  const blockedTable = createLockTable();
  const blockedAttempts = createInMemoryLoginAttemptRecorder();
  const blockedDependencies = {
    rest: lockRest(blockedTable, blockedAttempts),
    attempts: blockedAttempts,
    audit: createInMemoryAuditTrail(),
    alerts: createInMemoryLockAlerts().notifier,
    now: () => NOW,
  };

  await recordFailedSignIn(failure, blockedDependencies);
  await blockedAttempts.record({
    factor: "password",
    outcome: "blocked",
    userId: USER_ID,
    companyId: FIRM_ID,
    emailHash: null,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  });
  const afterBlocked = await recordFailedSignIn(failure, blockedDependencies);

  expectEqual(afterBlocked.opened, true, "a blocked attempt does not erase the streak");

  // ---- the two factors are counted apart, and the lock names the one that reached two
  const factors = createLockTable();
  const factorAttempts = createInMemoryLoginAttemptRecorder();
  const factorDependencies = {
    rest: lockRest(factors, factorAttempts),
    attempts: factorAttempts,
    audit: createInMemoryAuditTrail(),
    alerts: createInMemoryLockAlerts().notifier,
    now: () => NOW,
  };

  await recordFailedSignIn(failure, factorDependencies);
  const oneCodeFailure = await recordFailedSignIn({ ...failure, factor: "totp" }, factorDependencies);

  expectEqual(oneCodeFailure.opened, false, "one wrong password and one wrong code are not two of a kind");

  const twoCodeFailures = await recordFailedSignIn({ ...failure, factor: "totp" }, factorDependencies);

  expectEqual(twoCodeFailures.opened, true, "two consecutive wrong codes open the lock");
  expectEqual(factors.rows[0]?.triggered_by, "totp", "the lock names the code factor");

  // ---- a broken alert path cannot stop a lock from existing
  const deafTable = createLockTable();
  const deafAttempts = createInMemoryLoginAttemptRecorder();
  const deafAlerts = createInMemoryLockAlerts();
  const deafDependencies = {
    rest: lockRest(deafTable, deafAttempts),
    attempts: deafAttempts,
    audit: createInMemoryAuditTrail(),
    alerts: deafAlerts.notifier,
    now: () => NOW,
  };

  deafAlerts.failNext();
  await recordFailedSignIn(failure, deafDependencies);
  const despiteBrokenAlert = await recordFailedSignIn(failure, deafDependencies);

  expectEqual(despiteBrokenAlert.opened, true, "a lock starts even when the owner alert cannot be queued");
  expectEqual(deafTable.rows.length, 1, "the lock row exists although the alert failed");
  expectEqual(deafAlerts.calls.length, 1, "the owner alert is asked for once, and only when the lock starts");

  // ---- the guard the password reset of a later STEP uses
  const expiry = table.rows[0]?.expires_at ?? "";

  await expectRejects(
    () => assertAccountUnlocked(rest, USER_ID, NOW),
    "ACCOUNT_LOCKED",
    "the guard refuses a locked account",
  );
  expectEqual(
    (await assertAccountUnlocked(rest, USER_ID, Date.parse(expiry) + 1_000)).locked,
    false,
    "the guard passes once the lock has run out",
  );

  // ---- the two hours run out: the state says open, and the next pair writes a second row
  instant = Date.parse(expiry) + 1;

  expectEqual(
    (await readAccountLock(rest, USER_ID, instant)).locked,
    false,
    "a lock whose two hours passed is not a lock",
  );

  // The streak is still long (nothing has succeeded), so the very next failure is the one that
  // writes the new lock - after closing the row the clock ended.
  const relocked = await recordFailedSignIn(failure, dependencies);
  const afterRelock = await recordFailedSignIn(failure, dependencies);

  expectEqual(relocked.opened, true, "an expired lock can be followed by a new one");
  expectEqual(afterRelock.opened, false, "the new lock is still one row");
  expectEqual(table.rows.length, 2, "the expired row stays as history and a new row is written");
  expectEqual(
    table.rows[0]?.expired_at,
    new Date(instant).toISOString(),
    "the expired row records the instant it was closed",
  );
  expectEqual(table.rows[1]?.expired_at, null, "the newest row is open");
  expectEqual(table.rows[1]?.triggered_by, "password", "the new row names the factor again");

  // ---- an office unlock frees the account the same way an expiry does
  const office = createLockTable();
  const officeAttempts = createInMemoryLoginAttemptRecorder();
  const officeDependencies = {
    rest: lockRest(office, officeAttempts),
    attempts: officeAttempts,
    audit: createInMemoryAuditTrail(),
    alerts: createInMemoryLockAlerts().notifier,
    now: () => NOW,
  };

  await recordFailedSignIn(failure, officeDependencies);
  await recordFailedSignIn(failure, officeDependencies);

  expectEqual(office.rows.length, 1, "the account is locked before the unlock");

  const officeLock = office.rows[0];

  if (officeLock !== undefined) {
    officeLock.unlocked_at = new Date(NOW + 60_000).toISOString();
    officeLock.unlocked_by = OTHER_USER_ID;
  }

  expectEqual(
    (await readAccountLock(officeDependencies.rest, USER_ID, NOW + 120_000)).locked,
    false,
    "an unlock by the office ends the lock",
  );

  const relockedAfterUnlock = await recordFailedSignIn(failure, {
    ...officeDependencies,
    now: () => NOW + 180_000,
  });

  expectEqual(relockedAfterUnlock.opened, true, "an unlocked account can be locked again");

  // ---- the lock service never writes the account row, which is why a password change cannot clear
  expectEqual(
    touched.every((name) => name === "select:account_locks" || name === "select:login_attempts" || name === "update:account_locks" || name === "insert:account_locks"),
    true,
    "the lock service touches only its own table and the attempt counter",
  );

  // ---- the error a locked account answers
  const lockError = accountLockError(locked);

  expectEqual(lockError.code, "ACCOUNT_LOCKED", "a locked account answers its own code");
  expectEqual(lockError.retryAfterSeconds, 7_200, "the answer says how long the lock has left");
  expectEqual(ERROR_CODES.ACCOUNT_LOCKED.status, 423, "the lock answers 423");
  expectEqual(ERROR_CODES.ACCOUNT_LOCKED.retryable, true, "the lock is worth retrying later");

  // ---- sign in: a correct password on a locked account does not sign in
  const lockedTable = createLockTable();
  const lockedFixture = signinFixture({ locks: lockedTable });

  lockedTable.insert([
    {
      company_id: FIRM_ID,
      user_id: USER_ID,
      triggered_by: "password",
      locked_at: new Date(NOW - 600_000).toISOString(),
      expires_at: new Date(NOW + 6_600_000).toISOString(),
    },
  ]);

  const blockedSignIn = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        lockedFixture.dependencies,
      ),
    "a correct password on a locked account is refused",
  );

  expectEqual(blockedSignIn.code, "ACCOUNT_LOCKED", "the refusal names the lock");
  expectEqual(blockedSignIn.retryAfterSeconds, 6_600, "the refusal says how long is left");
  expectEqual(lockedFixture.attempts.attempts.length, 1, "the blocked sign in is one attempt row");
  expectEqual(lockedFixture.attempts.attempts[0]?.outcome, "blocked", "the attempt is a block");
  expectEqual(lockedFixture.attempts.attempts[0]?.userId, USER_ID, "the attempt names the account");
  expectEqual(lockedFixture.signOuts.length, 1, "the provider session of a refused sign in is ended");
  expectEqual(
    lockedFixture.audit.entries.at(-1)?.action,
    "user.signin_blocked",
    "the blocked sign in is audited",
  );
  expectEqual(
    lockedFixture.audit.entries.at(-1)?.payload["remaining_seconds"],
    6_600,
    "the entry records how long the lock had left",
  );
  expectEqual(
    lockedFixture.audit.entries.some((entry) => entry.action === "user.signed_in"),
    false,
    "no sign in is audited for a locked account",
  );

  // ---- sign in: changing the password of a locked account does not help
  if (lockedFixture.user !== null) {
    lockedFixture.user["password_hash"] = "scrypt$1$16384$8$c2FsdA$aGFzaA";
    lockedFixture.user["password_updated_at"] = new Date(NOW + 1_000).toISOString();
  }

  await expectRejects(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        lockedFixture.dependencies,
      ),
    "ACCOUNT_LOCKED",
    "a changed password does not clear the lock",
  );

  // ---- sign in: a wrong password on a locked account reveals nothing
  const wrongOnLocked = signinFixture({ locks: lockedTable, signIn: rejectedSignIn });
  const wrongOnLockedError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        wrongOnLocked.dependencies,
      ),
    "a wrong password on a locked account is refused",
  );

  expectEqual(
    wrongOnLockedError.code,
    "AUTHENTICATION_REQUIRED",
    "a stranger without the password learns nothing about the lock",
  );
  expectEqual(
    wrongOnLocked.attempts.attempts.some((attempt) => attempt.outcome === "blocked"),
    false,
    "a wrong password is never answered as a block",
  );
  expectEqual(
    wrongOnLocked.attempts.attempts[0]?.userId,
    USER_ID,
    "a wrong password on a known account is attributed to it",
  );

  // ---- sign in: two wrong passwords lock the account
  const failingTable = createLockTable();
  const failing = signinFixture({ locks: failingTable, signIn: rejectedSignIn });

  await expectRejects(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        failing.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "the first wrong password is refused",
  );

  expectEqual(failingTable.rows.length, 0, "one wrong password does not lock the account");
  expectEqual(failing.alerts.calls.length, 0, "one wrong password asks for no alert");

  await expectRejects(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        failing.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "the second wrong password is refused",
  );

  expectEqual(failingTable.rows.length, 1, "two wrong passwords lock the account");
  expectEqual(failing.alerts.calls.length, 1, "the sign in path asks for the owner alert once the lock starts");
  expectEqual(failing.alerts.calls[0]?.userId, USER_ID, "the alert is about the account that locked");
  expectEqual(failing.alerts.calls[0]?.companyId, FIRM_ID, "the alert names the company of the account");
  expectEqual(failing.alerts.calls[0]?.factor, "password", "the alert names the password factor");
  expectEqual(failingTable.rows[0]?.triggered_by, "password", "the lock names the password factor");
  expectEqual(failingTable.rows[0]?.user_id, USER_ID, "the lock names the account of the address");
  expectEqual(
    failing.audit.entries.some((entry) => entry.action === "user.login_locked"),
    true,
    "the lock start is audited",
  );

  // ---- sign in: an address with no account locks nothing
  const unknownTable = createLockTable();
  const unknown = signinFixture({ locks: unknownTable, signIn: rejectedSignIn, user: null });

  for (let index = 0; index < 3; index += 1) {
    await expectRejects(
      () =>
        signInMerchant(
          {
            request: signinRequest({ email: "nobody@example.com" }),
            remoteIp: "203.0.113.9",
            userAgent: "gate",
          },
          unknown.dependencies,
        ),
      "AUTHENTICATION_REQUIRED",
      "an address with no account is refused",
    );
  }

  expectEqual(unknownTable.rows.length, 0, "an address with no account locks nothing");
  expectEqual(
    unknown.attempts.attempts.every((attempt) => attempt.userId === null),
    true,
    "an unknown address is recorded without an account",
  );
  expectEqual(
    unknown.attempts.attempts.every((attempt) => attempt.emailHash !== null),
    true,
    "an unknown address is recorded by the hash of the address",
  );

  // ---- the second factor: two wrong codes lock, and a lock refuses even a correct code
  const codeTable = createLockTable();
  const codeFixture = twoFactorLoginFixture({ locks: codeTable });
  const codeSecret = openEnrolledSecret(
    codeFixture.state.user.totp_secret_ciphertext ?? "",
    USER_ID,
    MASTER_KEY,
  );
  const goodCode = totpCodeForStep(base32Decode(codeSecret) ?? new Uint8Array(), totpStep(NOW));
  const issue = async (): Promise<string> =>
    (
      await issueTwoFactorChallenge(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          session: {
            accessToken: makeAccessToken(baseClaims()),
            refreshToken: "refresh-token-000000000000000000",
            expiresAtEpochMs: NOW + 3_600_000,
            sessionId: SESSION_ID,
          },
          device: readDeviceContext("gate"),
          remoteIp: "203.0.113.9",
          userAgent: "gate",
        },
        codeFixture.dependencies,
      )
    ).token;

  const firstHandle = await issue();
  const wrongCode = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: firstHandle, code: "000000", remoteIp: "203.0.113.9", userAgent: "gate" },
        codeFixture.dependencies,
      ),
    "a wrong code is refused",
  );

  expectEqual(wrongCode.code, "AUTHENTICATION_REQUIRED", "a wrong code is the generic rejection");
  expectEqual(codeTable.rows.length, 0, "one wrong code does not lock the account");
  expectEqual(codeFixture.alerts.calls.length, 0, "one wrong code asks for no alert");
  expectEqual(
    codeFixture.attempts.attempts.at(-1)?.factor,
    "totp",
    "the wrong code is recorded against the code factor",
  );

  const secondHandle = await issue();

  await expectRejects(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: secondHandle, code: "000000", remoteIp: "203.0.113.9", userAgent: "gate" },
        codeFixture.dependencies,
      ),
    "AUTHENTICATION_REQUIRED",
    "the second wrong code is refused",
  );

  expectEqual(codeTable.rows.length, 1, "two wrong codes lock the account");
  expectEqual(codeTable.rows[0]?.triggered_by, "totp", "the lock names the code factor");
  expectEqual(codeFixture.alerts.calls.length, 1, "two wrong codes ask for the owner alert once");
  expectEqual(codeFixture.alerts.calls[0]?.factor, "totp", "the alert names the code factor");

  const thirdHandle = await issue();
  const lockedCorrectCode = await captureRejection(
    () =>
      completeTwoFactorChallenge(
        { challengeToken: thirdHandle, code: goodCode, remoteIp: "203.0.113.9", userAgent: "gate" },
        codeFixture.dependencies,
      ),
    "a correct code on a locked account is refused",
  );

  expectEqual(lockedCorrectCode.code, "ACCOUNT_LOCKED", "the lock refuses a correct code too");
  expect(
    (lockedCorrectCode.retryAfterSeconds ?? 0) > 0,
    "the refusal says how long the lock has left",
  );
  expectEqual(
    codeFixture.audit.entries.some((entry) => entry.action === "user.signed_in"),
    false,
    "no session is issued for a locked account",
  );
  expectEqual(
    codeFixture.attempts.attempts.at(-1)?.outcome,
    "blocked",
    "the refused attempt is recorded as a block",
  );

  // A count of the streak is public so a screen can explain it: two wrong codes read as two.
  expectEqual(
    await countConsecutiveFailures(codeFixture.dependencies.rest, USER_ID, "totp"),
    2,
    "the streak of the code factor reads two after two wrong codes",
  );
}

/* ------------------------------------------------------------------ main */

/**
 * A logger that keeps the sentences a service wrote, without a JSON line in the way.
 *
 * The owner alert logs the outcomes that are answers rather than successes - no sender configured,
 * no owner recorded - and an operator finding those lines is the difference between "the office never
 * set up email" and "the platform is broken".
 */
function captureLogger(): { readonly logger: Logger; readonly warnings: string[] } {
  const warnings: string[] = [];
  const handle: Logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (message: string): void => {
      warnings.push(message);
    },
    error: (): void => undefined,
    child: (): Logger => handle,
  };

  return { logger: handle, warnings };
}

interface AlertLockRow {
  readonly id: string;
  readonly user_id: string;
  alert_send_id: string | null;
  owner_alerted_at: string | null;
}

interface AlertSendRow {
  readonly id: string;
  readonly company_id: string | null;
  readonly template_key: string;
  readonly recipient_email: string;
  readonly recipient_user_id: string | null;
  readonly subject: string;
  readonly provider: string;
  readonly max_attempts: number;
  readonly reference_kind: string | null;
  readonly reference_id: string | null;
  readonly queued_at: string;
  status: string;
  failure_reason: string | null;
}

interface AlertWorld {
  readonly rest: RestClient;
  readonly locks: AlertLockRow[];
  readonly sends: AlertSendRow[];
  readonly updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[];
}

/**
 * The four tables `lib/auth/lock-alert.ts` reads and the two it writes, in memory.
 *
 * The point of the double is not to imitate PostgREST but to keep the state that decides the answer:
 * which lock is open, whether it already names an alert, whether the office configured a sender,
 * whether the company has an owner, and whether the claim on the lock was won. Every one of those is
 * a switch a check below flips on purpose.
 */
function alertWorld(options: {
  readonly locks?: readonly AlertLockRow[];
  readonly method?: "smtp" | "api" | null;
  readonly ownerUserId?: string | null;
  readonly ownerEmail?: string | null;
  readonly failTable?: string | null;
  /** Another request claimed the lock first, between this call's read and its update. */
  readonly loseClaim?: boolean;
  /** The queue accepted the insert but answered with no representation. */
  readonly returnNoSendId?: boolean;
} = {}): AlertWorld {
  const locks = (options.locks ?? []).map((row) => ({ ...row }));
  const sends: AlertSendRow[] = [];
  const updates: { table: string; query: string; values: Readonly<Record<string, unknown>> }[] = [];
  const method = options.method === undefined ? "smtp" : options.method;
  const ownerUserId = options.ownerUserId === undefined ? OWNER_USER_ID : options.ownerUserId;
  const ownerEmail = options.ownerEmail === undefined ? "owner@firm.test" : options.ownerEmail;

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      if (options.failTable === table) {
        return Promise.reject(new Error("the database did not answer"));
      }

      if (table === "account_locks") {
        const byId = /(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1];
        const byUser = /(?:^|[&?])user_id=eq\.([^&]+)/u.exec(query)?.[1];
        const matched = locks.filter((row) =>
          byId === undefined ? row.user_id === decodeURIComponent(byUser ?? "") : row.id === byId,
        );

        return Promise.resolve(matched.map((row) => ({ ...row })) as unknown as readonly TRow[]);
      }

      if (table === "email_settings") {
        return Promise.resolve(
          (method === null ? [] : [{ method }]) as unknown as readonly TRow[],
        );
      }

      if (table === "role_assignments") {
        return Promise.resolve(
          (ownerUserId === null ? [] : [{ user_id: ownerUserId }]) as unknown as readonly TRow[],
        );
      }

      if (table === "users") {
        return Promise.resolve(
          (ownerEmail === null ? [] : [{ email: ownerEmail }]) as unknown as readonly TRow[],
        );
      }

      return Promise.resolve([] as readonly TRow[]);
    },
    insert(): Promise<void> {
      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
    ): Promise<readonly TRow[]> {
      if (table !== "email_send_logs") {
        return Promise.resolve([] as readonly TRow[]);
      }

      const written: AlertSendRow[] = [];

      for (const values of rows) {
        const row: AlertSendRow = {
          id: `send-${String(sends.length + written.length + 1)}`,
          company_id: (values["company_id"] as string | null | undefined) ?? null,
          template_key: String(values["template_key"]),
          recipient_email: String(values["recipient_email"]),
          recipient_user_id: (values["recipient_user_id"] as string | null | undefined) ?? null,
          subject: String(values["subject"]),
          provider: String(values["provider"]),
          max_attempts: Number(values["max_attempts"]),
          reference_kind: (values["reference_kind"] as string | null | undefined) ?? null,
          reference_id: (values["reference_id"] as string | null | undefined) ?? null,
          queued_at: String(values["queued_at"]),
          status: "queued",
          failure_reason: null,
        };

        written.push(row);
      }

      sends.push(...written);

      return Promise.resolve(
        (options.returnNoSendId === true ? [] : written.map((row) => ({ id: row.id }))) as unknown as readonly TRow[],
      );
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      updates.push({ table, query, values });

      if (table === "account_locks") {
        const id = /(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1] ?? "";

        for (const row of locks) {
          if (row.id !== id) {
            continue;
          }

          if (query.includes("alert_send_id=is.null") && row.alert_send_id !== null) {
            continue;
          }

          if (options.loseClaim === true) {
            continue;
          }

          Object.assign(row, values);
        }

        return Promise.resolve();
      }

      if (table === "email_send_logs") {
        const id = /(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1] ?? "";

        for (const row of sends) {
          if (row.id === id && row.status === "queued") {
            Object.assign(row, values);
          }
        }
      }

      return Promise.resolve();
    },
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };

  return { rest, locks, sends, updates };
}

/**
 * The owner alert of section 22, proved end to end against the tables it writes.
 *
 * Six properties, and each one is a sentence from the specification or a way the platform must not
 * break: the alert is queued once per lock with the template section 23 already knows; a second call
 * for the same lock queues nothing; a lock whose company has no owner, or whose platform has no
 * sender, is still a lock and no email; a storage failure is an answer and not an exception; and a
 * losing race sends one email, not two.
 */
async function checkLockAlert(): Promise<void> {
  expectEqual(LOCK_ALERT_TEMPLATE_KEY, "login_lock_alert", "the alert uses the template of section 23");
  expectEqual(LOCK_ALERT_MAX_ATTEMPTS, 3, "an alert is retried three times at most");

  // ---- the alert of a lock that just started
  const queuedWorld = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
  });
  const queuedAudit = createInMemoryAuditTrail();
  const queuedLogger = captureLogger();
  const queuedFacts: LockAlertFacts = {
    userId: USER_ID,
    companyId: FIRM_ID,
    factor: "password",
    lockedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 7_200_000).toISOString(),
    failedAttempts: 2,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  };
  const notifier = createLockAlertNotifier({
    rest: queuedWorld.rest,
    audit: queuedAudit,
    logger: queuedLogger.logger,
    now: () => NOW,
  });

  const queued = await notifier.alertOnLock(queuedFacts);

  expectEqual(queued.status, "queued", "a lock with an owner and a sender queues the alert");
  expectEqual(queuedWorld.sends.length, 1, "one lock queues one email");
  expectEqual(queued.sendId, queuedWorld.sends[0]?.id, "the answer names the queue row it wrote");
  expectEqual(queuedWorld.sends[0]?.template_key, "login_lock_alert", "the row carries the template key");
  expectEqual(queuedWorld.sends[0]?.recipient_email, "owner@firm.test", "the row is addressed to the owner");
  expectEqual(queuedWorld.sends[0]?.recipient_user_id, USER_ID, "the row names the locked account");
  expectEqual(queuedWorld.sends[0]?.provider, "smtp", "the row follows the sending method of section 23");
  expectEqual(queuedWorld.sends[0]?.max_attempts, LOCK_ALERT_MAX_ATTEMPTS, "the row carries its retry ceiling");
  expectEqual(queuedWorld.sends[0]?.reference_kind, "account", "the row points at an account");
  expectEqual(queuedWorld.sends[0]?.reference_id, USER_ID, "the row points at the locked account");
  expectEqual(
    queuedWorld.sends[0]?.subject,
    getMessage("email.lockAlert.subject"),
    "the subject is the catalog string, not a literal in the service",
  );
  expectEqual(queuedWorld.locks[0]?.alert_send_id, queuedWorld.sends[0]?.id, "the lock names the email");
  expectEqual(
    queuedWorld.locks[0]?.owner_alerted_at,
    new Date(NOW).toISOString(),
    "the lock records when the owner was alerted",
  );
  expectEqual(queuedAudit.entries.length, 1, "the alert is audited once");
  expectEqual(queuedAudit.entries[0]?.action, "user.login_lock_alerted", "the audit entry names the alert");
  expectEqual(queuedAudit.entries[0]?.payload["send_id"], queuedWorld.sends[0]?.id, "the entry names the email");
  expectEqual(queuedAudit.entries[0]?.payload["recipient"], "owner", "the entry says who was told");
  expectEqual(queuedAudit.entries[0]?.actorUserId, null, "nobody was signed in when the lock started");
  expectEqual(queuedLogger.warnings.length, 0, "a queued alert warns about nothing");

  // ---- a second call for the same lock queues nothing
  const again = await notifier.alertOnLock(queuedFacts);

  expectEqual(again.status, "already_alerted", "a lock that already alerted its owner is not alerted twice");
  expectEqual(queuedWorld.sends.length, 1, "the second call writes no second email");
  expectEqual(queuedAudit.entries.length, 1, "the second call audits nothing");

  // ---- no sending method configured is an answer, not a break
  const noMethod = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
    method: null,
  });
  const noMethodLogger = captureLogger();
  const noMethodOutcome = await createLockAlertNotifier({
    rest: noMethod.rest,
    audit: createInMemoryAuditTrail(),
    logger: noMethodLogger.logger,
    now: () => NOW,
  }).alertOnLock(queuedFacts);

  expectEqual(
    noMethodOutcome.status,
    "sender_not_configured",
    "a platform with no active sending method queues nothing",
  );
  expectEqual(noMethod.sends.length, 0, "no sender means no queue row");
  expectEqual(noMethod.locks[0]?.owner_alerted_at, null, "the lock does not claim an alert it never queued");
  expectEqual(noMethodLogger.warnings.length, 1, "the missing sending method is logged for an operator");

  // ---- a platform account has no merchant owner
  const platformLock = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
  });
  const noCompany = await createLockAlertNotifier({
    rest: platformLock.rest,
    audit: createInMemoryAuditTrail(),
    logger: captureLogger().logger,
    now: () => NOW,
  }).alertOnLock({ ...queuedFacts, companyId: null });

  expectEqual(noCompany.status, "no_owner", "an account without a company has no owner to alert");
  expectEqual(platformLock.sends.length, 0, "no owner means no email");

  // ---- a company whose owner assignment was revoked
  const noOwner = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
    ownerUserId: null,
  });
  const missingOwner = await createLockAlertNotifier({
    rest: noOwner.rest,
    audit: createInMemoryAuditTrail(),
    logger: captureLogger().logger,
    now: () => NOW,
  }).alertOnLock(queuedFacts);

  expectEqual(missingOwner.status, "no_owner", "a company without a live owner assignment alerts nobody");
  expectEqual(noOwner.sends.length, 0, "an unreachable owner means no email");

  // ---- a lock that is no longer open
  const noLock = alertWorld();
  const withoutLock = await createLockAlertNotifier({
    rest: noLock.rest,
    audit: createInMemoryAuditTrail(),
    logger: captureLogger().logger,
    now: () => NOW,
  }).alertOnLock(queuedFacts);

  expectEqual(withoutLock.status, "no_lock", "an account with no open lock queues no alert");
  expectEqual(noLock.sends.length, 0, "no lock means no email");

  // ---- a storage failure is an answer, never an exception
  const brokenRead = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
    failTable: "account_locks",
  });
  const brokenLogger = captureLogger();
  const brokenOutcome = await createLockAlertNotifier({
    rest: brokenRead.rest,
    audit: createInMemoryAuditTrail(),
    logger: brokenLogger.logger,
    now: () => NOW,
  }).alertOnLock(queuedFacts);

  expectEqual(brokenOutcome.status, "failed", "a database that did not answer is a failed alert");
  expectEqual(brokenOutcome.sendId, null, "a failed alert names no queue row");
  expectEqual(brokenLogger.warnings.length, 1, "a failed alert is logged");

  // ---- a losing race: the email is queued, the lock is claimed elsewhere, the row is dropped
  const raced = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
    loseClaim: true,
  });
  const raceOutcome = await createLockAlertNotifier({
    rest: raced.rest,
    audit: createInMemoryAuditTrail(),
    logger: captureLogger().logger,
    now: () => NOW,
  }).alertOnLock(queuedFacts);

  expectEqual(raceOutcome.status, "already_alerted", "a claim that lost the race reports an existing alert");
  expectEqual(raced.sends.length, 1, "the losing call wrote one queue row");
  expectEqual(raced.sends[0]?.status, "dropped", "the row of the losing call is dropped, so no second email");
  expectEqual(
    raced.sends[0]?.failure_reason,
    "The lock already alerted its owner.",
    "the dropped row says why it was dropped",
  );
  expectEqual(raced.locks[0]?.owner_alerted_at, null, "a losing call does not stamp the lock");

  // ---- a queue that accepted a row but answered with nothing
  const silent = alertWorld({
    locks: [{ id: "lock-1", user_id: USER_ID, alert_send_id: null, owner_alerted_at: null }],
    returnNoSendId: true,
  });
  const silentOutcome = await createLockAlertNotifier({
    rest: silent.rest,
    audit: createInMemoryAuditTrail(),
    logger: captureLogger().logger,
    now: () => NOW,
  }).alertOnLock(queuedFacts);

  expectEqual(silentOutcome.status, "failed", "a queue row with no id cannot be named, so the alert failed");
  expectEqual(silent.locks[0]?.alert_send_id, null, "a nameless row leaves the lock unpointed");
}


/** An office actor whose flags the unlock guard reads, for a check that is not the reset flow. */
function officeActor(options: {
  readonly roles: readonly PlatformRole[];
  readonly twoFactorSatisfied?: boolean;
  readonly userId?: string;
}): RequestActor {
  return {
    userId: options.userId ?? OTHER_USER_ID,
    companyId: null,
    roles: options.roles,
    sessionId: SESSION_ID,
    assuranceLevel: options.twoFactorSatisfied === false ? "aal1" : "aal2",
    authenticatedAtEpochMs: NOW - 60_000,
    expiresAtEpochMs: NOW + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: options.twoFactorSatisfied ?? true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: null,
    reauthenticatedAtEpochMs: null,
  };
}

interface UnlockLockRow {
  readonly id: string;
  readonly user_id: string;
  readonly company_id: string | null;
  readonly triggered_by: "password" | "totp";
  readonly locked_at: string;
  readonly expires_at: string;
  readonly owner_alerted_at: string | null;
  owner_contact_confirmed_at: string | null;
  unlocked_at: string | null;
  unlocked_by: string | null;
  unlock_note: string | null;
  expired_at: string | null;
}

interface UnlockWorld {
  readonly rest: RestClient;
  readonly rows: UnlockLockRow[];
  /** The emails the unlock queued, in the shape `0061` stores them. */
  readonly sends: AlertSendRow[];
  /** Every table the service asked for, in order, with the verb it used. */
  readonly touched: string[];
}

/**
 * The one table the unlock service is allowed to touch, in memory.
 *
 * It keeps what the answer depends on - which lock is open, whether a person or the clock closed it,
 * and whether the conditional update found the row it was written for - and it records every other
 * table the service asks for, because an unlock that quietly wrote `users` or `login_attempts` would
 * be a second way to clear a lock.
 */
function unlockWorld(options: {
  readonly row?: Partial<UnlockLockRow>;
  readonly rows?: readonly Partial<UnlockLockRow>[];
  /** Another officer, or the clock, won between the read and the write. */
  readonly loseRace?: boolean;
  /** The sending method section 23 has active, or null when the office configured none. */
  readonly sendingMethod?: "smtp" | "api" | null;
  /** The address of the unlocked account, or null when the row has none. */
  readonly accountEmail?: string | null;
  /** The email queue refuses the confirmation. */
  readonly failQueue?: boolean;
} = {}): UnlockWorld {
  const base: UnlockLockRow = {
    id: LOCK_ID,
    user_id: USER_ID,
    company_id: FIRM_ID,
    triggered_by: "password",
    locked_at: new Date(NOW - 600_000).toISOString(),
    expires_at: new Date(NOW - 600_000 + 7_200_000).toISOString(),
    owner_alerted_at: new Date(NOW - 599_000).toISOString(),
    owner_contact_confirmed_at: null,
    unlocked_at: null,
    unlocked_by: null,
    unlock_note: null,
    expired_at: null,
  };
  const rows: UnlockLockRow[] = (options.rows ?? [options.row ?? {}]).map((row) => ({
    ...base,
    ...row,
  }));
  const sends: AlertSendRow[] = [];
  const touched: string[] = [];
  const method = options.sendingMethod === undefined ? "smtp" : options.sendingMethod;
  const accountEmail = options.accountEmail === undefined ? "owner@firm.test" : options.accountEmail;

  const rest: RestClient = {
    select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
      touched.push(`select:${table}`);

      if (table === "email_settings") {
        return Promise.resolve(
          (method === null ? [] : [{ method }]) as unknown as readonly TRow[],
        );
      }

      if (table === "users") {
        return Promise.resolve(
          (accountEmail === null ? [] : [{ email: accountEmail }]) as unknown as readonly TRow[],
        );
      }

      if (table !== "account_locks") {
        return Promise.resolve([] as readonly TRow[]);
      }

      const byId = /(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1];
      const byUser = /(?:^|[&?])user_id=eq\.([^&]+)/u.exec(query)?.[1];
      const live = query.includes("unlocked_at=is.null")
        ? rows.filter((row) => row.unlocked_at === null && row.expired_at === null)
        : rows;
      const matched =
        byId === undefined
          ? live.filter((row) => row.user_id === decodeURIComponent(byUser ?? ""))
          : live.filter((row) => row.id === byId);

      return Promise.resolve(matched.map((row) => ({ ...row })) as unknown as readonly TRow[]);
    },
    insert(): Promise<void> {
      touched.push("insert:unknown");
      return Promise.reject(new Error("the unlock service inserts nothing directly"));
    },
    insertReturning<TRow>(
      table: string,
      values: readonly Readonly<Record<string, unknown>>[],
    ): Promise<readonly TRow[]> {
      touched.push(`insert:${table}`);

      if (table !== "email_send_logs" || options.failQueue === true) {
        return Promise.reject(new Error(`the unlock service must not insert into ${table}`));
      }

      const written: AlertSendRow[] = values.map((row) => ({
        id: `send-${String(sends.length + 1)}`,
        company_id: (row["company_id"] as string | null | undefined) ?? null,
        template_key: String(row["template_key"]),
        recipient_email: String(row["recipient_email"]),
        recipient_user_id: (row["recipient_user_id"] as string | null | undefined) ?? null,
        subject: String(row["subject"]),
        provider: String(row["provider"]),
        max_attempts: Number(row["max_attempts"]),
        reference_kind: (row["reference_kind"] as string | null | undefined) ?? null,
        reference_id: (row["reference_id"] as string | null | undefined) ?? null,
        queued_at: String(row["queued_at"]),
        status: "queued",
        failure_reason: null,
      }));

      sends.push(...written);

      return Promise.resolve(written.map((row) => ({ id: row.id })) as unknown as readonly TRow[]);
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      touched.push(`update:${table}`);

      if (table !== "account_locks") {
        return Promise.reject(new Error(`the unlock service must not write ${table}`));
      }

      const id = /(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1] ?? "";

      for (const row of rows) {
        if (row.id !== id || options.loseRace === true) {
          continue;
        }

        if (query.includes("unlocked_at=is.null") && row.unlocked_at !== null) {
          continue;
        }

        if (query.includes("expired_at=is.null") && row.expired_at !== null) {
          continue;
        }

        Object.assign(row, values);
      }

      return Promise.resolve();
    },
    rpc: (): Promise<unknown> => Promise.resolve(null),
  };

  return { rest, rows, sends, touched };
}

/**
 * The office unlock of section 22, proved twice over: the permission, and the record.
 *
 * The permission checks are first because they are the security of the whole STEP: a merchant
 * holding `owner` - including the owner of the locked company - must not be able to end their own
 * lock, and neither must the roles that never touch access. The record checks come second: an unlock
 * that a person performed names the person, stamps the contact, keeps the note and writes exactly one
 * audit entry, while an unlock the platform cannot describe is refused before it happens.
 */
async function checkAccountUnlock(): Promise<void> {
  expectEqual(
    ACCOUNT_UNLOCK_OFFICE_ROLES.join(","),
    "super_admin,ceo,compliance_kyc,support",
    "the roles that may unlock are the office roles that talk to a merchant",
  );
  expectEqual(ACCOUNT_UNLOCK_NOTE_MAX_LENGTH, 280, "the note ceiling is the column's");

  const note = "Called the owner on the number on file and confirmed the address by email.";
  const request = {
    lockId: LOCK_ID,
    note,
    ownerContactConfirmed: true,
  } as const;

  // ---- every permitted office role may unlock, and the record is the same for each
  for (const role of ACCOUNT_UNLOCK_OFFICE_ROLES) {
    const world = unlockWorld();
    const audit = createInMemoryAuditTrail();
    const result = await unlockAccountLock(
      { ...request, actor: officeActor({ roles: [role] }) },
      { rest: world.rest, audit, logger: captureLogger().logger, now: () => NOW },
    );

    expectEqual(result.status, "unlocked", `${role} may unlock an account`);
  }

  // ---- the roles that must never do it, including the merchant's own owner role
  for (const roles of [["owner"], ["blogger"], ["finance_ops"], ["client"], []] as const) {
    const world = unlockWorld();

    await expectRejects(
      () =>
        unlockAccountLock(
          { ...request, actor: officeActor({ roles: roles as readonly PlatformRole[] }) },
          { rest: world.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
        ),
      "PERMISSION_DENIED",
      `roles [${roles.join(",")}] cannot unlock an account`,
    );
    expectEqual(world.touched.length, 0, "a refused caller causes no read and no write");
  }

  // ---- an office session without a second factor is not enough
  const unproven = unlockWorld();

  await expectRejects(
    () =>
      unlockAccountLock(
        { ...request, actor: officeActor({ roles: ["super_admin"], twoFactorSatisfied: false }) },
        { rest: unproven.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
      ),
    "PERMISSION_DENIED",
    "an office session that has not answered a second factor cannot unlock",
  );
  expectEqual(unproven.touched.length, 0, "the second factor is checked before anything is read");

  // ---- the unlock itself
  const world = unlockWorld();
  const audit = createInMemoryAuditTrail();
  const officer = officeActor({ roles: ["support"] });
  const unlocked = await unlockAccountLock(
    { ...request, note: `  ${note}  `, actor: officer },
    { rest: world.rest, audit, logger: captureLogger().logger, now: () => NOW },
  );
  const row = world.rows[0];

  expectEqual(unlocked.lockId, LOCK_ID, "the answer names the lock it closed");
  expectEqual(unlocked.userId, USER_ID, "the answer names the account that may sign in again");
  expectEqual(unlocked.companyId, FIRM_ID, "the answer names the company of the account");
  expectEqual(unlocked.unlockedAt, new Date(NOW).toISOString(), "the answer names the unlock instant");
  expectEqual(row?.unlocked_at, unlocked.unlockedAt, "the row records the unlock instant");
  expectEqual(row?.unlocked_by, officer.userId, "the row records the officer who unlocked");
  expectEqual(
    row?.owner_contact_confirmed_at,
    unlocked.unlockedAt,
    "the unlock records that the owner was contacted, at the same instant",
  );
  expectEqual(row?.unlock_note, note, "the row keeps the note, trimmed");
  expectEqual(unlocked.ownerContactConfirmedAt, unlocked.unlockedAt, "the answer says when contact was recorded");
  expectEqual(audit.entries.length, 1, "an unlock writes exactly one audit entry");
  expectEqual(audit.entries[0]?.action, "user.login_unlocked", "the entry names the unlock");
  expectEqual(audit.entries[0]?.actorUserId, officer.userId, "the entry names the officer");
  expectEqual(audit.entries[0]?.entityId, USER_ID, "the entry points at the unlocked account");
  expectEqual(audit.entries[0]?.companyId, FIRM_ID, "the entry is chained on the merchant's company");
  expectEqual(audit.entries[0]?.payload["lock_id"], LOCK_ID, "the entry names the lock row");
  expectEqual(audit.entries[0]?.payload["triggered_by"], "password", "the entry names the factor that locked");
  expectEqual(audit.entries[0]?.payload["owner_alerted"], true, "the entry records whether the owner was told");
  expectEqual(audit.entries[0]?.payload["note_length"], note.length, "the entry records the length, never the note");
  expectEqual(audit.entries[0]?.payload["lock_age_seconds"], 600, "the entry records how long the lock lasted");
  expectEqual(
    [...new Set(world.touched.map((entry) => entry.split(":")[1]))].sort().join(","),
    "account_locks,email_send_logs,email_settings,users",
    "the unlock touches the lock row and the email queue, and no other table",
  );
  expectEqual(world.touched.includes("update:users"), false, "the unlock never writes the account row");
  expectEqual(
    world.touched.includes("update:login_attempts"),
    false,
    "the unlock never resets the streak that caused the lock",
  );

  // ---- the lock is closed for the sign in service too
  const afterUnlock = await readAccountLock(world.rest, USER_ID, NOW);

  expectEqual(afterUnlock.locked, false, "an unlocked account is not locked for the sign in service");
  expectEqual(afterUnlock.remainingSeconds, null, "an unlocked account has no remaining time");

  // ---- the account is told, through the queue of section 23
  expectEqual(ACCOUNT_UNLOCK_TEMPLATE_KEY, "account_unlock", "the confirmation uses the template of section 23");
  expectEqual(ACCOUNT_UNLOCK_MAIL_MAX_ATTEMPTS, 3, "a confirmation is retried three times at most");
  expectEqual(world.sends.length, 1, "an unlock queues one confirmation email");
  expectEqual(world.sends[0]?.template_key, "account_unlock", "the queue row carries the template key");
  expectEqual(world.sends[0]?.recipient_email, "owner@firm.test", "the confirmation goes to the unlocked account");
  expectEqual(world.sends[0]?.recipient_user_id, USER_ID, "the row names the account it is about");
  expectEqual(world.sends[0]?.company_id, FIRM_ID, "the row names the company of the account");
  expectEqual(world.sends[0]?.provider, "smtp", "the row follows the sending method of section 23");
  expectEqual(world.sends[0]?.max_attempts, ACCOUNT_UNLOCK_MAIL_MAX_ATTEMPTS, "the row carries its retry ceiling");
  expectEqual(world.sends[0]?.reference_kind, "account", "the row points at an account");
  expectEqual(world.sends[0]?.reference_id, USER_ID, "the row points at the unlocked account");
  expectEqual(world.sends[0]?.queued_at, unlocked.unlockedAt, "the row is queued at the unlock instant");
  expectEqual(
    world.sends[0]?.subject,
    getMessage("email.accountUnlock.subject"),
    "the subject is the catalog string, not a literal in the service",
  );

  // ---- no sender, no address, and a queue that refuses: the unlock still stands
  const silentOffice = unlockWorld({ sendingMethod: null });
  const silentLogger = captureLogger();
  const withoutSender = await unlockAccountLock(
    { ...request, actor: officer },
    { rest: silentOffice.rest, audit: createInMemoryAuditTrail(), logger: silentLogger.logger, now: () => NOW },
  );

  expectEqual(withoutSender.status, "unlocked", "an unlock succeeds when the office configured no sender");
  expectEqual(silentOffice.sends.length, 0, "no sender means no confirmation row");
  expectEqual(silentLogger.warnings.length, 1, "the missing sender is logged for an operator");

  const anonymous = unlockWorld({ accountEmail: null });
  const anonymousLogger = captureLogger();
  const withoutAddress = await unlockAccountLock(
    { ...request, actor: officer },
    { rest: anonymous.rest, audit: createInMemoryAuditTrail(), logger: anonymousLogger.logger, now: () => NOW },
  );

  expectEqual(withoutAddress.status, "unlocked", "an unlock succeeds when the account has no address");
  expectEqual(anonymous.sends.length, 0, "no address means no confirmation row");
  expectEqual(anonymousLogger.warnings.length, 1, "the missing address is logged");

  const refusedQueue = unlockWorld({ failQueue: true });
  const refusedLogger = captureLogger();
  let queuedAnyway: Awaited<ReturnType<typeof unlockAccountLock>> | null = null;
  let queueFailure: unknown = null;

  try {
    queuedAnyway = await unlockAccountLock(
      { ...request, actor: officer },
      { rest: refusedQueue.rest, audit: createInMemoryAuditTrail(), logger: refusedLogger.logger, now: () => NOW },
    );
  } catch (error) {
    queueFailure = error;
  }

  expectEqual(queueFailure, null, "a queue that refuses the confirmation does not reject the unlock");
  expectEqual(queuedAnyway?.status, "unlocked", "a queue that refuses the confirmation does not undo the unlock");
  expectEqual(refusedQueue.rows[0]?.unlocked_at !== null, true, "the lock stays closed after the failed queue");
  expectEqual(refusedLogger.warnings.length, 1, "the failed confirmation is logged");

  // ---- a contact recorded earlier keeps its own instant
  const earlier = new Date(NOW - 300_000).toISOString();
  const earlyWorld = unlockWorld({ row: { owner_contact_confirmed_at: earlier } });

  const early = await unlockAccountLock(
    { ...request, actor: officer },
    { rest: earlyWorld.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
  );

  expectEqual(
    earlyWorld.rows[0]?.owner_contact_confirmed_at,
    earlier,
    "a contact recorded before the unlock keeps its instant",
  );
  expectEqual(early.ownerContactConfirmedAt, earlier, "the answer keeps the earlier contact instant");

  // ---- the contact confirmation is required, and it is a field, not a formality
  const unconfirmed = unlockWorld();

  await expectRejects(
    () =>
      unlockAccountLock(
        { ...request, ownerContactConfirmed: false, actor: officer },
        { rest: unconfirmed.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
      ),
    "VALIDATION_FAILED",
    "an unlock without the contact confirmed is refused",
  );
  expectEqual(unconfirmed.touched.length, 0, "an unconfirmed unlock reads nothing");
  expectEqual(unconfirmed.rows[0]?.unlocked_at, null, "an unconfirmed unlock closes nothing");

  // ---- the note is required, bounded and trimmed
  for (const [label, candidate] of [
    ["an empty note", ""],
    ["a whitespace note", "   "],
    ["a note past the ceiling", "x".repeat(ACCOUNT_UNLOCK_NOTE_MAX_LENGTH + 1)],
  ] as const) {
    const invalid = unlockWorld();

    await expectRejects(
      () =>
        unlockAccountLock(
          { ...request, note: candidate, actor: officer },
          { rest: invalid.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
        ),
      "VALIDATION_FAILED",
      `${label} is refused`,
    );
    expectEqual(invalid.rows[0]?.unlocked_at, null, `${label} closes no lock`);
  }

  // ---- an id that is not a lock, and a lock that does not exist
  const notAnId = unlockWorld();

  await expectRejects(
    () =>
      unlockAccountLock(
        { ...request, lockId: "not-a-lock", actor: officer },
        { rest: notAnId.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
      ),
    "RESOURCE_NOT_FOUND",
    "an id that is not shaped like a lock id is not found",
  );

  const missing = unlockWorld({ rows: [] });

  await expectRejects(
    () =>
      unlockAccountLock(
        { ...request, actor: officer },
        { rest: missing.rest, audit: createInMemoryAuditTrail(), logger: captureLogger().logger, now: () => NOW },
      ),
    "RESOURCE_NOT_FOUND",
    "a lock that does not exist is not found",
  );

  // ---- a lock that is already closed is history, whichever closed it
  for (const [label, closed] of [
    ["an unlocked lock", { unlocked_at: new Date(NOW - 60_000).toISOString(), unlocked_by: OTHER_USER_ID }],
    ["an expired lock", { expired_at: new Date(NOW - 60_000).toISOString() }],
    [
      "a lock whose two hours are over",
      { expires_at: new Date(NOW - 1_000).toISOString() },
    ],
  ] as const) {
    const settled = unlockWorld({ row: closed });
    const settledAudit = createInMemoryAuditTrail();

    await expectRejects(
      () =>
        unlockAccountLock(
          { ...request, actor: officer },
          { rest: settled.rest, audit: settledAudit, logger: captureLogger().logger, now: () => NOW },
        ),
      "CONFLICT",
      `${label} cannot be unlocked again`,
    );
    expectEqual(settledAudit.entries.length, 0, `${label} writes no audit entry`);
  }

  // ---- a second officer who won the race
  const raced = unlockWorld({ loseRace: true });
  const racedAudit = createInMemoryAuditTrail();

  await expectRejects(
    () =>
      unlockAccountLock(
        { ...request, actor: officer },
        { rest: raced.rest, audit: racedAudit, logger: captureLogger().logger, now: () => NOW },
      ),
    "CONFLICT",
    "an unlock that another officer performed first is a conflict",
  );
  expectEqual(racedAudit.entries.length, 0, "a lost race writes no audit entry");

  // ---- an unlock the platform cannot record is not reported as done
  const unrecorded = unlockWorld();
  const failingAudit = {
    append: (): Promise<void> => Promise.reject(new Error("the audit chain is unavailable")),
  } as unknown as Parameters<typeof unlockAccountLock>[1]["audit"];
  let recordFailure: unknown = null;

  try {
    await unlockAccountLock(
      { ...request, actor: officer },
      { rest: unrecorded.rest, audit: failingAudit, logger: captureLogger().logger, now: () => NOW },
    );
  } catch (error) {
    recordFailure = error;
  }

  expect(recordFailure !== null, "an unlock that cannot be audited fails rather than returning success");
  expectEqual(
    unrecorded.rows[0]?.unlocked_at !== null,
    true,
    "the row is closed before the audit is attempted, so the failure is visible to the next caller",
  );
}


/* ------------------------------------------------------- disclosure (048) */

/**
 * The route files under `app/api/auth`, as the app router serves them.
 *
 * Read from disk rather than listed by hand: the property this gate protects is "no anonymous
 * surface answers about an account", and a surface nobody remembered to classify is exactly the
 * way that property gets lost. Reading is the only way to notice the route that was added later.
 */
async function authRoutePaths(): Promise<readonly string[]> {
  const root = new URL("../../app/api/auth/", import.meta.url);
  const entries = await readdir(root, { recursive: true });
  const paths = entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith("/route.ts"))
    .map((entry) => `/api/auth/${entry.slice(0, -"/route.ts".length)}`)
    .sort();

  return paths;
}

/** The catalog envelope of a failure, at a fixed request id, so two answers can be compared. */
function renderedEnvelope(error: AppError): string {
  return JSON.stringify(buildErrorEnvelope(error, "disclosure-gate-request"));
}

/**
 * Section 22 line 243: "Error messages never reveal whether an account exists".
 *
 * The gate proves it in three layers.
 *
 *   1. **The contract.** Every route under `app/api/auth` is classified, every catalogued code
 *      exists and none of the four record-carrying codes appears on an anonymous surface.
 *   2. **The answers.** A wrong password, an address with no account and a locked account without
 *      its password render the *same* envelope, character for character; the lock answer appears
 *      only on the far side of a correct password, which section 22 line 238 requires.
 *   3. **The signup.** Three duplicate paths - the provider's obfuscated person, the provider's
 *      refusal code and the platform's own `users_email_key` - all answer the acceptance body and
 *      write nothing, and none of them can delete an account that already existed.
 */
async function checkDisclosure(): Promise<void> {
  // ---- the refusal every anonymous surface shares
  expectEqual(ANONYMOUS_REFUSAL, "AUTHENTICATION_REQUIRED", "the anonymous refusal is the sign in code");
  expectEqual(ERROR_CODES[ANONYMOUS_REFUSAL].status, 401, "an anonymous refusal answers 401");
  expectEqual(ERROR_CODES[ANONYMOUS_REFUSAL].retryable, false, "a refusal is not retryable");

  const first = anonymousRejection();
  const second = anonymousRejection();

  expect(first !== second, "two refusals are two errors, so a detail cannot travel between routes");
  expectEqual(first.code, ANONYMOUS_REFUSAL, "the helper builds the shared code");
  expectEqual(first.details.length, 0, "a refusal carries no detail");

  // ---- the catalogue covers the files that exist
  const routes = await authRoutePaths();
  const classified = classifiedPaths();

  expect(routes.length >= 8, "the auth folder still holds its route files");
  expectEqual(
    new Set(classified).size,
    classified.length,
    "no path is classified twice",
  );

  for (const route of routes) {
    expect(
      classified.includes(route),
      `the auth route ${route} is classified as anonymous or as session scoped`,
    );
  }

  for (const surface of ANONYMOUS_AUTH_SURFACES) {
    expect(routes.includes(surface.path), `the anonymous surface ${surface.path} is a real route`);
    expect(surface.codes.length > 0, `the anonymous surface ${surface.path} lists its codes`);
    expect(
      surface.note.length > 20,
      `the anonymous surface ${surface.path} says why its list ends where it does`,
    );

    for (const code of surface.codes) {
      expect(isCatalogCode(code), `the code ${code} of ${surface.path} exists in the catalog`);
      expect(
        FORBIDDEN_ON_ANONYMOUS_SURFACES.includes(code) === false,
        `${surface.path} never answers ${code}, which describes a record`,
      );
    }
  }

  for (const surface of SESSION_AUTH_SURFACES) {
    expect(routes.includes(surface.path), `the session surface ${surface.path} is a real route`);
  }

  expectEqual(anonymousSurfaceCodes("/api/auth/signup")?.includes("CONFLICT"), false, "signup cannot answer a conflict");
  expectEqual(anonymousSurfaceCodes("/api/auth/signin")?.includes("ACCOUNT_LOCKED"), true, "sign in may answer the lock, after the password");
  expectEqual(anonymousSurfaceCodes("/api/auth/does-not-exist"), null, "an unknown path is not an anonymous surface");

  // ---- a detail may describe a form, never an account
  for (const rule of ["email_exists", "account_not_found", "address_taken", "account_locked", "totp_enrolled", "already_registered"]) {
    expect(isDisclosingDetail(rule), `the detail rule ${rule} is refused on an anonymous answer`);
  }

  for (const rule of ["invalid_format", "too_small", "required", "not_accepted", "breached", "invalid_json"]) {
    expect(isDisclosingDetail(rule) === false, `the detail rule ${rule} describes the form and is allowed`);
  }

  // ---- one body for every accepted signup
  expect(Object.isFrozen(SIGNUP_ACCEPTANCE), "the signup acceptance cannot be varied at runtime");
  expectEqual(SIGNUP_ACCEPTANCE.status, "verification_required", "an accepted signup asks for the mail link");
  expectEqual(TWO_FACTOR_RESET_ACCEPTANCE.status, "accepted", "a reset request answers one sentence");

  // ---- the signup: the provider already holds the address
  const anonymousSignup = (): { readonly request: unknown; readonly remoteIp: null; readonly userAgent: null } => ({
    request: signupRequest(),
    remoteIp: null,
    userAgent: null,
  });

  const bySignal = registrationFixture({
    provider: { ok: true, value: { userId: USER_ID, session: null, identity: "existing" } },
  });
  const signalResult = await expectAnswer(
    () => registerMerchant(anonymousSignup(), bySignal.dependencies),
    "a duplicate signup answers instead of throwing",
  );

  expectEqual(
    signalResult?.status,
    "indistinguishable",
    "a provider that already holds the address accepts and creates nothing",
  );
  expectEqual(bySignal.rest.calls.length, 0, "the obfuscated duplicate writes no row");
  expectEqual(bySignal.newAdmin.deleted.length, 0, "the account that already existed is not deleted");
  expectEqual(bySignal.audit.entries.length, 0, "no signup is audited for an address that exists");

  // ---- the signup: the provider refuses the address
  const byCode = registrationFixture({
    provider: {
      ok: false,
      failure: { kind: "rejected", status: 422, code: "user_already_exists", retryAfterSeconds: null },
    },
  });
  const codeResult = await expectAnswer(
    () => registerMerchant(anonymousSignup(), byCode.dependencies),
    "a refused address answers instead of throwing",
  );

  expectEqual(codeResult?.status, "indistinguishable", "a provider that refuses the address accepts and creates nothing");
  expectEqual(byCode.rest.calls.length, 0, "the refusal writes no row");
  expectEqual(byCode.newAdmin.deleted.length, 0, "a refused address deletes no account");

  const otherRefusal = registrationFixture({
    provider: {
      ok: false,
      failure: { kind: "rejected", status: 422, code: "weak_password", retryAfterSeconds: null },
    },
  });
  const refusalError = await captureRejection(
    () => registerMerchant(anonymousSignup(), otherRefusal.dependencies),
    "a refusal that is not about the address is still reported",
  );

  expectEqual(refusalError.code, "VALIDATION_FAILED", "an unrelated refusal keeps its own answer");
  expectEqual(refusalError.details.length, 0, "the unrelated refusal tells the form nothing either");

  // ---- the signup: the platform already holds the address
  const held = registrationFixture({ registeredEmails: ["owner@example.com"] });
  const heldResult = await expectAnswer(
    () => registerMerchant(anonymousSignup(), held.dependencies),
    "an address the platform holds answers instead of throwing",
  );

  expectEqual(heldResult?.status, "indistinguishable", "an address this platform holds accepts and creates nothing");
  expectEqual(
    held.rest.calls.filter((call) => call.kind === "insert" || call.kind === "insertReturning").length,
    0,
    "no company and no person are written for an address that exists",
  );
  expectEqual(held.newAdmin.deleted.length, 0, "the provider account of the existing person is not deleted");
  expectEqual(
    held.rest.calls.filter((call) => call.kind === "select").length,
    1,
    "the question is one index lookup",
  );

  // ---- the signup: two requests raced and one lost
  const raced = registrationFixture({ conflictInsertTable: "users" });
  const racedResult = await expectAnswer(
    () => registerMerchant(anonymousSignup(), raced.dependencies),
    "a lost race answers instead of throwing",
  );

  expectEqual(racedResult?.status, "indistinguishable", "a lost race answers like a duplicate");
  expectEqual(raced.newAdmin.deleted.length, 1, "the provider user this request created is cleaned up");
  expectEqual(raced.newAdmin.deleted[0], USER_ID, "the cleanup names the identifier the provider minted");
  expectEqual(
    raced.rest.calls.some((call) => call.kind === "update" && call.table === "users"),
    false,
    "no other party's account is soft closed by the compensation",
  );
  expect(
    raced.rest.calls.some((call) => call.kind === "update" && call.table === "companies"),
    "the company this attempt created is undone",
  );

  // ---- a real failure still compensates, and still reports itself
  const broken = registrationFixture({ failInsertTable: "role_assignments" });
  const brokenError = await captureRejection(
    () => registerMerchant(anonymousSignup(), broken.dependencies),
    "a failure after the person exists is reported",
  );

  const unproven = registrationFixture({
    failInsertTable: "role_assignments",
    provider: { ok: true, value: { userId: USER_ID, session: null, identity: "unknown" } },
  });
  const unprovenError = await captureRejection(
    () => registerMerchant(anonymousSignup(), unproven.dependencies),
    "a failure after an unprovable provider answer is reported",
  );

  expectEqual(unprovenError.code, "DEPENDENCY_FAILED", "the unprovable answer is still an outage");
  expectEqual(
    unproven.newAdmin.deleted.length,
    0,
    "a provider account the platform cannot prove it created is never deleted",
  );
  expect(
    unproven.rest.calls.some((call) => call.kind === "update" && call.table === "users"),
    "the person the platform recorded is still soft closed",
  );

  expectEqual(brokenError.code, "DEPENDENCY_FAILED", "an outage is still an outage");
  expectEqual(broken.newAdmin.deleted.length, 1, "the provider account this platform recorded is deleted");
  expectEqual(broken.newAdmin.deleted[0], USER_ID, "the compensation names the account it created");
  expect(
    broken.rest.calls.some((call) => call.kind === "update" && call.table === "users"),
    "the recorded person is soft closed",
  );

  // ---- the sign in: one envelope for every reason
  const canonical = renderedEnvelope(anonymousRejection());

  const unknownAccount = signinFixture({ user: null });
  const unknownError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        unknownAccount.dependencies,
      ),
    "an address with no account is refused",
  );

  expectEqual(unknownError.code, "AUTHENTICATION_REQUIRED", "an unknown address answers the shared code");
  expectEqual(unknownError.details.length, 0, "an unknown address names no field");
  expectEqual(renderedEnvelope(unknownError), canonical, "an unknown address renders the canonical refusal");

  const wrongPasswordFixture = signinFixture({ signIn: rejectedSignIn });
  const wrongPassword = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        wrongPasswordFixture.dependencies,
      ),
    "a wrong password is refused",
  );

  expectEqual(wrongPassword.code, "AUTHENTICATION_REQUIRED", "a wrong password answers the shared code");
  expectEqual(renderedEnvelope(wrongPassword), canonical, "a wrong password renders exactly what an unknown address renders");

  const unconfirmed = signinFixture({
    user: {
      id: USER_ID,
      company_id: FIRM_ID,
      status: "active",
      email_verified_at: null,
      deleted_at: null,
      totp_confirmed_at: null,
    },
  });
  const unconfirmedError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        unconfirmed.dependencies,
      ),
    "an unconfirmed address is refused",
  );

  expectEqual(renderedEnvelope(unconfirmedError), canonical, "an unconfirmed mail renders the same refusal again");

  // ---- the lock is invisible without the password
  const lockedTable = createLockTable();

  lockedTable.insert([
    {
      company_id: FIRM_ID,
      user_id: USER_ID,
      triggered_by: "password",
      locked_at: new Date(NOW - 600_000).toISOString(),
      expires_at: new Date(NOW + 6_600_000).toISOString(),
    },
  ]);

  const lockedOwner = signinFixture({ locks: lockedTable });
  const lockedError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        lockedOwner.dependencies,
      ),
    "a correct password on a locked account is refused",
  );

  expectEqual(lockedError.code, "ACCOUNT_LOCKED", "a proven password learns the lock");
  expect(renderedEnvelope(lockedError) !== canonical, "the lock answer is a different answer, as section 22 allows");

  const lockedStranger = signinFixture({ locks: lockedTable, signIn: rejectedSignIn });
  const lockedStrangerError = await captureRejection(
    () =>
      signInMerchant(
        { request: signinRequest(), remoteIp: "203.0.113.9", userAgent: "gate" },
        lockedStranger.dependencies,
      ),
    "a wrong password on a locked account is refused",
  );

  expectEqual(lockedStrangerError.code, "AUTHENTICATION_REQUIRED", "a stranger never learns the lock");
  expectEqual(renderedEnvelope(lockedStrangerError), canonical, "a locked account without its password renders the canonical refusal");
}

/* ------------------------------------------------ device proof key (049) */

/** The row `0009` creates, as the gate's fake table keeps it. */
interface DeviceKeyRow {
  readonly id: string;
  readonly user_id: string;
  readonly company_id: string | null;
  readonly fingerprint: string;
  readonly public_key: string;
  readonly algorithm: string;
  readonly label: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly trusted_at: string | null;
  readonly revoked_at: string | null;
  readonly deleted_at: string | null;
}

interface DeviceKeyTable {
  readonly rows: readonly DeviceKeyRow[];
  readonly updates: readonly { readonly id: string; readonly values: Readonly<Record<string, unknown>> }[];
  seed(values: {
    readonly user_id: string;
    readonly fingerprint: string;
    readonly revoked_at?: string | null;
  }): string;
  readonly rest: RestClient;
}

/**
 * A fake `public.device_proof_keys` that enforces the checks `0009` enforces.
 *
 * `blindSelects` makes the next N reads answer nothing, which is how the race against
 * `device_proof_keys_live_key` is reproduced without threads: the service reads, sees no key, and
 * the insert it then attempts collides with a row that became live in between.
 */
function createDeviceKeyTable(options: { readonly blindSelects?: number } = {}): DeviceKeyTable {
  const rows: DeviceKeyRow[] = [];
  const updates: { id: string; values: Readonly<Record<string, unknown>> }[] = [];
  let blind = options.blindSelects ?? 0;

  const matches = (query: string): readonly DeviceKeyRow[] => {
    const userId = /(?:^|[&?])user_id=eq\.([^&]+)/u.exec(query)?.[1] ?? null;
    const fingerprint = /(?:^|[&?])fingerprint=eq\.([^&]+)/u.exec(query)?.[1] ?? null;
    const limit = Number.parseInt(/limit=(\d+)/u.exec(query)?.[1] ?? "", 10);
    const live = query.includes("revoked_at=is.null")
      ? rows.filter((row) => row.revoked_at === null && row.deleted_at === null)
      : rows;

    return live
      .filter((row) => userId === null || row.user_id === decodeURIComponent(userId))
      .filter((row) => fingerprint === null || row.fingerprint === decodeURIComponent(fingerprint))
      .slice(0, Number.isFinite(limit) ? limit : rows.length);
  };

  const write = (batch: readonly Readonly<Record<string, unknown>>[]): readonly DeviceKeyRow[] =>
    batch.map((values) => {
      const fingerprint = String(values["fingerprint"]);
      const publicKey = String(values["public_key"]);
      const rawLabel = values["label"];
      const label = rawLabel === null || rawLabel === undefined ? null : String(rawLabel);
      const userId = String(values["user_id"]);

      if (!PROOF_KEY_FINGERPRINT_PATTERN.test(fingerprint)) {
        throw new AppError("VALIDATION_FAILED");
      }

      if (!isPublicKeyShape(publicKey)) {
        throw new AppError("VALIDATION_FAILED");
      }

      // device_proof_keys_label_check: trimmed, one to eighty characters.
      if (label !== null && (label !== label.trim() || label.length > PROOF_KEY_LABEL_MAXIMUM_LENGTH)) {
        throw new AppError("VALIDATION_FAILED");
      }

      // device_proof_keys_live_key: one live row per account and fingerprint.
      if (
        rows.some(
          (row) =>
            row.user_id === userId &&
            row.fingerprint === fingerprint &&
            row.revoked_at === null &&
            row.deleted_at === null,
        )
      ) {
        throw new AppError("CONFLICT");
      }

      const row: DeviceKeyRow = {
        id: `device-${String(rows.length + 1)}`,
        user_id: userId,
        company_id: (values["company_id"] as string | null | undefined) ?? null,
        fingerprint,
        public_key: publicKey,
        algorithm: String(values["algorithm"]),
        label,
        first_seen_at: String(values["first_seen_at"]),
        last_seen_at: String(values["last_seen_at"]),
        trusted_at: null,
        revoked_at: null,
        deleted_at: null,
      };

      rows.push(row);

      return row;
    });

  return {
    rows,
    updates,
    seed(values) {
      const row: DeviceKeyRow = {
        id: `seed-${String(rows.length + 1)}`,
        user_id: values.user_id,
        company_id: FIRM_ID,
        fingerprint: values.fingerprint,
        public_key: "x".repeat(122),
        algorithm: "ES256",
        label: "seeded",
        first_seen_at: new Date(NOW - 86_400_000).toISOString(),
        last_seen_at: new Date(NOW - 86_400_000).toISOString(),
        trusted_at: new Date(NOW - 86_400_000).toISOString(),
        revoked_at: values.revoked_at ?? null,
        deleted_at: null,
      };

      rows.push(row);

      return row.id;
    },
    rest: {
      select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
        if (table !== "device_proof_keys") {
          return Promise.resolve([]);
        }

        if (blind > 0) {
          blind -= 1;

          return Promise.resolve([]);
        }

        return Promise.resolve(matches(query) as unknown as readonly TRow[]);
      },
      insert(table: string, batch: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
        if (table === "device_proof_keys") {
          write(batch);
        }

        return Promise.resolve();
      },
      insertReturning<TRow>(
        table: string,
        batch: readonly Readonly<Record<string, unknown>>[],
      ): Promise<readonly TRow[]> {
        if (table !== "device_proof_keys") {
          return Promise.resolve([]);
        }

        return Promise.resolve(write(batch).map((row) => ({ id: row.id }) as unknown as TRow));
      },
      update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
        if (table !== "device_proof_keys") {
          return Promise.resolve();
        }

        const id = decodeURIComponent(/(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1] ?? "");
        const index = rows.findIndex((row) => row.id === id && row.revoked_at === null && row.deleted_at === null);
        const current = index === -1 ? undefined : rows[index];

        if (current === undefined) {
          return Promise.resolve();
        }

        updates.push({ id, values });
        rows[index] = { ...current, ...values } as DeviceKeyRow;

        return Promise.resolve();
      },
      rpc(): Promise<unknown> {
        return Promise.resolve(null);
      },
    },
  };
}

const chromeAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * The device proof key: generation in the browser, and the row the server writes.
 *
 * The three halves of the feature are proven where they run. Generation and the fingerprint are the
 * *same module* the browser loads, executed here under Node's WebCrypto, so the values the gate
 * compares are the values a browser produces. The parse is the server's, with `createPublicKey`
 * behind it. The row, the cap, the race and the audit entry are the service's, against a table that
 * enforces the checks `0009` enforces.
 *
 * What cannot be proven here is IndexedDB itself; the store's guard (`isStoredProofKey`) is, because
 * that guard is what decides whether a record read back from a browser is used or replaced.
 */
async function checkDeviceProofKey(): Promise<void> {
  // ---- the shared half: base64url in both directions
  const bytes = new Uint8Array(32).map((_value, index) => (index * 7 + 3) % 256);
  const encoded = encodeBase64Url(bytes);

  expect(encoded.length > 0 && !encoded.includes("="), "base64url carries no padding");
  expect(/^[A-Za-z0-9_-]+$/u.test(encoded), "base64url uses only the two safe symbols");
  expectEqual(decodeBase64Url(encoded)?.length, 32, "base64url round trips to the same length");
  expectEqual(decodeBase64Url(encoded)?.[31], bytes[31], "base64url round trips the last byte");
  expectEqual(decodeBase64Url(`${encoded}==`), null, "a padded string is refused rather than repaired");
  expectEqual(decodeBase64Url("a+b/"), null, "the standard alphabet is refused");
  expectEqual(decodeBase64Url(""), null, "an empty string is not a key");
  expectEqual(decodeBase64Url("a"), null, "a length that cannot be base64 is refused");

  // ---- a real pair, the way the browser generates it
  const generated = await generateProofKeyPair();

  expectEqual(generated.algorithm, "ES256", "a browser generates ES256 by default");
  expectEqual(generated.privateKey.extractable, false, "the private half cannot be exported");
  expectEqual(generated.publicKey.extractable, true, "the public half can be exported");
  expect(generated.privateKey.usages.includes("sign"), "the private half is allowed to sign");
  expectEqual(isPublicKeyShape(generated.publicKeyBase64Url), true, "the exported key fits the column");
  expectEqual(generated.fingerprint.length, 43, "the fingerprint is a SHA-256 in base64url");
  expect(PROOF_KEY_FINGERPRINT_PATTERN.test(generated.fingerprint), "the fingerprint fits 0009's check");

  const otherPair = await generateProofKeyPair();

  expect(generated.fingerprint !== otherPair.fingerprint, "two devices have two fingerprints");

  // ---- the server parses what the browser produced
  const inspection = await inspectProofKey(generated.publicKeyBase64Url, "ES256");

  expectEqual(inspection?.canonicalBase64Url, generated.publicKeyBase64Url, "the server stores the encoding it received");
  expectEqual(inspection?.fingerprint, generated.fingerprint, "both sides compute one fingerprint");
  expectEqual(inspection?.algorithm, "ES256", "the server keeps the declared algorithm");

  const p384 = await generateProofKeyPair("ES384");
  const p384Inspection = await inspectProofKey(p384.publicKeyBase64Url, "ES384");

  expectEqual(p384Inspection?.fingerprint, p384.fingerprint, "an ES384 key is accepted as ES384");
  expectEqual(await inspectProofKey(p384.publicKeyBase64Url, "ES256"), null, "a P-384 key is not an ES256 key");

  const ed = await generateProofKeyPair("EdDSA");
  const edInspection = await inspectProofKey(ed.publicKeyBase64Url, "EdDSA");

  expectEqual(edInspection?.fingerprint, ed.fingerprint, "an Ed25519 key is accepted as EdDSA");
  expectEqual(await inspectProofKey(ed.publicKeyBase64Url, "ES256"), null, "an Ed25519 key is not an ES256 key");

  expectEqual(await inspectProofKey("not-a-key-at-all-not-a-key-at-all-0000", "ES256"), null, "bytes that are not DER are refused");
  expectEqual(await inspectProofKey(`${generated.publicKeyBase64Url}==`, "ES256"), null, "a padded key is refused");
  expectEqual(await inspectProofKey(generated.publicKeyBase64Url.slice(0, 31), "ES256"), null, "a short string is refused");
  expectEqual(await inspectProofKey(generated.publicKeyBase64Url, "RS256"), null, "an algorithm outside the column is refused");
  expectEqual(await inspectProofKey(42, "ES256"), null, "a number is not a key");

  // ---- the row, the cap, the race
  const table = createDeviceKeyTable();
  const audit = createInMemoryAuditTrail();
  const dependencies = { rest: table.rest, audit, now: () => NOW, maximumDevices: 4 };
  const actor = { userId: USER_ID, companyId: FIRM_ID, sessionId: "session-1" };

  const enrolled = await enrolDeviceProofKey(
    { request: publicProofKeyOf({ ...generated }), userAgent: chromeAgent, remoteIp: "203.0.113.9" },
    actor,
    dependencies,
  );

  expectEqual(enrolled.status, "enrolled", "a first key is enrolled");
  expectEqual(table.rows.length, 1, "one row is written");
  expectEqual(enrolled.device.deviceId, table.rows[0]?.id, "the answer names the row");
  expectEqual(table.rows[0]?.trusted_at, null, "a new device is not trusted before STEP 052");
  expectEqual(table.rows[0]?.label, "Chrome on macOS", "the label comes from the user agent");
  expectEqual(table.rows[0]?.user_id, USER_ID, "the key belongs to the signed in account");
  expectEqual(table.rows[0]?.company_id, FIRM_ID, "the key carries the tenant of the account");
  expectEqual(table.rows[0]?.public_key, generated.publicKeyBase64Url, "the canonical key is stored");
  expectEqual(table.rows[0]?.fingerprint, generated.fingerprint, "the server computed the fingerprint");
  expectEqual(table.rows[0]?.algorithm, "ES256", "the algorithm is stored");
  expectEqual(audit.entries[0]?.action, "user.device_enrolled", "the enrolment is audited");
  expectEqual(audit.entries[0]?.entityType, "device_proof_key", "the entry names a device");
  expectEqual(audit.entries[0]?.entityId, enrolled.device.deviceId, "the entry names the row");
  expectEqual(audit.entries[0]?.payload["trusted"], false, "the entry records that trust is pending");
  expectEqual(audit.entries[0]?.payload["algorithm"], "ES256", "the entry records the algorithm");
  expect(
    JSON.stringify(audit.entries[0]?.payload).includes(generated.publicKeyBase64Url.slice(0, 32)) === false,
    "the audit entry carries no key material",
  );

  // ---- the same browser asking twice
  const again = await enrolDeviceProofKey(
    { request: publicProofKeyOf({ ...generated }), userAgent: chromeAgent, remoteIp: "203.0.113.9" },
    actor,
    dependencies,
  );

  expectEqual(again.status, "already_enrolled", "a second call for the same key is not a new device");
  expectEqual(table.rows.length, 1, "the second call writes no second row");
  expectEqual(table.updates.length, 1, "the second call moves the seen instant");
  expectEqual(table.updates[0]?.values["last_seen_at"], new Date(NOW).toISOString(), "the seen instant is now");
  expectEqual(audit.entries[1]?.action, "user.device_proof_refreshed", "the refresh is audited");

  // ---- another account holding the same fingerprint is not this account's business
  table.seed({ user_id: OTHER_USER_ID, fingerprint: otherPair.fingerprint });

  const neighbour = await enrolDeviceProofKey(
    { request: publicProofKeyOf({ ...otherPair }), userAgent: chromeAgent, remoteIp: null },
    actor,
    dependencies,
  );

  expectEqual(neighbour.status, "enrolled", "the same key under another account does not block this one");
  expectEqual(table.rows.length, 3, "the neighbour's row is untouched and this one is added");

  // ---- the cap
  const capped = createDeviceKeyTable();
  const cappedAudit = createInMemoryAuditTrail();
  const oneDevice = { rest: capped.rest, audit: cappedAudit, now: () => NOW, maximumDevices: 1 };

  await enrolDeviceProofKey(
    { request: publicProofKeyOf({ ...generated }), userAgent: chromeAgent, remoteIp: null },
    actor,
    oneDevice,
  );

  const thirdPair = await generateProofKeyPair();
  const capError = await captureRejection(
    () =>
      enrolDeviceProofKey(
        { request: publicProofKeyOf({ ...thirdPair }), userAgent: chromeAgent, remoteIp: null },
        actor,
        oneDevice,
      ),
    "a key past the device ceiling is refused",
  );

  expectEqual(capError.code, "CONFLICT", "the ceiling is a conflict, not a form problem");
  expectEqual(capped.rows.length, 1, "the refused key writes no row");
  expectEqual(cappedAudit.entries.length, 1, "the refused key writes no audit entry");

  // ---- the race the unique index decides
  const racing = createDeviceKeyTable({ blindSelects: 1 });

  racing.seed({ user_id: USER_ID, fingerprint: generated.fingerprint });

  const raced = await enrolDeviceProofKey(
    { request: publicProofKeyOf({ ...generated }), userAgent: chromeAgent, remoteIp: null },
    { ...actor, sessionId: null },
    { rest: racing.rest, audit: createInMemoryAuditTrail(), now: () => NOW, maximumDevices: 4 },
  );

  expectEqual(raced.status, "already_enrolled", "the loser of the race answers like a second call");
  expectEqual(racing.rows.length, 1, "the loser writes no second row");

  // ---- a revoked key may be replaced
  const revokedTable = createDeviceKeyTable();

  revokedTable.seed({
    user_id: USER_ID,
    fingerprint: generated.fingerprint,
    revoked_at: new Date(NOW - 1_000).toISOString(),
  });

  const replaced = await enrolDeviceProofKey(
    { request: publicProofKeyOf({ ...generated }), userAgent: chromeAgent, remoteIp: null },
    actor,
    { rest: revokedTable.rest, audit: createInMemoryAuditTrail(), now: () => NOW, maximumDevices: 4 },
  );

  expectEqual(replaced.status, "enrolled", "a revoked device frees its fingerprint again");
  expectEqual(revokedTable.rows.length, 2, "the revoked row stays as history");

  // ---- what a request may and may not contain
  const refused = await captureRejection(
    () =>
      enrolDeviceProofKey(
        { request: { algorithm: "ES256" }, userAgent: chromeAgent, remoteIp: null },
        actor,
        dependencies,
      ),
    "a body without a key is refused",
  );

  expectEqual(refused.code, "VALIDATION_FAILED", "a missing key is a form problem");
  expectEqual(refused.details[0]?.field, "publicKey", "the detail names the field");
  expectEqual(refused.details[0]?.rule, "invalid_key", "the detail names no value");

  const wrongCurve = await captureRejection(
    () =>
      enrolDeviceProofKey(
        {
          request: { publicKey: p384.publicKeyBase64Url, algorithm: "ES256" },
          userAgent: chromeAgent,
          remoteIp: null,
        },
        actor,
        dependencies,
      ),
    "a key whose curve contradicts its algorithm is refused",
  );

  expectEqual(wrongCurve.code, "VALIDATION_FAILED", "the curve mismatch is a form problem");

  expectEqual(
    deviceEnrolmentSchema.safeParse({
      publicKey: generated.publicKeyBase64Url,
      algorithm: "ES256",
      label: "x",
    }).success,
    false,
    "the form refuses a field the endpoint does not have",
  );
  expectEqual(
    deviceEnrolmentSchema.safeParse(publicProofKeyOf({ ...generated })).success,
    true,
    "the shape the browser sends is the shape the endpoint accepts",
  );

  // ---- the label, and the store's guard
  expectEqual(proofKeyLabel("  Chrome on macOS  "), "Chrome on macOS", "a label is trimmed");
  expectEqual(proofKeyLabel("x".repeat(200)).length, PROOF_KEY_LABEL_MAXIMUM_LENGTH, "a label is cut to the column");
  expectEqual(proofKeyLabel(`${"ab"}${" ".repeat(78)}cd`), "ab", "a cut that lands on spaces ends without one");
  expectEqual(proofKeyLabel("   "), "an unknown device", "an empty label still names a device");

  const stored = {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    publicKeyBase64Url: generated.publicKeyBase64Url,
    fingerprint: generated.fingerprint,
    algorithm: generated.algorithm,
    deviceId: null,
    trusted: false,
    createdAtEpochMs: NOW,
  };

  expectEqual(isStoredProofKey(stored), true, "the record this module writes is read back");
  expectEqual(isStoredProofKey({ ...stored, fingerprint: "short" }), false, "a record with a bad fingerprint is discarded");
  expectEqual(isStoredProofKey({ ...stored, algorithm: "RS256" }), false, "a record with an unknown algorithm is discarded");
  expectEqual(isStoredProofKey({ ...stored, privateKey: "not a key" }), false, "a record whose pair is not a pair is discarded");
  expectEqual(isStoredProofKey(null), false, "nothing is not a record");
}

/* ------------------------------------------------ request proof (050) */

interface ProofDeviceRow {
  readonly id: string;
  readonly user_id: string;
  readonly public_key: string;
  readonly algorithm: string;
  readonly trusted_at: string | null;
  readonly revoked_at: string | null;
  readonly deleted_at: string | null;
}

interface ProofNonceRow {
  readonly device_proof_key_id: string;
  readonly nonce: string;
  readonly method: string;
  readonly path: string;
  readonly signed_at: string;
  readonly expires_at: string;
}

interface ProofWorld {
  readonly devices: readonly ProofDeviceRow[];
  readonly nonces: readonly ProofNonceRow[];
  seedDevice(values: {
    readonly id: string;
    readonly user_id: string;
    readonly public_key: string;
    readonly algorithm?: string;
    readonly trusted_at?: string | null;
    readonly revoked_at?: string | null;
  }): void;
  readonly rest: RestClient;
}

/**
 * A fake pair of tables for the proof check: the enrolled keys `0009` holds and the spent nonces
 * `0088` holds, with the unique index that makes a replay a replay.
 */
function createProofWorld(): ProofWorld {
  const devices: ProofDeviceRow[] = [];
  const nonces: ProofNonceRow[] = [];

  return {
    devices,
    nonces,
    seedDevice(values) {
      devices.push({
        id: values.id,
        user_id: values.user_id,
        public_key: values.public_key,
        algorithm: values.algorithm ?? "ES256",
        trusted_at: values.trusted_at ?? null,
        revoked_at: values.revoked_at ?? null,
        deleted_at: null,
      });
    },
    rest: {
      select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
        if (table !== "device_proof_keys") {
          return Promise.resolve([]);
        }

        const id = /(?:^|[&?])id=eq\.([^&]+)/u.exec(query)?.[1] ?? null;
        const userId = /(?:^|[&?])user_id=eq\.([^&]+)/u.exec(query)?.[1] ?? null;
        const live = query.includes("revoked_at=is.null")
          ? devices.filter((row) => row.revoked_at === null && row.deleted_at === null)
          : devices;

        return Promise.resolve(
          live
            .filter((row) => id === null || row.id === decodeURIComponent(id))
            .filter((row) => userId === null || row.user_id === decodeURIComponent(userId))
            .slice(0, 1) as unknown as readonly TRow[],
        );
      },
      insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
        if (table !== "request_proof_nonces") {
          return Promise.resolve();
        }

        for (const row of rows) {
          const nonce: ProofNonceRow = {
            device_proof_key_id: String(row["device_proof_key_id"]),
            nonce: String(row["nonce"]),
            method: String(row["method"]),
            path: String(row["path"]),
            signed_at: String(row["signed_at"]),
            expires_at: String(row["expires_at"]),
          };

          if (
            nonces.some(
              (spent) =>
                spent.device_proof_key_id === nonce.device_proof_key_id && spent.nonce === nonce.nonce,
            )
          ) {
            throw new AppError("CONFLICT");
          }

          nonces.push(nonce);
        }

        return Promise.resolve();
      },
      insertReturning<TRow>(): Promise<readonly TRow[]> {
        return Promise.resolve([]);
      },
      update(): Promise<void> {
        return Promise.resolve();
      },
      rpc(): Promise<unknown> {
        return Promise.resolve(null);
      },
    },
  };
}

/** One signed request, assembled the way a browser assembles it. */
interface SignedCall {
  readonly request: Request;
  readonly nonce: string;
  readonly timestamp: string;
}

interface SignCallOptions {
  readonly path: string;
  readonly body: string;
  readonly deviceKeyId: string;
  readonly privateKey: CryptoKey;
  readonly algorithm?: ProofKeyAlgorithm;
  /** The message that is signed, when it must differ from the request that is sent. */
  readonly signedPath?: string;
  readonly signedBody?: string;
  readonly signedMethod?: string;
  readonly signedTimestamp?: string;
  readonly method?: string;
  readonly timestamp?: number;
  readonly nonce?: string;
  readonly signatureOverride?: string;
  readonly omit?: readonly string[];
  readonly search?: string;
}

/**
 * Build one signed request, exactly as `deviceProofHeaders()` builds one.
 *
 * The `signed*` fields exist so a check can prove that a message signed over something else is
 * refused: a signature that only ever covers what it should is a signature nobody has tested.
 */
async function signedCall(options: SignCallOptions): Promise<SignedCall> {
  const timestamp = String(options.timestamp ?? NOW);
  const nonce = options.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const algorithm = options.algorithm ?? "ES256";
  const message = requestProofMessage({
    method: options.signedMethod ?? options.method ?? "POST",
    path: options.signedPath ?? options.path,
    bodyDigest: await requestBodyDigest(options.signedBody ?? options.body),
    timestamp: options.signedTimestamp ?? timestamp,
    nonce,
    deviceKeyId: options.deviceKeyId,
  });
  const signature =
    options.signatureOverride ??
    (await signProofMessage(options.privateKey, algorithm, message));
  const omitted = options.omit ?? [];
  const headers: Record<string, string> = { "content-type": "application/json" };

  for (const [name, value] of [
    [REQUEST_PROOF_HEADERS.deviceKey, options.deviceKeyId],
    [REQUEST_PROOF_HEADERS.timestamp, timestamp],
    [REQUEST_PROOF_HEADERS.nonce, nonce],
    [REQUEST_PROOF_HEADERS.signature, signature],
  ] as const) {
    if (!omitted.includes(name)) {
      headers[name] = value;
    }
  }

  return {
    nonce,
    timestamp,
    request: new Request(`https://platform.test${options.path}${options.search ?? ""}`, {
      method: options.method ?? "POST",
      headers,
      body: options.body,
    }),
  };
}

/**
 * The signature check on the endpoints where a cookie is not enough.
 *
 * Every value here is produced by the module the browser loads - a real non-extractable key, a real
 * signature over the real canonical message - and checked by the module the server runs. The fake
 * tables enforce the one rule that matters in the database: `0088`'s unique index on
 * `(device, nonce)`, which is what turns a replay into a conflict.
 */
async function checkRequestProof(): Promise<void> {
  // ---- the message layout
  const parts = {
    method: "post",
    path: "/api/office/account-locks/unlock",
    bodyDigest: "-",
    timestamp: "1800000000000",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    deviceKeyId: "device-050",
  };
  const message = requestProofMessage(parts);
  const lines = message.split("\n");

  expectEqual(lines.length, 7, "the message is seven lines");
  expectEqual(lines[0], REQUEST_PROOF_VERSION, "the first line is the version");
  expectEqual(lines[1], "POST", "the method is upper cased in the message");
  expectEqual(lines[2], parts.path, "the third line is the path");
  expectEqual(lines[3], "-", "an empty body is a dash");
  expectEqual(lines[4], parts.timestamp, "the fifth line is the timestamp");
  expectEqual(lines[5], parts.nonce, "the sixth line is the nonce");
  expectEqual(lines[6], parts.deviceKeyId, "the last line is the device");
  expectEqual(
    requestProofMessage({ ...parts, timestamp: "1800000000001" }) !== message,
    true,
    "a different timestamp is a different message",
  );
  expectEqual(
    requestProofMessage({ ...parts, path: `${parts.path}x` }) !== message,
    true,
    "a different path is a different message",
  );
  expectEqual(
    requestProofMessage({ ...parts, bodyDigest: "x" }) !== message,
    true,
    "a different body is a different message",
  );

  // ---- the digest
  expectEqual(await requestBodyDigest(""), "-", "an empty body has no digest");
  expectEqual(
    await sha256Base64Url(new TextEncoder().encode("")),
    "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    "the empty string hashes to the known SHA-256",
  );
  expectEqual(
    (await requestBodyDigest("{}")).length,
    43,
    "a body digest is a base64url SHA-256",
  );
  expect(
    (await requestBodyDigest("{}")) !== (await requestBodyDigest('{"a":1}')),
    "two bodies have two digests",
  );

  // ---- signing and verifying, for all three algorithms
  for (const algorithm of ["ES256", "ES384", "EdDSA"] as const) {
    const pair = await generateProofKeyPair(algorithm);
    const signature = await signProofMessage(pair.privateKey, algorithm, message);

    expect(signature.length > 60, `an ${algorithm} signature is a base64url string`);

    const verified = await verifyProofMessage({
      publicKeyBase64Url: pair.publicKeyBase64Url,
      algorithm,
      message,
      signatureBase64Url: signature,
    });

    expect(verified, `an ${algorithm} signature verifies with its own key`);
    expect(
      await verifyProofMessage({
        publicKeyBase64Url: pair.publicKeyBase64Url,
        algorithm,
        message: `${message}x`,
        signatureBase64Url: signature,
      }) === false,
      `an ${algorithm} signature does not verify over a different message`,
    );

    const other = await generateProofKeyPair(algorithm);

    expect(
      await verifyProofMessage({
        publicKeyBase64Url: other.publicKeyBase64Url,
        algorithm,
        message,
        signatureBase64Url: signature,
      }) === false,
      `an ${algorithm} signature does not verify with another key`,
    );
  }

  const pair = await generateProofKeyPair();
  const goodSignature = await signProofMessage(pair.privateKey, "ES256", message);

  expect(
    await verifyProofMessage({
      publicKeyBase64Url: pair.publicKeyBase64Url,
      algorithm: "ES256",
      message,
      signatureBase64Url: `${goodSignature.slice(0, -4)}AAAA`,
    }) === false,
    "a tampered signature does not verify",
  );
  expect(
    await verifyProofMessage({
      publicKeyBase64Url: "not-a-key",
      algorithm: "ES256",
      message,
      signatureBase64Url: goodSignature,
    }) === false,
    "a key that is not a key does not verify",
  );
  expect(
    await verifyProofMessage({
      publicKeyBase64Url: pair.publicKeyBase64Url,
      algorithm: "ES256",
      message,
      signatureBase64Url: "AAAA",
    }) === false,
    "a signature of the wrong length does not verify",
  );

  // ---- the check, against the tables it reads
  const world = createProofWorld();
  const audit = createInMemoryAuditTrail();
  const dependencies = { rest: world.rest, audit, now: () => NOW };
  const actor = {
    userId: USER_ID,
    companyId: FIRM_ID,
    roles: ["owner"] as const,
    sessionId: "session-050",
    assuranceLevel: "aal2" as const,
    authenticatedAtEpochMs: NOW - 60_000,
    expiresAtEpochMs: NOW + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: "device-050",
    sessionFamilyId: "family-050",
    mfaVerifiedAtEpochMs: NOW - 60_000,
    reauthenticatedAtEpochMs: null,
  };
  const path = "/api/office/account-locks/unlock";
  const body = '{"lockId":"018f3b1c-6666-7c2a-9d1e-2b3c4d5e6f75","note":"called the owner"}';

  world.seedDevice({
    id: "device-050",
    user_id: USER_ID,
    public_key: pair.publicKeyBase64Url,
  });

  const call = await signedCall({
    path,
    body,
    deviceKeyId: "device-050",
    privateKey: pair.privateKey,
  });
  const outcome = await verifySensitiveRequest(
    { request: call.request, bodyText: body, actor },
    dependencies,
  );

  expectEqual(outcome.deviceKeyId, "device-050", "a correct proof names the device");
  expectEqual(outcome.algorithm, "ES256", "the outcome reports the algorithm of the row");
  expectEqual(outcome.trusted, false, "an unconfirmed device is reported as untrusted");
  expectEqual(outcome.signedAtEpochMs, NOW, "the outcome reports the signed instant");
  expectEqual(outcome.nonce, call.nonce, "the outcome reports the nonce it spent");
  expectEqual(world.nonces.length, 1, "one proof spends one nonce");
  expectEqual(world.nonces[0]?.nonce, call.nonce, "the row stores the nonce");
  expectEqual(world.nonces[0]?.path, path, "the row stores the path");
  expectEqual(world.nonces[0]?.method, "POST", "the row stores the method");
  expectEqual(
    world.nonces[0]?.expires_at,
    new Date(NOW + 120_000).toISOString(),
    "the row expires one window after the signed instant",
  );
  expectEqual(audit.entries.length, 0, "a verified proof writes no audit entry of its own");

  // ---- replay
  const replay = await captureRejection(
    () => verifySensitiveRequest({ request: call.request, bodyText: body, actor }, dependencies),
    "a replayed request is refused",
  );

  expectEqual(replay.code, "AUTHENTICATION_REQUIRED", "a replay answers the shared refusal");
  expectEqual(replay.details.length, 0, "a replay names no detail");
  expectEqual(world.nonces.length, 1, "a replay spends nothing twice");
  expectEqual(
    audit.entries.at(-1)?.action,
    "user.request_proof_rejected",
    "a replay is audited as a rejected proof",
  );
  expectEqual(audit.entries.at(-1)?.payload["reason"], "replayed", "the entry names the reason");
  expect(
    JSON.stringify(audit.entries.at(-1)?.payload ?? null).includes(call.nonce) === false,
    "the entry does not quote the nonce",
  );

  // ---- the window, on both sides
  const boundary = await signedCall({
    path,
    body,
    deviceKeyId: "device-050",
    privateKey: pair.privateKey,
    timestamp: NOW - REQUEST_PROOF_WINDOW_MS,
  });

  const boundaryOutcome = await verifySensitiveRequest(
    { request: boundary.request, bodyText: body, actor },
    dependencies,
  );

  expectEqual(
    boundaryOutcome.signedAtEpochMs,
    NOW - REQUEST_PROOF_WINDOW_MS,
    "a request exactly one window old is still accepted",
  );

  for (const offset of [-REQUEST_PROOF_WINDOW_MS - 1, REQUEST_PROOF_WINDOW_MS + 1]) {
    const stale = await signedCall({
      path,
      body,
      deviceKeyId: "device-050",
      privateKey: pair.privateKey,
      timestamp: NOW + offset,
    });
    const refusal = await captureRejection(
      () => verifySensitiveRequest({ request: stale.request, bodyText: body, actor }, dependencies),
      `a request ${String(offset)} milliseconds from now is refused`,
    );

    expectEqual(refusal.code, "AUTHENTICATION_REQUIRED", "a request outside the window is refused");
    expectEqual(
      audit.entries.at(-1)?.payload["reason"],
      "stale-timestamp",
      "the entry names the clock as the reason",
    );
  }

  // ---- the device the proof names
  const unknownDevice = await signedCall({
    path,
    body,
    deviceKeyId: "device-unknown",
    privateKey: pair.privateKey,
  });
  const unknownRefusal = await captureRejection(
    () => verifySensitiveRequest({ request: unknownDevice.request, bodyText: body, actor }, dependencies),
    "a device this account does not hold is refused",
  );

  expectEqual(unknownRefusal.code, "AUTHENTICATION_REQUIRED", "an unknown device is refused");
  expectEqual(
    audit.entries.at(-1)?.payload["reason"],
    "unknown-device",
    "the entry names the unknown device",
  );

  world.seedDevice({
    id: "device-neighbour",
    user_id: OTHER_USER_ID,
    public_key: pair.publicKeyBase64Url,
  });

  const neighbour = await signedCall({
    path,
    body,
    deviceKeyId: "device-neighbour",
    privateKey: pair.privateKey,
  });

  await captureRejection(
    () => verifySensitiveRequest({ request: neighbour.request, bodyText: body, actor }, dependencies),
    "another account's device is refused",
  );
  expectEqual(
    audit.entries.at(-1)?.payload["reason"],
    "unknown-device",
    "another account's device is unknown to this actor",
  );

  world.seedDevice({
    id: "device-revoked",
    user_id: USER_ID,
    public_key: pair.publicKeyBase64Url,
    revoked_at: new Date(NOW - 1_000).toISOString(),
  });

  const revokedCall = await signedCall({
    path,
    body,
    deviceKeyId: "device-revoked",
    privateKey: pair.privateKey,
  });

  await captureRejection(
    () => verifySensitiveRequest({ request: revokedCall.request, bodyText: body, actor }, dependencies),
    "a revoked device is refused",
  );
  expectEqual(audit.entries.at(-1)?.payload["reason"], "unknown-device", "a revoked device is not live");

  world.seedDevice({
    id: "device-trusted",
    user_id: USER_ID,
    public_key: pair.publicKeyBase64Url,
    trusted_at: new Date(NOW - 500_000).toISOString(),
  });

  const trustedCall = await signedCall({
    path,
    body,
    deviceKeyId: "device-trusted",
    privateKey: pair.privateKey,
  });
  const trusted = await verifySensitiveRequest(
    {
      request: trustedCall.request,
      bodyText: body,
      actor: { ...actor, deviceProofKeyId: "device-trusted" },
    },
    dependencies,
  );

  expectEqual(trusted.trusted, true, "a confirmed device is reported as trusted");

  // ---- the session's own binding (STEP 051)
  world.seedDevice({
    id: "device-sibling",
    user_id: USER_ID,
    public_key: pair.publicKeyBase64Url,
  });

  const siblingCall = await signedCall({
    path,
    body,
    deviceKeyId: "device-sibling",
    privateKey: pair.privateKey,
  });
  const sibling = await captureRejection(
    () => verifySensitiveRequest({ request: siblingCall.request, bodyText: body, actor }, dependencies),
    "a sibling device of the same account cannot sign for this session",
  );

  expectEqual(sibling.code, "AUTHENTICATION_REQUIRED", "the sibling refusal is the shared one");
  expectEqual(
    audit.entries.at(-1)?.payload["reason"],
    "session-device-mismatch",
    "the entry names the session binding",
  );

  // ---- the message a request actually signs
  const tamperedCases: readonly (readonly [string, Partial<SignCallOptions>, string])[] = [
    ["a body that was altered after signing", { signedBody: '{"lockId":"other"}' }, "signature"],
    ["a path the caller did not sign", { signedPath: "/api/auth/2fa/backup-codes" }, "signature"],
    ["a message signed over a different method", { signedMethod: "DELETE" }, "signature"],
    ["a request whose method is not the registered one", { method: "PUT" }, "method-mismatch"],
    ["a timestamp the caller did not sign", { signedTimestamp: String(NOW - 1_000) }, "signature"],
  ];

  for (const [description, overrides, reason] of tamperedCases) {
    const attempt = await signedCall({
      path,
      body,
      deviceKeyId: "device-050",
      privateKey: pair.privateKey,
      ...overrides,
    });
    await captureRejection(
      () => verifySensitiveRequest({ request: attempt.request, bodyText: body, actor }, dependencies),
      `${description} is refused`,
    );

    expectEqual(
      audit.entries.at(-1)?.payload["reason"],
      reason,
      `${description} is refused as ${reason}`,
    );
  }

  const foreignSignature = await generateProofKeyPair();
  const forged = await signedCall({
    path,
    body,
    deviceKeyId: "device-050",
    privateKey: foreignSignature.privateKey,
  });

  await captureRejection(
    () => verifySensitiveRequest({ request: forged.request, bodyText: body, actor }, dependencies),
    "a signature from another key is refused",
  );
  expectEqual(audit.entries.at(-1)?.payload["reason"], "signature", "the entry names the signature");

  // ---- the request the proof does not cover
  const withQuery = await signedCall({
    path,
    body,
    deviceKeyId: "device-050",
    privateKey: pair.privateKey,
    search: "?lockId=1",
  });

  await captureRejection(
    () => verifySensitiveRequest({ request: withQuery.request, bodyText: body, actor }, dependencies),
    "a request with a query string is refused",
  );
  expectEqual(
    audit.entries.at(-1)?.payload["reason"],
    "query-not-signed",
    "the entry names the unsigned query",
  );

  const unlistedPath = await signedCall({
    path: "/api/office/2fa-reset-requests",
    body,
    deviceKeyId: "device-050",
    privateKey: pair.privateKey,
  });

  await captureRejection(
    () => verifySensitiveRequest({ request: unlistedPath.request, bodyText: body, actor }, dependencies),
    "a path outside the registry is refused",
  );
  expectEqual(
    audit.entries.at(-1)?.payload["reason"],
    "path-not-sensitive",
    "the entry names the path",
  );

  // ---- the headers
  for (const header of [
    REQUEST_PROOF_HEADERS.deviceKey,
    REQUEST_PROOF_HEADERS.timestamp,
    REQUEST_PROOF_HEADERS.nonce,
    REQUEST_PROOF_HEADERS.signature,
  ]) {
    const missing = await signedCall({
      path,
      body,
      deviceKeyId: "device-050",
      privateKey: pair.privateKey,
      omit: [header],
    });

    await captureRejection(
      () =>
        verifySensitiveRequest({ request: missing.request, bodyText: body, actor }, dependencies),
      `a request without ${header} is refused`,
    );

    expectEqual(
      audit.entries.at(-1)?.payload["reason"],
      "missing-header",
      `the entry names the missing ${header}`,
    );
  }

  const malformed = new Request(`https://platform.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [REQUEST_PROOF_HEADERS.deviceKey]: "x",
      [REQUEST_PROOF_HEADERS.timestamp]: "now",
      [REQUEST_PROOF_HEADERS.nonce]: "short",
      [REQUEST_PROOF_HEADERS.signature]: "AAAA",
    },
    body,
  });

  await captureRejection(
    () => verifySensitiveRequest({ request: malformed, bodyText: body, actor }, dependencies),
    "a header of the wrong shape is refused",
  );
  expectEqual(
    audit.entries.at(-1)?.payload["reason"],
    "malformed-header",
    "the entry names the shape",
  );

  // ---- the registry, against the routes on disk
  const paths = SENSITIVE_ENDPOINTS.map((endpoint) => endpoint.path);

  expectEqual(new Set(paths).size, paths.length, "no endpoint is listed twice");

  for (const endpoint of SENSITIVE_ENDPOINTS) {
    expect(endpoint.note.length > 20, `${endpoint.path} says why it is on the list`);
    expectEqual(isSensitivePath(endpoint.path), true, `${endpoint.path} is recognised as sensitive`);

    const source = await readFile(new URL(`../../app${endpoint.path}/route.ts`, import.meta.url), "utf8");

    expect(
      source.includes("verifySensitiveRequest("),
      `${endpoint.path} calls the proof check`,
    );
    expect(
      source.includes('request.text()'),
      `${endpoint.path} hands the raw body to the check`,
    );
    expect(
      source.indexOf("verifySensitiveRequest(") < source.indexOf("JSON.parse("),
      `${endpoint.path} verifies the proof before it parses the body`,
    );
  }

  expectEqual(isSensitivePath("/api/auth/devices"), false, "an ordinary route is not sensitive");

  // ---- the request the browser builds is the request this module rebuilds
  const browserCall = await signedCall({
    path,
    body,
    deviceKeyId: "device-050",
    privateKey: pair.privateKey,
    nonce: "BBBBBBBBBBBBBBBBBBBBBB",
    timestamp: NOW + 1_000,
  });

  expectEqual(browserCall.timestamp, String(NOW + 1_000), "the browser signs its own instant");
  expectEqual(browserCall.request.headers.get(REQUEST_PROOF_HEADERS.nonce), "BBBBBBBBBBBBBBBBBBBBBB", "the nonce travels in its own header");
}

/**
 * An in-memory `public.sessions`.
 *
 * The two constraints the rotation decides on are here in full, because a double that accepted
 * everything would prove nothing: a token hash is unique, and one row can have at most one child
 * (`sessions_rotation_key`). The two hooks exist to reach a race that a single threaded gate cannot
 * otherwise produce: `ignoreNextUpdate` loses a compare and swap, and nothing else does.
 */
interface SessionTableRow {
  id: string;
  user_id: string;
  company_id: string | null;
  device_proof_key_id: string;
  token_hash: string;
  family_id: string;
  rotated_from_session_id: string | null;
  issued_at: number;
  expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
  revocation_reason: string | null;
  replay_detected_at: number | null;
  mfa_verified_at: number | null;
  reauthenticated_at: number | null;
  deleted_at: number | null;
}

interface SessionTable extends SessionTokenStore {
  readonly rows: SessionTableRow[];
  ignoreNextUpdate: boolean;
  familyCount(): number;
}

function createSessionTable(): SessionTable {
  const rows: SessionTableRow[] = [];
  let sequence = 0;

  function nextId(): string {
    sequence += 1;

    return `session-${String(sequence).padStart(4, "0")}`;
  }

  function matches(row: SessionTableRow, query: string): boolean {
    for (const clause of query.split("&")) {
      const [field, value] = clause.split("=");

      if (field === undefined || value === undefined) {
        continue;
      }

      if (field === "revoked_at") {
        if (value === "is.null" && row.revoked_at !== null) {
          return false;
        }
      }

      if (field === "revocation_reason") {
        const expected = value.replace("eq.", "");

        if (row.revocation_reason !== expected) {
          return false;
        }
      }
    }

    return true;
  }

  function visible(row: SessionTableRow): boolean {
    return row.deleted_at === null;
  }

  function toRow(row: SessionTableRow): SessionRow {
    return {
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      deviceProofKeyId: row.device_proof_key_id,
      familyId: row.family_id,
      rotatedFromSessionId: row.rotated_from_session_id,
      issuedAtEpochMs: row.issued_at,
      expiresAtEpochMs: row.expires_at,
      absoluteExpiresAtEpochMs: row.absolute_expires_at,
      revokedAtEpochMs: row.revoked_at,
      revocationReason: row.revocation_reason,
      replayDetectedAtEpochMs: row.replay_detected_at,
      mfaVerifiedAtEpochMs: row.mfa_verified_at,
      reauthenticatedAtEpochMs: row.reauthenticated_at,
    };
  }

  const table: SessionTable = {
    rows,
    ignoreNextUpdate: false,
    familyCount(): number {
      return new Set(rows.map((row) => row.family_id)).size;
    },

    findByHash(tokenHash: string): Promise<SessionRow | null> {
      const found = rows.find((row) => row.token_hash === tokenHash && visible(row));

      return Promise.resolve(found === undefined ? null : toRow(found));
    },

    findLiveInFamily(familyId: string): Promise<SessionRow | null> {
      const found = rows.find(
        (row) => row.family_id === familyId && row.revoked_at === null && visible(row),
      );

      return Promise.resolve(found === undefined ? null : toRow(found));
    },

    insert(row: NewSessionRow): Promise<SessionRow> {
      if (rows.some((existing) => existing.token_hash === row.tokenHash)) {
        throw new AppError("CONFLICT");
      }

      if (
        row.rotatedFromSessionId !== undefined &&
        row.rotatedFromSessionId !== null &&
        rows.some((existing) => existing.rotated_from_session_id === row.rotatedFromSessionId)
      ) {
        throw new AppError("CONFLICT");
      }

      const created: SessionTableRow = {
        id: nextId(),
        user_id: row.userId,
        company_id: row.companyId,
        device_proof_key_id: row.deviceProofKeyId,
        token_hash: row.tokenHash,
        family_id: row.familyId ?? `family-${String(sequence).padStart(4, "0")}`,
        rotated_from_session_id: row.rotatedFromSessionId ?? null,
        issued_at: row.issuedAtEpochMs,
        expires_at: row.expiresAtEpochMs,
        absolute_expires_at: row.absoluteExpiresAtEpochMs,
        revoked_at: null,
        revocation_reason: null,
        replay_detected_at: null,
        mfa_verified_at: row.mfaVerifiedAtEpochMs,
        reauthenticated_at: row.reauthenticatedAtEpochMs,
        deleted_at: null,
      };
      rows.push(created);

      return Promise.resolve(toRow(created));
    },

    update(sessionId: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      if (table.ignoreNextUpdate) {
        table.ignoreNextUpdate = false;

        return Promise.resolve();
      }

      for (const row of rows) {
        if (row.id !== sessionId || !visible(row) || !matches(row, query)) {
          continue;
        }

        if (typeof values["revoked_at"] === "string") {
          row.revoked_at = Date.parse(values["revoked_at"]);
        }

        if (typeof values["revocation_reason"] === "string") {
          row.revocation_reason = values["revocation_reason"];
        }

        if (typeof values["replay_detected_at"] === "string") {
          row.replay_detected_at = Date.parse(values["replay_detected_at"]);
        }
      }

      return Promise.resolve();
    },

    revokeFamily(familyId: string, values: Readonly<Record<string, unknown>>): Promise<number> {
      const live = rows.filter((row) => row.family_id === familyId && row.revoked_at === null);

      for (const row of live) {
        row.revoked_at = Date.parse(String(values["revoked_at"]));
        row.revocation_reason = String(values["revocation_reason"]);
      }

      return Promise.resolve(live.length);
    },

    revokeDevice(
      deviceProofKeyId: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<number> {
      const live = rows.filter(
        (row) => row.device_proof_key_id === deviceProofKeyId && row.revoked_at === null,
      );

      for (const row of live) {
        row.revoked_at = Date.parse(String(values["revoked_at"]));
        row.revocation_reason = String(values["revocation_reason"]);
      }

      return Promise.resolve(live.length);
    },
  };

  return table;
}

async function checkSessionRotation(): Promise<void> {
  // ---- the token itself
  const minted = createRawSessionToken();

  expectEqual(minted.length, 43, "a session token is 43 base64url characters");
  expect(SESSION_TOKEN_PATTERN.test(minted), "a minted token matches the pattern 0010 accepts");
  expect(createRawSessionToken() !== minted, "two tokens are never the same");
  expectEqual(hashSessionToken(minted).length, 43, "the hash is 43 characters too");
  expect(hashSessionToken(minted) !== minted, "the hash is not the token");
  expectEqual(hashSessionToken(minted), hashSessionToken(minted), "the hash is deterministic");
  const changedToken = `${minted.slice(0, 42)}${minted.endsWith("A") ? "B" : "A"}`;

  expect(hashSessionToken(changedToken) !== hashSessionToken(minted), "a changed token hashes differently");
  expect(isSessionToken(minted), "a minted token is a session token");
  expect(!isSessionToken("short"), "a short string is not a session token");
  expect(!isSessionToken(`${minted}=`), "a padded string is not a session token");
  expect(!isSessionToken(`${minted}A`), "a 44 character string is not a session token");
  expect(!isSessionToken(42), "a number is not a session token");

  // ---- the first binding
  const table = createSessionTable();
  const audit = createInMemoryAuditTrail();
  const dependencies = { sessions: table, audit, now: () => NOW };

  const bound = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal2",
      ipAddress: "203.0.113.9",
      userAgent: chromeAgent,
      claimSessionId: SESSION_ID,
    },
    dependencies,
  );

  expectEqual(bound.kind, "bound", "a cookie without a session token starts a family");
  expectEqual(table.rows.length, 1, "binding writes one row");
  expectEqual(table.rows[0]?.user_id, USER_ID, "the row belongs to the account");
  expectEqual(table.rows[0]?.device_proof_key_id, "device-051", "the row is bound to the device");
  expectEqual(table.rows[0]?.token_hash, hashSessionToken((bound as { token: string }).token), "the row holds the hash, never the token");
  expect(table.rows[0]?.token_hash !== (bound as { token: string }).token, "the row does not hold the token");
  expectEqual(table.rows[0]?.issued_at, NOW, "the row starts now");
  expectEqual(table.rows[0]?.expires_at, NOW + SESSION_ROTATION_WINDOW_MS, "one rotation lives one window");
  expectEqual(table.rows[0]?.absolute_expires_at, NOW + SESSION_ABSOLUTE_WINDOW_MS, "the family gets a ceiling");
  expectEqual(table.rows[0]?.mfa_verified_at, NOW, "an aal2 cookie records when the second factor was proven");
  expectEqual(audit.entries.at(-1)?.action, "session.bound", "binding is audited");
  expectEqual(audit.entries.at(-1)?.payload["device_proof_key_id"], "device-051", "the entry names the device");
  expect(
    JSON.stringify(audit.entries.at(-1)?.payload).includes((bound as { token: string }).token) === false,
    "the audit entry never quotes the token",
  );

  const firstToken = (bound as { token: string }).token;
  const live = await resolveSessionToken({ token: firstToken, userId: USER_ID }, dependencies);

  expectEqual(live.kind, "live", "a fresh token resolves to its row");

  if (live.kind === "live") {
    expectEqual(live.row.deviceProofKeyId, "device-051", "the resolved row carries the device");
    expectEqual(live.row.companyId, FIRM_ID, "the resolved row carries the tenant");
  }

  // ---- an aal1 binding records no second factor
  const aal1Table = createSessionTable();
  const aal1 = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: aal1Table, audit: createInMemoryAuditTrail(), now: () => NOW },
  );

  expectEqual(aal1Table.rows[0]?.mfa_verified_at, null, "an aal1 binding records no second factor");
  expectEqual(aal1.kind, "bound", "the aal1 binding still binds");

  // ---- the second binding is a second family
  const secondFamily = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    dependencies,
  );

  expectEqual(table.familyCount(), 2, "a second binding starts a second family");
  expect(
    (secondFamily as { familyId: string }).familyId !== (bound as { familyId: string }).familyId,
    "the two families are distinct",
  );

  // ---- what a token can resolve to
  const unknown = await resolveSessionToken({ token: createRawSessionToken(), userId: USER_ID }, dependencies);

  expectEqual(unknown.kind, "unknown", "a token no row carries resolves to nothing");

  const neighbour = await resolveSessionToken({ token: firstToken, userId: OTHER_USER_ID }, dependencies);

  expectEqual(neighbour.kind, "unknown", "a token of one account does not authenticate another");

  const malformed = await resolveSessionToken({ token: "not-a-token", userId: USER_ID }, dependencies);

  expectEqual(malformed.kind, "unknown", "a string that is not a token is refused before any query");

  // ---- the interval: a young session is answered, not rotated
  const young = await issueSessionToken(
    {
      presentedToken: firstToken,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal2",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    dependencies,
  );

  expectEqual(young.kind, "current", "a session younger than the interval is not rotated");
  expectEqual(table.rows.length, 2, "and nothing is written");

  // ---- the rotation
  const later = NOW + SESSION_ROTATION_INTERVAL_MS;
  const rotationDependencies = { sessions: table, audit, now: () => later };
  const rotated = await issueSessionToken(
    {
      presentedToken: firstToken,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal2",
      ipAddress: "203.0.113.9",
      userAgent: chromeAgent,
      claimSessionId: null,
    },
    rotationDependencies,
  );

  expectEqual(rotated.kind, "rotated", "a session past the interval rotates");
  expectEqual(table.rows.length, 3, "a rotation writes one child");
  expectEqual(table.rows[0]?.revocation_reason, "ROTATED", "the replaced row is revoked as a rotation");
  expectEqual(table.rows[0]?.revoked_at, later, "the revocation is stamped with the rotation instant");

  const child = table.rows[2];

  expectEqual(child?.rotated_from_session_id, "session-0001", "the child names its parent");
  expectEqual(child?.family_id, "family-0001", "the child copies the family");
  expectEqual(child?.absolute_expires_at, NOW + SESSION_ABSOLUTE_WINDOW_MS, "the child copies the ceiling");
  expectEqual(child?.expires_at, later + SESSION_ROTATION_WINDOW_MS, "the child gets a fresh window");
  expectEqual(child?.mfa_verified_at, NOW, "the child keeps the instant the second factor was proven");
  expectEqual(audit.entries.at(-1)?.action, "session.rotated", "the rotation is audited");
  expectEqual(audit.entries.at(-1)?.payload["previous_session_id"], "session-0001", "the entry names the parent");

  const rotatedToken = (rotated as { token: string }).token;

  expect(rotatedToken !== firstToken, "a rotation mints a new token");
  expectEqual(
    (await resolveSessionToken({ token: rotatedToken, userId: USER_ID }, rotationDependencies)).kind,
    "live",
    "the new token is the live one",
  );

  // ---- the grace window
  const insideGrace = await resolveSessionToken(
    { token: firstToken, userId: USER_ID },
    { sessions: table, audit, now: () => later + SESSION_ROTATION_GRACE_MS },
  );

  expectEqual(insideGrace.kind, "grace", "a spent token is honoured inside the grace window");

  const afterGrace = await resolveSessionToken(
    { token: firstToken, userId: USER_ID },
    { sessions: table, audit, now: () => later + SESSION_ROTATION_GRACE_MS + 1 },
  );

  expectEqual(afterGrace.kind, "replayed", "the same token past the grace window is a replay");
  expectEqual(table.rows[0]?.revocation_reason, "REPLAY_DETECTED", "the replayed row is marked as a replay");
  expectEqual(table.rows[0]?.replay_detected_at, later + SESSION_ROTATION_GRACE_MS + 1, "the replay instant is recorded");
  expectEqual(child?.revocation_reason, "FAMILY_REVOKED", "the whole family is revoked");
  expectEqual(
    audit.entries.filter((entry) => entry.action === "session.family_revoked").length,
    1,
    "the family revocation is audited once",
  );
  expectEqual(
    audit.entries.at(-1)?.payload["revoked_sessions"],
    1,
    "the entry counts the live rows it ended",
  );

  const endedHead = await resolveSessionToken(
    { token: rotatedToken, userId: USER_ID },
    { sessions: table, audit, now: () => later + SESSION_ROTATION_GRACE_MS + 2 },
  );

  expectEqual(endedHead.kind, "revoked", "the rest of a revoked family stops working");

  // ---- a replay presented to the issuing service is the same answer
  const replayAttempt = await issueSessionToken(
    {
      presentedToken: firstToken,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal2",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: table, audit, now: () => later + SESSION_ROTATION_GRACE_MS + 3 },
  );

  expectEqual(replayAttempt.kind, "refused", "a replay cannot be rotated into a new session");

  // ---- expiry, on both clocks
  const expiryTable = createSessionTable();
  const expiring = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: expiryTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );
  const expiringToken = (expiring as { token: string }).token;

  expectEqual(
    (await resolveSessionToken({ token: expiringToken, userId: USER_ID }, {
      sessions: expiryTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + SESSION_ROTATION_WINDOW_MS,
    })).kind,
    "expired",
    "a row resolves as expired at its own expiry",
  );

  const ceilingTable = createSessionTable();
  const ceiling = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: ceilingTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );

  const ceilingRow = ceilingTable.rows[0];

  if (ceilingRow === undefined) {
    throw new Error("the ceiling check needs the row it just wrote");
  }

  ceilingRow.expires_at = NOW + SESSION_ABSOLUTE_WINDOW_MS + 1;

  expectEqual(
    (await resolveSessionToken({ token: (ceiling as { token: string }).token, userId: USER_ID }, {
      sessions: ceilingTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + SESSION_ABSOLUTE_WINDOW_MS,
    })).kind,
    "expired",
    "the family's ceiling ends a session even if its own expiry is later",
  );

  // ---- a rotation cannot reach past the ceiling
  const ceilingRotationTable = createSessionTable();
  const shortFamily = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    {
      sessions: ceilingRotationTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW,
      absoluteWindowMs: 20 * 60_000,
    },
  );

  const atCeiling = await issueSessionToken(
    {
      presentedToken: (shortFamily as { token: string }).token,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    {
      sessions: ceilingRotationTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + SESSION_ROTATION_INTERVAL_MS,
      absoluteWindowMs: 20 * 60_000,
    },
  );

  expectEqual(atCeiling.kind, "rotated", "a short family still rotates inside its ceiling");
  expectEqual(
    ceilingRotationTable.rows[1]?.expires_at,
    NOW + 20 * 60_000,
    "the rotation stops at the ceiling instead of extending it",
  );
  expectEqual(
    ceilingRotationTable.rows[1]?.absolute_expires_at,
    NOW + 20 * 60_000,
    "the child copies the ceiling it cannot pass",
  );

  const ceilingToken = (atCeiling as { token: string }).token;
  const pastCeiling = await issueSessionToken(
    {
      presentedToken: ceilingToken,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    {
      sessions: ceilingRotationTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + 20 * 60_000,
      absoluteWindowMs: 20 * 60_000,
    },
  );

  expectEqual(pastCeiling.kind, "refused", "a token whose family reached its ceiling is refused");
  expectEqual(
    (pastCeiling as { reason: string }).reason,
    "expired",
    "the refusal is the expiry its ceiling produced",
  );

  // ---- the device binding of a session
  const mismatchTable = createSessionTable();
  const mismatch = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: mismatchTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );
  const mismatchOutcome = await issueSessionToken(
    {
      presentedToken: (mismatch as { token: string }).token,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-sibling",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    {
      sessions: mismatchTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + SESSION_ROTATION_INTERVAL_MS,
    },
  );

  expectEqual(mismatchOutcome.kind, "refused", "a session cannot move to another device");
  expectEqual(
    (mismatchOutcome as { reason: string }).reason,
    "device-mismatch",
    "the refusal names the device mismatch",
  );
  expectEqual(mismatchTable.rows.length, 1, "and writes nothing");

  // ---- a rotation that lost its compare and swap
  const raceTable = createSessionTable();
  const raced = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: raceTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );

  raceTable.ignoreNextUpdate = true;

  const lost = await issueSessionToken(
    {
      presentedToken: (raced as { token: string }).token,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    {
      sessions: raceTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + SESSION_ROTATION_INTERVAL_MS,
    },
  );

  expectEqual(lost.kind, "current", "a rotation that lost the swap answers the live session");
  expectEqual(raceTable.rows.length, 1, "and writes nothing");
  expectEqual(raceTable.rows[0]?.revoked_at, null, "the row is still the live row");

  // ---- a rotation whose child already exists
  const forkTable = createSessionTable();
  const forked = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: forkTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );

  await forkTable.insert({
    userId: USER_ID,
    companyId: null,
    deviceProofKeyId: "device-051",
    tokenHash: hashSessionToken(createRawSessionToken()),
    issuedAtEpochMs: NOW + SESSION_ROTATION_INTERVAL_MS,
    expiresAtEpochMs: NOW + SESSION_ROTATION_WINDOW_MS,
    absoluteExpiresAtEpochMs: NOW + SESSION_ABSOLUTE_WINDOW_MS,
    mfaVerifiedAtEpochMs: null,
    reauthenticatedAtEpochMs: null,
    ipAddress: null,
    userAgent: null,
    familyId: (forked as { familyId: string }).familyId,
    rotatedFromSessionId: "session-0001",
  });

  const forkOutcome = await issueSessionToken(
    {
      presentedToken: (forked as { token: string }).token,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    {
      sessions: forkTable,
      audit: createInMemoryAuditTrail(),
      now: () => NOW + SESSION_ROTATION_INTERVAL_MS,
    },
  );

  expectEqual(forkOutcome.kind, "current", "a fork answers the child that already exists");
  expectEqual(forkTable.rows.length, 2, "a fork writes no third row");

  // ---- ending a session, and ending one device's sessions
  const revokeTable = createSessionTable();
  const revokedSession = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: revokeTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );
  const revokeAudit = createInMemoryAuditTrail();

  await revokeSession(
    {
      sessionId: (revokedSession as { sessionId: string }).sessionId,
      userId: USER_ID,
      companyId: null,
      reason: "SIGNED_OUT",
      ipAddress: null,
      userAgent: null,
    },
    { sessions: revokeTable, audit: revokeAudit, now: () => NOW },
  );

  expectEqual(revokeTable.rows[0]?.revocation_reason, "SIGNED_OUT", "a sign out ends the row");
  expectEqual(revokeAudit.entries.at(-1)?.action, "session.revoked", "the sign out is audited");
  expectEqual(
    (await resolveSessionToken({ token: (revokedSession as { token: string }).token, userId: USER_ID }, {
      sessions: revokeTable,
      audit: revokeAudit,
      now: () => NOW,
    })).kind,
    "revoked",
    "an ended session resolves as revoked",
  );

  const deviceTable = createSessionTable();
  const deviceAudit = createInMemoryAuditTrail();
  await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: null,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: deviceTable, audit: deviceAudit, now: () => NOW },
  );

  const deviceRevoked = await revokeDeviceSessions(
    { deviceProofKeyId: "device-051", userId: USER_ID, companyId: null },
    { sessions: deviceTable, audit: deviceAudit, now: () => NOW },
  );

  expectEqual(deviceRevoked, 1, "dropping a device ends its session");
  expectEqual(deviceTable.rows[0]?.revocation_reason, "DEVICE_REVOKED", "with the device reason");
  expectEqual(deviceAudit.entries.at(-1)?.action, "session.device_revoked", "and the act is audited");

  // ---- the reader every route uses
  const policy = cookiePolicy();
  const directory = createInMemoryActorDirectory([activeOwner]);
  const readerTable = createSessionTable();
  const readerAudit = createInMemoryAuditTrail();
  const readerOptions = {
    directory,
    cookiePolicy: policy,
    sessions: readerTable,
    audit: readerAudit,
    nowEpochMs: NOW,
  };

  const unboundCookie = sessionCookie(policy, baseClaims());

  await expectRejects(
    () => readRequestActor(unboundCookie, readerOptions),
    "AUTHENTICATION_REQUIRED",
    "a cookie that names no session is refused",
  );

  const unbound = await readBoundSession(unboundCookie, { ...readerOptions, allowUnbound: true });

  expectEqual(unbound.bound, false, "an unbound cookie is reported as unbound");
  expectEqual(unbound.sessionToken, null, "and carries no token");
  expectEqual(unbound.actor.sessionId, SESSION_ID, "an unbound actor keeps the provider's session id");
  expectEqual(unbound.actor.deviceProofKeyId, null, "an unbound actor names no device");

  const readerBinding = await issueSessionToken(
    {
      presentedToken: null,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-051",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: readerTable, audit: readerAudit, now: () => NOW },
  );
  const boundCookie = sessionCookie(policy, baseClaims(), {
    sessionToken: (readerBinding as { token: string }).token,
  });

  const readerActor = await readRequestActor(boundCookie, readerOptions);

  expectEqual(readerActor.sessionId, "session-0001", "a bound actor carries the platform session id");
  expectEqual(readerActor.deviceProofKeyId, "device-051", "a bound actor carries its device");
  expectEqual(readerActor.sessionFamilyId, "family-0001", "a bound actor carries its family");

  const boundSession = await readBoundSession(boundCookie, readerOptions);

  expectEqual(boundSession.bound, true, "a bound cookie is reported as bound");
  expectEqual(
    boundSession.payload.accessToken.length > 0,
    true,
    "the reader hands back the payload it verified",
  );

  const neighbourBinding = await issueSessionToken(
    {
      presentedToken: null,
      userId: OTHER_USER_ID,
      companyId: null,
      deviceProofKeyId: "device-neighbour",
      assuranceLevel: "aal1",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: readerTable, audit: readerAudit, now: () => NOW },
  );
  const neighbourCookie = sessionCookie(policy, baseClaims(), {
    sessionToken: (neighbourBinding as { token: string }).token,
  });

  await expectRejects(
    () => readRequestActor(neighbourCookie, readerOptions),
    "AUTHENTICATION_REQUIRED",
    "a token of another account does not authenticate this one",
  );

  const mismatchedCookie = sessionCookie(policy, { ...baseClaims(), sub: OTHER_USER_ID });

  await expectRejects(
    () => readRequestActor(mismatchedCookie, readerOptions),
    "AUTHENTICATION_REQUIRED",
    "a cookie whose subject disagrees with its payload is refused",
  );

  // A revoked row is refused, and `allowUnbound` does not rescue it.
  await revokeSession(
    {
      sessionId: (readerBinding as { sessionId: string }).sessionId,
      userId: USER_ID,
      companyId: FIRM_ID,
      reason: "ADMIN_REVOKED",
      ipAddress: null,
      userAgent: null,
    },
    { sessions: readerTable, audit: readerAudit, now: () => NOW },
  );

  await expectRejects(
    () => readRequestActor(boundCookie, { ...readerOptions, allowUnbound: true }),
    "AUTHENTICATION_REQUIRED",
    "a revoked session is refused even where an unbound cookie is allowed",
  );

  // ---- the exception, on disk
  const root = new URL("../../app/", import.meta.url);
  const entries = await readdir(root, { recursive: true });
  const sources = await Promise.all(
    entries
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
      .map(async (entry) => ({
        path: `/${entry}`,
        source: await readFile(new URL(entry, root), "utf8"),
      })),
  );
  const unboundCallers = sources
    .filter((file) => file.source.includes("allowUnbound"))
    .map((file) => file.path)
    .sort();

  expectEqual(
    unboundCallers.length,
    2,
    "exactly two files may let a cookie run before it is bound",
  );
  expect(
    unboundCallers.includes("/api/auth/session/rotate/route.ts"),
    "the rotation that binds is one of them",
  );
  expect(
    unboundCallers.includes("/api/auth/devices/route.ts"),
    "the enrolment that makes a key exist is the other",
  );

  const rotateRoute = sources.find((file) => file.path === "/api/auth/session/rotate/route.ts");

  expect(
    rotateRoute !== undefined && rotateRoute.source.includes("issueSessionToken"),
    "the rotation route issues the token it answers with",
  );
  expect(
    rotateRoute !== undefined && rotateRoute.source.includes("readBoundSession"),
    "the rotation route reads the session it extends",
  );

  const keepers = sources.filter(
    (file) => file.path.endsWith(".tsx") && file.source.includes("<SessionKeeper"),
  );

  // The settings screen, the new device confirmation, the step-up screen, STEP 054's two session
  // lists, STEP 079's onboarding wizard, the STEP 080-099 onboarding screens (the merchant
  // account screen and the office account review queue of STEP 099 included) and the STEP 106
  // client hub, new and edit screens, the STEP 108 catalogue screens - which are one component mounted
  // at four paths - the STEP 110 client import screen, the STEP 111 catalogue import screen, which is
  // likewise one component at two paths, and the STEP 112 invoice create screen; each keeps the token
  // rotating while the person reads it.
  // The office half is one of them because reading another account's sessions must not leave the
  // reader's own token unrotated, and the wizard is one because a merchant may sit on it for a
  // while.
  expectEqual(keepers.length, 25, "every signed-in page keeps its session rotating");
}

/**
 * An in-memory picture of the four tables STEP 052 writes.
 *
 * The double keeps the two rules the migration enforces and the service depends on - one live
 * challenge per device, one challenge per alert - because a double that accepted everything would
 * prove nothing about the code that reads those answers. Everything else is a plain array with the
 * filters the service sends.
 */
interface TrustDeviceRow {
  id: string;
  user_id: string;
  label: string | null;
  trusted_at: string | null;
  revoked_at: string | null;
  deleted_at: string | null;
}

interface TrustChallengeRow {
  id: string;
  company_id: string | null;
  user_id: string;
  device_proof_key_id: string;
  alert_send_id: string | null;
  attempts: number;
  max_attempts: number;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  deleted_at: string | null;
}

interface TrustAccountRow {
  id: string;
  email: string;
  totp_secret_ciphertext: string | null;
  totp_confirmed_at: string | null;
  deleted_at: string | null;
}

interface TrustSendRow {
  id: string;
  company_id: string | null;
  template_key: string;
  recipient_email: string;
  recipient_user_id: string | null;
  subject: string;
  provider: string;
  status: string;
  failure_reason: string | null;
  reference_kind: string;
  reference_id: string;
}

interface TrustWorld {
  readonly devices: TrustDeviceRow[];
  readonly challenges: TrustChallengeRow[];
  readonly accounts: TrustAccountRow[];
  readonly sends: TrustSendRow[];
  readonly methods: readonly ("smtp" | "api")[];
  readonly rest: RestClient;
  /** Set by a test that wants the queue to refuse, which a deployment can do too. */
  refuseQueue: boolean;
  sequence(): number;
}

/** The value of one `name=eq.value` filter, or null when the query does not carry it. */
function filterValue(query: string, name: string): string | null {
  const match = new RegExp(`(?:^|[&])${name}=eq\\.([^&]+)`, "u").exec(query);
  const value = match?.[1];

  return value === undefined ? null : decodeURIComponent(value);
}

function createTrustWorld(options: {
  readonly method?: "smtp" | "api";
  readonly totp?: boolean;
  readonly secret?: string;
}): TrustWorld {
  const devices: TrustDeviceRow[] = [];
  const challenges: TrustChallengeRow[] = [];
  const accounts: TrustAccountRow[] = [];
  const sends: TrustSendRow[] = [];
  const methods = options.method === undefined ? [] : [options.method];
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;

    return `${prefix}-${String(counter).padStart(4, "0")}`;
  }

  const world: TrustWorld = {
    devices,
    challenges,
    accounts,
    sends,
    methods,
    refuseQueue: false,
    sequence(): number {
      return counter;
    },
    rest: {
      select<TRow>(table: string, query: string): Promise<readonly TRow[]> {
        if (table === "device_proof_keys") {
          const id = filterValue(query, "id");
          const userId = filterValue(query, "user_id");

          return Promise.resolve(
            devices
              .filter((row) => row.revoked_at === null && row.deleted_at === null)
              .filter((row) => id === null || row.id === id)
              .filter((row) => userId === null || row.user_id === userId)
              .map((row) => ({ id: row.id, label: row.label, trusted_at: row.trusted_at }))
              .slice(0, 1) as unknown as readonly TRow[],
          );
        }

        if (table === "device_trust_challenges") {
          const deviceId = filterValue(query, "device_proof_key_id");

          return Promise.resolve(
            challenges
              .filter((row) => row.consumed_at === null && row.revoked_at === null && row.deleted_at === null)
              .filter((row) => deviceId === null || row.device_proof_key_id === deviceId)
              .map((row) => ({
                id: row.id,
                alert_send_id: row.alert_send_id,
                attempts: row.attempts,
                max_attempts: row.max_attempts,
                expires_at: row.expires_at,
                consumed_at: row.consumed_at,
              }))
              .slice(0, 1) as unknown as readonly TRow[],
          );
        }

        if (table === "users") {
          const id = filterValue(query, "id");

          return Promise.resolve(
            accounts
              .filter((row) => row.deleted_at === null)
              .filter((row) => id === null || row.id === id)
              .map((row) => ({
                email: row.email,
                totp_secret_ciphertext: row.totp_secret_ciphertext,
                totp_confirmed_at: row.totp_confirmed_at,
              }))
              .slice(0, 1) as unknown as readonly TRow[],
          );
        }

        if (table === "email_settings") {
          return Promise.resolve(
            methods.map((method) => ({ method })).slice(0, 1) as unknown as readonly TRow[],
          );
        }

        return Promise.resolve([]);
      },

      insert<TRow>(): Promise<TRow> {
        return Promise.reject(new AppError("INTERNAL_ERROR"));
      },

      insertReturning<TRow>(
        table: string,
        rows: readonly Readonly<Record<string, unknown>>[],
      ): Promise<readonly TRow[]> {
        if (table === "email_send_logs") {
          if (world.refuseQueue) {
            return Promise.reject(new AppError("DEPENDENCY_FAILED"));
          }

          const written = rows.map((row) => {
            const send: TrustSendRow = {
              id: nextId("send"),
              company_id: (row["company_id"] as string | null | undefined) ?? null,
              template_key: String(row["template_key"]),
              recipient_email: String(row["recipient_email"]),
              recipient_user_id: (row["recipient_user_id"] as string | null | undefined) ?? null,
              subject: String(row["subject"]),
              provider: String(row["provider"]),
              status: "queued",
              failure_reason: null,
              reference_kind: String(row["reference_kind"]),
              reference_id: String(row["reference_id"]),
            };

            sends.push(send);

            return { id: send.id };
          });

          return Promise.resolve(written as unknown as readonly TRow[]);
        }

        if (table === "device_trust_challenges") {
          const written: { id: string }[] = [];

          for (const row of rows) {
            const deviceId = String(row["device_proof_key_id"]);
            const alertSendId = (row["alert_send_id"] as string | null | undefined) ?? null;
            const live = challenges.some(
              (existing) =>
                existing.device_proof_key_id === deviceId &&
                existing.consumed_at === null &&
                existing.revoked_at === null &&
                existing.deleted_at === null,
            );

            if (live || (alertSendId !== null && challenges.some((existing) => existing.alert_send_id === alertSendId))) {
              throw new AppError("CONFLICT");
            }

            const challenge: TrustChallengeRow = {
              id: nextId("challenge"),
              company_id: (row["company_id"] as string | null | undefined) ?? null,
              user_id: String(row["user_id"]),
              device_proof_key_id: deviceId,
              alert_send_id: alertSendId,
              attempts: Number(row["attempts"] ?? 0),
              max_attempts: Number(row["max_attempts"] ?? 5),
              issued_at: String(row["issued_at"]),
              expires_at: String(row["expires_at"]),
              consumed_at: null,
              revoked_at: null,
              deleted_at: null,
            };

            challenges.push(challenge);
            written.push({ id: challenge.id });
          }

          return Promise.resolve(written as unknown as readonly TRow[]);
        }

        return Promise.resolve([]);
      },

      update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
        if (table === "device_trust_challenges") {
          const id = filterValue(query, "id");
          const liveOnly = query.includes("consumed_at=is.null");

          for (const row of challenges) {
            if (id !== null && row.id !== id) {
              continue;
            }

            if (liveOnly && (row.consumed_at !== null || row.revoked_at !== null)) {
              continue;
            }

            if ("attempts" in values) {
              row.attempts = Number(values["attempts"]);
            }

            if ("consumed_at" in values) {
              row.consumed_at = String(values["consumed_at"]);
            }

            if ("revoked_at" in values) {
              row.revoked_at = String(values["revoked_at"]);
            }
          }

          return Promise.resolve();
        }

        if (table === "device_proof_keys") {
          const id = filterValue(query, "id");
          const untrustedOnly = query.includes("trusted_at=is.null");

          for (const row of devices) {
            if (id !== null && row.id !== id) {
              continue;
            }

            if (untrustedOnly && row.trusted_at !== null) {
              continue;
            }

            if ("trusted_at" in values) {
              row.trusted_at = String(values["trusted_at"]);
            }
          }

          return Promise.resolve();
        }

        if (table === "email_send_logs") {
          const id = filterValue(query, "id");

          for (const row of sends) {
            if (id !== null && row.id !== id) {
              continue;
            }

            if ("status" in values) {
              row.status = String(values["status"]);
            }

            if ("failure_reason" in values) {
              row.failure_reason = String(values["failure_reason"]);
            }
          }

          return Promise.resolve();
        }

        return Promise.resolve();
      },

      rpc(): Promise<unknown> {
        return Promise.resolve(null);
      },
    },
  };

  return world;
}

/** One refusal, with the rule it named so a test can tell two refusals apart. */
function trustRefusalRule(error: AppError): string | null {
  const details = error.details;

  return details[0]?.rule ?? null;
}

/**
 * STEP 052: new device detection, the alert, and the confirmation that turns the flag over.
 *
 * The gate proves five things, in the order the module decides them:
 *
 *   1. a device nobody has confirmed is challenged once, and the owner is told once, through the
 *      section 23 queue in the shape that queue already uses;
 *   2. a device that is already trusted, and a device that is not this account's, are answers rather
 *      than errors, because the caller's job is to say "not trusted" and not to handle a failure;
 *   3. a deployment with no sending method still records the challenge, and says so in the log;
 *   4. the confirmation needs the authenticator code, spends an attempt on a wrong one, and refuses
 *      a session that is bound to another device before it reads a code at all;
 *   5. a spent budget, an ended challenge and an account that never finished its second factor are
 *      different refusals, because each asks the person for something different.
 */
async function checkDeviceTrust(): Promise<void> {
  const window = 24 * 60 * 60_000;

  // ---- the constants the migration and the service agree on
  expectEqual(DEVICE_TRUST_MAXIMUM_ATTEMPTS, 5, "the attempt budget is five codes");
  expectEqual(DEVICE_TRUST_WINDOW_MS, window, "a challenge lives a day");
  expectEqual(NEW_DEVICE_TEMPLATE_KEY, "new_device_alert", "the alert uses the template of section 23");

  const migration = await readFile(
    new URL("../../migrations/0090_device_trust_challenges.sql", import.meta.url),
    "utf8",
  );
  const logMigration = await readFile(
    new URL("../../migrations/0061_email_send_logs.sql", import.meta.url),
    "utf8",
  );

  expect(migration.includes("interval '24 hours'"), "the migration bounds the window the service uses");
  expect(migration.includes("attempts <= max_attempts"), "the migration bounds the budget the service spends");
  expect(logMigration.includes("'new_device_alert'"), "the template the alert names is one the log accepts");

  // ---- a challenge, and the alert that goes with it
  const world = createTrustWorld({ method: "smtp", secret: base32Encode(new Uint8Array(20).fill(3)) });
  const deviceId = "018f3b1c-2222-7c2a-9d1e-2b3c4d5e6f71";
  const secret = base32Encode(new Uint8Array(20).fill(3));

  world.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: "Office laptop",
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  world.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: packSecretBox(
      sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID)),
    ),
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    deleted_at: null,
  });

  const audit = createInMemoryAuditTrail();
  const logger = captureLogger().logger;
  const dependencies = {
    rest: world.rest,
    audit,
    logger,
    masterKey: () => MASTER_KEY,
    now: () => NOW,
  };

  const challengeInput = {
    userId: USER_ID,
    companyId: FIRM_ID,
    deviceId,
    ipAddress: "203.0.113.9",
    userAgent: "gate",
  };

  const first = await challengeDeviceTrust(challengeInput, dependencies);

  expectEqual(first.status, "challenged", "an unconfirmed device is challenged");
  expectEqual(
    first.status === "challenged" ? first.expiresAtEpochMs : 0,
    NOW + window,
    "the challenge expires a day after it was issued",
  );
  expectEqual(world.sends.length, 1, "the owner is told about the new device once");

  const send = world.sends[0];

  expectEqual(send?.template_key, "new_device_alert", "the alert is the template of section 23");
  expectEqual(send?.status, "queued", "the alert is queued, not sent");
  expectEqual(send?.provider, "smtp", "the alert uses the sending method the office made active");
  expectEqual(send?.recipient_email, "owner@example.com", "the alert goes to the account's own address");
  expectEqual(send?.reference_kind, "account", "the alert names the account it is about");
  expectEqual(send?.reference_id, USER_ID, "and names it by id");
  expectEqual(send?.subject, getMessage("email.newDevice.subject"), "the subject is a message, not a literal");
  expect(
    send !== undefined && send.subject.length > 20 && send.subject.length <= 200,
    "the subject fits a mail header",
  );

  expectEqual(audit.entries.length, 1, "the challenge writes one audit entry");
  expectEqual(audit.entries[0]?.action, "device.trust_challenged", "the entry names the challenge");
  expectEqual(audit.entries[0]?.entityType, "device_proof_key", "the entry names the device it is about");
  expectEqual(audit.entries[0]?.entityId, deviceId, "and names it by id");
  expectEqual(audit.entries[0]?.payload["alert_queued"], true, "the entry records that the owner was told");
  expect(
    typeof audit.entries[0]?.action === "string" && /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(audit.entries[0].action),
    "the action name fits the audit vocabulary",
  );

  // ---- a second bind is the same device, not a second email
  const again = await challengeDeviceTrust(challengeInput, dependencies);

  expectEqual(again.status, "already_open", "a live challenge is reused, not repeated");
  expectEqual(world.sends.length, 1, "a second bind mails the owner nothing");
  expectEqual(world.challenges.length, 1, "and writes no second row");
  expectEqual(audit.entries.length, 1, "and writes no second audit entry");

  // ---- a device that is already trusted is not a new device
  const trustedWorld = createTrustWorld({ method: "smtp" });

  trustedWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: new Date(NOW - 86_400_000).toISOString(),
    revoked_at: null,
    deleted_at: null,
  });

  const trustedOutcome = await challengeDeviceTrust(challengeInput, {
    ...dependencies,
    rest: trustedWorld.rest,
  });

  expectEqual(trustedOutcome.status, "already_trusted", "a confirmed device is not challenged again");
  expectEqual(trustedWorld.challenges.length, 0, "and writes no challenge");
  expectEqual(trustedWorld.sends.length, 0, "and mails nobody");

  // ---- a device of another account is not this account's device
  const strangerWorld = createTrustWorld({ method: "smtp" });

  strangerWorld.devices.push({
    id: deviceId,
    user_id: "018f3b1c-9999-7c2a-9d1e-2b3c4d5e6f79",
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });

  expectEqual(
    (await challengeDeviceTrust(challengeInput, { ...dependencies, rest: strangerWorld.rest })).status,
    "no_device",
    "a device of somebody else answers no_device",
  );

  // ---- a deployment with no sending method still records the challenge
  const silentWorld = createTrustWorld({});
  const silentLogger = captureLogger();

  silentWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  silentWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: null,
    totp_confirmed_at: null,
    deleted_at: null,
  });

  const silent = await challengeDeviceTrust(challengeInput, {
    ...dependencies,
    rest: silentWorld.rest,
    audit: createInMemoryAuditTrail(),
    logger: silentLogger.logger,
  });

  expectEqual(silent.status, "challenged", "a challenge without an email is still a challenge");
  expectEqual(silent.status === "challenged" ? silent.alertSendId : "x", null, "the challenge names no alert");
  expectEqual(silentWorld.sends.length, 0, "no alert row is written without a sending method");
  expectEqual(silentWorld.challenges.length, 1, "the challenge itself is recorded");
  expectEqual(silentLogger.warnings.length, 1, "the missing sender is logged rather than swallowed");

  // ---- a queue that refuses does not stop the challenge
  const brokenWorld = createTrustWorld({ method: "api" });

  brokenWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  brokenWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: null,
    totp_confirmed_at: null,
    deleted_at: null,
  });
  brokenWorld.refuseQueue = true;

  const broken = await challengeDeviceTrust(challengeInput, {
    ...dependencies,
    rest: brokenWorld.rest,
    audit: createInMemoryAuditTrail(),
    logger: captureLogger().logger,
  });

  expectEqual(broken.status, "challenged", "a queue that is down does not refuse the device");
  expectEqual(broken.status === "challenged" ? broken.alertSendId : "x", null, "and the challenge names no alert");

  // ---- the confirmation
  const confirmWorld = createTrustWorld({ method: "smtp" });

  confirmWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: "Office laptop",
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  confirmWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: packSecretBox(
      sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID)),
    ),
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    deleted_at: null,
  });

  const confirmAudit = createInMemoryAuditTrail();
  const confirmDependencies = {
    rest: confirmWorld.rest,
    audit: confirmAudit,
    logger: captureLogger().logger,
    masterKey: () => MASTER_KEY,
    now: () => NOW,
  };

  await challengeDeviceTrust(challengeInput, confirmDependencies);

  const key = base32Decode(secret) ?? new Uint8Array();

  expectEqual(
    (
      await readDeviceTrust({ userId: USER_ID, deviceId }, { rest: confirmWorld.rest })
    )?.attemptsRemaining,
    DEVICE_TRUST_MAXIMUM_ATTEMPTS,
    "a fresh challenge has its whole budget",
  );

  const wrongCode = await captureRejection(
    () =>
      confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: deviceId,
          code: "000000",
          ipAddress: null,
          userAgent: null,
        },
        confirmDependencies,
      ),
    "a wrong code is refused",
  );

  expectEqual(wrongCode.code, "VALIDATION_FAILED", "a wrong code is a form refusal");
  expectEqual(trustRefusalRule(wrongCode), "invalid_code", "and says which form field is wrong");
  expectEqual(confirmWorld.challenges[0]?.attempts, 1, "a wrong code spends an attempt");
  expectEqual(confirmWorld.devices[0]?.trusted_at, null, "a wrong code does not trust the device");
  expectEqual(confirmAudit.entries.at(-1)?.action, "device.trust_rejected", "a wrong code is audited");
  expectEqual(
    (
      await readDeviceTrust({ userId: USER_ID, deviceId }, { rest: confirmWorld.rest })
    )?.attemptsRemaining,
    DEVICE_TRUST_MAXIMUM_ATTEMPTS - 1,
    "the budget shrinks by one",
  );

  const otherDevice = await captureRejection(
    () =>
      confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: "018f3b1c-3333-7c2a-9d1e-2b3c4d5e6f72",
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        confirmDependencies,
      ),
    "a session bound to another device is refused",
  );

  expectEqual(otherDevice.code, "PERMISSION_DENIED", "a session on another device cannot trust this one");
  expectEqual(confirmWorld.challenges[0]?.attempts, 1, "and spending nothing, not even an attempt");

  const trusted = await confirmDeviceTrust(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceId,
      sessionDeviceId: deviceId,
      code: totpCodeForStep(key, totpStep(NOW)),
      ipAddress: "203.0.113.9",
      userAgent: "gate",
    },
    confirmDependencies,
  );

  expectEqual(trusted.status, "trusted", "the right code trusts the device");
  expectEqual(confirmWorld.devices[0]?.trusted_at, new Date(NOW).toISOString(), "the device is stamped");
  expectEqual(confirmWorld.challenges[0]?.consumed_at, new Date(NOW).toISOString(), "the challenge is consumed");
  expectEqual(confirmAudit.entries.at(-1)?.action, "device.trusted", "the decision is audited");
  expectEqual(
    confirmAudit.entries.at(-1)?.entityId,
    deviceId,
    "the entry names the device it trusted",
  );

  const state = await readDeviceTrust({ userId: USER_ID, deviceId }, { rest: confirmWorld.rest });

  expectEqual(state?.trustedAtEpochMs, NOW, "a trusted device reports its instant");
  expectEqual(state?.challengeExpiresAtEpochMs, null, "and reports no live challenge");
  expectEqual(state?.label, "Office laptop", "and reports the label the account gave it");
  expectEqual(
    await readDeviceTrust({ userId: USER_ID, deviceId: "018f3b1c-4444-7c2a-9d1e-2b3c4d5e6f74" }, { rest: confirmWorld.rest }),
    null,
    "an unknown device reports nothing",
  );

  expectEqual(
    (
      await confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: deviceId,
          code: "000000",
          ipAddress: null,
          userAgent: null,
        },
        confirmDependencies,
      )
    ).status,
    "already_trusted",
    "a second confirmation is not an error and asks for no code",
  );

  // ---- the three refusals that ask for different things
  const noChallengeWorld = createTrustWorld({ method: "smtp" });

  noChallengeWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  noChallengeWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: packSecretBox(sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID))),
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    deleted_at: null,
  });

  const noChallenge = await captureRejection(
    () =>
      confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: deviceId,
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        { ...confirmDependencies, rest: noChallengeWorld.rest },
      ),
    "a device with no live challenge is refused",
  );

  expectEqual(trustRefusalRule(noChallenge), "no_live_challenge", "no challenge names the device field");

  const expiredWorld = createTrustWorld({ method: "smtp" });

  expiredWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  expiredWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: packSecretBox(sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID))),
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    deleted_at: null,
  });
  expiredWorld.challenges.push({
    id: "challenge-expired",
    company_id: FIRM_ID,
    user_id: USER_ID,
    device_proof_key_id: deviceId,
    alert_send_id: null,
    attempts: 0,
    max_attempts: DEVICE_TRUST_MAXIMUM_ATTEMPTS,
    issued_at: new Date(NOW - 2 * window).toISOString(),
    expires_at: new Date(NOW - window).toISOString(),
    consumed_at: null,
    revoked_at: null,
    deleted_at: null,
  });

  const expired = await captureRejection(
    () =>
      confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: deviceId,
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        { ...confirmDependencies, rest: expiredWorld.rest },
      ),
    "an expired challenge is refused",
  );

  expectEqual(trustRefusalRule(expired), "challenge_expired", "an expired challenge says so");
  expectEqual(expiredWorld.devices[0]?.trusted_at, null, "an expired challenge trusts nothing");

  const spentWorld = createTrustWorld({ method: "smtp" });

  spentWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  spentWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: packSecretBox(sealSecret(MASTER_KEY, secret, twoFactorContext(USER_ID))),
    totp_confirmed_at: new Date(NOW - 86_400_000).toISOString(),
    deleted_at: null,
  });
  spentWorld.challenges.push({
    id: "challenge-spent",
    company_id: FIRM_ID,
    user_id: USER_ID,
    device_proof_key_id: deviceId,
    alert_send_id: null,
    attempts: DEVICE_TRUST_MAXIMUM_ATTEMPTS,
    max_attempts: DEVICE_TRUST_MAXIMUM_ATTEMPTS,
    issued_at: new Date(NOW - 1_000).toISOString(),
    expires_at: new Date(NOW + window).toISOString(),
    consumed_at: null,
    revoked_at: null,
    deleted_at: null,
  });

  const spent = await captureRejection(
    () =>
      confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: deviceId,
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        { ...confirmDependencies, rest: spentWorld.rest },
      ),
    "a spent budget is refused even for the right code",
  );

  expectEqual(trustRefusalRule(spent), "attempts_exhausted", "a spent budget says so");
  expectEqual(spentWorld.devices[0]?.trusted_at, null, "a spent budget trusts nothing");

  const unenrolledWorld = createTrustWorld({ method: "smtp" });

  unenrolledWorld.devices.push({
    id: deviceId,
    user_id: USER_ID,
    label: null,
    trusted_at: null,
    revoked_at: null,
    deleted_at: null,
  });
  unenrolledWorld.accounts.push({
    id: USER_ID,
    email: "owner@example.com",
    totp_secret_ciphertext: null,
    totp_confirmed_at: null,
    deleted_at: null,
  });
  unenrolledWorld.challenges.push({
    id: "challenge-unenrolled",
    company_id: FIRM_ID,
    user_id: USER_ID,
    device_proof_key_id: deviceId,
    alert_send_id: null,
    attempts: 0,
    max_attempts: DEVICE_TRUST_MAXIMUM_ATTEMPTS,
    issued_at: new Date(NOW - 1_000).toISOString(),
    expires_at: new Date(NOW + window).toISOString(),
    consumed_at: null,
    revoked_at: null,
    deleted_at: null,
  });

  const unenrolled = await captureRejection(
    () =>
      confirmDeviceTrust(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          deviceId,
          sessionDeviceId: deviceId,
          code: "123456",
          ipAddress: null,
          userAgent: null,
        },
        { ...confirmDependencies, rest: unenrolledWorld.rest },
      ),
    "an account with no second factor is refused",
  );

  expectEqual(trustRefusalRule(unenrolled), "two_factor_required", "and is told to enrol first");
  expectEqual(unenrolledWorld.challenges[0]?.attempts, 0, "a missing second factor spends no attempt");

  // ---- what the sensitive endpoints ask of a proof
  const untrustedProof = {
    deviceKeyId: deviceId,
    algorithm: "ES256" as const,
    trusted: false,
    signedAtEpochMs: NOW,
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  };

  const refusedProof = await captureRejection(
    () => Promise.resolve(requireTrustedDevice(untrustedProof)),
    "an unconfirmed device is refused a dangerous action",
  );

  expectEqual(refusedProof.code, "PERMISSION_DENIED", "the refusal is a permission, not a sign in");
  expect(
    requireTrustedDevice({ ...untrustedProof, trusted: true }) === undefined,
    "a confirmed device is allowed through",
  );

  // ---- the routes that carry it, on disk
  //
  // The import line is removed before searching, because a route that imports a guard and never
  // calls it is exactly the mistake this part exists to catch: a substring search over the whole
  // file would pass on the `import` alone.
  const withoutImports = (source: string): string =>
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("import "))
      .join("\n");

  const root = new URL("../../app/", import.meta.url);
  const confirmRoute = await readFile(
    new URL("api/auth/devices/confirm/route.ts", root),
    "utf8",
  ).catch(() => "");
  const rotateRoute = await readFile(
    new URL("api/auth/session/rotate/route.ts", root),
    "utf8",
  ).catch(() => "");
  const confirmScreen = await readFile(new URL("(auth)/devices/confirm/page.tsx", root), "utf8").catch(
    () => "",
  );

  const confirmRouteBody = withoutImports(confirmRoute);
  const rotateRouteBody = withoutImports(rotateRoute);

  expect(
    confirmRouteBody.includes("confirmDeviceTrust("),
    "the confirmation route calls the service",
  );
  expect(
    confirmRouteBody.includes("sessionDeviceId: actor.deviceProofKeyId"),
    "the confirmation route binds the session to the device it confirms",
  );
  expect(
    confirmRouteBody.indexOf("readRequestActor(") < confirmRouteBody.indexOf("request.json()"),
    "the confirmation route authenticates before it parses the body",
  );
  expect(
    rotateRouteBody.includes("challengeDeviceTrust("),
    "the rotation route detects a new device",
  );
  expect(
    rotateRouteBody.includes("outcome.kind === \"bound\""),
    "and does it on a bind, which is the request that starts a session",
  );
  expect(confirmScreen.includes("DeviceConfirmForm"), "the confirmation screen has its form");
  expect(confirmScreen.includes("<SessionKeeper"), "and keeps the token rotating while it is open");
  expect(
    SESSION_AUTH_SURFACES.some((surface) => surface.path === "/api/auth/devices/confirm"),
    "the confirmation is a session surface, so its codes are catalogued",
  );

  const sensitiveRoutes = await Promise.all(
    SENSITIVE_ENDPOINTS.map((endpoint) =>
      readFile(new URL(`.${endpoint.path}/route.ts`, root), "utf8").catch(() => ""),
    ),
  );

  for (const [index, endpoint] of SENSITIVE_ENDPOINTS.entries()) {
    expect(
      withoutImports(sensitiveRoutes[index] ?? "").includes("requireTrustedDevice("),
      `${endpoint.path} refuses an unconfirmed device`,
    );
  }
}

/**
 * An in-memory picture of the three tables a step-up touches.
 *
 * `users` is read for the sealed secret and the backup verifiers, `account_locks` decides whether a
 * correct code is even looked at, and `sessions` is the row the instant is written on - which is the
 * whole point of the STEP, so the double records exactly which update was sent.
 */
interface StepUpAccountRow {
  id: string;
  company_id: string | null;
  status: string;
  deleted_at: string | null;
  totp_secret_ciphertext: string | null;
  totp_confirmed_at: string | null;
  backup_code_hashes: readonly string[];
}

interface StepUpLockRow {
  triggered_by: "password" | "totp";
  locked_at: string;
  expires_at: string;
}

interface StepUpWorld {
  readonly account: StepUpAccountRow;
  readonly locks: StepUpLockRow[];
  /** Every update the service sent to `sessions`, in order. */
  readonly sessionUpdates: { sessionId: string; query: string; values: Readonly<Record<string, unknown>> }[];
  /** Every update the service sent to `users`, in order. */
  readonly userUpdates: Readonly<Record<string, unknown>>[];
  readonly rest: RestClient;
}

function createStepUpWorld(options: {
  readonly totpSecret: string | null;
  readonly backupCodes?: readonly string[];
  readonly status?: string;
  readonly locked?: boolean;
}): StepUpWorld {
  const userUpdates: Readonly<Record<string, unknown>>[] = [];
  const locks: StepUpLockRow[] = [];

  if (options.locked === true) {
    locks.push({
      triggered_by: "totp",
      locked_at: new Date(NOW - 60_000).toISOString(),
      expires_at: new Date(NOW + 3_600_000).toISOString(),
    });
  }

  const account: StepUpAccountRow = {
    id: USER_ID,
    company_id: FIRM_ID,
    status: options.status ?? "active",
    deleted_at: null,
    totp_secret_ciphertext:
      options.totpSecret === null
        ? null
        : packSecretBox(sealSecret(MASTER_KEY, options.totpSecret, twoFactorContext(USER_ID))),
    totp_confirmed_at:
      options.totpSecret === null ? null : new Date(NOW - 86_400_000).toISOString(),
    backup_code_hashes: options.backupCodes ?? [],
  };

  const world: StepUpWorld = {
    account,
    locks,
    sessionUpdates: [],
    userUpdates,
    rest: {
      select<TRow>(table: string): Promise<readonly TRow[]> {
        if (table === "users") {
          return Promise.resolve([
            {
              id: account.id,
              company_id: account.company_id,
              status: account.status,
              deleted_at: account.deleted_at,
              totp_secret_ciphertext: account.totp_secret_ciphertext,
              totp_confirmed_at: account.totp_confirmed_at,
              backup_code_hashes: account.backup_code_hashes,
            },
          ] as unknown as readonly TRow[]);
        }

        if (table === "account_locks") {
          return Promise.resolve(
            locks.slice(0, 1) as unknown as readonly TRow[],
          );
        }

        return Promise.resolve([]);
      },
      insert(): Promise<void> {
        return Promise.resolve();
      },
      insertReturning(): Promise<readonly never[]> {
        return Promise.resolve([]);
      },
      update(table: string, _query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
        if (table === "users") {
          userUpdates.push(values);
        }

        return Promise.resolve();
      },
      rpc(): Promise<unknown> {
        return Promise.resolve(null);
      },
    },
  };

  return world;
}

/** The session store a step-up writes to: one live row, and a record of what was asked of it. */
function createStepUpSessions(world: StepUpWorld, instant: number): SessionTokenStore {
  const row: SessionRow = {
    id: "session-053",
    userId: USER_ID,
    companyId: FIRM_ID,
    deviceProofKeyId: "device-053",
    familyId: "family-053",
    rotatedFromSessionId: null,
    issuedAtEpochMs: instant - 60_000,
    expiresAtEpochMs: instant + SESSION_ROTATION_WINDOW_MS,
    absoluteExpiresAtEpochMs: instant + SESSION_ABSOLUTE_WINDOW_MS,
    revokedAtEpochMs: null,
    revocationReason: null,
    replayDetectedAtEpochMs: null,
    mfaVerifiedAtEpochMs: instant - 60_000,
    reauthenticatedAtEpochMs: null,
  };

  return {
    findByHash(): Promise<SessionRow | null> {
      return Promise.resolve(row);
    },
    findLiveInFamily(): Promise<SessionRow | null> {
      return Promise.resolve(row);
    },
    insert(): Promise<SessionRow> {
      return Promise.resolve(row);
    },
    update(sessionId: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      world.sessionUpdates.push({ sessionId, query, values });

      return Promise.resolve();
    },
    revokeFamily(): Promise<number> {
      return Promise.resolve(0);
    },
    revokeDevice(): Promise<number> {
      return Promise.resolve(0);
    },
  };
}

/**
 * STEP 053: the step-up guard, the code that satisfies it, and the endpoints that ask.
 *
 * The gate proves five things:
 *
 *   1. freshness is the later of two instants on the session row, and the window has edges;
 *   2. a stale session answers `403` with `reauth_required`, which is not the same answer as "this
 *      account may not do this";
 *   3. the second factor is the proof: a wrong code is refused and counted, a right one is written
 *      on the session row, and a backup code is spent;
 *   4. section 22's lock still applies - a locked account is refused before its code is looked at;
 *   5. a rotation carries the instant, so replacing the token does not undo a fresh proof.
 */
async function checkStepUp(): Promise<void> {
  // ---- the window, as a value
  expectEqual(STEP_UP_WINDOW_MS, 10 * 60_000, "a proof counts for ten minutes");
  expectEqual(REAUTHENTICATION_REQUIRED_RULE, "reauth_required", "the rule a stale session answers");

  const none = readStepUpState({ mfaVerifiedAtEpochMs: null, reauthenticatedAtEpochMs: null }, NOW);

  expectEqual(none.satisfied, false, "a session with no proof is not fresh");
  expectEqual(none.proof, "none", "and says it has no proof");
  expectEqual(none.provenAtEpochMs, null, "and names no instant");
  expectEqual(none.freshUntilEpochMs, null, "and no window");

  const afterSignIn = readStepUpState(
    { mfaVerifiedAtEpochMs: NOW - 60_000, reauthenticatedAtEpochMs: null },
    NOW,
  );

  expectEqual(afterSignIn.satisfied, true, "a sign in a minute ago is a fresh proof");
  expectEqual(afterSignIn.proof, "sign-in", "and says where it came from");
  expectEqual(afterSignIn.freshUntilEpochMs, NOW - 60_000 + STEP_UP_WINDOW_MS, "and when it stops counting");

  const stale = readStepUpState({ mfaVerifiedAtEpochMs: NOW - 3_600_000, reauthenticatedAtEpochMs: null }, NOW);

  expectEqual(stale.satisfied, false, "a sign in an hour ago is not a fresh proof");

  const afterReauth = readStepUpState(
    { mfaVerifiedAtEpochMs: NOW - 3_600_000, reauthenticatedAtEpochMs: NOW - 1_000 },
    NOW,
  );

  expectEqual(afterReauth.satisfied, true, "a reauthentication is fresher than the sign in");
  expectEqual(afterReauth.proof, "reauthenticated", "and is the one that counts");

  // The later of the two, whichever order they arrive in.
  expectEqual(
    readStepUpState({ mfaVerifiedAtEpochMs: NOW - 1_000, reauthenticatedAtEpochMs: NOW - 5_000 }, NOW).proof,
    "sign-in",
    "the sign in still counts when it is the later of the two",
  );

  // The edges of the window: satisfied up to the millisecond before it ends.
  expectEqual(readStepUpState({ mfaVerifiedAtEpochMs: NOW, reauthenticatedAtEpochMs: null }, NOW).satisfied, true, "the instant of the proof itself counts");
  expectEqual(
    readStepUpState(
      { mfaVerifiedAtEpochMs: NOW - STEP_UP_WINDOW_MS + 1, reauthenticatedAtEpochMs: null },
      NOW,
    ).satisfied,
    true,
    "one millisecond inside the window counts",
  );
  expectEqual(
    readStepUpState(
      { mfaVerifiedAtEpochMs: NOW - STEP_UP_WINDOW_MS, reauthenticatedAtEpochMs: null },
      NOW,
    ).satisfied,
    false,
    "the millisecond the window ends does not",
  );

  // ---- the guard
  const guardAudit = createInMemoryAuditTrail();
  void guardAudit;

  expect(
    requireFreshReauthentication(
      { mfaVerifiedAtEpochMs: NOW - 60_000, reauthenticatedAtEpochMs: null },
      NOW,
    ).satisfied,
    "the guard lets a fresh session through",
  );

  const refused = await captureRejection(
    () =>
      Promise.resolve(
        requireFreshReauthentication(
          { mfaVerifiedAtEpochMs: NOW - 3_600_000, reauthenticatedAtEpochMs: null },
          NOW,
        ),
      ),
    "a stale session is refused",
  );

  expectEqual(refused.code, "PERMISSION_DENIED", "the refusal is a permission, not a sign in");
  expectEqual(refused.status, 403, "and it is a 403");
  expectEqual(refused.details[0]?.field, "session", "the detail names the session");
  expectEqual(refused.details[0]?.rule, "reauth_required", "and the rule a screen acts on");
  expect(
    isDisclosingDetail(refused.details[0]?.rule ?? "") === false,
    "the rule tells a stranger nothing about an account",
  );

  // ---- the proof itself
  const secret = base32Encode(new Uint8Array(20).fill(9));
  const key = base32Decode(secret) ?? new Uint8Array();
  const world = createStepUpWorld({ totpSecret: secret });
  const audit = createInMemoryAuditTrail();
  const attempts = createInMemoryLoginAttemptRecorder();
  const sessions = createStepUpSessions(world, NOW);
  const dependencies = {
    rest: world.rest,
    audit,
    sessions,
    attempts,
    masterKey: () => MASTER_KEY,
    now: () => NOW,
  };

  const rejected = await captureRejection(
    () =>
      reauthenticateSession(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          sessionId: "session-053",
          code: "000000",
          ipAddress: null,
          userAgent: null,
        },
        dependencies,
      ),
    "a wrong code is refused",
  );

  expectEqual(rejected.code, "VALIDATION_FAILED", "a wrong code is a form refusal");
  expectEqual(rejected.details[0]?.rule, "invalid_code", "and names the field");
  expectEqual(world.sessionUpdates.length, 0, "a wrong code writes no instant on the session");
  expectEqual(attempts.attempts.length, 1, "a wrong code is recorded as a failed attempt");
  expectEqual(attempts.attempts[0]?.factor, "totp", "against the second factor");
  expectEqual(attempts.attempts[0]?.outcome, "failed", "as a failure");
  expectEqual(audit.entries.at(-1)?.action, "session.reauth_rejected", "and is audited");
  expectEqual(audit.entries.at(-1)?.entityType, "session", "against the session");

  const confirmed = await reauthenticateSession(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      sessionId: "session-053",
      code: totpCodeForStep(key, totpStep(NOW)),
      ipAddress: "203.0.113.9",
      userAgent: "gate",
    },
    dependencies,
  );

  expectEqual(confirmed.status, "reauthenticated", "the right code satisfies the step-up");
  expectEqual(confirmed.proof, "totp", "and says which factor proved it");
  expectEqual(confirmed.freshUntilEpochMs, NOW + STEP_UP_WINDOW_MS, "and answers the new window");
  expectEqual(world.sessionUpdates.length, 1, "one write, on the session row");
  expectEqual(world.sessionUpdates[0]?.sessionId, "session-053", "the caller's own row");
  expectEqual(
    world.sessionUpdates[0]?.values["reauthenticated_at"],
    new Date(NOW).toISOString(),
    "the row carries the instant the proof was made",
  );
  expect(
    world.sessionUpdates[0]?.query.includes("revoked_at=is.null") === true,
    "and only while the session is still live",
  );
  expectEqual(audit.entries.at(-1)?.action, "session.reauthenticated", "the decision is audited");
  expectEqual(audit.entries.at(-1)?.sessionId, "session-053", "against the session it happened in");
  expectEqual(audit.entries.at(-1)?.payload["method"], "totp", "with the method that proved it");
  expect(
    typeof audit.entries.at(-1)?.action === "string" &&
      /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(audit.entries.at(-1)?.action ?? ""),
    "the action name fits the audit vocabulary",
  );

  // A backup code, and what spending it costs.
  const backupCode = "a1b2c3d4e5";
  const backupWorld = createStepUpWorld({
    totpSecret: secret,
    backupCodes: [
      await hashPassword(backupCode),
      await hashPassword("f6e5d4c3b2"),
    ],
  });
  const backupSessions = createStepUpSessions(backupWorld, NOW);
  const backupAudit = createInMemoryAuditTrail();
  const backupOutcome = await reauthenticateSession(
    {
      userId: USER_ID,
      companyId: FIRM_ID,
      sessionId: "session-053",
      code: backupCode,
      ipAddress: null,
      userAgent: null,
    },
    {
      rest: backupWorld.rest,
      audit: backupAudit,
      sessions: backupSessions,
      attempts: createInMemoryLoginAttemptRecorder(),
      masterKey: () => MASTER_KEY,
      now: () => NOW,
    },
  );

  expectEqual(backupOutcome.proof, "backup_code", "a backup code satisfies the step-up too");
  expectEqual(backupOutcome.remainingBackupCodes, 1, "and one code is spent");
  expectEqual(backupWorld.userUpdates.length, 1, "the account's verifiers are rewritten");
  expectEqual(
    (backupWorld.userUpdates[0]?.["backup_code_hashes"] as readonly string[]).length,
    1,
    "with the used code removed",
  );
  expectEqual(backupSessions.update !== undefined, true, "and the session is still stamped");
  expectEqual(backupAudit.entries.at(-1)?.action, "session.reauthenticated", "the entry names the proof");

  // An account with no second factor cannot step up, and is not told it typed a wrong code.
  const unenrolled = await captureRejection(
    () =>
      reauthenticateSession(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          sessionId: "session-053",
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        { ...dependencies, rest: createStepUpWorld({ totpSecret: null }).rest },
      ),
    "an account with no second factor is refused",
  );

  expectEqual(unenrolled.code, "VALIDATION_FAILED", "and it is a form refusal");
  expectEqual(unenrolled.details[0]?.rule, "two_factor_required", "that sends them to the enrolment");

  // Section 22's lock survives a correct code.
  const lockedWorld = createStepUpWorld({ totpSecret: secret, locked: true });
  const locked = await captureRejection(
    () =>
      reauthenticateSession(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          sessionId: "session-053",
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        { ...dependencies, rest: lockedWorld.rest, sessions: createStepUpSessions(lockedWorld, NOW) },
      ),
    "a locked account cannot step up, even with the right code",
  );

  expectEqual(locked.code, "ACCOUNT_LOCKED", "the lock answers as it does everywhere else");
  expectEqual(lockedWorld.sessionUpdates.length, 0, "and nothing is written on the session");

  // A session that is not bound cannot reauthenticate: there is no row to write it on.
  const unbound = await captureRejection(
    () =>
      reauthenticateSession(
        {
          userId: USER_ID,
          companyId: FIRM_ID,
          sessionId: null,
          code: totpCodeForStep(key, totpStep(NOW)),
          ipAddress: null,
          userAgent: null,
        },
        dependencies,
      ),
    "an unbound session cannot step up",
  );

  expectEqual(unbound.code, "AUTHENTICATION_REQUIRED", "and is told to sign in");

  // ---- a rotation carries the instant
  const rotationTable = createSessionTable();
  const rotationToken = createRawSessionToken();

  await rotationTable.insert({
    userId: USER_ID,
    companyId: FIRM_ID,
    deviceProofKeyId: "device-053",
    tokenHash: hashSessionToken(rotationToken),
    issuedAtEpochMs: NOW - SESSION_ROTATION_INTERVAL_MS,
    expiresAtEpochMs: NOW + SESSION_ROTATION_WINDOW_MS,
    absoluteExpiresAtEpochMs: NOW + SESSION_ABSOLUTE_WINDOW_MS,
    mfaVerifiedAtEpochMs: NOW - SESSION_ROTATION_INTERVAL_MS,
    reauthenticatedAtEpochMs: NOW - 60_000,
    ipAddress: null,
    userAgent: null,
    familyId: null,
    rotatedFromSessionId: null,
  });

  const rotated = await issueSessionToken(
    {
      presentedToken: rotationToken,
      userId: USER_ID,
      companyId: FIRM_ID,
      deviceProofKeyId: "device-053",
      assuranceLevel: "aal2",
      ipAddress: null,
      userAgent: null,
      claimSessionId: null,
    },
    { sessions: rotationTable, audit: createInMemoryAuditTrail(), now: () => NOW },
  );

  expectEqual(rotated.kind, "rotated", "the token is replaced");

  const child = rotationTable.rows.find(
    (row) => row.rotated_from_session_id === rotationTable.rows[0]?.id,
  );

  expectEqual(
    child?.reauthenticated_at,
    NOW - 60_000,
    "a rotation carries the proof forward, so a new token does not undo it",
  );
  expectEqual(child?.mfa_verified_at, NOW - SESSION_ROTATION_INTERVAL_MS, "and the sign in instant with it");

  // ---- the endpoints that carry it, on disk
  const root = new URL("../../app/", import.meta.url);
  const reauthRoute = await readFile(new URL("api/auth/session/reauth/route.ts", root), "utf8").catch(
    () => "",
  );
  const unlockRoute = await readFile(
    new URL("api/office/account-locks/unlock/route.ts", root),
    "utf8",
  ).catch(() => "");
  const reauthPage = await readFile(new URL("(auth)/reauth/page.tsx", root), "utf8").catch(() => "");
  const reauthForm = await readFile(new URL("(auth)/reauth/reauth-form.tsx", root), "utf8").catch(
    () => "",
  );
  const actorSource = await readFile(new URL("../../lib/auth/request-actor.ts", import.meta.url), "utf8");

  expect(reauthRoute.includes("reauthenticateSession"), "the step-up route calls the service");
  expect(
    reauthRoute.indexOf("readRequestActor(") < reauthRoute.indexOf("JSON.parse("),
    "and never parses a body before it knows whose session it is",
  );
  expectEqual(
    reauthRoute.split("request.text()").length - 1,
    1,
    "and reads the body exactly once, because the signature covers those bytes",
  );
  expect(
    reauthRoute.indexOf("verifySensitiveRequest(") < reauthRoute.indexOf("JSON.parse("),
    "and verifies the proof before it parses the body",
  );
  expect(reauthRoute.includes("requireTrustedDevice("), "and refuses an unconfirmed device");
  expect(
    unlockRoute.includes("requireFreshReauthentication("),
    "the account unlock of section 22 asks for a fresh proof",
  );
  expect(
    unlockRoute.indexOf("requireTrustedDevice(") < unlockRoute.indexOf("requireFreshReauthentication("),
    "and asks it after the device trust, so a stranger learns nothing about freshness",
  );
  expect(reauthPage.includes("readStepUpState("), "the step-up screen reads the state it shows");
  expect(reauthPage.includes("<SessionKeeper"), "and keeps the token rotating while it is open");
  expect(
    reauthForm.includes('deviceProofHeaders("POST", "/api/auth/session/reauth"'),
    "the form signs the request with the device key",
  );
  expect(
    isSensitivePath("/api/auth/session/reauth"),
    "the step-up endpoint is one the platform will not act on without a proof",
  );
  expect(
    actorSource.includes("reauthenticatedAtEpochMs: resolution.row.reauthenticatedAtEpochMs"),
    "the session row is where the guard reads the instant from",
  );
  expect(
    actorSource.includes("mfaVerifiedAtEpochMs: resolution.row.mfaVerifiedAtEpochMs"),
    "and the sign in instant beside it",
  );

  const migration = await readFile(
    new URL("../../migrations/0091_sessions_reauthenticated_at.sql", import.meta.url),
    "utf8",
  );
  const sessionsMigration = await readFile(
    new URL("../../migrations/0010_sessions.sql", import.meta.url),
    "utf8",
  );

  // The two bounds live in two files, on purpose: `0010` wrote the column and its lower bound, and
  // `0091` adds only the upper one. A migration that re-adds the column cannot apply at all, which
  // is the mistake `checkNoRevisions` in the migrations gate now refuses.
  expect(
    sessionsMigration.includes("reauthenticated_at timestamptz") &&
      sessionsMigration.includes("sessions_reauthenticated_check"),
    "0010 owns the column and the lower bound",
  );
  expect(
    migration.includes("sessions_reauthenticated_within_row_check") &&
      !migration.includes("add column reauthenticated_at"),
    "0091 adds the upper bound and never the column",
  );
}

/** A row of `public.sessions`, in the shape STEP 054 reads and writes. */
interface SessionListRow {
  id: string;
  user_id: string;
  device_proof_key_id: string | null;
  issued_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  deleted_at: string | null;
}

/** A row of `public.device_proof_keys`, only the columns the list shows. */
interface SessionListDeviceRow {
  id: string;
  label: string | null;
  trusted_at: string | null;
  revoked_at: string | null;
  deleted_at: string | null;
}

interface SessionListWorld {
  readonly rest: RestClient;
  readonly sessions: SessionTokenStore;
  readonly audit: ReturnType<typeof createInMemoryAuditTrail>;
  readonly rows: SessionListRow[];
  readonly devices: SessionListDeviceRow[];
  /** Every query the service sent, in order. */
  readonly queries: string[];
  /** Clauses this double does not understand: a stale double must fail rather than match everything. */
  readonly unknown: string[];
}

/** The second live session of the owner, and the one the fixtures revoke. */
const SECOND_SESSION_ID = "018f3b1c-4444-7c2a-9d1e-2b3c4d5e6f73";
const REVOKED_SESSION_ID = "018f3b1c-5555-7c2a-9d1e-2b3c4d5e6f74";
const OTHER_SESSION_ID = "018f3b1c-6666-7c2a-9d1e-2b3c4d5e6f75";
const TRUSTED_DEVICE_ID = "018f3b1c-7777-7c2a-9d1e-2b3c4d5e6f76";
const UNTRUSTED_DEVICE_ID = "018f3b1c-8888-7c2a-9d1e-2b3c4d5e6f77";

/**
 * The rows the session list reads, in memory.
 *
 * It keeps the two facts the service depends on - a row belongs to one account, and a revoked row is
 * not live - because a double that matched every query would prove nothing about the filters the
 * service sends. An unknown clause is recorded rather than ignored.
 */
function sessionListWorld(): SessionListWorld {
  const rows: SessionListRow[] = [
    {
      id: SESSION_ID,
      user_id: USER_ID,
      device_proof_key_id: TRUSTED_DEVICE_ID,
      issued_at: new Date(NOW - 120_000).toISOString(),
      last_seen_at: new Date(NOW - 30_000).toISOString(),
      expires_at: new Date(NOW + 3_600_000).toISOString(),
      revoked_at: null,
      revocation_reason: null,
      deleted_at: null,
    },
    {
      id: SECOND_SESSION_ID,
      user_id: USER_ID,
      device_proof_key_id: UNTRUSTED_DEVICE_ID,
      issued_at: new Date(NOW - 600_000).toISOString(),
      last_seen_at: new Date(NOW - 300_000).toISOString(),
      expires_at: new Date(NOW + 1_800_000).toISOString(),
      revoked_at: null,
      revocation_reason: null,
      deleted_at: null,
    },
    {
      id: OTHER_SESSION_ID,
      user_id: OTHER_USER_ID,
      device_proof_key_id: TRUSTED_DEVICE_ID,
      issued_at: new Date(NOW - 60_000).toISOString(),
      last_seen_at: new Date(NOW - 60_000).toISOString(),
      expires_at: new Date(NOW + 3_600_000).toISOString(),
      revoked_at: null,
      revocation_reason: null,
      deleted_at: null,
    },
    {
      id: REVOKED_SESSION_ID,
      user_id: USER_ID,
      device_proof_key_id: TRUSTED_DEVICE_ID,
      issued_at: new Date(NOW - 900_000).toISOString(),
      last_seen_at: new Date(NOW - 900_000).toISOString(),
      expires_at: new Date(NOW + 600_000).toISOString(),
      revoked_at: new Date(NOW - 800_000).toISOString(),
      revocation_reason: "SIGNED_OUT",
      deleted_at: null,
    },
  ];
  const devices: SessionListDeviceRow[] = [
    { id: TRUSTED_DEVICE_ID, label: "Office laptop", trusted_at: new Date(NOW - 86_400_000).toISOString(), revoked_at: null, deleted_at: null },
    { id: UNTRUSTED_DEVICE_ID, label: null, trusted_at: null, revoked_at: null, deleted_at: null },
  ];
  const queries: string[] = [];
  const unknown: string[] = [];
  const audit = createInMemoryAuditTrail();

  function matches(query: string, row: SessionListRow): boolean {
    for (const clause of query.split("&")) {
      const separator = clause.indexOf("=");

      if (separator <= 0) {
        continue;
      }

      const key = clause.slice(0, separator);
      const raw = clause.slice(separator + 1);
      const value = decodeURIComponent(raw);

      if (key === "select" || key === "order" || key === "limit") {
        continue;
      }

      if (key === "id") {
        if (value.startsWith("eq.") && row.id !== decodeURIComponent(value.slice(3))) {
          return false;
        }

        if (value.startsWith("neq.") && row.id === decodeURIComponent(value.slice(4))) {
          return false;
        }

        if (value.startsWith("in.(")) {
          const listed = value
            .slice(4, -1)
            .split(",")
            .map((entry) => decodeURIComponent(entry));

          if (!listed.includes(row.id)) {
            return false;
          }
        }

        continue;
      }

      if (key === "user_id" && value.startsWith("eq.")) {
        if (row.user_id !== decodeURIComponent(value.slice(3))) {
          return false;
        }

        continue;
      }

      if (key === "revoked_at" || key === "deleted_at") {
        if (value === "is.null") {
          if (row[key] !== null) {
            return false;
          }

          continue;
        }
      }

      unknown.push(clause);
    }

    return true;
  }

  const rest: RestClient = {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      queries.push(`${table}?${query}`);

      if (table === "sessions") {
        return rows.filter((row) => matches(query, row)).map((row) => schema.parse(row));
      }

      if (table === "users") {
        const wanted = rows.some((row) => row.user_id === USER_ID) ? USER_ID : OTHER_USER_ID;

        return query.includes(`id=eq.${encodeURIComponent(wanted)}`) ? [schema.parse({ id: wanted })] : [];
      }

      if (table === "device_proof_keys") {
        return devices
          .filter((device) => query.includes(encodeURIComponent(device.id)) || devices.length > 0)
          .map((device) => schema.parse(device));
      }

      unknown.push(`table ${table}`);

      return [];
    },
    async insert(): Promise<void> {
      throw new AppError("INTERNAL_ERROR");
    },
    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new AppError("INTERNAL_ERROR");
    },
    async update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      queries.push(`update ${table}?${query}`);

      if (table !== "sessions") {
        unknown.push(`update ${table}`);

        return;
      }

      for (const row of rows) {
        if (matches(query, row)) {
          Object.assign(row as unknown as Record<string, unknown>, values);
        }
      }
    },
    async rpc(): Promise<unknown> {
      throw new AppError("INTERNAL_ERROR");
    },
  };

  return { rest, sessions: createRestSessionTokenStore(rest), audit, rows, devices, queries, unknown };
}

/**
 * STEP 054: the session list and the instant revoke.
 *
 * The service is proved against a table that keeps one account apart from another, because that is
 * the property the whole STEP rests on: a list that leaked a second account's session and a revoke
 * that could end one are the same defect in two directions. The routes are then read on disk for the
 * order of their checks, and the pages for the rotation they must keep.
 */
async function checkSessionList(): Promise<void> {
  // ---- the role list, and the reason it matches a list that already exists
  expectEqual(
    SESSION_MANAGEMENT_OFFICE_ROLES.join(","),
    ACCOUNT_UNLOCK_OFFICE_ROLES.join(","),
    "the session office roles are the roles that already handle merchants",
  );
  expectEqual(SESSION_LIST_LIMIT, 50, "the list stops at fifty sessions");

  // ---- the owner's list
  const world = sessionListWorld();
  const owner = officeActor({ roles: ["owner"], userId: USER_ID });
  const listed = await listOwnSessions(owner, {
    rest: world.rest,
    audit: world.audit,
    sessions: world.sessions,
    now: () => NOW,
  });

  expectEqual(listed.length, 2, "the list shows the owner's two live sessions");
  expectEqual(
    listed.some((session) => session.id === REVOKED_SESSION_ID),
    false,
    "a revoked session is not listed",
  );
  expectEqual(
    listed.some((session) => session.id === OTHER_SESSION_ID),
    false,
    "another account's session is never listed",
  );
  expectEqual(
    listed.find((session) => session.current)?.id,
    SESSION_ID,
    "the session asking is marked, not hidden",
  );
  expectEqual(
    listed.find((session) => session.id === SESSION_ID)?.deviceLabel,
    "Office laptop",
    "the row names the device it is bound to",
  );
  expectEqual(
    listed.find((session) => session.id === SECOND_SESSION_ID)?.deviceLabel,
    null,
    "a device with no label says so instead of inventing one",
  );
  expectEqual(
    listed.find((session) => session.id === SESSION_ID)?.deviceTrusted,
    true,
    "a confirmed device is reported as confirmed",
  );
  expectEqual(
    listed.find((session) => session.id === SECOND_SESSION_ID)?.deviceTrusted,
    false,
    "an unconfirmed device is reported as unconfirmed",
  );

  const listQuery = world.queries[0] ?? "";

  expect(listQuery.includes(`user_id=eq.${encodeURIComponent(USER_ID)}`), "the list is filtered by the actor's own account");
  expect(listQuery.includes("revoked_at=is.null"), "the list reads only live rows");
  expect(listQuery.includes("deleted_at=is.null"), "the list skips soft deleted rows");
  expect(listQuery.includes("&order=issued_at.desc"), "the newest session is first");
  expect(listQuery.includes("ip_address") === false, "the list selects no address");
  expect(listQuery.includes("user_agent") === false, "the list selects no user agent");
  expect(listQuery.includes("token_hash") === false, "the list never reads a token hash");

  await expectRejects(
    () =>
      listOwnSessions(
        { ...owner, sessionId: null },
        { rest: world.rest, audit: world.audit, sessions: world.sessions },
      ),
    "AUTHENTICATION_REQUIRED",
    "a caller without a session has no list",
  );

  // ---- the owner's revoke
  const own = sessionListWorld();
  const ownAudit = own.audit;

  await expectRejects(
    () =>
      revokeOwnSession(
        { actor: owner, sessionId: OTHER_SESSION_ID, ipAddress: null, userAgent: null },
        { rest: own.rest, audit: ownAudit, sessions: own.sessions, now: () => NOW },
      ),
    "RESOURCE_NOT_FOUND",
    "another account's session is not revocable and is not even acknowledged",
  );

  await expectRejects(
    () =>
      revokeOwnSession(
        { actor: owner, sessionId: REVOKED_SESSION_ID, ipAddress: null, userAgent: null },
        { rest: own.rest, audit: ownAudit, sessions: own.sessions, now: () => NOW },
      ),
    "RESOURCE_NOT_FOUND",
    "a session that already ended is refused instead of stamped twice",
  );

  await expectRejects(
    () =>
      revokeOwnSession(
        { actor: owner, sessionId: "../users", ipAddress: null, userAgent: null },
        { rest: own.rest, audit: ownAudit, sessions: own.sessions, now: () => NOW },
      ),
    "RESOURCE_NOT_FOUND",
    "an identifier that is not an identifier never reaches a query",
  );

  expectEqual(
    own.rows.find((row) => row.id === OTHER_SESSION_ID)?.revoked_at,
    null,
    "no refusal touched another account's row",
  );

  const revoked = await revokeOwnSession(
    { actor: owner, sessionId: SECOND_SESSION_ID, ipAddress: "203.0.113.7", userAgent: "test" },
    { rest: own.rest, audit: ownAudit, sessions: own.sessions, now: () => NOW },
  );
  const secondRow = own.rows.find((row) => row.id === SECOND_SESSION_ID);

  expectEqual(revoked.wasCurrent, false, "ending another session is not ending this one");
  expectEqual(secondRow?.revoked_at, new Date(NOW).toISOString(), "the revoked row carries the instant");
  expectEqual(secondRow?.revocation_reason, "SIGNED_OUT", "an owner's revoke is a sign out");
  expect(
    SESSION_REVOCATION_REASONS.includes("SIGNED_OUT"),
    "the reason written is one the migration already allows",
  );

  const ownerEntry = ownAudit.entries.at(-1);

  expectEqual(ownerEntry?.action, "session.revoked_by_owner", "the revoke is audited under its own name");
  expectEqual(ownerEntry?.actorUserId, USER_ID, "the audit names the account that acted");
  expectEqual(ownerEntry?.entityId, SECOND_SESSION_ID, "the audit names the session that ended");

  const self = await revokeOwnSession(
    { actor: owner, sessionId: SESSION_ID, ipAddress: null, userAgent: null },
    { rest: own.rest, audit: ownAudit, sessions: own.sessions, now: () => NOW },
  );

  expectEqual(self.wasCurrent, true, "ending the session asking is reported as such, so the screen can say so");

  // ---- every other session at once
  const everyone = sessionListWorld();
  const others = await revokeOtherOwnSessions(
    { actor: owner, ipAddress: null, userAgent: null },
    { rest: everyone.rest, audit: everyone.audit, sessions: everyone.sessions, now: () => NOW },
  );

  expectEqual(others, 1, "the count is the number of sessions that ended");
  expectEqual(
    everyone.rows.find((row) => row.id === SESSION_ID)?.revoked_at,
    null,
    "the session asking survives its own request",
  );
  expectEqual(
    everyone.rows.find((row) => row.id === SECOND_SESSION_ID)?.revocation_reason,
    "SIGNED_OUT",
    "the other sessions are signed out",
  );
  expectEqual(
    everyone.rows.find((row) => row.id === OTHER_SESSION_ID)?.revoked_at,
    null,
    "another account's live session is untouched",
  );
  expectEqual(
    everyone.audit.entries.at(-1)?.action,
    "session.others_revoked",
    "the sweep is audited with a name of its own",
  );
  expectEqual(
    (everyone.audit.entries.at(-1)?.payload as { readonly revoked_sessions?: unknown } | undefined)
      ?.revoked_sessions,
    1,
    "the audit entry says how many doors were closed",
  );

  const entriesAfterSweep = everyone.audit.entries.length;
  const again = await revokeOtherOwnSessions(
    { actor: owner, ipAddress: null, userAgent: null },
    { rest: everyone.rest, audit: everyone.audit, sessions: everyone.sessions, now: () => NOW },
  );

  expectEqual(again, 0, "a second sweep has nothing to end");
  expectEqual(everyone.audit.entries.length, entriesAfterSweep, "and writes no entry for nothing");

  // ---- the office half
  const office = sessionListWorld();
  const support = officeActor({ roles: ["support"] });
  const merchant = officeActor({ roles: ["owner"], userId: USER_ID });
  const finance = officeActor({ roles: ["finance_ops"] });

  await expectRejects(
    () =>
      listAccountSessions(
        { actor: merchant, userId: OTHER_USER_ID },
        { rest: office.rest, audit: office.audit, sessions: office.sessions },
      ),
    "PERMISSION_DENIED",
    "a merchant cannot read another account's sessions",
  );

  await expectRejects(
    () =>
      listAccountSessions(
        { actor: finance, userId: OTHER_USER_ID },
        { rest: office.rest, audit: office.audit, sessions: office.sessions },
      ),
    "PERMISSION_DENIED",
    "a role outside the four cannot read them either",
  );

  await expectRejects(
    () =>
      listAccountSessions(
        { actor: support, userId: "not-an-identifier" },
        { rest: office.rest, audit: office.audit, sessions: office.sessions },
      ),
    "RESOURCE_NOT_FOUND",
    "an account id that is not an identifier answers a plain not found",
  );

  const accountSessions = await listAccountSessions(
    { actor: support, userId: USER_ID },
    { rest: office.rest, audit: office.audit, sessions: office.sessions },
  );

  expectEqual(accountSessions.length, 2, "the office reads the account's live sessions");
  expectEqual(
    accountSessions.some((session) => session.current),
    false,
    "no row is marked current: the officer is not in this account",
  );
  expectEqual(
    office.audit.entries.at(-1)?.action,
    "session.list_read_by_office",
    "reading another account's sessions is audited",
  );
  expectEqual(
    office.audit.entries.at(-1)?.actorUserId,
    OTHER_USER_ID,
    "the read names the officer, not the account read",
  );

  await expectRejects(
    () =>
      revokeAccountSession(
        { actor: support, userId: OTHER_USER_ID, sessionId: SESSION_ID, ipAddress: null, userAgent: null },
        { rest: office.rest, audit: office.audit, sessions: office.sessions, now: () => NOW },
      ),
    "RESOURCE_NOT_FOUND",
    "a session id paired with the wrong account ends nothing",
  );

  await expectRejects(
    () =>
      revokeAccountSession(
        { actor: merchant, userId: OTHER_USER_ID, sessionId: OTHER_SESSION_ID, ipAddress: null, userAgent: null },
        { rest: office.rest, audit: office.audit, sessions: office.sessions, now: () => NOW },
      ),
    "PERMISSION_DENIED",
    "a merchant cannot end another account's session through the office path",
  );

  const officeRevoke = await revokeAccountSession(
    {
      actor: support,
      userId: USER_ID,
      sessionId: SECOND_SESSION_ID,
      ipAddress: "203.0.113.7",
      userAgent: "test",
    },
    { rest: office.rest, audit: office.audit, sessions: office.sessions, now: () => NOW },
  );
  const officeRow = office.rows.find((row) => row.id === SECOND_SESSION_ID);
  const officeEntry = office.audit.entries.at(-1);

  expectEqual(officeRevoke.sessionId, SECOND_SESSION_ID, "the office revoke answers the session it ended");
  expectEqual(officeRow?.revocation_reason, "ADMIN_REVOKED", "an office revoke is recorded as one");
  expect(
    SESSION_REVOCATION_REASONS.includes("ADMIN_REVOKED"),
    "the office reason is in the vocabulary the migration closed",
  );
  expectEqual(officeEntry?.action, "session.revoked_by_office", "the office revoke has its own audit name");
  expectEqual(officeEntry?.actorUserId, OTHER_USER_ID, "the audit names the officer as the actor");
  expectEqual(
    (officeEntry?.payload as { readonly subject_user_id?: unknown } | undefined)?.subject_user_id,
    USER_ID,
    "and names the account whose session ended",
  );

  // ---- the deferred clauses: none, or the double is stale
  for (const each of [world, own, everyone, office]) {
    expectEqual(each.unknown.length, 0, "the double understood every clause the service sent");
  }

  // ---- the vocabulary of the audit actions
  const actions = ["session.revoked_by_owner", "session.others_revoked", "session.list_read_by_office", "session.revoked_by_office"];

  for (const action of actions) {
    expectEqual(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test(action), true, `the audit name "${action}" matches the catalog pattern`);
    expect(action.length <= 64, `the audit name "${action}" fits in sixty four characters`);
  }

  // ---- the service, on disk
  const serviceSource = await readFile(new URL("./session-list.ts", import.meta.url), "utf8");

  expectEqual(
    serviceSource.split("requireAnyRole(").length - 1,
    2,
    "both office functions check the role themselves",
  );

  for (const action of actions) {
    expectEqual(serviceSource.split(`"${action}"`).length - 1, 1, `the service writes "${action}" once`);
  }

  for (const column of ["ip_address", "user_agent", "fingerprint", "token_hash"]) {
    expectEqual(
      serviceSource.includes(column),
      false,
      `the session list never touches ${column}`,
    );
  }

  // ---- the routes and the pages, on disk
  const appSources = await readAppTree();
  const readApp = (path: string): string => appSourceOf(appSources, path);

  const ownerRevokeRoute = readApp("/api/auth/sessions/revoke/route.ts");
  const officeRevokeRoute = readApp("/api/office/sessions/revoke/route.ts");

  expect(ownerRevokeRoute.includes("verifySensitiveRequest("), "the owner's revoke is a signed request");
  expectEqual(
    ownerRevokeRoute.includes("requireFreshReauthentication"),
    false,
    "the owner's revoke is not gated on freshness: closing a door should never wait",
  );
  expect(
    ownerRevokeRoute.indexOf("readRequestActor(") < ownerRevokeRoute.indexOf("JSON.parse("),
    "the actor is read before the body is parsed",
  );

  expect(officeRevokeRoute.includes("verifySensitiveRequest("), "the office revoke is a signed request");
  expect(officeRevokeRoute.includes("requireFreshReauthentication(actor)"), "the office revoke needs the fresh window");
  expect(
    officeRevokeRoute.indexOf("verifySensitiveRequest(") <
      officeRevokeRoute.indexOf("requireFreshReauthentication(actor)"),
    "the proof is checked before the freshness, so a stranger learns nothing about the clock",
  );
  expect(
    officeRevokeRoute.indexOf("requireFreshReauthentication(actor)") <
      officeRevokeRoute.indexOf("JSON.parse("),
    "and both before the body is read",
  );

  expect(readApp("/api/auth/sessions/route.ts").includes("listOwnSessions("), "the owner's read calls the service");
  expect(
    readApp("/office/sessions/page.tsx").includes("listAccountSessions("),
    "the office page reads through the service, where the role check lives",
  );
  expectEqual(
    readApp("/api/office/sessions/route.ts").includes("SESSION_MANAGEMENT_OFFICE_ROLES"),
    false,
    "the office route adds no second copy of the role list",
  );
  expect(
    readApp("/office/sessions/page.tsx").includes("searchParams"),
    "the office page asks for an account instead of guessing one",
  );

  for (const path of ["/(auth)/sessions/page.tsx", "/office/sessions/page.tsx"]) {
    expect(readApp(path).includes("<SessionKeeper"), `the page ${path} keeps the token rotating`);
  }

  // ---- the two lists a request must be signed for, and the two surfaces that are classified
  expect(
    SENSITIVE_ENDPOINTS.some((endpoint) => endpoint.path === "/api/auth/sessions/revoke"),
    "the owner's revoke is on the signed endpoint list",
  );
  expect(
    SENSITIVE_ENDPOINTS.some((endpoint) => endpoint.path === "/api/office/sessions/revoke"),
    "the office revoke is on the signed endpoint list",
  );
  expect(classifiedPaths().includes("/api/auth/sessions"), "the owner's list is a classified surface");
  expect(
    classifiedPaths().includes("/api/auth/sessions/revoke"),
    "the owner's revoke is a classified surface",
  );
}

/** Every `.ts` and `.tsx` file under `app/`, read once and keyed by its path from the app root. */
async function readAppTree(): Promise<readonly { readonly path: string; readonly source: string }[]> {
  const root = new URL("../../app/", import.meta.url);
  const entries = await readdir(root, { recursive: true });

  return Promise.all(
    entries
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".tsx") || entry.endsWith(".ts"))
      .map(async (entry) => ({
        path: `/${entry}`,
        source: await readFile(new URL(entry, root), "utf8"),
      })),
  );
}

/** The source of one app file, or an empty string so a missing file fails its own assertion. */
function appSourceOf(
  sources: readonly { readonly path: string; readonly source: string }[],
  path: string,
): string {
  return sources.find((file) => file.path === path)?.source ?? "";
}

/** The one statement `consume_rate_limit` answers with, as the REST client can return it. */
function rateLimitAnswer(options: {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly firstRefusal: boolean;
}): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      allowed: options.allowed,
      remaining: options.remaining,
      retry_after_seconds: options.retryAfterSeconds,
      first_refusal: options.firstRefusal,
    },
  ];
}

/**
 * STEP 055: IP based rate limiting on the authentication endpoints.
 *
 * Two things are proved here, and they are the two a limiter can get wrong. The **policy** half is a
 * statement about the tree: every auth route must name its scope, must call the limiter before it
 * reads a body or a session, and no scope may exist without an endpoint. The **counting** half is a
 * statement about the service: the address is canonicalised before it is hashed, a refusal is a `429`
 * that carries the wait, an address-less request is refused rather than allowed, and the audit entry
 * is written once per window rather than once per request.
 *
 * The database half - that `consume_rate_limit` increments and answers in one statement - cannot be
 * proved by an in-memory double, which is why this check also reads `0092` and why the STEP carries a
 * PGlite replay of the function beside it.
 */
async function checkRateLimit(): Promise<void> {
  // ---- the catalog entry the screens and the headers depend on
  expectEqual(ERROR_CODES.RATE_LIMITED.status, 429, "a limited request answers 429");
  expectEqual(ERROR_CODES.RATE_LIMITED.retryable, true, "and is retryable, so the answer carries a wait");
  expect(
    isAllowedOnSurface("/api/auth/signin", "RATE_LIMITED"),
    "an anonymous surface may already answer the code, so no disclosure rule changes",
  );
  expectEqual(
    /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/.test(RATE_LIMIT_AUDIT_ACTION),
    true,
    "the audit action matches the catalog pattern",
  );
  expect(RATE_LIMIT_AUDIT_ACTION.length <= 64, "and fits the audit action ceiling");

  // ---- the policy: one scope per auth route, and no scope without a route
  const authRoot = new URL("../../app/api/auth/", import.meta.url);
  const authEntries = (await readdir(authRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith("/route.ts"))
    .sort();

  expectEqual(authEntries.length, 15, "fifteen authentication routes exist");
  expectEqual(
    authEntries.length,
    Object.keys(RATE_LIMITED_PATHS).length,
    "and every one of them has a scope",
  );
  expectEqual(
    RATE_LIMIT_SCOPES.length,
    Object.keys(RATE_LIMITED_PATHS).length,
    "no policy is written for an endpoint that does not exist",
  );

  for (const scope of RATE_LIMIT_SCOPES) {
    const policy = RATE_LIMIT_POLICIES[scope];

    expect(policy !== undefined, `the scope ${scope} has a policy`);
    expect(Number.isInteger(policy.limit) && policy.limit >= 1, `the limit of ${scope} is a positive integer`);
    expect(
      Number.isInteger(policy.windowSeconds) && policy.windowSeconds >= 1 && policy.windowSeconds <= 86_400,
      `the window of ${scope} is between a second and a day`,
    );
    expect(
      RATE_LIMIT_SCOPES.includes(scope),
      `the policy key ${scope} is a scope, so the two lists cannot drift`,
    );
  }

  // Session rotation is the loosest because every open tab rotates; the reset request is the
  // tightest because each one is a message to the office.
  expectEqual(
    RATE_LIMIT_POLICIES.session_rotate.limit,
    Math.max(...RATE_LIMIT_SCOPES.map((scope) => RATE_LIMIT_POLICIES[scope].limit)),
    "session rotation carries the loosest limit",
  );
  expectEqual(
    RATE_LIMIT_POLICIES.two_factor_reset.limit,
    Math.min(...RATE_LIMIT_SCOPES.map((scope) => RATE_LIMIT_POLICIES[scope].limit)),
    "the second factor reset carries the tightest",
  );

  // ---- the routes, on disk
  for (const [path, scope] of Object.entries(RATE_LIMITED_PATHS)) {
    const routePath = `${path.replace("/api/auth/", "").slice(0)}/route.ts`;
    const source = await readFile(new URL(routePath, authRoot), "utf8");

    expectEqual(
      source.split("enforceRateLimit(").length - 1,
      1,
      `${path} calls the limiter exactly once`,
    );
    expect(
      source.includes(`scope: "${scope}"`),
      `${path} is counted under its own scope`,
    );
    expect(
      source.indexOf("enforceRateLimit(") < source.indexOf("request.text()") ||
        !source.includes("request.text()"),
      `${path} is counted before the body is read`,
    );
    expect(
      source.indexOf("enforceRateLimit(") < source.indexOf("JSON.parse(") ||
        !source.includes("JSON.parse("),
      `${path} is counted before the body is parsed`,
    );
    expectEqual(
      rateLimitScopeForPath(path),
      scope,
      `the scope lookup answers ${scope} for ${path}`,
    );
  }

  expectEqual(rateLimitScopeForPath("/api/office/sessions"), null, "an office route is not an auth route");

  // ---- one address, one key
  expectEqual(
    canonicalClientAddress("2001:0db8:0000:0000:0000:0000:0000:0001"),
    "2001:db8::1",
    "an IPv6 address is canonicalised before it is counted",
  );
  expectEqual(
    canonicalClientAddress("::1"),
    "::1",
    "the loopback keeps its one spelling",
  );
  expectEqual(canonicalClientAddress("203.0.113.7"), "203.0.113.7", "an IPv4 address is unchanged");
  expectEqual(
    rateLimitKeyHash("2001:0db8::1"),
    rateLimitKeyHash("2001:0db8:0000:0000:0000:0000:0000:0001"),
    "two spellings of one address share one counter",
  );
  expectEqual(
    rateLimitKeyHash("203.0.113.7").length,
    64,
    "the key is a sha256 in hex, so it fits the column check",
  );
  expect(
    isRateLimitKeyHash(rateLimitKeyHash("203.0.113.7")),
    "and is recognisable as one",
  );
  expectEqual(
    rateLimitKeyHash("203.0.113.7").includes("203"),
    false,
    "the address itself is not in the key",
  );

  // ---- the count, as the service performs it
  const calls: { readonly fn: string; readonly args: Readonly<Record<string, unknown>> }[] = [];
  const allowedBody = rateLimitAnswer({ allowed: true, remaining: 2, retryAfterSeconds: 0, firstRefusal: false });
  const refusedBody = rateLimitAnswer({ allowed: false, remaining: 0, retryAfterSeconds: 42, firstRefusal: true });
  const counterRest: RestClient = {
    async select<TRow>(): Promise<readonly TRow[]> {
      throw new AppError("INTERNAL_ERROR");
    },
    async insert(): Promise<void> {
      throw new AppError("INTERNAL_ERROR");
    },
    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new AppError("INTERNAL_ERROR");
    },
    async update(): Promise<void> {
      throw new AppError("INTERNAL_ERROR");
    },
    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      calls.push({ fn: functionName, args: arguments_ });

      return arguments_["p_scope"] === "signin" ? refusedBody : allowedBody;
    },
  };

  const allowedDecision = await consumeRateLimit(
    { scope: "signup", address: "203.0.113.7" },
    { rest: counterRest, audit: createInMemoryAuditTrail(), now: () => NOW },
  );

  expectEqual(allowedDecision.allowed, true, "an allowed answer is passed through");
  expectEqual(allowedDecision.remaining, 2, "with what is left of the window");
  expectEqual(allowedDecision.retryAfterSeconds, 0, "and no wait");
  expectEqual(calls.at(-1)?.fn, "consume_rate_limit", "the decision is the function's, not the service's");
  expectEqual(calls.at(-1)?.args["p_scope"], "signup", "the scope is the endpoint's name");
  expectEqual(
    calls.at(-1)?.args["p_limit"],
    RATE_LIMIT_POLICIES.signup.limit,
    "the limit sent is the policy's",
  );
  expectEqual(
    calls.at(-1)?.args["p_window_seconds"],
    RATE_LIMIT_POLICIES.signup.windowSeconds,
    "the window sent is the policy's",
  );
  expectEqual(
    calls.at(-1)?.args["p_now"],
    new Date(NOW).toISOString(),
    "the instant is the injected clock, so the window is testable",
  );
  expectEqual(
    calls.at(-1)?.args["p_key_hash"],
    rateLimitKeyHash("203.0.113.7"),
    "the key sent is the hash of the address, never the address",
  );

  const wrongShape: RestClient = {
    ...counterRest,
    async rpc(): Promise<unknown> {
      return { allowed: true };
    },
  };

  await expectRejects(
    () =>
      consumeRateLimit(
        { scope: "signin", address: "203.0.113.7" },
        { rest: wrongShape, audit: createInMemoryAuditTrail() },
      ),
    "DEPENDENCY_FAILED",
    "an answer the service cannot read is a dependency failure, not an allow",
  );

  // ---- the guard a route calls
  const refusedAudit = createInMemoryAuditTrail();
  const refusedRequest = new Request("https://example.test/api/auth/signin", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  const refusal = await captureRejection(
    () => enforceRateLimit({ request: refusedRequest, scope: "signin" }, { rest: counterRest, audit: refusedAudit, now: () => NOW }),
    "a limited request is refused",
  );

  expectEqual(refusal.code, "RATE_LIMITED", "with the code the catalog gives 429");
  expectEqual(refusal.retryAfterSeconds, 42, "and the wait the counter answered");
  expectEqual(refusedAudit.entries.length, 1, "the first refusal of a window is audited once");
  expectEqual(refusedAudit.entries[0]?.action, RATE_LIMIT_AUDIT_ACTION, "under the rate limit action");
  expectEqual(refusedAudit.entries[0]?.ipAddress, "203.0.113.7", "the audit entry names the address");
  expectEqual(
    (refusedAudit.entries[0]?.payload as { readonly scope?: unknown } | undefined)?.scope,
    "signin",
    "and the endpoint it was refused on",
  );
  expectEqual(refusedAudit.entries[0]?.actorUserId, null, "no account is named, because none was read");

  const allowedAudit = createInMemoryAuditTrail();
  await enforceRateLimit(
    { request: refusedRequest, scope: "signup" },
    { rest: counterRest, audit: allowedAudit, now: () => NOW },
  );

  expectEqual(allowedAudit.entries.length, 0, "an allowed request writes no audit entry");

  const repeatRefusal = createInMemoryAuditTrail();
  const repeatRest: RestClient = {
    ...counterRest,
    async rpc(): Promise<unknown> {
      return rateLimitAnswer({ allowed: false, remaining: 0, retryAfterSeconds: 42, firstRefusal: false });
    },
  };

  await expectRejects(
    () =>
      enforceRateLimit(
        { request: refusedRequest, scope: "signin" },
        { rest: repeatRest, audit: repeatRefusal, now: () => NOW },
      ),
    "RATE_LIMITED",
    "a later refusal in the same window is refused too",
  );
  expectEqual(repeatRefusal.entries.length, 0, "and is not audited again, so an attack is one entry per window");

  const addressless = new Request("https://example.test/api/auth/signin", { method: "POST" });

  await expectRejects(
    () =>
      enforceRateLimit(
        { request: addressless, scope: "signin" },
        { rest: counterRest, audit: createInMemoryAuditTrail(), now: () => NOW },
      ),
    "SERVICE_UNAVAILABLE",
    "a request that carries no address is refused rather than allowed unlimited",
  );
  expectEqual(
    calls.filter((call) => call.args["p_scope"] === "signin" && call.args["p_now"] === undefined).length,
    0,
    "and the counter is not asked about an address that does not exist",
  );

  // ---- the sentence a screen shows for a refusal
  const refusalSource = await readFile(new URL("./refusal-message.ts", import.meta.url), "utf8");

  expectEqual(
    refusalSource.includes('from "node:'),
    false,
    "the refusal sentence is client safe: it imports nothing from Node",
  );
  expect(
    refusalSource.includes('formatMessage("rateLimit.waitWithMinutes"'),
    "a long wait is said in minutes",
  );
  expect(
    refusalSource.includes('formatMessage("rateLimit.wait"'),
    "a short one in seconds",
  );

  const clientSources = await readAppTree();

  for (const [path, file] of [
    ["/api/auth/signin", "/(auth)/signin/signin-form.tsx"],
    ["/api/auth/signup", "/(auth)/signup/signup-form.tsx"],
    ["/api/auth/devices/confirm", "/(auth)/devices/confirm/device-confirm-form.tsx"],
    ["/api/auth/sessions/revoke", "/(auth)/sessions/session-list.tsx"],
    ["/api/office/sessions/revoke", "/office/sessions/office-session-list.tsx"],
  ] as const) {
    const source = appSourceOf(clientSources, file);

    expect(
      source.includes("rateLimitSentence("),
      `the screen of ${path} says how long the wait is`,
    );
  }

  expect(
    appSourceOf(clientSources, "/office/2fa-reset-requests/office-reset-queue.tsx").includes(
      "rateLimitSentence(",
    ),
    "the office decision screen says how long the wait is too",
  );

  // ---- the migration, on disk
  const migration = await readFile(new URL("../../migrations/0092_rate_limit_windows.sql", import.meta.url), "utf8");
  const rollback = await readFile(
    new URL("../../migrations/0092_rate_limit_windows.down.sql", import.meta.url),
    "utf8",
  );

  expect(migration.includes("create table public.rate_limit_windows"), "0092 creates the counter table");
  expect(migration.includes("create function public.consume_rate_limit("), "and the one statement that moves it");
  expect(
    migration.includes("on conflict on constraint rate_limit_windows_scope_key_unique do update"),
    "the increment is an upsert, so two simultaneous attempts serialise on the row",
  );
  expect(migration.includes("where counter_row.window_started_at < window_start"), "a lapsed window is reset in place");
  expectEqual(
    migration.split("set search_path = ''").length - 1,
    1,
    "the function pins its search path, so no caller can redirect it",
  );
  expectEqual(
    migration.includes("security definer"),
    false,
    "it runs with the caller's rights, like every other function of this schema",
  );
  expectEqual(
    migration.includes("delete from"),
    false,
    "a forward migration removes no rows; retention belongs to the cleanup job",
  );
  expect(rollback.includes("drop function if exists public.consume_rate_limit("), "the rollback drops the function");
  expect(rollback.includes("drop table if exists public.rate_limit_windows;"), "and then the table");
}

/**
 * STEP 056: the three places that take a person's words run them through the sanitiser.
 *
 * A library nobody calls is a library that does not protect anything, so this check reads the call
 * sites as well as the behaviour: the counts prove the schema still has its `.transform`, and the
 * parse proves the transform is the sanitiser rather than an identity function. The corpus of attack
 * strings lives in `lib/security/verify.ts`, which is one module's proof; what belongs here is the
 * claim that *this* platform's inputs go through it.
 */
async function checkSanitizerWiring(): Promise<void> {
  const registrationSource = await readFile(new URL("./registration.ts", import.meta.url), "utf8");
  const resetSource = await readFile(new URL("./two-factor-reset.ts", import.meta.url), "utf8");
  const unlockSource = await readFile(new URL("./account-unlock.ts", import.meta.url), "utf8");

  expectEqual(
    registrationSource.split("sanitizeSingleLineText(").length - 1,
    2,
    "the signup name and company name are sanitised",
  );
  expectEqual(
    registrationSource.split(".transform(").length - 1 >= 2,
    true,
    "and the sanitiser runs inside the schema, so no path can skip it",
  );
  expectEqual(
    resetSource.split("sanitizeMultilineText(").length - 1,
    2,
    "the reset request reason and the decision note are sanitised",
  );
  expectEqual(
    resetSource.split("sanitizeSingleLineText(").length - 1,
    1,
    "and the document reference the officer records",
  );
  expectEqual(
    unlockSource.split("sanitizeMultilineText(").length - 1,
    1,
    "the unlock note is sanitised",
  );

  const clean = signupInputSchema.parse({
    fullName: "A\u0000li\u202ece",
    email: "owner@example.com",
    password: "CorrectHorse9!",
    companyName: "  K.D.\u200b Trading  ",
    acceptedPolicies: ["kyc_kyb"],
    turnstileToken: null,
  });

  expectEqual(clean.fullName, "Alice", "a name is stripped of the null byte and the override before it is used");
  expectEqual(clean.companyName, "K.D. Trading", "and so is a company name, which keeps its punctuation");
  expectEqual(
    signupInputSchema.parse({
      fullName: "ordinary name",
      email: "owner@example.com",
      password: "CorrectHorse9!",
      companyName: "Ordinary Company",
      acceptedPolicies: ["kyc_kyb"],
      turnstileToken: null,
    }).fullName,
    "ordinary name",
    "while ordinary text passes through unchanged",
  );
}

/**
 * STEP 057: the double submit token on every mutation.
 *
 * A CSRF defence is only as good as its coverage, so this check is mostly a statement about the tree:
 * every route that answers a `POST` must call the guard, and every browser file that sends one must
 * carry the header. The behaviour half then proves the four ways a request can fail - no cookie, no
 * header, a malformed value and a value that does not match - all answer the same sentence, and that
 * the token endpoint is anonymous, rate limited and classified like every other auth route.
 */
async function checkCsrfProtection(): Promise<void> {
  // ---- the token, as a value
  const token = createCsrfToken();

  expectEqual(CSRF_TOKEN_PATTERN.test(token), true, "a token has the one shape the pattern allows");
  expectEqual(token.length, 43, "and is 43 base64url characters, which is 32 bytes");
  expectEqual(createCsrfToken() === createCsrfToken(), false, "two tokens are never the same one");
  expectEqual(CSRF_TOKEN_PATTERN.test("short"), false, "a short value is not a token");
  expectEqual(CSRF_TOKEN_PATTERN.test(`${"a".repeat(43)}!`), false, "and neither is a longer one with a symbol");

  const securePolicy = csrfPolicy({ secure: true });
  const insecurePolicy = csrfPolicy({ secure: false });
  const cookie = csrfCookie(token, securePolicy);

  expectEqual(securePolicy.cookieName, "__Host-kd_csrf", "the secure cookie carries the host-only prefix");
  expectEqual(insecurePolicy.cookieName, "kd_csrf", "and a development deployment uses the bare name");
  expect(cookie.startsWith(`__Host-kd_csrf=${token}`), "the cookie value is the token");
  expect(cookie.includes("Path=/"), "it is rooted, which the prefix requires");
  expect(cookie.includes("Secure"), "and Secure, which the prefix also requires");
  expect(cookie.includes("SameSite=Strict"), "it is strict, so another site never sends it");
  expectEqual(cookie.includes("HttpOnly"), false, "and it is readable, because the page must send it back");
  expect(cookie.includes("Domain=") === false, "it carries no Domain, or the prefix would be refused");
  expect(csrfCookie(token, insecurePolicy).includes("Secure") === false, "the development cookie is not Secure");

  // ---- reading it back
  expectEqual(readCsrfCookie(`a=1; __Host-kd_csrf=${token}; b=2`, securePolicy), token, "the cookie of the header is read");
  expectEqual(readCsrfCookie(`kd_csrf=${token}`, securePolicy), null, "and the other name is not it");
  expectEqual(readCsrfCookie(`__Host-kd_csrf=${token}`, insecurePolicy), null, "the reverse holds too");
  expectEqual(readCsrfCookie(null, securePolicy), null, "no header is no token");
  expectEqual(readCsrfCookie(`__Host-kd_csrf=bad`, securePolicy), null, "a malformed value is no token");

  expectEqual(csrfTokensMatch(token, token), true, "a token matches itself");
  expectEqual(csrfTokensMatch(token, createCsrfToken()), false, "and not another one");
  expectEqual(csrfTokensMatch(token, "short"), false, "nor a value of another length");

  // ---- the decision, and the one sentence every failure earns
  const withBoth = (headerToken: string, cookieToken: string): Request =>
    new Request("https://example.test/api/auth/signin", {
      method: "POST",
      headers: { cookie: `__Host-kd_csrf=${cookieToken}`, "x-csrf-token": headerToken },
    });

  expectEqual(verifyCsrfRequest(withBoth(token, token)).ok, true, "a request carrying both halves passes");
  expectEqual(verifyCsrfRequest(new Request("https://example.test/", { method: "POST" })).reason, "missing_cookie", "no cookie is the first refusal");
  expectEqual(
    verifyCsrfRequest(
      new Request("https://example.test/", { method: "POST", headers: { cookie: `__Host-kd_csrf=${token}` } }),
    ).reason,
    "missing_header",
    "a cookie without the header is the second",
  );
  expectEqual(
    verifyCsrfRequest(
      new Request("https://example.test/", {
        method: "POST",
        headers: { cookie: `__Host-kd_csrf=${token}`, "x-csrf-token": "not-a-token" },
      }),
    ).reason,
    "malformed_token",
    "a value that is not a token is the third",
  );
  expectEqual(verifyCsrfRequest(withBoth(createCsrfToken(), token)).reason, "mismatch", "and two different tokens the fourth");

  const refusal = await captureRejection(
    () => Promise.resolve(requireCsrfToken(new Request("https://example.test/", { method: "POST" }))),
    "the guard refuses a request with no token",
  );

  expectEqual(refusal?.code, "VALIDATION_FAILED", "with the catalogue's validation code");
  expectEqual(refusal?.details[0]?.field, CSRF_FIELD, "naming the csrf field");
  expectEqual(refusal?.details[0]?.rule, CSRF_RULE, "and one rule for every way it can fail");
  expectEqual(
    isAllowedOnSurface("/api/auth/signin", "VALIDATION_FAILED"),
    true,
    "which the sign in surface is allowed to answer",
  );
  expectEqual(
    isAllowedOnSurface("/api/auth/signin", "PERMISSION_DENIED"),
    false,
    "unlike the code a role failure uses, which is why this one is not that",
  );
  expectEqual(requireCsrfToken(withBoth(token, token)), token, "and the guard answers the token it accepted");

  // ---- the routes: every mutation is protected, and protected first
  const appSources = await readAppTree();
  const postRoutes = appSources
    .filter((file) => file.path.startsWith("/api/") && file.path.endsWith("/route.ts"))
    .filter((file) => file.source.includes("export const POST"))
    .map((file) => file.path.replace("/", "/api/").replace("/api/api/", "/api/").replace(/\/route\.ts$/u, ""))
    .sort();

  expectEqual(postRoutes.length, CSRF_PROTECTED_PATHS.length, "every route that answers a POST is on the protected list");
  expectEqual(
    postRoutes.join(","),
    [...CSRF_PROTECTED_PATHS].sort().join(","),
    "and the list names exactly those routes",
  );

  /**
   * The source a protected route is judged by: its own file, plus any file it builds its handlers from.
   *
   * A route that re-exports the handler of another route - the way `/api/services` re-exports
   * `/api/products`' handler for the second catalogue - holds no `requireCsrfToken` of its own, and
   * judging it alone would fail a route whose token check is one file away. So an import of another
   * `route` module is followed once and the two sources are read together.
   */
  const routeChain = (path: string): string => {
    const own = appSourceOf(appSources, `${path}/route.ts`);

    for (const match of own.matchAll(/from "([^"]*\/route)"/gu)) {
      const tail = (match[1] ?? "")
        .split("/")
        .filter((part) => part !== "" && part !== "." && part !== "..");
      const target = appSources.find(
        (candidate) => candidate.path !== `${path}/route.ts` && candidate.path.endsWith(`/${tail.join("/")}.ts`),
      );

      if (target !== undefined) {
        return `${own}\n${target.source}`;
      }
    }

    return own;
  };

  /**
   * The source of one exported handler, from its `export const NAME` to the next one.
   *
   * A route file holds several handlers and each answers its own method: the mutating ones must check
   * the token before they look the session up, and the reading ones have no token to check. Counting
   * across the whole file cannot tell those apart, so a route that serves a `GET` beside its `POST`
   * would fail an assertion its `POST` satisfies - which is what `/api/clients/[id]` did on `main`
   * before this change. Splitting on the exports is the smallest thing that measures the rule the
   * assertion is named for.
   */
  const handlersOf = (source: string): readonly string[] => {
    const starts = [...source.matchAll(/^export const (GET|POST|PUT|PATCH|DELETE)\b/gmu)];

    return starts.map((match, index) => {
      const from = match.index ?? 0;
      const to = starts[index + 1]?.index ?? source.length;

      return source.slice(from, to);
    });
  };

  const isMutating = (handler: string): boolean => /^export const (POST|PUT|PATCH|DELETE)\b/u.test(handler);

  /**
   * A handler that points at another one instead of implementing it: `= handlers.POST`,
   * `= createCatalogueRoute(kind)`.
   *
   * The two catalogues of section 15 are one implementation mounted at four addresses, so the second
   * route's handler is the first route's handler under another name. Its token check is therefore one
   * file away - inside the factory, or inside the route it re-exports - and that is the case the
   * assertions below follow rather than fail.
   */
  const delegatesOf = (handler: string): boolean =>
    /^export const (GET|POST|PUT|PATCH|DELETE) = [A-Za-z_$][\w$.]*(\([^;]*\))?;\s*$/u.test(handler.trim());

  for (const path of CSRF_PROTECTED_PATHS) {
    const routePath = `${path.replace("/api/", "")}/route.ts`;
    const source = routePath.startsWith("office/")
      ? appSourceOf(appSources, `/api/office/${routePath.slice("office/".length)}`)
      : routePath.startsWith("auth/")
        ? appSourceOf(appSources, `/api/auth/${routePath.slice("auth/".length)}`)
        : appSourceOf(appSources, `/api/${routePath}`);

    expect(source.length > 0, `${path} exists on disk`);

    const chain = routeChain(path);
    const own = handlersOf(source);
    const mutating = own.filter(isMutating);

    expect(mutating.length > 0, `${path} answers a mutation`);
    expect(chain.includes("requireCsrfToken("), `${path} checks the token`);

    for (const handler of mutating) {
      if (delegatesOf(handler)) {
        // The check is inside the factory or the route this handler names, which the chain covers.
        continue;
      }

      expect(handler.includes("requireCsrfToken("), `${path} has a mutating handler that checks the token`);

      const token = handler.indexOf("requireCsrfToken(");
      const session = handler.indexOf("readRequestActor(");
      const body = handler.indexOf("request.text()");

      expect(session === -1 || token < session, `${path} checks the token before it looks the session up`);
      expect(body === -1 || token < body, `${path} checks the token before it reads the body`);
    }

    // A reading handler has no token to check and no body to read: a `GET` that parsed one would be a
    // read that could be turned into a write by the body it accepted.
    for (const handler of own.filter((candidate) => !isMutating(candidate))) {
      expect(!handler.includes("request.text()"), `${path} reads no body on a handler that changes nothing`);
    }

    if (path.startsWith("/api/auth/")) {
      expect(
        source.indexOf("enforceRateLimit(") < source.indexOf("requireCsrfToken("),
        `${path} counts the request before it judges the token`,
      );
    }
  }

  // ---- the client: every browser file that mutates carries the header
  //
  // A mutation is not only a POST. A `DELETE` changes state and needs the same token, and until STEP 113
  // the two browser files that only ever deleted (`clients/[id]`, `products/[id]`) were counted by
  // neither check: a file with no POST never entered this list, so nothing asserted it carried the
  // token. The line editor is the first file that posts *and* deletes, which is what surfaced the gap.
  // Counting every mutating method closes it, and the two delete-only files are now covered.
  const MUTATION_METHODS = ['method: "POST"', 'method: "DELETE"'] as const;
  const mutationCalls = (source: string): number =>
    MUTATION_METHODS.reduce((total, marker) => total + source.split(marker).length - 1, 0);
  const browserMutations = appSources
    .filter((file) => mutationCalls(file.source) > 0)
    .map((file) => file.path)
    .sort();

  expectEqual(browserMutations.length, 41, "forty one browser files send a mutation");
  expectEqual(
    browserMutations.reduce((total, path) => total + mutationCalls(appSourceOf(appSources, path)), 0),
    49,
    "across forty nine call sites",
  );
  const postCalls = mutationCalls;
  const tokenSpreads = (source: string): number =>
    (source.match(/\.\.\.csrf\b/gu)?.length ?? 0) + (source.match(/\.\.\.\(await csrfHeaders\(\)\)/gu)?.length ?? 0);

  expectEqual(
    browserMutations.every((path) => appSourceOf(appSources, path).includes("csrfHeaders(")),
    true,
    "and every one of them asks for the token",
  );
  expectEqual(
    browserMutations.every((path) => tokenSpreads(appSourceOf(appSources, path)) === postCalls(appSourceOf(appSources, path))),
    true,
    "spreading it into the headers of every mutation it sends, one spread per call",
  );
  expect(
    appSourceOf(appSources, "/(auth)/signin/signin-form.tsx").includes("csrfHeaders("),
    "the sign in form carries it, which is the one form with no session yet",
  );

  // ---- the token endpoint
  const tokenRoute = appSourceOf(appSources, "/api/auth/csrf/route.ts");

  expect(tokenRoute.length > 0, "the token endpoint exists");
  expect(tokenRoute.includes("csrfCookie("), "it installs the cookie it answers with");
  expect(tokenRoute.includes('"cache-control": "no-store"'), "and is never cached, because one token per cache is a shared token");
  expect(tokenRoute.includes('scope: "csrf"'), "it is rate limited like every other auth route");
  expectEqual(rateLimitScopeForPath(CSRF_TOKEN_PATH), "csrf", "through the scope its path maps to");
  expectEqual(classifiedPaths().includes("/api/auth/csrf"), true, "and classified as an anonymous surface");
  expectEqual(
    ANONYMOUS_AUTH_SURFACES.find((surface) => surface.path === "/api/auth/csrf")?.codes.includes("VALIDATION_FAILED"),
    false,
    "it answers a token or a transport failure, never a statement about a record",
  );

  // ---- the module boundary: the server half needs Node, the browser half must not
  const serverSource = await readFile(new URL("../security/csrf.ts", import.meta.url), "utf8");
  const browserSource = await readFile(new URL("../security/csrf-client.ts", import.meta.url), "utf8");

  const proofStore = await readFile(new URL("./device-proof-store.ts", import.meta.url), "utf8");

  expect(proofStore.includes("csrfHeaders("), "even the shared proof store carries the token on both of its calls");
  expect(serverSource.includes('from "node:crypto"'), "the token is minted with the platform's random source");
  expect(serverSource.includes("timingSafeEqual"), "and compared without an early exit");
  expectEqual(browserSource.includes('from "node:'), false, "the browser half imports no Node builtin");
  expectEqual(browserSource.includes("import "), false, "and imports nothing at all, so no server module reaches a bundle");
  expect(browserSource.includes("document.cookie"), "it reads the cookie the server will compare against");
  expect(browserSource.includes(CSRF_TOKEN_PATH), "and asks the one endpoint that issues a token");
}

/**
 * STEP 058: the transport may only reach a decided destination.
 *
 * The library half lives in `lib/security/ssrf.ts` and is proved there. What this check adds is the
 * wiring: that the configuration builds the allowlist, that the transport consults it before it dials,
 * that a refused destination never reaches `fetch`, and that the two provider constants of earlier
 * STEPs are on the list - because a guard that blocks the challenge endpoint is an outage, and a guard
 * nobody wired is a comment.
 */
async function checkOutboundGuard(): Promise<void> {
  const projectHost = new URL(config.projectUrl).hostname;

  expect(config.outbound.allowedHosts.includes(projectHost), "the project host is on the transport allowlist");
  expect(
    config.outbound.allowedHosts.includes(OUTBOUND_PROVIDER_HOSTS.challenge[0] ?? ""),
    "the challenge provider is on it",
  );
  expect(
    config.outbound.allowedHosts.includes(OUTBOUND_PROVIDER_HOSTS.breach[0] ?? ""),
    "and the breach corpus",
  );
  expectEqual(policyAllowsHost(config.outbound, "evil.gate"), false, "and a name nobody configured is not");
  expectEqual(config.outbound.allowLoopback, false, "the test deployment is not a loopback one");
  expect(
    policyAllowsHost(config.outbound, new URL(TURNSTILE_SITEVERIFY_URL).hostname),
    "the siteverify constant of STEP 041 passes the policy it is called with",
  );
  expect(
    policyAllowsHost(config.outbound, new URL(BREACH_RANGE_ENDPOINT).hostname),
    "and the breach constant of STEP 040",
  );

  const sent: string[] = [];
  const record = (url: string): Promise<Response> => {
    sent.push(url);

    return Promise.resolve(jsonResponse({ ok: true }));
  };

  const guarded = createAuthHttp({
    fetch: (url) => record(url),
    outbound: config.outbound,
    resolve: gateResolver,
  });

  const metadata = await guarded.send({
    method: "GET",
    url: "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    apiKey: config.anonymousKey,
  });

  expect(!metadata.ok && metadata.failure.kind === "blocked", "a metadata URL is a blocked failure");
  expect(!metadata.ok && metadata.failure.code === "private_host", "carrying the rule that refused it");
  expectEqual(sent.length, 0, "and no request is sent at all");
  expect(
    !metadata.ok && toAuthAppError(metadata.failure).code === "DEPENDENCY_FAILED",
    "the refusal answers the caller as a dependency failure",
  );

  const offList = await guarded.send({
    method: "GET",
    url: "https://evil.gate/rest/v1/users",
    apiKey: config.anonymousKey,
  });

  expect(!offList.ok && offList.failure.kind === "blocked", "a host off the allowlist is blocked");
  expect(!offList.ok && offList.failure.code === "host_not_allowed", "for the allowlist rule");
  expectEqual(sent.length, 0, "and still no request is sent");

  const plainHttp = await guarded.send({
    method: "GET",
    url: "http://project-ref.supabase.co/rest/v1/users",
    apiKey: config.anonymousKey,
  });

  expect(!plainHttp.ok && plainHttp.failure.code === "unsupported_scheme", "plain http is blocked outside development");
  expectEqual(sent.length, 0, "with no request sent");

  const privateAnswer = createAuthHttp({
    fetch: (url) => record(url),
    outbound: config.outbound,
    resolve: createOutboundResolver({ lookup: () => Promise.resolve(["10.0.0.5"]) }),
  });

  const rebound = await privateAnswer.send({
    method: "GET",
    url: config.endpoints.usersTable,
    apiKey: config.serviceRoleKey,
  });

  expect(!rebound.ok && rebound.failure.kind === "blocked", "a name that answers with a private address is blocked");
  expect(!rebound.ok && rebound.failure.code === "private_address", "for the address rule");
  expectEqual(sent.length, 0, "and the socket is never opened");

  const canonical = createAuthHttp({
    fetch: (url) => record(url),
    outbound: config.outbound,
    resolve: gateResolver,
  });

  const answer = await canonical.send({
    method: "GET",
    url: "HTTPS://PROJECT-REF.SUPABASE.CO/rest/v1/users",
    apiKey: config.anonymousKey,
  });

  expect(answer.ok, "an allowlisted host is reached whatever its spelling");
  expectEqual(
    sent[0],
    "https://project-ref.supabase.co/rest/v1/users",
    "and the transport dials the canonical form the guard decided on, not the string it was given",
  );

  const loopback = await createAuthHttp({
    fetch: (url) => record(url),
    outbound: outboundPolicy({ projectUrl: "http://127.0.0.1:54321", allowLoopback: true }),
    resolve: gateResolver,
  }).send({ method: "GET", url: "http://127.0.0.1:54321/auth/v1/token", apiKey: config.anonymousKey });

  expect(loopback.ok, "a development transport reaches its container on loopback");

  // ---- the source: the guard is before the socket, and there is one door
  const httpSource = await readFile(new URL("./http.ts", import.meta.url), "utf8");
  const configSource = await readFile(new URL("./config.ts", import.meta.url), "utf8");

  expect(httpSource.includes("assertOutboundUrl(request.url"), "the transport asks the guard about the request URL");
  expect(
    httpSource.indexOf("assertOutboundUrl(") < httpSource.indexOf("doFetch("),
    "before it builds the request, so a refused destination costs no socket",
  );
  expect(httpSource.includes('redirect: "error"'), "a redirect is an error: no hop is followed unguarded");
  expect(httpSource.includes('credentials: "omit"'), "and no cookie jar of the process travels");
  expect(httpSource.includes("outbound: config.outbound"), "the configured policy is the one the transport uses");
  expect(configSource.includes("outboundPolicy("), "the policy is built beside the URL it belongs to");
  expect(configSource.includes("allowLoopback: loopbackDevelopment"), "with the one development exception, stated once");

  const libRoot = new URL("../../lib/", import.meta.url);
  // The gates themselves are excluded: a certificate may write the word `fetch(` in an assertion
  // about a certificate, and none of them is ever loaded by the application.
  const libEntries = (await readdir(libRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith("verify.ts"));

  const dialling: string[] = [];

  for (const entry of libEntries) {
    const source = await readFile(new URL(entry, libRoot), "utf8");

    if (/\bfetch\(/u.test(source)) {
      dialling.push(entry);
    }
  }

  // ---- how many doors there are, and what each one guarantees
  //
  // Two server doors and one browser door. `auth/http.ts` speaks to the auth provider and
  // `storage/http.ts` to the object store; the storage transport was written to the same four
  // guarantees, and the assertions below hold it to its own rather than trusting the comment that
  // claims them. The third module is the browser's, which dials this application and nothing else.
  //
  // A name appearing here that is not one of those four is a module that opened a socket nobody
  // decided on, which is the whole reason the list is an equality and not a minimum. The storage door
  // was missing from it between STEP 105 and STEP 117, so the gate answered red for eleven STEPs:
  // a red gate teaches a reader to skip it, which is worse than the gap it was reporting.
  expectEqual(
    dialling.sort().join(","),
    ["auth/device-proof-store.ts", "auth/http.ts", "security/csrf-client.ts", "storage/http.ts"].join(","),
    "the server has two doors and the browser has its own, and no fourth module dials",
  );

  const storageHttpSource = await readFile(new URL("../storage/http.ts", import.meta.url), "utf8");

  expect(
    storageHttpSource.includes("checkOutboundUrl(url, policy)"),
    "the storage transport asks the same guard about its destination",
  );
  expect(
    storageHttpSource.indexOf("checkOutboundUrl(") < storageHttpSource.indexOf("fetchImpl(decision.target.url"),
    "before it opens a socket, so a refused destination costs no request",
  );
  expect(
    storageHttpSource.includes('redirect: "error"'),
    "a redirect is an error there too, so a service role key cannot be carried to another origin",
  );
  expect(storageHttpSource.includes("AbortSignal.timeout("), "no provider call can hang");
  expect(
    storageHttpSource.includes("decision.target.url"),
    "and it dials the canonical form the guard decided on, not the string it was given",
  );
  expect(
    storageHttpSource.includes("outboundPolicy({ projectUrl, extraHosts, allowLoopback })"),
    "with a policy built from the endpoint it belongs to",
  );
  expect(
    storageHttpSource.includes('nodeEnv !== "production" && isLoopbackHost('),
    "and the same single development exception, stated once",
  );
  expect(
    !storageHttpSource.includes("logger"),
    "logging nothing itself, because a provider answer carries signature material",
  );
}

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
  await checkLoginLock();
  await checkLockAlert();
  await checkAccountUnlock();
  await checkDisclosure();
  await checkDeviceProofKey();
  await checkRequestProof();
  await checkSessionRotation();
  await checkDeviceTrust();
  await checkStepUp();
  await checkSessionList();
  await checkRateLimit();
  await checkSanitizerWiring();
  await checkCsrfProtection();
  await checkOutboundGuard();

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
