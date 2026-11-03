// path: app/(dashboard)/clients/[id]/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { AppError } from "@/lib/errors/app-error";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getMessage } from "@/lib/i18n/messages";
import { getClient, type ClientSnapshot } from "@/services/clients/clients";
import { readOwnerActor } from "../../onboarding/owner-actor";
import { ClientForm } from "../client-form";

export const metadata: Metadata = {
  title: getMessage("clients.editTitle"),
  description: getMessage("clients.editDescription"),
};

/** The client is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * Section 15's client edit form.
 *
 * The page reads the caller's own client through `services/clients/clients.ts` - which applies the
 * `owner` role and the company scope - and hands the snapshot to the form. The four refusals are
 * kept apart because each is a different fact: signed out, not an owner, the service out, and the
 * row simply not there (another merchant's id answers the same 404, so the page never confirms
 * which merchant owns it).
 */
type EditPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ready"; readonly client: ClientSnapshot };

async function readEditState(clientId: string): Promise<EditPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const client = await getClient(
      { actor: actorState.actor, clientId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", client };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden" };
    }

    if (error instanceof AppError && error.code === "RESOURCE_NOT_FOUND") {
      return { kind: "not-found" };
    }

    return { kind: "unavailable" };
  }
}

export default async function EditClientPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  const state = await readEditState(decodeURIComponent(id));

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("clients.editTitle")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("clients.editDescription")}</p>
        </header>

        {state.kind === "ready" ? (
          <ClientForm initial={state.client} savePath={`/api/clients/${state.client.id}`} creating={false} />
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("clients.signedOut")
              : state.kind === "forbidden"
                ? getMessage("clients.forbidden")
                : state.kind === "not-found"
                  ? getMessage("clients.notFound")
                  : getMessage("clients.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
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
