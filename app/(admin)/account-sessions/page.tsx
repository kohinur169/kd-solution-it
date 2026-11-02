// path: app/(admin)/account-sessions/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { OfficeSessionConsole } from "./office-session-console";
import {
  SESSION_SEARCH_MAXIMUM_LENGTH,
  readAccountSessions,
  subjectKindOf,
  type AccountSessionsSnapshot,
} from "./session-console";

export const metadata: Metadata = {
  title: getMessage("officeAccountSessions.title"),
  description: getMessage("officeAccountSessions.description"),
};

/**
 * Section 22's office view of one account's sessions.
 *
 * ## What this page is, and what it is not
 *
 * The sessions, the reason codes and the audit entries are STEP 054's: `listAccountSessions` reads
 * them, `revokeAccountSession` ends one with `ADMIN_REVOKED` and the officer's name on the row, and
 * `app/office/sessions` is still the account's own screen. This page is the step before them - naming
 * the account - and the two controls a person actually uses: end this session, or end the rest.
 *
 * ## Why the account is named by identifier or exact address
 *
 * A merchant writes in with their email, so an officer holding a support ticket has no identifier to
 * paste. The address is matched exactly against `users_email_key`, which `0003` makes unique, so the
 * answer is one row or none on an index - never a list of people whose names look alike. Everything
 * else the box receives is refused at the form with a sentence, because a search of the wrong shape
 * is something the person can fix and not a failure to report.
 *
 * ## Why there is no role list in this file
 *
 * `readAccountSessions` asks the session roles before its first query, with the same constant
 * `listAccountSessions` uses, so a role that may not read sessions cannot learn from the
 * "no account" sentence whether an address exists. The three refusals are told apart because they mean
 * different things: no session is the sign in form, a role without the permission is an answer, and a
 * read that did not happen is an outage that must not look like an account with no sessions.
 *
 * ## Why the search is a plain form
 *
 * It is a `GET` of one field back to this page, so the query is in the address: an officer can keep the
 * link, hand it to a colleague, or paste it into the ticket. No state is held in the browser and no
 * request is made before the button is pressed.
 */

type ConsoleStateKind = "signed-out" | "forbidden" | "invalid-empty" | "invalid-format" | "missing" | "unavailable" | "ready";

interface ConsoleState {
  readonly kind: ConsoleStateKind;
  readonly snapshot: AccountSessionsSnapshot | null;
}

async function readConsoleState(query: string): Promise<ConsoleState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", snapshot: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", snapshot: null };
  }

  if (subjectKindOf(query) === "empty") {
    return { kind: "invalid-empty", snapshot: null };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readAccountSessions(
      { actor: actorState.actor, query },
      { rest: runtime.rest, audit: runtime.audit, sessions: runtime.sessions, now: (): number => Date.now() },
    );

    return snapshot === null ? { kind: "missing", snapshot: null } : { kind: "ready", snapshot };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out", snapshot: null };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden", snapshot: null };
    }

    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      const rule = error.details[0]?.rule;

      return { kind: rule === "required" ? "invalid-empty" : "invalid-format", snapshot: null };
    }

    return { kind: "unavailable", snapshot: null };
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const headingClasses = "text-xl font-semibold tracking-tight";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const mutedClasses = "text-sm text-muted-foreground";

const formClasses = "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card";

const labelClasses = "text-sm font-semibold text-foreground";

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-primary";

const submitClasses =
  "w-fit rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const subjectClasses = "grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2";

const subjectTermClasses = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

const subjectDetailClasses = "font-medium text-foreground";

export default async function AccountSessionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>;
}): Promise<ReactNode> {
  const parameters = await searchParams;
  const rawQuery = parameters["q"];
  const query = (typeof rawQuery === "string" ? rawQuery : "").trim();
  const state = await readConsoleState(query);
  const snapshot = state.snapshot;

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeAccountSessions.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeAccountSessions.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeAccountSessions.description")}</p>
        <p className={noteClasses}>{getMessage("officeAccountSessions.guardNote")}</p>
      </header>

      <section aria-labelledby="session-search" className={formClasses}>
        <h2 className={headingClasses} id="session-search">
          {getMessage("officeAccountSessions.searchHeading")}
        </h2>
        <form action="/account-sessions" className="flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
          <div className="flex w-full flex-col gap-1">
            <label className={labelClasses} htmlFor="session-search-account">
              {getMessage("officeAccountSessions.searchLabel")}
            </label>
            <input
              autoComplete="off"
              className={inputClasses}
              defaultValue={query}
              id="session-search-account"
              maxLength={SESSION_SEARCH_MAXIMUM_LENGTH}
              name="q"
              required
              type="text"
            />
          </div>
          <button className={submitClasses} type="submit">
            {getMessage("officeAccountSessions.searchSubmit")}
          </button>
        </form>
        <p className={noteClasses}>{getMessage("officeAccountSessions.searchHint")}</p>
        <p className={noteClasses}>
          {formatMessage("officeAccountSessions.searchMaximumNote", {
            count: SESSION_SEARCH_MAXIMUM_LENGTH,
          })}
        </p>
        {query.length === 0 ? null : (
          <Link className={linkClasses} href="/account-sessions">
            {getMessage("officeAccountSessions.searchClear")}
          </Link>
        )}
      </section>

      {state.kind === "invalid-empty" || state.kind === "ready" ? null : state.kind === "invalid-format" ? (
        <p className={alertClasses} role="alert">
          {getMessage("officeAccountSessions.invalidFormat")}
        </p>
      ) : state.kind === "missing" ? (
        <p className={mutedClasses}>
          {formatMessage("officeAccountSessions.missingAccount", { query })}
        </p>
      ) : (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeAccountSessions.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeAccountSessions.forbidden")
              : getMessage("officeAccountSessions.unavailable")}
        </p>
      )}

      {snapshot === null ? (
        state.kind === "invalid-empty" ? (
          <section aria-labelledby="session-idle" className="flex flex-col gap-2">
            <h2 className={headingClasses} id="session-idle">
              {getMessage("officeAccountSessions.idleHeading")}
            </h2>
            <p className={descriptionClasses}>{getMessage("officeAccountSessions.idleBody")}</p>
          </section>
        ) : null
      ) : (
        <>
          <section aria-labelledby="session-subject" className="flex flex-col gap-3">
            <h2 className={headingClasses} id="session-subject">
              {getMessage("officeAccountSessions.subjectHeading")}
            </h2>
            <dl className={subjectClasses}>
              <div>
                <dt className={subjectTermClasses}>{getMessage("officeAccountSessions.subjectName")}</dt>
                <dd className={subjectDetailClasses}>{snapshot.subject.fullName}</dd>
              </div>
              <div>
                <dt className={subjectTermClasses}>{getMessage("officeAccountSessions.subjectEmail")}</dt>
                <dd className={subjectDetailClasses}>{snapshot.subject.email}</dd>
              </div>
              <div>
                <dt className={subjectTermClasses}>{getMessage("officeAccountSessions.subjectId")}</dt>
                <dd className="font-mono text-xs text-foreground">{snapshot.subject.userId}</dd>
              </div>
              <div>
                <dt className={subjectTermClasses}>{getMessage("officeAccountSessions.subjectCompany")}</dt>
                <dd className={subjectDetailClasses}>
                  {snapshot.subject.companyId === null
                    ? getMessage("officeAccountSessions.subjectNoCompany")
                    : snapshot.subject.companyId}
                </dd>
              </div>
            </dl>
            <p className={noteClasses}>
              {formatMessage("officeAccountSessions.countsLine", {
                live: snapshot.counts.live,
                trusted: snapshot.counts.trustedDevices,
                unconfirmed: snapshot.counts.unconfirmedDevices,
                dropped: snapshot.counts.droppedDevices,
              })}
            </p>
          </section>

          <OfficeSessionConsole
            counts={snapshot.counts}
            readAtEpochMs={snapshot.readAtEpochMs}
            sessions={snapshot.sessions}
            subject={snapshot.subject}
          />
        </>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/admin">
          {getMessage("officeAccountSessions.home")}
        </Link>
      </nav>
    </div>
  );
}
