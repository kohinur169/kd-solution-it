// path: app/(admin)/account-unlocks/account-locks.ts
import { z } from "zod";
import { ACCOUNT_UNLOCK_NOTE_MAX_LENGTH, ACCOUNT_UNLOCK_OFFICE_ROLES } from "../../../lib/auth/account-unlock.ts";
import type { RestClient } from "../../../lib/auth/rest.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "../../../lib/auth/session.ts";
import type { RequestActor } from "../../../lib/auth/types.ts";
import { AppError } from "../../../lib/errors/app-error.ts";
import type { MessagePath } from "../../../lib/i18n/messages.ts";

/**
 * The two lists section 22's unlock screen is built on.
 *
 * ## What already exists, and what this module is
 *
 * The lock is `0012_account_locks.sql`, the note an unlock must carry is `0087`, the alert that went
 * to the owner is `0086`, and the act itself is STEP 047's `unlockAccountLock`: read, refuse, write,
 * read back, audit, queue the confirmation. None of that is repeated here. What is missing - and what
 * this module is - is the question the service answers only for one lock it was already given:
 * *which* locks are open, for whom, and since when.
 *
 * ## The two lists
 *
 * 1. **The queue.** Every open lock, the one that has waited longest first, because a person who has
 *    been shut out of their own business for an hour and fifty minutes is the one the office owes an
 *    answer. It is capped at fifty: a queue that long is an incident, and a screen that pretends to
 *    show all of it would be a page nobody can load.
 * 2. **The record.** What the office closed most recently, newest first, so an officer can see that a
 *    colleague already ended a lock - and read the note they wrote - instead of discovering it only
 *    after writing a second note that changes nothing.
 *
 * ## Why the account is joined
 *
 * Section 22 unlocks "only after contact with the owner is confirmed by email". An officer cannot
 * confirm contact with somebody they cannot identify, so the queue carries the account's address and
 * name beside its identifier. That is one read of `users` for the identifiers on the page and nothing
 * else: no listing, no search, no field the screen does not print.
 *
 * ## Why a lapsed row is shown and not offered
 *
 * `unlockAccountLock` refuses a lock whose two hours are over with `CONFLICT`, because the clock
 * already ended it - `readAccountLock` of STEP 045 treats it as open, and closing it would change no
 * sign-in. So the screen prints such a row as "the time is up" and offers no button: a screen that
 * offered one would be promising an action the service refuses, and an officer would learn the rule
 * from an error instead of from the row.
 *
 * ## Why the same guard as the write
 *
 * `unlockAccountLock` asks two questions - `ACCOUNT_UNLOCK_OFFICE_ROLES` and a satisfied second
 * factor - before it touches anything. This module asks the same two before its first query, with the
 * same functions, so a role that could not unlock cannot read either list, and the screen needs no
 * copy of the rule. Reading the queue is reading merchant addresses; it is not a courtesy for a role
 * that may not act on it.
 */

/** How many open locks the queue carries. */
export const ACCOUNT_LOCK_QUEUE_LIMIT = 50;

/** How many closed locks the record beside it carries. */
export const ACCOUNT_LOCK_RECENT_LIMIT = 20;

/** The note ceiling, taken from the column and the service rather than restated. */
export const ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH = ACCOUNT_UNLOCK_NOTE_MAX_LENGTH;

/** The two factors that can reach the threshold, spelled as `account_locks.triggered_by` spells them. */
export const ACCOUNT_LOCK_FACTORS = ["password", "totp"] as const;

export type AccountLockFactor = (typeof ACCOUNT_LOCK_FACTORS)[number];

/**
 * Where one open row stands.
 *
 * `lapsed` is not a column: it is a row that nobody closed and the clock has passed. The screen says
 * so, and the service refuses it, which is why the two agree here rather than in two places.
 */
export type AccountLockStanding = "open" | "lapsed";

/** The account behind a lock, as far as this screen may print it: both columns are `not null` in `0003`. */
export interface AccountLockAccount {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

export interface OpenLockView {
  readonly id: string;
  readonly userId: string;
  readonly companyId: string | null;
  readonly triggeredBy: AccountLockFactor;
  readonly lockedAt: string;
  readonly expiresAt: string;
  readonly remainingSeconds: number;
  readonly standing: AccountLockStanding;
  /** True when the lock alert of section 23 reached the owner. A missing one is a fact worth showing. */
  readonly ownerAlerted: boolean;
  /** When a colleague already recorded the contact, or null. */
  readonly ownerContactConfirmedAt: string | null;
  readonly account: AccountLockAccount | null;
  /** True only when `unlockAccountLock` would accept this row right now. */
  readonly unlockable: boolean;
}

export interface ClosedLockView {
  readonly id: string;
  readonly userId: string;
  readonly companyId: string | null;
  readonly triggeredBy: AccountLockFactor;
  readonly lockedAt: string;
  readonly unlockedAt: string;
  readonly unlockedBy: string | null;
  /** What the officer verified. On the row, and therefore printable to the office. */
  readonly unlockNote: string | null;
  readonly account: AccountLockAccount | null;
}

export interface AccountLockQueue {
  readonly open: readonly OpenLockView[];
  readonly closed: readonly ClosedLockView[];
  readonly readAtEpochMs: number;
  readonly queueLimit: number;
  readonly recentLimit: number;
}

export interface AccountLockQueueDependencies {
  readonly rest: RestClient;
  readonly now?: () => number;
}

const openRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  triggered_by: z.enum(ACCOUNT_LOCK_FACTORS),
  locked_at: z.string().min(1).max(40),
  expires_at: z.string().min(1).max(40),
  owner_alerted_at: z.string().min(1).max(40).nullable(),
  owner_contact_confirmed_at: z.string().min(1).max(40).nullable(),
});

const closedRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  triggered_by: z.enum(ACCOUNT_LOCK_FACTORS),
  locked_at: z.string().min(1).max(40),
  unlocked_at: z.string().min(1).max(40),
  unlocked_by: z.string().min(1).max(64).nullable(),
  unlock_note: z.string().min(1).max(ACCOUNT_LOCK_NOTE_MAXIMUM_LENGTH).nullable(),
});

const accountRowSchema = z.object({
  id: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  full_name: z.string().min(1).max(120),
});

/** Where a lock stands at one instant, failing closed when its expiry cannot be read. */
export function lockStandingOf(expiresAt: string, instantMs: number): AccountLockStanding {
  const expiresAtMs = Date.parse(expiresAt);

  if (!Number.isFinite(expiresAtMs)) {
    return "lapsed";
  }

  return expiresAtMs > instantMs ? "open" : "lapsed";
}

/** The whole seconds a lock has left, or zero once its two hours are over. */
export function remainingSecondsOf(expiresAt: string, instantMs: number): number {
  const expiresAtMs = Date.parse(expiresAt);

  if (!Number.isFinite(expiresAtMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiresAtMs - instantMs) / 1_000));
}

/** The catalog key of the factor that reached the threshold. */
export function lockFactorLabelKey(factor: AccountLockFactor): MessagePath {
  return factor === "password" ? "officeUnlock.factorPassword" : "officeUnlock.factorTotp";
}

/** The catalog key of a lock's standing. */
export function lockStandingLabelKey(standing: AccountLockStanding): MessagePath {
  return standing === "open" ? "officeUnlock.standingOpen" : "officeUnlock.standingLapsed";
}

function accountsById(accounts: readonly AccountLockAccount[]): ReadonlyMap<string, AccountLockAccount> {
  return new Map(accounts.map((account) => [account.userId, account]));
}

function instantOf(epochMs: number): number {
  return Number.isFinite(epochMs) ? epochMs : Date.now();
}

/**
 * The two lists, for one office account.
 *
 * Four reads and no writes: the open locks, the recently closed ones, and - only when there is
 * somebody to look up - one read of the accounts named by both. An account whose row is gone from
 * `users` is printed by its identifier rather than dropped, because a lock on an account the office
 * cannot see is exactly the kind of row somebody has to be told about.
 */
export async function listAccountLocks(
  input: { readonly actor: RequestActor },
  dependencies: AccountLockQueueDependencies,
): Promise<AccountLockQueue> {
  requireAnyRole(input.actor, ACCOUNT_UNLOCK_OFFICE_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const instantMs = instantOf(dependencies.now?.() ?? Date.now());

  const openRows = await dependencies.rest.select(
    "account_locks",
    "select=id,user_id,company_id,triggered_by,locked_at,expires_at,owner_alerted_at" +
      ",owner_contact_confirmed_at&unlocked_at=is.null&expired_at=is.null&deleted_at=is.null" +
      `&order=locked_at.asc&limit=${String(ACCOUNT_LOCK_QUEUE_LIMIT)}`,
    openRowSchema,
  );

  const closedRows = await dependencies.rest.select(
    "account_locks",
    "select=id,user_id,company_id,triggered_by,locked_at,unlocked_at,unlocked_by,unlock_note" +
      "&unlocked_at=not.is.null&deleted_at=is.null" +
      `&order=unlocked_at.desc&limit=${String(ACCOUNT_LOCK_RECENT_LIMIT)}`,
    closedRowSchema,
  );

  const userIds = [
    ...new Set([...openRows.map((row) => row.user_id), ...closedRows.map((row) => row.user_id)]),
  ];
  let accounts: ReadonlyMap<string, AccountLockAccount> = new Map();

  if (userIds.length > 0) {
    const rows = await dependencies.rest.select(
      "users",
      `select=id,email,full_name&id=in.(${userIds.map((id) => encodeURIComponent(id)).join(",")})` +
        "&deleted_at=is.null&limit=100",
      accountRowSchema,
    );

    accounts = accountsById(
      rows.map((row) => ({ userId: row.id, email: row.email, fullName: row.full_name })),
    );
  }

  return {
    open: openRows.map((row) => {
      const standing = lockStandingOf(row.expires_at, instantMs);

      return {
        id: row.id,
        userId: row.user_id,
        companyId: row.company_id,
        triggeredBy: row.triggered_by,
        lockedAt: row.locked_at,
        expiresAt: row.expires_at,
        remainingSeconds: remainingSecondsOf(row.expires_at, instantMs),
        standing,
        ownerAlerted: row.owner_alerted_at !== null,
        ownerContactConfirmedAt: row.owner_contact_confirmed_at,
        account: accounts.get(row.user_id) ?? null,
        unlockable: standing === "open",
      };
    }),
    closed: closedRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      triggeredBy: row.triggered_by,
      lockedAt: row.locked_at,
      unlockedAt: row.unlocked_at,
      unlockedBy: row.unlocked_by,
      unlockNote: row.unlock_note,
      account: accounts.get(row.user_id) ?? null,
    })),
    readAtEpochMs: instantMs,
    queueLimit: ACCOUNT_LOCK_QUEUE_LIMIT,
    recentLimit: ACCOUNT_LOCK_RECENT_LIMIT,
  };
}
