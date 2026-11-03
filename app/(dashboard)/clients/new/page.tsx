// path: app/(dashboard)/clients/new/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getMessage } from "@/lib/i18n/messages";
import { readOwnerActor } from "../../onboarding/owner-actor";
import { ClientForm } from "../client-form";

export const metadata: Metadata = {
  title: getMessage("clients.newTitle"),
  description: getMessage("clients.newDescription"),
};

/** The form is empty per request; the actor is read per request. */
export const dynamic = "force-dynamic";

/**
 * Section 15's client create form.
 *
 * The page reads the actor once and hands the form a null snapshot, because there is nothing to
 * prefill: every field starts empty and the service decides which of them are required. A signed
 * out or unavailable session gets the refusal sentence, never an empty form - a form posted with no
 * session behind it is exactly what the CSRF check on the route exists to refuse.
 */
export default async function NewClientPage(): Promise<ReactNode> {
  const actorState = await readOwnerActor();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("clients.newTitle")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("clients.newDescription")}</p>
        </header>

        {actorState.kind === "actor" ? (
          <ClientForm initial={null} savePath="/api/clients" creating={true} />
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {actorState.kind === "anonymous"
              ? getMessage("clients.signedOut")
              : getMessage("clients.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {actorState.kind === "anonymous" ? (
            <Link className="w-fit underline" href="/signin">
              {getMessage("clients.signInLink")}
            </Link>
          ) : (
            <Link className="w-fit underline" href="/clients">
              {getMessage("clients.backLink")}
            </Link>
          )}
          <Link className="w-fit underline" href="/">
            {getMessage("clients.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
