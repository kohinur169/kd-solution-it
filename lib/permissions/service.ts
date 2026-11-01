// path: lib/permissions/service.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { requireAnyRole } from "../auth/session.ts";
import { requireFreshReauthentication } from "../auth/step-up.ts";
import { isPlatformRole, type RequestActor } from "../auth/types.ts";
import {
  DELEGABLE_PERMISSION_KEYS,
  GRANT_DURATIONS,
  PERMISSION_ACTIVE_LIMIT,
  PERMISSION_DELEGATION_ROLES,
  PERMISSION_EXPIRING_SOON_MS,
  PERMISSION_HISTORY_LIMIT,
  PERMISSION_REASON_MAXIMUM_LENGTH,
  PERMISSION_REASON_MINIMUM_LENGTH,
  RESERVED_PERMISSION_KEYS,
  expiryInstantOf,
  isDelegablePermission,
  isGrantDurationDays,
  isPermissionKey,
  normalizeEmail,
} from "./registry.ts";

/**
 * The delegation screen's service: list what is delegated, hand one permission out, take one back.
 *
 * ## Why this is not a role editor
 *
 * `role_assignments` answers "what kind of office user is this"; `office_permissions` answers "which
 * named authority does this person hold on top of that". A grant writes the second and never the first,
 * so the screen cannot quietly promote anybody: the account keeps its role, its charter and its place
 * in the office, and gains one action until an instant. The audit trail carries both ends of that
 * window, which is what section 2 asks of every permission grant and change.
 *
 * ## The checks, and the order they run in
 *
 *   1. the caller holds the delegation role (`PERMISSION_DELEGATION_ROLES`, one role in section 2);
 *   2. the caller proved a second factor in the last ten minutes - an authority handed to a colleague
 *      is as sensitive as a key, so a session that has not proved itself cannot hand one out;
 *   3. the key is one this screen may delegate, which excludes the three the super administrator keeps
 *      and every key that is not in the catalog at all;
 *   4. the address is an address, and it belongs to an active account;
 *   5. the account is not the caller, and it holds an office role - a merchant has no office authority
 *      to extend, and section 2 keeps the merchant's own powers to `owner` rows;
 *   6. the account does not already hold the key, because `office_permissions_live_key` allows one live
 *      row per (account, key) and a lapsed row still counts as live until it is withdrawn;
 *   7. the reason is long enough to be worth reading and the window is one the screen offers.
 *
 * Only then is the row written, and the audit entry follows the row: a grant the platform cannot record
 * is a grant that did not happen.
 *
 * ## Why a lapsed grant is listed and not deleted
 *
 * `expires_at` passing is not an event anybody performs, so no row is written when it passes. The read
 * marks the row as lapsed and stops answering permission checks with it, and the row stays on the
 * screen until somebody withdraws it - the `office_permissions_live_key` index treats it as live, and a
 * row that blocks a new grant without being visible would be a puzzle rather than a record.
 */

/** The two tables this module reads and one it writes, plus the two lookups a grant makes. */
export type PermissionStore = Omit<RestClient, "rpc">;

export interface PermissionDependencies {
  readonly store: PermissionStore;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** One delegation as the screen reads it: who, what, why, until when, and how it ended. */
export interface DelegationView {
  readonly id: string;
  readonly permission: string;
  readonly holderId: string;
  readonly holderName: string | null;
  readonly holderEmail: string | null;
  readonly grantedById: string | null;
  readonly grantedByName: string | null;
  readonly grantedAtEpochMs: number;
  /** Null only for a row written before this STEP made a window mandatory. */
  readonly expiresAtEpochMs: number | null;
  readonly expired: boolean;
  readonly expiringSoon: boolean;
  readonly revokedAtEpochMs: number | null;
  readonly revokedByName: string | null;
  readonly reason: string | null;
  readonly version: number;
}

/** Everything the delegation screen renders, in one read. */
export interface DelegationSnapshot {
  /** Unexpired and not withdrawn. */
  readonly active: readonly DelegationView[];
  /** Past its window and not withdrawn: still on the screen, no longer answering a check. */
  readonly lapsed: readonly DelegationView[];
  /** The last twenty withdrawals, newest first. */
  readonly ended: readonly DelegationView[];
  /** The keys the form may offer. */
  readonly delegable: readonly string[];
  /** The three the screen never hands out, which it names instead of offering. */
  readonly reserved: readonly string[];
  readonly readAtEpochMs: number;
}

const identifierSchema = z.string().trim().min(1).max(64);

const instantSchema = z.string().min(1).max(40);

const permissionRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  permission: z.string().min(1).max(64),
  granted_by: z.string().min(1).max(64).nullable(),
  granted_at: instantSchema,
  expires_at: instantSchema.nullable(),
  revoked_at: instantSchema.nullable(),
  revoked_by: z.string().min(1).max(64).nullable().optional(),
  reason: z.string().max(PERMISSION_REASON_MAXIMUM_LENGTH).nullable(),
  version: z.number().int().positive(),
});

const accountRowSchema = z.object({
  id: z.string().min(1).max(64),
  email: z.string().min(5).max(254),
  full_name: z.string().max(120),
  status: z.string().min(1).max(20),
  deleted_at: z.string().nullable(),
});

const roleRowSchema = z.object({ role: z.string().min(1).max(32) });

const insertedRowSchema = z.object({ id: z.string().min(1).max(64) });

const delegationColumns =
  "select=id,user_id,permission,granted_by,granted_at,expires_at,revoked_at,revoked_by,reason,version";

function nowOf(dependencies: PermissionDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function epochOf(value: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function epochOrNull(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : epochOf(value);
}

/** The accounts behind a page of rows, in one query, keyed by id. */
type AccountIndex = ReadonlyMap<string, z.infer<typeof accountRowSchema>>;

async function readAccounts(
  ids: readonly string[],
  dependencies: PermissionDependencies,
): Promise<AccountIndex> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const index = new Map<string, z.infer<typeof accountRowSchema>>();

  if (unique.length === 0) {
    return index;
  }

  const rows = await dependencies.store.select(
    "users",
    `select=id,email,full_name,status,deleted_at&id=in.(${unique
      .map((id) => encodeURIComponent(id))
      .join(",")})&limit=${String(PERMISSION_ACTIVE_LIMIT)}`,
    accountRowSchema,
  );

  for (const row of rows) {
    index.set(row.id, row);
  }

  return index;
}

function viewOf(
  row: z.infer<typeof permissionRowSchema>,
  accounts: AccountIndex,
  instant: number,
): DelegationView {
  if (!isPermissionKey(row.permission)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const expiresAtEpochMs = epochOrNull(row.expires_at);
  const expired = expiresAtEpochMs !== null && expiresAtEpochMs <= instant;
  const holder = accounts.get(row.user_id) ?? null;
  const grantor = row.granted_by === null ? null : (accounts.get(row.granted_by) ?? null);
  const revoker =
    row.revoked_by === null || row.revoked_by === undefined
      ? null
      : (accounts.get(row.revoked_by) ?? null);

  return {
    id: row.id,
    permission: row.permission,
    holderId: row.user_id,
    holderName: holder?.full_name ?? null,
    holderEmail: holder?.email ?? null,
    grantedById: row.granted_by,
    grantedByName: grantor?.full_name ?? null,
    grantedAtEpochMs: epochOf(row.granted_at),
    expiresAtEpochMs,
    expired,
    expiringSoon:
      !expired && expiresAtEpochMs !== null && expiresAtEpochMs - instant <= PERMISSION_EXPIRING_SOON_MS,
    revokedAtEpochMs: epochOrNull(row.revoked_at),
    revokedByName: revoker?.full_name ?? null,
    reason: row.reason,
    version: row.version,
  };
}

/**
 * Read what is delegated, what has run out, and what was withdrawn.
 *
 * Three queries and no loop: the live rows, the twenty most recent withdrawals, and the accounts both
 * lists name - one request for all of them. A row whose holder has since been deleted keeps a null name
 * rather than disappearing, because the delegation is about the authority and not about the account
 * still existing.
 */
export async function listDelegations(
  input: { readonly actor: RequestActor },
  dependencies: PermissionDependencies,
): Promise<DelegationSnapshot> {
  requireAnyRole(input.actor, PERMISSION_DELEGATION_ROLES);

  const instant = nowOf(dependencies);

  const liveRows = await dependencies.store.select(
    "office_permissions",
    `${delegationColumns}&revoked_at=is.null&deleted_at=is.null&order=expires_at.asc` +
      `&limit=${String(PERMISSION_ACTIVE_LIMIT)}`,
    permissionRowSchema,
  );

  const endedRows = await dependencies.store.select(
    "office_permissions",
    `${delegationColumns}&revoked_at=not.is.null&deleted_at=is.null&order=revoked_at.desc` +
      `&limit=${String(PERMISSION_HISTORY_LIMIT)}`,
    permissionRowSchema,
  );

  const accounts = await readAccounts(
    [
      ...liveRows.map((row) => row.user_id),
      ...liveRows.map((row) => row.granted_by ?? ""),
      ...endedRows.map((row) => row.user_id),
      ...endedRows.map((row) => row.revoked_by ?? ""),
    ],
    dependencies,
  );

  const liveViews = liveRows.map((row) => viewOf(row, accounts, instant));
  const endedViews = endedRows.map((row) => viewOf(row, accounts, instant));

  return {
    active: liveViews.filter((view) => !view.expired),
    lapsed: liveViews.filter((view) => view.expired),
    ended: endedViews,
    delegable: DELEGABLE_PERMISSION_KEYS,
    reserved: RESERVED_PERMISSION_KEYS,
    readAtEpochMs: instant,
  };
}

/** The live office roles of one account: a grant needs an officer, and a merchant is not one. */
async function liveOfficeRolesOf(
  userId: string,
  dependencies: PermissionDependencies,
): Promise<readonly string[]> {
  const rows = await dependencies.store.select(
    "role_assignments",
    `select=role&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&deleted_at=is.null` +
      "&limit=16",
    roleRowSchema,
  );

  return rows.map((row) => row.role).filter((role) => isPlatformRole(role) && role !== "owner");
}

/**
 * Hand one permission to one office account, until an instant.
 *
 * The insert is the guard the read cannot be: two super administrators granting the same key at the same
 * moment both pass the duplicate read, and only `office_permissions_live_key` refuses the second. A
 * unique violation therefore answers the same `CONFLICT` with the same rule the read answers, so the
 * screen words both the same way.
 */
export async function grantPermission(
  input: {
    readonly actor: RequestActor;
    readonly permission: string;
    readonly email: string;
    readonly days: number;
    readonly reason: string;
  },
  dependencies: PermissionDependencies,
): Promise<DelegationView> {
  const instant = nowOf(dependencies);

  requireAnyRole(input.actor, PERMISSION_DELEGATION_ROLES);
  requireFreshReauthentication(input.actor, instant);

  if (!isPermissionKey(input.permission)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "permission", rule: "unknown_permission" }],
    });
  }

  if (!isDelegablePermission(input.permission)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "permission", rule: "not_delegable" }],
    });
  }

  const email = normalizeEmail(input.email);

  if (email === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "email", rule: "invalid_format" }],
    });
  }

  const reason = input.reason.trim();

  if (
    reason.length < PERMISSION_REASON_MINIMUM_LENGTH ||
    reason.length > PERMISSION_REASON_MAXIMUM_LENGTH
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "reason", rule: "invalid_length" }],
    });
  }

  if (!isGrantDurationDays(input.days) || !GRANT_DURATIONS.some((duration) => duration.days === input.days)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "days", rule: "invalid_range" }],
    });
  }

  const accounts = await dependencies.store.select(
    "users",
    `select=id,email,full_name,status,deleted_at&email=eq.${encodeURIComponent(email)}&limit=2`,
    accountRowSchema,
  );

  const account = accounts.find((row) => row.deleted_at === null);

  if (account === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (account.id === input.actor.userId) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "email", rule: "self" }],
    });
  }

  if (account.status !== "active") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "email", rule: "account_inactive" }],
    });
  }

  const roles = await liveOfficeRolesOf(account.id, dependencies);

  if (roles.length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "email", rule: "not_office_staff" }],
    });
  }

  // A lapsed row still holds the live key, so this read asks for the same rows the index does.
  const existing = await dependencies.store.select(
    "office_permissions",
    `select=id&user_id=eq.${encodeURIComponent(account.id)}` +
      `&permission=eq.${encodeURIComponent(input.permission)}` +
      "&revoked_at=is.null&deleted_at=is.null&limit=1",
    insertedRowSchema,
  );

  if (existing.length > 0) {
    throw new AppError("CONFLICT", { details: [{ field: "permission", rule: "duplicate" }] });
  }

  const expiresAtEpochMs = expiryInstantOf(instant, input.days);
  const grantedAt = new Date(instant).toISOString();
  const expiresAt = new Date(expiresAtEpochMs).toISOString();

  let inserted: readonly z.infer<typeof insertedRowSchema>[];

  try {
    inserted = await dependencies.store.insertReturning(
      "office_permissions",
      [
        {
          user_id: account.id,
          permission: input.permission,
          granted_by: input.actor.userId,
          granted_at: grantedAt,
          expires_at: expiresAt,
          reason,
        },
      ],
      insertedRowSchema,
    );
  } catch (error) {
    // `office_permissions_live_key` is the real guard; the read above only words the common case.
    if (error instanceof AppError && error.code === "CONFLICT") {
      throw new AppError("CONFLICT", { details: [{ field: "permission", rule: "duplicate" }] });
    }

    throw error;
  }

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  await dependencies.audit.append({
    action: "permission.granted",
    actorUserId: input.actor.userId,
    entityType: "office_permission",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      permission: input.permission,
      holder_user_id: account.id,
      holder_roles: roles,
      granted_at: grantedAt,
      expires_at: expiresAt,
      days: input.days,
      reason_length: reason.length,
    },
  });

  return {
    id: row.id,
    permission: input.permission,
    holderId: account.id,
    holderName: account.full_name,
    holderEmail: account.email,
    grantedById: input.actor.userId,
    grantedByName: null,
    grantedAtEpochMs: instant,
    expiresAtEpochMs,
    expired: false,
    expiringSoon: expiresAtEpochMs - instant <= PERMISSION_EXPIRING_SOON_MS,
    revokedAtEpochMs: null,
    revokedByName: null,
    reason,
    version: 1,
  };
}

/**
 * Withdraw one delegation now.
 *
 * The update is conditional on the row still being live and on the version the read returned, and it is
 * read back afterwards. The read back is what stops a write that matched nothing from looking like a
 * withdrawal: if the row is still live after the update, something moved between the two statements and
 * the answer is `CONFLICT`. (If another officer withdrew the same grant first, the second caller sees the
 * withdrawn row and the outcome they asked for - the grant is gone - so that case is not an error.) A
 * grant that has already run out is refused too: withdrawing it would change nothing, and the screen has
 * a different sentence for a window that ended by itself.
 */
export async function revokePermission(
  input: { readonly actor: RequestActor; readonly delegationId: string },
  dependencies: PermissionDependencies,
): Promise<DelegationView> {
  const instant = nowOf(dependencies);

  requireAnyRole(input.actor, PERMISSION_DELEGATION_ROLES);
  requireFreshReauthentication(input.actor, instant);

  const parsedId = identifierSchema.safeParse(input.delegationId);

  if (!parsedId.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const rows = await dependencies.store.select(
    "office_permissions",
    `${delegationColumns}&id=eq.${encodeURIComponent(parsedId.data)}` +
      "&revoked_at=is.null&deleted_at=is.null&limit=1",
    permissionRowSchema,
  );

  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const expiresAtEpochMs = epochOrNull(row.expires_at);

  if (expiresAtEpochMs !== null && expiresAtEpochMs <= instant) {
    throw new AppError("CONFLICT", { details: [{ field: "delegationId", rule: "expired" }] });
  }

  const revokedAt = new Date(instant).toISOString();

  await dependencies.store.update(
    "office_permissions",
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${String(row.version)}` +
      "&revoked_at=is.null&deleted_at=is.null",
    { revoked_at: revokedAt, revoked_by: input.actor.userId, version: row.version + 1 },
  );

  const after = await dependencies.store.select(
    "office_permissions",
    `${delegationColumns}&id=eq.${encodeURIComponent(row.id)}&limit=1`,
    permissionRowSchema,
  );

  const revoked = after[0];

  if (revoked === undefined || revoked.revoked_at === null) {
    throw new AppError("CONFLICT", { details: [{ field: "delegationId", rule: "changed" }] });
  }

  await dependencies.audit.append({
    action: "permission.revoked",
    actorUserId: input.actor.userId,
    entityType: "office_permission",
    entityId: revoked.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      permission: revoked.permission,
      holder_user_id: revoked.user_id,
      granted_at: revoked.granted_at,
      expires_at: revoked.expires_at,
      reason_length: revoked.reason?.length ?? 0,
    },
  });

  const accounts = await readAccounts([revoked.user_id, input.actor.userId], dependencies);

  return viewOf(revoked, accounts, instant);
}

/**
 * The permissions one account holds right now.
 *
 * The check every consumer of `office_permissions` must perform, in one place: live, not withdrawn, and
 * not past its window. A key the catalog does not know is dropped rather than returned - a row that
 * names something the platform cannot interpret cannot be a permission the platform grants.
 */
export async function effectivePermissionsOf(
  userId: string,
  dependencies: PermissionDependencies,
): Promise<readonly string[]> {
  const instant = nowOf(dependencies);

  const rows = await dependencies.store.select(
    "office_permissions",
    `${delegationColumns}&user_id=eq.${encodeURIComponent(userId)}` +
      "&revoked_at=is.null&deleted_at=is.null&limit=64",
    permissionRowSchema,
  );

  return rows
    .filter((row) => {
      const expiresAtEpochMs = epochOrNull(row.expires_at);

      return expiresAtEpochMs === null || expiresAtEpochMs > instant;
    })
    .map((row) => row.permission)
    .filter((permission) => isPermissionKey(permission));
}
