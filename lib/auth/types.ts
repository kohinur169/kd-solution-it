// path: lib/auth/types.ts
import { deepFreeze } from "../utils/freeze.ts";
import type { SessionCookiePayload } from "./cookies.ts";

/**
 * Every value that crosses the authentication boundary.
 *
 * The module has one rule about shapes: a value that leaves `lib/auth` is declared here, so a
 * later STEP that consumes a session cannot invent its own inline type and drift. The names are
 * deliberately boring - a session, a user, an actor - because the interesting part is which of
 * them is the authority for a decision:
 *
 *   - the token is evidence, not an authority. Its claims say what Supabase signed;
 *   - the actor record is the authority. It is the row in `public.users` plus the live grants in
 *     `public.role_assignments`, read on the server, and it is what a permission check uses;
 *   - the request actor is the two joined, with the session facts a route needs (which session,
 *     how strong, when it started), so a handler never reaches back into a cookie.
 *
 * Nothing here holds a secret beyond the tokens of one live session, and no type carries a
 * human readable failure sentence: a rejection is a machine readable reason that never reaches a
 * response (see `SessionRejectionReason`).
 */

/** The seven roles of FEATURE_LIST section 2, in the order `0004_role_assignments.sql` lists them. */
export const PLATFORM_ROLES = deepFreeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
  "finance_ops",
  "support",
  "blogger",
  "owner",
] as const);

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

const platformRoleSet: ReadonlySet<string> = new Set<string>(PLATFORM_ROLES);

/** True when a value is one of the seven roles. A database row is filtered through this. */
export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && platformRoleSet.has(value);
}

/** The `users.status` vocabulary of `0003_users.sql`. */
export const USER_ACCOUNT_STATUSES = deepFreeze(["active", "suspended", "closed"] as const);

export type UserAccountStatus = (typeof USER_ACCOUNT_STATUSES)[number];

const userAccountStatusSet: ReadonlySet<string> = new Set<string>(USER_ACCOUNT_STATUSES);

export function isUserAccountStatus(value: unknown): value is UserAccountStatus {
  return typeof value === "string" && userAccountStatusSet.has(value);
}

/**
 * Authenticator Assurance Level, as Supabase names it in a session claim.
 *
 * `aal1` is one factor (the password), `aal2` is two. Section 22 makes TOTP mandatory for every
 * account that holds a role, so an `aal1` session of a role holding account is a session that
 * still owes a factor; `RequestActor.twoFactorSatisfied` is the answered question.
 */
export type AssuranceLevel = "aal1" | "aal2";

const assuranceLevelSet: ReadonlySet<string> = new Set(["aal1", "aal2"]);

export function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return typeof value === "string" && assuranceLevelSet.has(value);
}

/** The identity facts Supabase Auth owns. Read from the token exchange, never from the browser. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly emailConfirmedAtEpochMs: number | null;
  readonly phone: string | null;
  readonly lastSignInAtEpochMs: number | null;
  readonly fullName: string | null;
}

/**
 * One live session as Supabase issued it.
 *
 * The access token is short lived and the refresh token is what makes a session survive a page
 * load, so both are carried together: they are only ever stored in the one HttpOnly cookie
 * `cookies.ts` writes, and a helper that needs one of them receives this value rather than
 * reading the cookie again.
 */
export interface AuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAtEpochMs: number;
  readonly expiresInSeconds: number;
  readonly user: AuthUser;
}

/**
 * The claims this server reads from an access token it issued.
 *
 * `subject` is the Supabase user id, and the platform keeps one invariant about it: it equals
 * `public.users.id`. STEP 038 creates both rows with one generated id, and the bootstrap runbook
 * creates the Supabase user with the id the operator already wrote into `0079`, so a claim is
 * looked up in the directory with no translation table.
 */
export interface SessionClaims {
  readonly subject: string;
  readonly sessionId: string | null;
  readonly assuranceLevel: AssuranceLevel;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly methods: readonly string[];
  readonly email: string | null;
}

/**
 * The platform side of a person: the authority for every permission decision.
 *
 * It is a projection of `public.users` and the live `public.role_assignments` rows, and it
 * deliberately carries no password hash, no TOTP secret and no personal document. `roles` is
 * deduplicated and sorted so two reads of the same account compare equal.
 */
export interface ActorRecord {
  readonly userId: string;
  readonly companyId: string | null;
  readonly status: UserAccountStatus;
  readonly roles: readonly PlatformRole[];
  readonly emailVerifiedAtEpochMs: number | null;
  readonly totpConfirmedAtEpochMs: number | null;
  readonly deletedAtEpochMs: number | null;
}

/** A request that has been authenticated: the claims and the actor record, joined and narrowed. */
export interface RequestActor {
  readonly userId: string;
  readonly companyId: string | null;
  readonly roles: readonly PlatformRole[];
  readonly sessionId: string | null;
  readonly assuranceLevel: AssuranceLevel;
  readonly authenticatedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  /** True when the platform row records a verified address. A route may require it. */
  readonly emailVerified: boolean;
  /** True when the session presented a second factor (`aal2`). */
  readonly twoFactorSatisfied: boolean;
  /** True when section 22 requires this actor to enrol TOTP before it may act. */
  readonly twoFactorEnrolmentRequired: boolean;
  /**
   * The device the platform session is bound to, or null before the session is bound.
   *
   * `public.sessions.device_proof_key_id` is the row's own binding, enforced by the composite
   * foreign key of `0010`. STEP 051 carries it onto the actor so a proof can be checked against the
   * device this session was issued for, and STEP 054 can end every session of one device.
   */
  readonly deviceProofKeyId: string | null;
  /** The family this session belongs to, so one revocation can end the whole login. */
  readonly sessionFamilyId: string | null;
  /**
   * When the second factor was satisfied for this session, from `sessions.mfa_verified_at`.
   *
   * Null before the session is bound, and null for a session the platform never saw a second factor
   * for. STEP 053 reads it as one of the two instants that make a proof fresh.
   */
  readonly mfaVerifiedAtEpochMs: number | null;
  /**
   * When this session last proved the second factor *again*, from `sessions.reauthenticated_at`.
   *
   * STEP 053 writes it, `0091` bounds it and the guard reads it. Null means this session has never
   * been reauthenticated, which is not a failure: a session that proved the second factor a moment
   * ago is fresh without it.
   */
  readonly reauthenticatedAtEpochMs: number | null;
}

/**
 * Why a request has no actor.
 *
 * This value is for the structured log and for the STEP that decides what to do about it (039
 * sends a suspended account to support, 052 asks for a new device confirmation). It is never
 * rendered: every reason answers with one `AUTHENTICATION_REQUIRED`, because section 22 forbids
 * an authentication error that reveals anything about an account.
 */
export type SessionRejectionReason =
  | "no-cookie"
  | "malformed-cookie"
  | "malformed-token"
  | "expired-token"
  | "unknown-account"
  | "suspended-account"
  | "closed-account"
  | "deleted-account"
  /** The cookie is valid but names no platform session: it predates binding (STEP 051). */
  | "unbound-session"
  /** The token names no row, or a row of another account. */
  | "unknown-session"
  /** The row's own expiry, or its family's ceiling, has passed. */
  | "expired-session"
  /** The row was ended for a reason other than rotation: signed out, revoked, a changed password. */
  | "revoked-session"
  /** A spent token was presented after the grace window, and its family has been revoked. */
  | "replayed-session";

/**
 * The one question a route asks. Two cases, so a handler cannot forget the rejection.
 *
 * An authenticated state also carries the platform session token the cookie held, or null when the
 * cookie predates binding. Only the reader of STEP 051 uses it; a handler keeps using the actor.
 */
export type SessionState =
  | {
      readonly kind: "authenticated";
      readonly actor: RequestActor;
      readonly sessionToken: string | null;
      /**
       * The verified payload itself.
       *
       * The rotation of STEP 051 rewrites one field of it - the session token - and has to carry
       * the provider's pair forward byte for byte. Handing the payload back here keeps that pair
       * inside the modules that already handle it rather than making a route decode a cookie a
       * second time.
       */
      readonly payload: SessionCookiePayload;
    }
  | { readonly kind: "unauthenticated"; readonly reason: SessionRejectionReason };

/**
 * How an upstream call failed, in the vocabulary of this module.
 *
 * There is no `message` field on purpose. Supabase can return arbitrary text in `msg`, and text
 * from a remote service is attacker influenced input: it reaches the structured log as a code,
 * never a response and never an exception message.
 */
export type AuthFailureKind =
  | "timeout"
  | "network"
  /**
   * The destination was refused before a socket was opened: the SSRF guard of STEP 058 said no.
   *
   * It is a kind of its own rather than `network`, because the two facts are different and only one of
   * them is worth waking someone for. A network failure is a provider having a bad day; a blocked
   * destination is this platform's own allowlist saying the URL was never legitimate, which is a
   * configuration fault, an attack, or both.
   */
  | "blocked"
  | "rate-limited"
  | "rejected"
  | "upstream"
  | "malformed-response";

export interface AuthFailure {
  readonly kind: AuthFailureKind;
  /** HTTP status of the upstream answer, or null when no answer arrived. */
  readonly status: number | null;
  /** The machine readable code of the upstream answer, or null. Never a sentence. */
  readonly code: string | null;
  /** Seconds the caller may wait, when the upstream answer said so. */
  readonly retryAfterSeconds: number | null;
}

/** A result that either carries a value or names a failure. Exceptions are not used here. */
export type AuthOutcome<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: AuthFailure };
