// path: app/(dashboard)/clients/import/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getMessage } from "@/lib/i18n/messages";
import { CLIENT_IMPORT_MAXIMUM_ROWS } from "@/services/clients/client-import";
import { MAXIMUM_CSV_ROWS } from "@/services/clients/csv";
import { readOwnerActor } from "../../onboarding/owner-actor";
import { ClientImportForm } from "./client-import-form";

export const metadata: Metadata = {
  title: getMessage("clients.importTitle"),
  description: getMessage("clients.importDescription"),
};

/** Read per request: the page asks who is signed in, and never caches a session. */
export const dynamic = "force-dynamic";

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/**
 * Section 15's client CSV import.
 *
 * ## Why the page reads the account and the form does not
 *
 * The form is a client component: it posts a file and prints the answer. Whether there is a session at
 * all is a server question, and a merchant who arrives here signed out should be told so instead of
 * being shown a file picker that will be refused. The page therefore reads the account once, exactly
 * as the client list and the client form do, and words the same three states the same way.
 *
 * ## Why the limits are printed
 *
 * A merchant with a five thousand row export needs to know before they upload it that this import takes
 * a thousand at a time, and a merchant whose file has a name column called something unusual needs to
 * know which headers are read. Both facts are the service's own constants, so the sentence cannot
 * drift from the code that enforces it.
 */
export default async function ClientImportPage(): Promise<ReactNode> {
  const actorState = await readOwnerActor();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {getMessage("clients.importTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">{getMessage("clients.importDescription")}</p>
        </header>

        {actorState.kind === "actor" ? (
          <>
            <p className="text-xs text-muted-foreground">
              {getMessage("clients.importLimits")
                .replace("{rows}", String(CLIENT_IMPORT_MAXIMUM_ROWS))
                .replace("{records}", String(MAXIMUM_CSV_ROWS))}
            </p>
            <ClientImportForm />
          </>
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {actorState.kind === "anonymous"
              ? getMessage("clients.importSignedOut")
              : getMessage("clients.importUnavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {actorState.kind === "anonymous" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("clients.signInLink")}
            </Link>
          ) : null}
          <Link className={linkClasses} href="/clients">
            {getMessage("clients.importBackToClients")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("clients.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
