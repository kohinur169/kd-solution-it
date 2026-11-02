// path: lib/auth/session-list.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import type { RestClient } from "./rest.ts";
import { requireAnyRole } from "./session.ts";
import type { SessionTokenStore } from "./session-rotation.ts";
import type { PlatformRole, RequestActor } from "./types.ts";

/**
 * The list of live sessions, and the two ways of ending one.
 *
 * Section 22 asks for "instant session revocation" with every session event audited, and this module
 * is the half of that promise a person can press: the owner sees the sessions their account is
 * signed in on and ends any of them, and an office role ends one on a merchant's behalf.
 *
 * ## Why the list is written here and not in a route
 *
 * A revoke is only as narrow as the read that precedes it. If the screen built its own query, one
 * missed `user_id=eq.` would turn a session list into a way to read a stranger's devices, and the
 * endpoint would still answer `200`. The ownership filter therefore lives in this file, next to the
 * write, and both take their subject from the actor rather than from the request body.
 *
 * ## What the list shows and what it leaves out
 *
 * One row per live session: the device it is bound to and that device's label, when the session
 * started, when it was last seen, and when it expires. The device's key and the raw address are not
 * selected - a screen that gets left open in an office should not be a list of addresses, and the
 * address is still on the row for the audit to read when it needs to.
 *
 * ## The two reasons
 *
 * `0010` closes the vocabulary, and the two this module writes were already in it: `SIGNED_OUT` when
 * the person ends their own session, `ADMIN_REVOKED` when an office role ends somebody else's. That
 * is deliberate - the row alone then says whether the act was the account's or the platform's, which
 * is the question an incident asks first.
 */

/** The roles that may look at, and end, another account's sessions. */
export const SESSION_MANAGEMENT_OFFICE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
  "support",
] as const satisfies readonly PlatformRole[]);

/** How many sessions the screen shows. An account with more live sessions than this is the incident. */
export const SESSION_LIST_LIMIT = 50;

/** One live session as the screen sees it. */
export interface SessionView {
  readonly id: string;
  readonly deviceId: string | null;
  readonly deviceLabel: string | null;
  /** True when the device has been confirmed (STEP 052), so the row can say so. */
  readonly deviceTrusted: boolean;
  /** True when the device was dropped (STEP 047), which ends the session with it. */
  readonly deviceRevoked: boolean;
  readonly issuedAtEpochMs: number;
  readonly lastSeenAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  /** True for the session making the request, which the screen marks instead of hiding. */
  readonly current: boolean;
}

/** What one revoke did, so the screen can tell the person to sign in again when it ended itself. */
export interface SessionRevokeOutcome {
  readonly sessionId: string;
  readonly wasCurrent: boolean;
}

export interface SessionListDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly sessions: SessionTokenStore;
  readonly now?: () => number;
}

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

const sessionRowSchema = z.object({
  id: z.string().min(1).max(64),
  device_proof_key_id: z.string().min(1).max(64).nullable(),
  issued_at: z.string().min(1).max(40),
  last_seen_at: z.string().min(1).max(40),
  expires_at: z.string().min(1).max(40),
});

const deviceRowSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(80).nullable(),
  trusted_at: z.string().max(40).nullable(),
  revoked_at: z.string().max(40).nullable(),
});

function epochMs(instant: string): number {
  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/**
 * Read the live sessions of one account, newest first, with the device each is bound to.
 *
 * `revoked_at is null and deleted_at is null` is the definition of live that `0010` writes and that
 * every reader in the platform uses; `sessions_user_idx` is `(user_id, revoked_at) where deleted_at
 * is null`, so this is the read the index was created for.
 */
async function readLiveSessions(
  userId: string,
  currentSessionId: string | null,
  dependencies: SessionListDependencies,
): Promise<readonly SessionView[]> {
  const rows = await dependencies.rest.select(
    "sessions",
    `select=id,device_proof_key_id,issued_at,last_seen_at,expires_at&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&deleted_at=is.null&order=issued_at.desc&limit=${SESSION_LIST_LIMIT}`,
    sessionRowSchema,
  );

  if (rows.length === 0) {
    return [];
  }

  const deviceIds = rows
    .map((row) => row.device_proof_key_id)
    .filter((value): value is string => value !== null);

  const devices =
    deviceIds.length === 0
      ? []
      : await dependencies.rest.select(
          "device_proof_keys",
          `select=id,label,trusted_at,revoked_at&id=in.(${deviceIds.map((id) => encodeURIComponent(id)).join(",")})&deleted_at=is.null`,
          deviceRowSchema,
        );

  const byId = new Map(devices.map((device) => [device.id, device]));

  return rows.map((row) => {
    const device = row.device_proof_key_id === null ? undefined : byId.get(row.device_proof_key_id);

    return {
      id: row.id,
      deviceId: row.device_proof_key_id,
      deviceLabel: device?.label ?? null,
      deviceTrusted: device?.trusted_at !== null && device?.trusted_at !== undefined,
      deviceRevoked: device?.revoked_at !== null && device?.revoked_at !== undefined,
      issuedAtEpochMs: epochMs(row.issued_at),
      lastSeenAtEpochMs: epochMs(row.last_seen_at),
      expiresAtEpochMs: epochMs(row.expires_at),
      current: row.id === currentSessionId,
    };
  });
}

/** The caller's own sessions. A signed-out caller has no list, so the missing session is `401`. */
export async function listOwnSessions(
  actor: RequestActor,
  dependencies: SessionListDependencies,
): Promise<readonly SessionView[]> {
  if (actor.sessionId === null) {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  return readLiveSessions(actor.userId, actor.sessionId, dependencies);
}

/**
 * End one of the caller's own sessions.
 *
 * The row must be the caller's and still live. A session id that belongs to somebody else answers
 * `RESOURCE_NOT_FOUND`, not `PERMISSION_DENIED`: an owner has no business learning that a session
 * they cannot see exists, and the difference between the two answers would be exactly that.
 */
export async function revokeOwnSession(
  input: {
    readonly actor: RequestActor;
    readonly sessionId: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: SessionListDependencies,
): Promise<SessionRevokeOutcome> {
  const parsedId = identifierSchema.safeParse(input.sessionId);

  if (!parsedId.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const rows = await dependencies.rest.select(
    "sessions",
    `select=id&id=eq.${encodeURIComponent(parsedId.data)}&user_id=eq.${encodeURIComponent(input.actor.userId)}&revoked_at=is.null&deleted_at=is.null&limit=1`,
    z.object({ id: z.string().min(1).max(64) }),
  );

  if (rows[0] === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const instant = new Date(now()).toISOString();

  await dependencies.sessions.update(rows[0].id, "revoked_at=is.null", {
    revoked_at: instant,
    revocation_reason: "SIGNED_OUT",
  });

  await dependencies.audit
    .append({
      action: "session.revoked_by_owner",
      actorUserId: input.actor.userId,
      entityType: "session",
      entityId: rows[0].id,
      companyId: input.actor.companyId,
      sessionId: rows[0].id,
      payload: { reason: "SIGNED_OUT", revoked_at: instant },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return { sessionId: rows[0].id, wasCurrent: rows[0].id === input.actor.sessionId };
}

/**
 * End every other session of the account, and keep the one asking.
 *
 * The session making the request is excluded on purpose: "sign out everywhere else" that signed the
 * person out too would be "sign out", and the screen already has that button. The count is read
 * before the update, so the answer and the audit entry name how many doors were closed rather than
 * claiming success without saying how much changed.
 */
export async function revokeOtherOwnSessions(
  input: {
    readonly actor: RequestActor;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: SessionListDependencies,
): Promise<number> {
  if (input.actor.sessionId === null) {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  const keep = encodeURIComponent(input.actor.sessionId);
  const rows = await dependencies.rest.select(
    "sessions",
    `select=id&user_id=eq.${encodeURIComponent(input.actor.userId)}&revoked_at=is.null&deleted_at=is.null&id=neq.${keep}&limit=200`,
    z.object({ id: z.string().min(1).max(64) }),
  );

  if (rows.length === 0) {
    return 0;
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const instant = new Date(now()).toISOString();

  await dependencies.rest.update(
    "sessions",
    `user_id=eq.${encodeURIComponent(input.actor.userId)}&revoked_at=is.null&deleted_at=is.null&id=neq.${keep}`,
    { revoked_at: instant, revocation_reason: "SIGNED_OUT" },
  );

  await dependencies.audit
    .append({
      action: "session.others_revoked",
      actorUserId: input.actor.userId,
      entityType: "user",
      entityId: input.actor.userId,
      companyId: input.actor.companyId,
      sessionId: input.actor.sessionId,
      payload: { reason: "SIGNED_OUT", revoked_sessions: rows.length },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return rows.length;
}

/**
 * The office read: the live sessions of one account.
 *
 * The role check is here, not in the route and not in the page, so a second caller cannot reach a
 * weaker version of the list by calling this module directly. Reading somebody's devices is a use of
 * a permission, and section 22 audits those too: the read appends `session.list_read_by_office`
 * naming the officer and the account, before the rows are returned.
 */
export async function listAccountSessions(
  input: { readonly actor: RequestActor; readonly userId: string },
  dependencies: SessionListDependencies,
): Promise<readonly SessionView[]> {
  requireAnyRole(input.actor, SESSION_MANAGEMENT_OFFICE_ROLES);

  const parsedId = identifierSchema.safeParse(input.userId);

  if (!parsedId.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const account = await dependencies.rest.select(
    "users",
    `select=id&id=eq.${encodeURIComponent(parsedId.data)}&deleted_at=is.null&limit=1`,
    z.object({ id: z.string().min(1).max(64) }),
  );

  if (account[0] === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const sessions = await readLiveSessions(account[0].id, null, dependencies);

  await dependencies.audit
    .append({
      action: "session.list_read_by_office",
      actorUserId: input.actor.userId,
      entityType: "user",
      entityId: account[0].id,
      companyId: input.actor.companyId,
      sessionId: input.actor.sessionId,
      payload: { live_sessions: sessions.length },
    })
    .catch(() => undefined);

  return sessions;
}

/**
 * The office write: end one session of another account.
 *
 * The course is the same as the owner's, with two differences that matter. The row is looked up by
 * account *and* session, so an officer who has been handed an account id cannot end a session of a
 * different account; and the reason is `ADMIN_REVOKED` with the officer as the actor, so the audit
 * trail answers "who ended this merchant's session" without reading two entries.
 */
export async function revokeAccountSession(
  input: {
    readonly actor: RequestActor;
    readonly userId: string;
    readonly sessionId: string;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: SessionListDependencies,
): Promise<SessionRevokeOutcome> {
  requireAnyRole(input.actor, SESSION_MANAGEMENT_OFFICE_ROLES);

  const parsedUser = identifierSchema.safeParse(input.userId);
  const parsedSession = identifierSchema.safeParse(input.sessionId);

  if (!parsedUser.success || !parsedSession.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const rows = await dependencies.rest.select(
    "sessions",
    `select=id&id=eq.${encodeURIComponent(parsedSession.data)}&user_id=eq.${encodeURIComponent(parsedUser.data)}&revoked_at=is.null&deleted_at=is.null&limit=1`,
    z.object({ id: z.string().min(1).max(64) }),
  );

  if (rows[0] === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const instant = new Date(now()).toISOString();

  await dependencies.sessions.update(rows[0].id, "revoked_at=is.null", {
    revoked_at: instant,
    revocation_reason: "ADMIN_REVOKED",
  });

  await dependencies.audit
    .append({
      action: "session.revoked_by_office",
      actorUserId: input.actor.userId,
      entityType: "session",
      entityId: rows[0].id,
      companyId: input.actor.companyId,
      sessionId: rows[0].id,
      payload: {
        reason: "ADMIN_REVOKED",
        revoked_at: instant,
        subject_user_id: parsedUser.data,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return { sessionId: rows[0].id, wasCurrent: rows[0].id === input.actor.sessionId };
}
