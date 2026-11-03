// path: app/(dashboard)/clients/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getMessage } from "@/lib/i18n/messages";
import { readOwnerActor } from "../onboarding/owner-actor";

export const metadata: Metadata = {
  title: getMessage("clients.title"),
  description: getMessage("clients.description"),
};

/** Read per request, so the sign in state is the answer of this moment. */
export const dynamic = "force-dynamic";

/**
 * Section 15's client area entry: the hub that links to the create form. The paginated list with
 * search is the next screen of this area; this page only proves the session and leads there.
 *
 * The page decides nothing about the data: the actor reader answers signed out, forbidden or
 * unavailable, and each refusal is worded as itself - printing the hub for a signed out visitor
 * would invite a form post with no session behind it.
 */
export default async function ClientsPage(): Promise<ReactNode> {
  const actorState = await readOwnerActor();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("clients.title")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("clients.description")}</p>
        </header>

        {actorState.kind === "actor" ? (
          <nav className="flex flex-col gap-2 text-sm">
            <Link className="w-fit rounded-md bg-foreground px-4 py-2 font-medium text-background" href="/clients/new">
              {getMessage("clients.addClient")}
            </Link>
            <Link className="w-fit underline" href="/onboarding">
              {getMessage("onboardingReview.backLink")}
            </Link>
          </nav>
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {actorState.kind === "anonymous"
              ? getMessage("clients.signedOut")
              : getMessage("clients.unavailable")}
          </p>
        )}

        {actorState.kind === "anonymous" ? (
          <Link className="w-fit text-sm underline" href="/signin">
            {getMessage("clients.signInLink")}
          </Link>
        ) : null}
      </div>
    </main>
  );
}
