// path: lib/auth/session.ts
import { AppError } from "../errors/app-error.ts";
import { decodeSessionCookies, type AuthCookiePolicy } from "./cookies.ts";
import type { ActorDirectory } from "./directory.ts";
import { claimsAreCurrent, decodeSessionClaims } from "./jwt.ts";
import type {
  ActorRecord,
  PlatformRole,
  RequestActor,
  SessionClaims,
  SessionRejectionReason,
  SessionState,
} from "./types.ts";

/**
 * Typed session access: the one way this platform answers "who is calling".
 *
 * A route, a server component and a job all ask the same question and all get one of two
 * answers. There is no third "maybe" and no untyped bag of fields, because the failures this
 * module prevents are exactly the ones an untyped cookie invites: a handler that reads
 * `session.user.id` and quietly gets `undefined`, a check that compares a role before the actor
 * is known, a suspended account that keeps working because the token was still valid.
 *
 * The order of the checks is the security property, and it is deliberate:
 *
 *   1. the cookie must be our cookie, complete and canonical, or there is no session;
 *   2. the token inside it must be a token this server issued in the shape it expects, and it
 *      must not be expired, allowing for clock skew;
 *   3. the subject of the token must be the user the cookie names, so a payload cannot be moved
 *      from one session to another;
 *   4. the platform row of that subject must exist, must be live and must not be suspended or
 *      closed. The claims are evidence; the row is the authority;
 *   5. only then is a `RequestActor` produced, carrying the role list a permission check uses.
 *
 * Every `unauthenticated` reason maps to one answer - `AUTHENTICATION_REQUIRED` - because section
 * 22 forbids telling a caller which of the five failed. The reason exists so the log can say,
 * and so STEP 039 can send a suspended account somewhere useful once the person has proven the
 * password, which is a decision taken after this reader has answered, not inside it.
 */

export interface SessionReaderOptions {
  readonly directory: ActorDirectory;
  readonly cookiePolicy: AuthCookiePolicy;
  /** Clock injection, so the gate can prove expiry without waiting for it. */
  readonly nowEpochMs?: number;
}

function unauthenticated(reason: SessionRejectionReason): SessionState {
  return { kind: "unauthenticated", reason };
}

/** Map an actor record's account state onto the reason a session is refused. */
function statusRejection(record: ActorRecord): SessionRejectionReason | null {
  if (record.deletedAtEpochMs !== null) {
    return "deleted-account";
  }

  switch (record.status) {
    case "active":
      return null;
    case "suspended":
      return "suspended-account";
    case "closed":
      return "closed-account";
  }
}

/**
 * True when section 22 requires this actor to enrol a second factor.
 *
 * "2FA TOTP is mandatory for every account holding role" is one sentence and two conditions, so
 * it is one function. An account with no live grant can do nothing anyway; an account with a
 * grant and no confirmed TOTP is the case STEP 041 turns into an enrolment screen instead of a
 * dashboard.
 */
export function isTwoFactorEnrolmentRequired(record: ActorRecord): boolean {
  return record.roles.length > 0 && record.totpConfirmedAtEpochMs === null;
}

/** Join the claims and the platform row into the value a handler receives. */
export function toRequestActor(claims: SessionClaims, record: ActorRecord): RequestActor {
  return {
    userId: record.userId,
    companyId: record.companyId,
    roles: record.roles,
    sessionId: claims.sessionId,
    assuranceLevel: claims.assuranceLevel,
    authenticatedAtEpochMs: claims.issuedAtEpochMs,
    expiresAtEpochMs: claims.expiresAtEpochMs,
    emailVerified: record.emailVerifiedAtEpochMs !== null,
    twoFactorSatisfied: claims.assuranceLevel === "aal2",
    twoFactorEnrolmentRequired: isTwoFactorEnrolmentRequired(record),
  };
}

/**
 * Read the session of one request.
 *
 * `cookieHeader` is the raw `cookie` header, or null when the request carried none. Passing the
 * header rather than a request keeps this module usable from a job and testable without one.
 */
export async function readSession(
  cookieHeader: string | null,
  options: SessionReaderOptions,
): Promise<SessionState> {
  if (cookieHeader === null || cookieHeader.trim().length === 0) {
    return unauthenticated("no-cookie");
  }

  const payload = decodeSessionCookies(options.cookiePolicy, cookieHeader);

  if (payload === null) {
    return unauthenticated("malformed-cookie");
  }

  const claims = decodeSessionClaims(payload.accessToken);

  if (claims === null) {
    return unauthenticated("malformed-token");
  }

  const nowEpochMs = options.nowEpochMs ?? Date.now();

  if (!claimsAreCurrent(claims, nowEpochMs)) {
    return unauthenticated("expired-token");
  }

  // A cookie that names one user and carries the token of another is not a session, whatever
  // the signature says. This is the first half of LR-022's "a cookie works only inside its own
  // session".
  if (payload.userId !== claims.subject) {
    return unauthenticated("malformed-cookie");
  }

  if (
    payload.sessionId !== null &&
    claims.sessionId !== null &&
    payload.sessionId !== claims.sessionId
  ) {
    return unauthenticated("malformed-cookie");
  }

  // A transport or database failure propagates as the `AppError` the directory threw. It is not
  // an authentication failure: the person may well be who they say they are, and answering 401
  // for an outage would sign every merchant out.
  const record = await options.directory.findActor(claims.subject);

  if (record === null) {
    return unauthenticated("unknown-account");
  }

  const rejection = statusRejection(record);

  if (rejection !== null) {
    return unauthenticated(rejection);
  }

  return { kind: "authenticated", actor: toRequestActor(claims, record) };
}

/** The sentence-free rejection every caller of this module throws. */
export function sessionRejectionError(): AppError {
  return new AppError("AUTHENTICATION_REQUIRED");
}

/** The actor of an authenticated state, or the catalogue's `AUTHENTICATION_REQUIRED`. */
export function requireActor(state: SessionState): RequestActor {
  if (state.kind !== "authenticated") {
    throw sessionRejectionError();
  }

  return state.actor;
}

/** True when the actor holds this exact role. */
export function hasRole(actor: RequestActor, role: PlatformRole): boolean {
  return actor.roles.includes(role);
}

/** True when the actor holds at least one of the roles. An empty list is never satisfied. */
export function hasAnyRole(actor: RequestActor, roles: readonly PlatformRole[]): boolean {
  return roles.some((role) => actor.roles.includes(role));
}

/**
 * The actor, or `PERMISSION_DENIED`.
 *
 * 403 and not 401: the caller has proved who they are and is not allowed, which is a different
 * answer from "sign in" (the catalogue README states the same rule from the other side).
 */
export function requireAnyRole(
  actor: RequestActor,
  roles: readonly PlatformRole[],
): RequestActor {
  if (!hasAnyRole(actor, roles)) {
    throw new AppError("PERMISSION_DENIED");
  }

  return actor;
}

/** The company an owner acts for, or `PERMISSION_DENIED` when the actor is a platform account. */
export function requireCompanyId(actor: RequestActor): string {
  if (actor.companyId === null) {
    throw new AppError("PERMISSION_DENIED");
  }

  return actor.companyId;
}

/**
 * True when the actor may act without a second step.
 *
 * Section 22 makes TOTP mandatory for a role holding account, so a session at `aal1` of such an
 * account is one factor short. STEP 041 uses this to decide between the dashboard and the
 * enrolment screen; STEP 053 uses the same flag for a step-up decision.
 */
export function hasSatisfiedTwoFactor(actor: RequestActor): boolean {
  return actor.twoFactorSatisfied && !actor.twoFactorEnrolmentRequired;
}
