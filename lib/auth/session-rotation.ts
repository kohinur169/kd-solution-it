// path: lib/auth/session-rotation.ts
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { isConflictError, type RestClient } from "./rest.ts";
import type { AssuranceLevel } from "./types.ts";

/**
 * The rotating session token: the second half of "a cookie works only inside its own session".
 *
 * A cookie alone is a bearer token. STEP 051 makes it a *reference*: the payload carries a random
 * token, the server stores only its SHA-256, and every request resolves that hash to the one row of
 * `public.sessions` the token belongs to. The row is the authority - a revoked, expired or replaced
 * session stops working on the next request, whatever the cookie's signature says.
 *
 * ## Rotation
 *
 * A row is replaced before it expires: the old row is revoked as `ROTATED` and a child row is
 * inserted that copies `family_id` and names its parent in `rotated_from_session_id`. `0010`'s
 * partial unique index allows one child per parent, so a rotation cannot fork - a second attempt to
 * rotate the same row loses a compare and swap, not a race.
 *
 * The compare and swap is a conditional update plus a read back: the update only matches a row
 * whose `revoked_at` is still null, and the row is read afterwards to learn whether the instant this
 * call wrote is the instant the row carries. STEP 047 used the same shape for the account unlock,
 * and for the same reason: PostgREST cannot open a transaction, so the only honest way to know
 * whether a conditional write landed is to read it back.
 *
 * ## Replay, and the grace window
 *
 * Presenting a token whose row was already rotated is the signature of a stolen cookie. Section 22
 * answers that by revoking the whole family. A browser, however, can legitimately present a spent
 * token: a request that was already in flight when the rotation answer rewrote the cookie. So a
 * spent token is honoured for `SESSION_ROTATION_GRACE_MS` after the rotation and refused as a replay
 * after it. The grace is short, it is measured from the rotation the row itself records, and it
 * never issues a second token: the cookie in the jar is already the current one.
 *
 * ## A chain has a ceiling
 *
 * Every rotation cannot simply extend the login, or a session would live for ever. `0089` added
 * `absolute_expires_at`: written when the family starts, copied by every rotation, and enforced by a
 * check that refuses a row whose own expiry reaches past it. The service computes each rotation's
 * expiry as the earlier of the rotation window and the ceiling.
 */

/** Bytes of randomness in one session token. 32 bytes encode to 43 base64url characters. */
export const SESSION_TOKEN_BYTES = 32;

/** The shape `0010`'s `sessions_token_hash_check` accepts, and the shape a token has. */
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/** How long one rotation may be used before it is replaced. */
export const SESSION_ROTATION_INTERVAL_MS = 15 * 60_000;

/** The life of one rotation. A session that is still in use is rotated long before this. */
export const SESSION_ROTATION_WINDOW_MS = 60 * 60_000;

/** The life of a whole login, copied by every rotation. */
export const SESSION_ABSOLUTE_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** How long after a rotation the replaced table is still honoured, for requests already in flight. */
export const SESSION_ROTATION_GRACE_MS = 30_000;

/** The revocation vocabulary of `0010`, as far as this module writes it. */
export const SESSION_REVOCATION_REASONS = [
  "SIGNED_OUT",
  "ROTATED",
  "REPLAY_DETECTED",
  "FAMILY_REVOKED",
  "ADMIN_REVOKED",
  "PASSWORD_CHANGED",
  "DEVICE_REVOKED",
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

/** A token this platform minted, or null when a caller had nothing usable. Never logged. */
export function createRawSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** The only form of the token the database sees, and the only form the log may name. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

/** True when a value is a token this platform could have minted. */
export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN_PATTERN.test(value);
}

/** The columns of `public.sessions` this module reads. Validated, like every REST answer. */
const sessionRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  device_proof_key_id: z.string().min(1).max(64),
  family_id: z.string().min(1).max(64),
  rotated_from_session_id: z.string().min(1).max(64).nullable(),
  issued_at: z.string().min(20).max(40),
  expires_at: z.string().min(20).max(40),
  absolute_expires_at: z.string().min(20).max(40),
  revoked_at: z.string().min(20).max(40).nullable(),
  revocation_reason: z.string().min(1).max(32).nullable(),
  replay_detected_at: z.string().min(20).max(40).nullable(),
  mfa_verified_at: z.string().min(20).max(40).nullable(),
  reauthenticated_at: z.string().min(20).max(40).nullable(),
});

/** One session row, in the shape the decisions below use. */
export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly companyId: string | null;
  readonly deviceProofKeyId: string;
  readonly familyId: string;
  readonly rotatedFromSessionId: string | null;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly absoluteExpiresAtEpochMs: number;
  readonly revokedAtEpochMs: number | null;
  readonly revocationReason: string | null;
  readonly replayDetectedAtEpochMs: number | null;
  readonly mfaVerifiedAtEpochMs: number | null;
  /** When this session last proved the second factor again (STEP 053), or null. */
  readonly reauthenticatedAtEpochMs: number | null;
}

const columns =
  "select=id,user_id,company_id,device_proof_key_id,family_id,rotated_from_session_id,issued_at," +
  "expires_at,absolute_expires_at,revoked_at,revocation_reason,replay_detected_at,mfa_verified_at," +
  "reauthenticated_at";

function toSessionRow(row: z.infer<typeof sessionRowSchema>): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    deviceProofKeyId: row.device_proof_key_id,
    familyId: row.family_id,
    rotatedFromSessionId: row.rotated_from_session_id,
    issuedAtEpochMs: Date.parse(row.issued_at),
    expiresAtEpochMs: Date.parse(row.expires_at),
    absoluteExpiresAtEpochMs: Date.parse(row.absolute_expires_at),
    revokedAtEpochMs: row.revoked_at === null ? null : Date.parse(row.revoked_at),
    revocationReason: row.revocation_reason,
    replayDetectedAtEpochMs:
      row.replay_detected_at === null ? null : Date.parse(row.replay_detected_at),
    mfaVerifiedAtEpochMs: row.mfa_verified_at === null ? null : Date.parse(row.mfa_verified_at),
    reauthenticatedAtEpochMs:
      row.reauthenticated_at === null ? null : Date.parse(row.reauthenticated_at),
  };
}

/** The row a new session starts as, before the database adds the id and the family. */
export interface NewSessionRow {
  readonly userId: string;
  readonly companyId: string | null;
  readonly deviceProofKeyId: string;
  readonly tokenHash: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly absoluteExpiresAtEpochMs: number;
  readonly mfaVerifiedAtEpochMs: number | null;
  /** Carried from the parent on a rotation, so a fresh proof survives the token being replaced. */
  readonly reauthenticatedAtEpochMs: number | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Set for a rotation, null for the row that starts a family. */
  readonly familyId?: string | null;
  readonly rotatedFromSessionId?: string | null;
}

/**
 * The four reads and writes this module needs.
 *
 * An interface rather than direct `RestClient` calls, so the gate can hold a real table: the
 * unique token hash and the one-child-per-parent rule are the two constraints the rotation decides
 * on, and a double that accepted both would prove nothing.
 */
export interface SessionTokenStore {
  /** The row a token hash belongs to, revoked or not, or null. */
  findByHash(tokenHash: string): Promise<SessionRow | null>;
  /** The one live row of a family, or null when every row of it ended. */
  findLiveInFamily(familyId: string): Promise<SessionRow | null>;
  /** Insert a row and read back the id and the family the database generated. */
  insert(row: NewSessionRow): Promise<SessionRow>;
  /** A conditional update: the query decides which rows are touched. */
  update(sessionId: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void>;
  /** Revoke every live row of a family, and answer how many there were. */
  revokeFamily(familyId: string, values: Readonly<Record<string, unknown>>): Promise<number>;
  /** Revoke every live row of one device, and answer how many there were. */
  revokeDevice(deviceProofKeyId: string, values: Readonly<Record<string, unknown>>): Promise<number>;
}

export function createRestSessionTokenStore(rest: RestClient): SessionTokenStore {
  return {
    async findByHash(tokenHash: string): Promise<SessionRow | null> {
      const rows = await rest.select(
        "sessions",
        `${columns}&token_hash=eq.${encodeURIComponent(tokenHash)}&deleted_at=is.null&limit=1`,
        sessionRowSchema,
      );

      return rows[0] === undefined ? null : toSessionRow(rows[0]);
    },

    async findLiveInFamily(familyId: string): Promise<SessionRow | null> {
      const rows = await rest.select(
        "sessions",
        `${columns}&family_id=eq.${encodeURIComponent(familyId)}` +
          "&revoked_at=is.null&deleted_at=is.null&limit=1",
        sessionRowSchema,
      );

      return rows[0] === undefined ? null : toSessionRow(rows[0]);
    },

    async insert(row: NewSessionRow): Promise<SessionRow> {
      const inserted = await rest.insertReturning(
        "sessions",
        [
          {
            user_id: row.userId,
            company_id: row.companyId,
            device_proof_key_id: row.deviceProofKeyId,
            token_hash: row.tokenHash,
            issued_at: new Date(row.issuedAtEpochMs).toISOString(),
            expires_at: new Date(row.expiresAtEpochMs).toISOString(),
            absolute_expires_at: new Date(row.absoluteExpiresAtEpochMs).toISOString(),
            mfa_verified_at:
              row.mfaVerifiedAtEpochMs === null
                ? null
                : new Date(row.mfaVerifiedAtEpochMs).toISOString(),
            reauthenticated_at:
              row.reauthenticatedAtEpochMs === null
                ? null
                : new Date(row.reauthenticatedAtEpochMs).toISOString(),
            ip_address: row.ipAddress,
            user_agent: row.userAgent,
            last_seen_at: new Date(row.issuedAtEpochMs).toISOString(),
            ...(row.familyId === undefined || row.familyId === null
              ? {}
              : { family_id: row.familyId }),
            ...(row.rotatedFromSessionId === undefined || row.rotatedFromSessionId === null
              ? {}
              : { rotated_from_session_id: row.rotatedFromSessionId }),
          },
        ],
        sessionRowSchema,
      );
      const first = inserted[0];

      if (first === undefined) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      return toSessionRow(first);
    },

    async update(
      sessionId: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      await rest.update(
        "sessions",
        `id=eq.${encodeURIComponent(sessionId)}&deleted_at=is.null&${query}`,
        values,
      );
    },

    async revokeFamily(
      familyId: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<number> {
      const live = await rest.select(
        "sessions",
        `select=id&family_id=eq.${encodeURIComponent(familyId)}&revoked_at=is.null&deleted_at=is.null`,
        z.object({ id: z.string().min(1).max(64) }),
      );

      if (live.length === 0) {
        return 0;
      }

      await rest.update(
        "sessions",
        `family_id=eq.${encodeURIComponent(familyId)}&revoked_at=is.null&deleted_at=is.null`,
        values,
      );

      return live.length;
    },

    async revokeDevice(
      deviceProofKeyId: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<number> {
      const live = await rest.select(
        "sessions",
        `select=id&device_proof_key_id=eq.${encodeURIComponent(deviceProofKeyId)}` +
          "&revoked_at=is.null&deleted_at=is.null",
        z.object({ id: z.string().min(1).max(64) }),
      );

      if (live.length === 0) {
        return 0;
      }

      await rest.update(
        "sessions",
        `device_proof_key_id=eq.${encodeURIComponent(deviceProofKeyId)}` +
          "&revoked_at=is.null&deleted_at=is.null",
        values,
      );

      return live.length;
    },
  };
}

export interface SessionRotationDependencies {
  readonly sessions: SessionTokenStore;
  readonly audit: AuditTrail;
  /** Clock injection, so the gate can prove the interval, the grace and the ceiling. */
  readonly now?: () => number;
  readonly rotationIntervalMs?: number;
  readonly rotationWindowMs?: number;
  readonly absoluteWindowMs?: number;
  readonly graceMs?: number;
}

function clock(dependencies: SessionRotationDependencies): number {
  return (dependencies.now ?? Date.now)();
}

function policy(dependencies: SessionRotationDependencies) {
  return {
    rotationIntervalMs: dependencies.rotationIntervalMs ?? SESSION_ROTATION_INTERVAL_MS,
    rotationWindowMs: dependencies.rotationWindowMs ?? SESSION_ROTATION_WINDOW_MS,
    absoluteWindowMs: dependencies.absoluteWindowMs ?? SESSION_ABSOLUTE_WINDOW_MS,
    graceMs: dependencies.graceMs ?? SESSION_ROTATION_GRACE_MS,
  };
}

/** What one request's token resolved to. Every case is named, so a caller cannot forget one. */
export type SessionResolution =
  | { readonly kind: "live"; readonly row: SessionRow }
  | { readonly kind: "grace"; readonly row: SessionRow }
  | { readonly kind: "unbound" }
  | { readonly kind: "unknown" }
  | { readonly kind: "expired" }
  | { readonly kind: "revoked"; readonly row: SessionRow }
  | { readonly kind: "replayed"; readonly row: SessionRow };

/**
 * Resolve the token a cookie carries, and answer what it is.
 *
 * This is the read on every authenticated request, so it is also where theft is noticed: a token
 * whose row was rotated is inside the grace window or it is a replay, and a replay ends the family
 * before the caller ever sees an answer. The audit entry is written here rather than in a caller,
 * because a request that is refused has no caller left to write one.
 */
export async function resolveSessionToken(
  input: {
    readonly token: string | null;
    readonly userId: string;
    readonly ipAddress?: string | null;
    readonly userAgent?: string | null;
  },
  dependencies: SessionRotationDependencies,
): Promise<SessionResolution> {
  if (input.token === null) {
    return { kind: "unbound" };
  }

  if (!isSessionToken(input.token)) {
    return { kind: "unknown" };
  }

  const nowEpochMs = clock(dependencies);
  const row = await dependencies.sessions.findByHash(hashSessionToken(input.token));

  if (row === null || row.userId !== input.userId) {
    return { kind: "unknown" };
  }

  if (row.revokedAtEpochMs !== null) {
    const spentRecently = nowEpochMs - row.revokedAtEpochMs <= policy(dependencies).graceMs;

    if (row.revocationReason === "ROTATED" && spentRecently) {
      return { kind: "grace", row };
    }

    if (row.revocationReason === "ROTATED" || row.replayDetectedAtEpochMs !== null) {
      return reportReplay(row, input, nowEpochMs, dependencies);
    }

    return { kind: "revoked", row };
  }

  if (row.expiresAtEpochMs <= nowEpochMs || row.absoluteExpiresAtEpochMs <= nowEpochMs) {
    return { kind: "expired" };
  }

  return { kind: "live", row };
}

/** Mark the spent row a replay, end its whole family, and answer the caller. */
async function reportReplay(
  row: SessionRow,
  input: { readonly userId: string; readonly ipAddress?: string | null; readonly userAgent?: string | null },
  nowEpochMs: number,
  dependencies: SessionRotationDependencies,
): Promise<SessionResolution> {
  const instant = new Date(nowEpochMs).toISOString();

  // The pairing `sessions_replay_check` demands: an instant is only legal together with a replay
  // revocation. The update is conditional on the reason, so two concurrent replays do not fight.
  await dependencies.sessions.update(row.id, "revocation_reason=eq.ROTATED", {
    revoked_at: instant,
    revocation_reason: "REPLAY_DETECTED",
    replay_detected_at: instant,
  });

  const revoked = await dependencies.sessions.revokeFamily(row.familyId, {
    revoked_at: instant,
    revocation_reason: "FAMILY_REVOKED",
  });

  await dependencies.audit
    .append({
      action: "session.replay_detected",
      actorUserId: row.userId,
      entityType: "session",
      entityId: row.id,
      companyId: row.companyId,
      sessionId: row.id,
      payload: {
        family_id: row.familyId,
        revoked_sessions: revoked,
        detected_at: instant,
      },
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  await dependencies.audit
    .append({
      action: "session.family_revoked",
      actorUserId: row.userId,
      entityType: "session",
      entityId: row.familyId,
      companyId: row.companyId,
      payload: { family_id: row.familyId, reason: "REPLAY_DETECTED", revoked_sessions: revoked },
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return { kind: "replayed", row };
}

/** What a bind or a rotation produced. */
export type SessionIssueOutcome =
  | {
      readonly kind: "bound" | "rotated";
      readonly sessionId: string;
      readonly familyId: string;
      readonly token: string;
      readonly expiresAtEpochMs: number;
    }
  | { readonly kind: "current"; readonly sessionId: string; readonly expiresAtEpochMs: number }
  | { readonly kind: "refused"; readonly reason: SessionRefusalReason };

export type SessionRefusalReason =
  | "replayed"
  | "revoked"
  | "expired"
  | "unknown"
  | "device-mismatch"
  | "unknown-device";

export interface SessionIssueInput {
  /** The token the browser presented, or null when this is the first binding. */
  readonly presentedToken: string | null;
  readonly userId: string;
  readonly companyId: string | null;
  /** The device row the browser says it is. Must be a live key of this account. */
  readonly deviceProofKeyId: string;
  /** The assurance the cookie established, so `mfa_verified_at` is written truthfully. */
  readonly assuranceLevel: AssuranceLevel;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** The session id the provider's claims named, recorded on the audit entry only. */
  readonly claimSessionId: string | null;
}

/**
 * Bind a session to a device, or rotate the one that is already bound.
 *
 * One function because it is one endpoint, and because the two cases share every rule that matters:
 * the device must be this account's, the ceiling is copied, and a spent token is a replay. The only
 * difference is whether the row starts a family or continues one.
 */
export async function issueSessionToken(
  input: SessionIssueInput,
  dependencies: SessionRotationDependencies,
): Promise<SessionIssueOutcome> {
  const nowEpochMs = clock(dependencies);
  const limits = policy(dependencies);

  if (input.presentedToken === null) {
    return openFamily(input, nowEpochMs, limits, dependencies);
  }

  const resolution = await resolveSessionToken(
    {
      token: input.presentedToken,
      userId: input.userId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    dependencies,
  );

  if (resolution.kind === "unbound") {
    return openFamily(input, nowEpochMs, limits, dependencies);
  }

  if (resolution.kind !== "live" && resolution.kind !== "grace") {
    return {
      kind: "refused",
      reason:
        resolution.kind === "replayed"
          ? "replayed"
          : resolution.kind === "expired"
            ? "expired"
            : resolution.kind === "revoked"
              ? "revoked"
              : "unknown",
    };
  }

  const row = resolution.row;

  if (row.deviceProofKeyId !== input.deviceProofKeyId) {
    return { kind: "refused", reason: "device-mismatch" };
  }

  // A token inside the grace window belongs to a row that was already replaced. The browser's jar
  // holds the current token - this request was in flight when it was rewritten - so nothing is
  // issued here, and the session is simply the one the rotation already made.
  if (resolution.kind === "grace") {
    const head = await dependencies.sessions.findLiveInFamily(row.familyId);

    if (head === null) {
      return { kind: "refused", reason: "revoked" };
    }

    return { kind: "current", sessionId: head.id, expiresAtEpochMs: head.expiresAtEpochMs };
  }

  if (nowEpochMs - row.issuedAtEpochMs < limits.rotationIntervalMs) {
    return { kind: "current", sessionId: row.id, expiresAtEpochMs: row.expiresAtEpochMs };
  }

  return rotate(row, input, nowEpochMs, limits, dependencies);
}

/** Start a family: the row that every later rotation copies from. */
async function openFamily(
  input: SessionIssueInput,
  nowEpochMs: number,
  limits: ReturnType<typeof policy>,
  dependencies: SessionRotationDependencies,
): Promise<SessionIssueOutcome> {
  const token = createRawSessionToken();
  const expiresAtEpochMs = nowEpochMs + limits.rotationWindowMs;
  const absoluteExpiresAtEpochMs = nowEpochMs + limits.absoluteWindowMs;
  const inserted = await dependencies.sessions.insert({
    userId: input.userId,
    companyId: input.companyId,
    deviceProofKeyId: input.deviceProofKeyId,
    tokenHash: hashSessionToken(token),
    issuedAtEpochMs: nowEpochMs,
    expiresAtEpochMs,
    absoluteExpiresAtEpochMs,
    mfaVerifiedAtEpochMs: input.assuranceLevel === "aal2" ? nowEpochMs : null,
    reauthenticatedAtEpochMs: null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    familyId: null,
    rotatedFromSessionId: null,
  });

  await dependencies.audit
    .append({
      action: "session.bound",
      actorUserId: input.userId,
      entityType: "session",
      entityId: inserted.id,
      companyId: input.companyId,
      sessionId: inserted.id,
      payload: {
        family_id: inserted.familyId,
        device_proof_key_id: input.deviceProofKeyId,
        expires_at: new Date(expiresAtEpochMs).toISOString(),
        absolute_expires_at: new Date(absoluteExpiresAtEpochMs).toISOString(),
        assurance_level: input.assuranceLevel,
        claim_session_id: input.claimSessionId,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return {
    kind: "bound",
    sessionId: inserted.id,
    familyId: inserted.familyId,
    token,
    expiresAtEpochMs,
  };
}

/**
 * Replace a live session row with its child.
 *
 * The order is the security property: the parent is revoked first, with a compare and swap, and only
 * a call that won the swap may insert a child. A caller that lost the swap is inside the grace
 * window it just created, and is answered with the family's live row instead of a second token.
 */
async function rotate(
  row: SessionRow,
  input: SessionIssueInput,
  nowEpochMs: number,
  limits: ReturnType<typeof policy>,
  dependencies: SessionRotationDependencies,
): Promise<SessionIssueOutcome> {
  const instant = new Date(nowEpochMs).toISOString();

  await dependencies.sessions.update(row.id, "revoked_at=is.null", {
    revoked_at: instant,
    revocation_reason: "ROTATED",
  });

  const reread = await dependencies.sessions.findByHash(hashSessionToken(input.presentedToken ?? ""));

  if (reread === null || reread.revokedAtEpochMs !== nowEpochMs || reread.revocationReason !== "ROTATED") {
    // Another request rotated the same row first. Its child is the live row of the family, and the
    // token this caller holds is spent - the grace rule decides whether that is a replay.
    const head = await dependencies.sessions.findLiveInFamily(row.familyId);

    if (head === null) {
      return { kind: "refused", reason: "revoked" };
    }

    if (head.deviceProofKeyId !== input.deviceProofKeyId) {
      return { kind: "refused", reason: "device-mismatch" };
    }

    return { kind: "current", sessionId: head.id, expiresAtEpochMs: head.expiresAtEpochMs };
  }

  const token = createRawSessionToken();
  const expiresAtEpochMs = Math.min(nowEpochMs + limits.rotationWindowMs, row.absoluteExpiresAtEpochMs);

  let child: SessionRow;

  try {
    child = await dependencies.sessions.insert({
      userId: row.userId,
      companyId: row.companyId,
      deviceProofKeyId: row.deviceProofKeyId,
      tokenHash: hashSessionToken(token),
      issuedAtEpochMs: nowEpochMs,
      expiresAtEpochMs,
      absoluteExpiresAtEpochMs: row.absoluteExpiresAtEpochMs,
      mfaVerifiedAtEpochMs: row.mfaVerifiedAtEpochMs,
      // The proof belongs to the login, not to one rotation of it: a token replaced one second after
      // a reauthentication must not send the person back to the code field.
      reauthenticatedAtEpochMs: row.reauthenticatedAtEpochMs,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      familyId: row.familyId,
      rotatedFromSessionId: row.id,
    });
  } catch (error) {
    // `sessions_rotation_key` already refuses a second child. Reaching it means another writer won,
    // which is not this caller's fault and is not a replay: the family still has one live row.
    if (isConflictError(error)) {
      const head = await dependencies.sessions.findLiveInFamily(row.familyId);

      return head === null
        ? { kind: "refused", reason: "revoked" }
        : { kind: "current", sessionId: head.id, expiresAtEpochMs: head.expiresAtEpochMs };
    }

    throw error;
  }

  await dependencies.audit
    .append({
      action: "session.rotated",
      actorUserId: row.userId,
      entityType: "session",
      entityId: child.id,
      companyId: row.companyId,
      sessionId: child.id,
      payload: {
        previous_session_id: row.id,
        family_id: row.familyId,
        expires_at: new Date(expiresAtEpochMs).toISOString(),
        absolute_expires_at: new Date(row.absoluteExpiresAtEpochMs).toISOString(),
        rotated_after_ms: nowEpochMs - row.issuedAtEpochMs,
      },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return {
    kind: "rotated",
    sessionId: child.id,
    familyId: row.familyId,
    token,
    expiresAtEpochMs,
  };
}

/**
 * End one session, for a sign out or a device that is being dropped.
 *
 * `054` owns the screens and the permission check; this is the write they will call, so that "every
 * session event is audited" holds for it too.
 */
export async function revokeSession(
  input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly companyId: string | null;
    readonly reason: SessionRevocationReason;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  },
  dependencies: SessionRotationDependencies,
): Promise<boolean> {
  const instant = new Date(clock(dependencies)).toISOString();

  await dependencies.sessions.update(input.sessionId, "revoked_at=is.null", {
    revoked_at: instant,
    revocation_reason: input.reason,
  });

  await dependencies.audit
    .append({
      action: "session.revoked",
      actorUserId: input.userId,
      entityType: "session",
      entityId: input.sessionId,
      companyId: input.companyId,
      sessionId: input.sessionId,
      payload: { reason: input.reason, revoked_at: instant },
      ...(input.ipAddress === null ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
    })
    .catch(() => undefined);

  return true;
}

/**
 * Revoke every session of one device.
 *
 * Section 22's "instant session revocation" and `0010`'s `DEVICE_REVOKED` reason meet here: dropping
 * a device has to end the logins it holds, or the device list is a decoration.
 */
export async function revokeDeviceSessions(
  input: {
    readonly deviceProofKeyId: string;
    readonly userId: string;
    readonly companyId: string | null;
  },
  dependencies: SessionRotationDependencies,
): Promise<number> {
  const instant = new Date(clock(dependencies)).toISOString();
  const revoked = await dependencies.sessions.revokeDevice(input.deviceProofKeyId, {
    revoked_at: instant,
    revocation_reason: "DEVICE_REVOKED",
  });

  if (revoked > 0) {
    await dependencies.audit
      .append({
        action: "session.device_revoked",
        actorUserId: input.userId,
        entityType: "device_proof_key",
        entityId: input.deviceProofKeyId,
        companyId: input.companyId,
        payload: { device_proof_key_id: input.deviceProofKeyId, revoked_sessions: revoked },
      })
      .catch(() => undefined);
  }

  return revoked;
}
