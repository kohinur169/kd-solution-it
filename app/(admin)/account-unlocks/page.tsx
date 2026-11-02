// path: app/(admin)/account-unlocks/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import {
  listAccountLocks,
  lockFactorLabelKey,
  type AccountLockAccount,
  type AccountLockQueue,
  type ClosedLockView,
} from "./account-locks";
import { OfficeUnlockQueue } from "./office-unlock-queue";

export const metadata: Metadata = {
  title: getMessage("officeUnlock.title"),
  description: getMessage("officeUnlock.description"),
};

/**
 * Section 22's account unlock screen.
 *
 * ## What this page is, and what it is not
 *
 * The lock is `0012`, the role list and the act are STEP 047's `unlockAccountLock`, and the wording of
 * the whole platform is the catalog. This page is the two lists a person works from - the open locks
 * and what the office closed most recently - and one control on each waiting row.
 *
 * ## Why the refusal is the service's answer
 *
 * There is no role list in this file. `listAccountLocks` asks `ACCOUNT_UNLOCK_OFFICE_ROLES` and the
 * second factor question before its first query, with the same two functions the unlock itself uses,
 * so a role that could not end a lock cannot read either list - and this screen cannot offer an
 * action its service would refuse. The three refusals are told apart because they mean different
 * things: no session is the sign in form, a role without the permission is an answer, and a read that
 * did not happen is an outage that must not look like an empty queue.
 *
 * ## Why the record is read-only here
 *
 * The second list is what a human did, with the note they wrote. Nothing on this screen edits it: an
 * unlock is a closure `0012` makes mutually exclusive with the clock, and rewriting one would rewrite
 * the record of who ended a lock. The row exists so the next officer can see the work was already
 * done, not so it can be redone.
 *
 * ## Why the day and the clock are the platform's
 *
 * Every instant printed here is a `timestamptz` from the platform's database, printed in UTC with the
 * seconds cut. Two officers reading the same row must be reading one fact, and "how long is left" is
 * computed by the service from the same clock that printed the page.
 */

type UnlockStateKind = "signed-out" | "forbidden" | "unavailable" | "ready";

interface UnlockState {
  readonly kind: UnlockStateKind;
  readonly queue: AccountLockQueue | null;
}

async function readUnlockState(): Promise<UnlockState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", queue: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", queue: null };
  }

  const runtime = getAuthRuntime();

  try {
    const queue = await listAccountLocks(
      { actor: actorState.actor },
      { rest: runtime.rest, now: (): number => Date.now() },
    );

    return { kind: "ready", queue };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out", queue: null };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden", queue: null };
    }

    return { kind: "unavailable", queue: null };
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const sectionClasses = "flex flex-col gap-3";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const headingClasses = "text-xl font-semibold tracking-tight";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const metaClasses = "flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground";

const tableClasses = "w-full min-w-2xl border-collapse text-left text-sm";

const headCellClasses =
  "border-b border-border pb-2 pr-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const cellClasses = "border-b border-border py-3 pr-4 align-top";

const codeClasses = "font-mono text-xs";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** One instant, printed the way every office screen prints one: UTC, seconds cut. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().replace("T", " ").slice(0, 19)
    : iso;
}

/** What a person sees for the account behind a lock, falling back to its identifier. */
function accountLine(account: AccountLockAccount | null, userId: string): string {
  if (account === null) {
    return formatMessage("officeUnlock.accountUnknown", { account: userId.slice(0, 8) });
  }

  return account.email.length > 0 ? account.email : account.fullName;
}

function closedLockRow(lock: ClosedLockView): ReactNode {
  return (
    <tr key={lock.id}>
      <td className={cellClasses}>
        <span className="font-medium">{accountLine(lock.account, lock.userId)}</span>
        <span className={`${codeClasses} block text-muted-foreground`}>{lock.userId.slice(0, 8)}</span>
      </td>
      <td className={cellClasses}>{getMessage(lockFactorLabelKey(lock.triggeredBy))}</td>
      <td className={cellClasses}>{formatMessage("officeUnlock.timeLine", { at: instantOf(lock.lockedAt) })}</td>
      <td className={cellClasses}>
        {formatMessage("officeUnlock.timeLine", { at: instantOf(lock.unlockedAt) })}
      </td>
      <td className={cellClasses}>
        {lock.unlockedBy === null ? (
          <span className="text-muted-foreground">{getMessage("officeUnlock.notRecorded")}</span>
        ) : (
          <span className={codeClasses}>{lock.unlockedBy.slice(0, 8)}</span>
        )}
      </td>
      <td className={cellClasses}>
        {lock.unlockNote === null ? (
          <span className="text-muted-foreground">{getMessage("officeUnlock.noteMissing")}</span>
        ) : (
          lock.unlockNote
        )}
      </td>
    </tr>
  );
}

export default async function AccountUnlocksPage(): Promise<ReactNode> {
  const state = await readUnlockState();
  const queue = state.queue;

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeUnlock.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeUnlock.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeUnlock.description")}</p>
        <p className={noteClasses}>{getMessage("officeUnlock.guardNote")}</p>
      </header>

      {queue === null ? (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeUnlock.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeUnlock.forbidden")
              : getMessage("officeUnlock.unavailable")}
        </p>
      ) : (
        <>
          <section aria-labelledby="unlock-queue" className={sectionClasses}>
            <h2 className={headingClasses} id="unlock-queue">
              {getMessage("officeUnlock.queueHeading")}
            </h2>
            <p className={descriptionClasses}>{getMessage("officeUnlock.queueDescription")}</p>
            <p className={metaClasses}>
              <span>{formatMessage("officeUnlock.openCount", { count: queue.open.length })}</span>
              <span>{formatMessage("officeUnlock.readAt", { at: instantOf(new Date(queue.readAtEpochMs).toISOString()) })}</span>
            </p>

            {queue.open.length === 0 ? (
              <p className="text-sm text-muted-foreground">{getMessage("officeUnlock.queueEmpty")}</p>
            ) : (
              <OfficeUnlockQueue open={queue.open} />
            )}
          </section>

          <section aria-labelledby="unlock-record" className={sectionClasses}>
            <h2 className={headingClasses} id="unlock-record">
              {getMessage("officeUnlock.recordHeading")}
            </h2>
            <p className={descriptionClasses}>{getMessage("officeUnlock.recordDescription")}</p>

            {queue.closed.length === 0 ? (
              <p className="text-sm text-muted-foreground">{getMessage("officeUnlock.recordEmpty")}</p>
            ) : (
              <>
                <p className={noteClasses}>
                  {formatMessage("officeUnlock.recordLimitNote", { count: queue.closed.length })}
                </p>
                <div className="overflow-x-auto">
                  <table className={tableClasses}>
                    <thead>
                      <tr>
                        <th className={headCellClasses} scope="col">
                          {getMessage("officeUnlock.columnAccount")}
                        </th>
                        <th className={headCellClasses} scope="col">
                          {getMessage("officeUnlock.columnFactor")}
                        </th>
                        <th className={headCellClasses} scope="col">
                          {getMessage("officeUnlock.columnLocked")}
                        </th>
                        <th className={headCellClasses} scope="col">
                          {getMessage("officeUnlock.columnUnlocked")}
                        </th>
                        <th className={headCellClasses} scope="col">
                          {getMessage("officeUnlock.columnUnlockedBy")}
                        </th>
                        <th className={headCellClasses} scope="col">
                          {getMessage("officeUnlock.columnNote")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>{queue.closed.map((lock) => closedLockRow(lock))}</tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/admin">
          {getMessage("officeUnlock.home")}
        </Link>
      </nav>
    </div>
  );
}
