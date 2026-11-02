// path: app/office/sessions/page.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { listAccountSessions, type SessionView } from "@/lib/auth/session-list";
import { getMessage } from "@/lib/i18n/messages";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { OfficeSessionList } from "./office-session-list";

export const metadata: Metadata = {
  title: getMessage("officeSessions.title"),
  description: getMessage("officeSessions.description"),
};

/** Another tab's revoke changes this list, so the page is read on every request. */
export const dynamic = "force-dynamic";

/**
 * The five answers this screen can give.
 *
 * "Nobody is signed in", "this account may not manage sessions", "no account was named", "the
 * account has no session" and "the sessions could not be read" are five different facts. Folding
 * them into one empty list would tell a support worker that a merchant is signed out when the truth
 * might be that the office lost its own permission.
 */
type OfficeSessionsState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "missing-account" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly userId: string;
      readonly sessions: readonly SessionView[];
    };

/**
 * Read one account's sessions for the person asking.
 *
 * The permission check and the audit entry are inside `listAccountSessions`, so the page cannot be a
 * weaker path to the same read. An account id that names nobody is `RESOURCE_NOT_FOUND` from the
 * service and becomes the "no account" sentence here rather than an error screen.
 */
async function readOfficeSessionsState(userId: string): Promise<OfficeSessionsState> {
  if (userId.length === 0) {
    return { kind: "missing-account" };
  }

  try {
    const cookieHeader = (await headers()).get("cookie");
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const sessions = await listAccountSessions(
      { actor, userId },
      { rest: runtime.rest, audit: runtime.audit, sessions: runtime.sessions },
    );

    return { kind: "ready", userId, sessions };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "AUTHENTICATION_REQUIRED") {
        return { kind: "signed-out" };
      }

      if (error.code === "PERMISSION_DENIED") {
        return { kind: "forbidden" };
      }

      if (error.code === "RESOURCE_NOT_FOUND") {
        return { kind: "missing-account" };
      }
    }

    return { kind: "unavailable" };
  }
}

/**
 * The office screen for one account's sessions.
 *
 * The merchant's own screen ends a session with `SIGNED_OUT`; this one ends it with `ADMIN_REVOKED`
 * and names the officer in the audit trail, so an incident can tell "the account closed this door"
 * from "the platform did". The revoke itself needs the fresh proof of STEP 053, because signing a
 * merchant out of every device is an act on somebody else's account.
 */
export default async function OfficeSessionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | readonly string[] | undefined>>>;
}): Promise<ReactNode> {
  const parameters = await searchParams;
  const account = parameters["userId"];
  const userId = typeof account === "string" ? account.trim() : "";

  const state = await readOfficeSessionsState(userId);

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("officeSessions.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("officeSessions.title")}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground sm:text-base">
          {getMessage("officeSessions.description")}
        </p>

        <form className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
          <label className="flex-1">
            <span className="text-sm font-medium">{getMessage("officeSessions.searchLabel")}</span>
            <input
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
              defaultValue={userId}
              name="userId"
              type="text"
            />
          </label>
          <button
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            type="submit"
          >
            {getMessage("officeSessions.searchSubmit")}
          </button>
        </form>

        {state.kind === "ready" ? (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">
              {getMessage("officeSessions.listTitle")}
            </h2>
            {state.sessions.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {getMessage("officeSessions.empty")}
              </p>
            ) : (
              <OfficeSessionList sessions={state.sessions} userId={state.userId} />
            )}
          </>
        ) : (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("officeSessions.signedOut")
              : state.kind === "forbidden"
                ? getMessage("officeSessions.forbidden")
                : state.kind === "missing-account"
                  ? getMessage("officeSessions.missingAccount")
                  : getMessage("officeSessions.unavailable")}
          </p>
        )}

        <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("officeSessions.home")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
