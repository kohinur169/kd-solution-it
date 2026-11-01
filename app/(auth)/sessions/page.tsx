// path: app/(auth)/sessions/page.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { listOwnSessions, type SessionView } from "@/lib/auth/session-list";
import { getMessage } from "@/lib/i18n/messages";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { SessionList } from "./session-list";

export const metadata: Metadata = {
  title: getMessage("sessions.title"),
  description: getMessage("sessions.description"),
};

/** A revoke in another tab changes this list, so the page is read on every request. */
export const dynamic = "force-dynamic";

/**
 * The three answers this screen can give, kept apart.
 *
 * "Nobody is signed in" and "the sessions could not be read" are different facts, and a screen that
 * folded them into an empty list would tell a person whose laptop was stolen that they were signed
 * out everywhere - which is the one sentence this page must never print by accident.
 */
type SessionsState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly sessions: readonly SessionView[] };

/**
 * Read the list for the person asking.
 *
 * The filter is the actor's own `userId`, inside `listOwnSessions`: the page passes no identifier, so
 * there is nothing a crafted request could point at another account.
 */
async function readSessionsState(): Promise<SessionsState> {
  try {
    const cookieHeader = (await headers()).get("cookie");
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const sessions = await listOwnSessions(actor, {
      rest: runtime.rest,
      audit: runtime.audit,
      sessions: runtime.sessions,
    });

    return { kind: "ready", sessions };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    return { kind: "unavailable" };
  }
}

/**
 * Section 22's session list for the owner.
 *
 * The list is read on the server because the session is: the browser receives rows and not a query,
 * and it never holds a value it could send back to widen it. Everything that changes the list - one
 * revoke, or every other session at once - is a signed `POST` from the client component, so the act
 * carries the device it was pressed on.
 */
export default async function SessionsPage(): Promise<ReactNode> {
  const state = await readSessionsState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("sessions.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("sessions.title")}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground sm:text-base">
          {getMessage("sessions.description")}
        </p>

        {state.kind === "ready" ? (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">
              {getMessage("sessions.listTitle")}
            </h2>
            <SessionList sessions={state.sessions} />
          </>
        ) : (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("sessions.signedOut")
              : getMessage("sessions.unavailable")}
          </p>
        )}

        <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("sessions.home")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
