// path: lib/auth/request-actor.ts
import type { AuditTrail } from "./audit.ts";
import type { ActorDirectory } from "./directory.ts";
import type { AuthCookiePolicy, SessionCookiePayload } from "./cookies.ts";
import { readSession, sessionRejectionError } from "./session.ts";
import {
  resolveSessionToken,
  type SessionResolution,
  type SessionTokenStore,
} from "./session-rotation.ts";
import type { RequestActor } from "./types.ts";

/**
 * The actor of one request, and the platform session behind it.
 *
 * STEP 039 built the first half: the cookie, its signature, its expiry and the account row. STEP 051
 * adds the second: the cookie carries a rotating token, the token names exactly one row of
 * `public.sessions`, and that row is what makes revocation and replay detection mean anything. A
 * route asks one question and gets one answer, and neither half can stand in for the other - the
 * cookie proves the platform signed this browser in, the row proves the session is still the session
 * the platform last issued.
 *
 * ## The one exception, and why it is named
 *
 * A browser on a new device has no proof key until STEP 049's enrolment runs, and enrolment needs a
 * session to know whose key it is registering - so between the sign in and that enrolment the cookie
 * cannot name a device, and no session row can exist (`0010` makes `device_proof_key_id` required).
 * `allowUnbound` is that window, and exactly two routes pass it: the enrolment itself and the
 * rotation that binds. Everything else refuses an unbound cookie, so the exception cannot quietly
 * become the rule.
 *
 * Every refusal is the catalogue's one `AUTHENTICATION_REQUIRED`. The reason stays inside this
 * module, for the log and for the gate.
 */

export interface RequestActorOptions {
  readonly directory: ActorDirectory;
  readonly cookiePolicy: AuthCookiePolicy;
  /** The platform session rows of `public.sessions`. */
  readonly sessions: SessionTokenStore;
  /** Where a detected replay is recorded, before the caller is refused. */
  readonly audit: AuditTrail;
  /** Fixed instant, for a gate that must not depend on the wall clock. */
  readonly nowEpochMs?: number;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /**
   * Accept a cookie that names no platform session.
   *
   * Only the enrolment of a device key and the rotation that binds a session pass this, because a
   * new browser has no key to bind to until one of them has run.
   */
  readonly allowUnbound?: boolean;
}

/** The actor of one request, plus the session token the cookie carried. */
export interface BoundSession {
  readonly actor: RequestActor;
  /** The rotating token, or null when the cookie predates binding. */
  readonly sessionToken: string | null;
  /** True when the actor came from a live row of `public.sessions`. */
  readonly bound: boolean;
  /**
   * The payload the cookie carried, already verified.
   *
   * Only the rotation route reads it, and only to carry the provider's pair forward into the cookie
   * it writes; every other caller takes the actor.
   */
  readonly payload: SessionCookiePayload;
}

function reject(resolution: SessionResolution): never {
  // The reasons are deliberately not distinguished for the caller: a spent token, an ended session
  // and a token for somebody else all answer the same sentence, exactly as a missing cookie does.
  void resolution;

  throw sessionRejectionError();
}

/**
 * Read the session of one request and resolve the row behind it.
 *
 * The order matters and is the point: the cookie is verified first, because a browser that cannot
 * prove the platform signed its payload has no business causing a session lookup; only then is the
 * token resolved, which is the step that can revoke a family.
 */
export async function readBoundSession(
  cookieHeader: string | null,
  options: RequestActorOptions,
): Promise<BoundSession> {
  const state = await readSession(cookieHeader, {
    directory: options.directory,
    cookiePolicy: options.cookiePolicy,
    ...(options.nowEpochMs === undefined ? {} : { nowEpochMs: options.nowEpochMs }),
  });
  if (state.kind !== "authenticated") {
    throw sessionRejectionError();
  }

  const actor = state.actor;
  const resolution = await resolveSessionToken(
    {
      token: state.sessionToken,
      userId: actor.userId,
      ipAddress: options.ipAddress ?? null,
      userAgent: options.userAgent ?? null,
    },
    {
      sessions: options.sessions,
      audit: options.audit,
      ...(options.nowEpochMs === undefined ? {} : { now: () => options.nowEpochMs ?? Date.now() }),
    },
  );

  if (resolution.kind === "unbound") {
    if (options.allowUnbound !== true) {
      reject(resolution);
    }

    return { actor, sessionToken: null, bound: false, payload: state.payload };
  }

  if (resolution.kind !== "live" && resolution.kind !== "grace") {
    reject(resolution);
  }

  return {
    actor: {
      ...actor,
      sessionId: resolution.row.id,
      deviceProofKeyId: resolution.row.deviceProofKeyId,
      sessionFamilyId: resolution.row.familyId,
      mfaVerifiedAtEpochMs: resolution.row.mfaVerifiedAtEpochMs,
      reauthenticatedAtEpochMs: resolution.row.reauthenticatedAtEpochMs,
    },
    sessionToken: state.sessionToken,
    bound: true,
    payload: state.payload,
  };
}

/** The actor of one request, for a route that is only available to a signed in person. */
export async function readRequestActor(
  cookieHeader: string | null,
  options: RequestActorOptions,
): Promise<RequestActor> {
  const session = await readBoundSession(cookieHeader, options);

  return session.actor;
}
