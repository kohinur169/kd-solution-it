// path: app/(dashboard)/developers/api-credentials/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { getCredentialRuntime } from "@/lib/api/credential-runtime";
import { readMerchantCredentials } from "@/lib/api/credentials";
import type { CredentialPanelView } from "@/lib/api/credential-fields";
import { readOwnerActor } from "../../onboarding/owner-actor";
import { CredentialPanel } from "./credential-panel";

export const metadata: Metadata = {
  title: "API credentials",
  description: "Create the test and live credentials your store uses to call the platform API.",
};

/** Read per request: the page carries a mask built from the merchant's own rows. */
export const dynamic = "force-dynamic";

type ScreenState =
  | { readonly kind: "ready"; readonly view: CredentialPanelView }
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" };

/**
 * The read behind the screen.
 *
 * A merchant whose session is gone is sent to sign in; a session that is not an `owner` is refused by the
 * service and answered as a forbidden page rather than an empty list, because an empty list would say "you
 * have no credentials" to somebody who may not see any.
 */
async function readScreenState(): Promise<ScreenState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const view = await readMerchantCredentials(actorState.actor, getCredentialRuntime());

    return { kind: "ready", view };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden" };
    }

    return { kind: "unavailable" };
  }
}

function refusalSentence(state: ScreenState): string {
  if (state.kind === "signed-out") {
    return getMessage("api.signedOut");
  }

  if (state.kind === "forbidden") {
    return getMessage("api.forbidden");
  }

  return getMessage("api.unavailable");
}

/**
 * Section 20's merchant API credentials at `/developers/api-credentials`.
 *
 * ## Why this address
 *
 * Section 20 is the only part of the platform a merchant reaches with a *machine* rather than a browser, so
 * its settings sit under `/developers` rather than beside invoices or settings. A merchant's other screens
 * are about its customers; this one is about its own integration, and the split keeps a store's key material
 * out of the pages a bookkeeper opens.
 *
 * ## What the page can and cannot show
 *
 * The list, the masks and the form. No full key, no reveal control, no download: section 20 says a key is
 * never displayed, and the page has no shape in which one could arrive - `readMerchantCredentials` returns
 * views, and a view has no field for a key.
 */
export default async function ApiCredentialsPage(): Promise<ReactNode> {
  const state = await readScreenState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("api.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("api.title")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("api.description")}</p>
        </header>

        {state.kind === "ready" ? (
          <CredentialPanel view={state.view} />
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {refusalSentence(state)}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className="text-primary underline-offset-4 hover:underline" href="/signin">
              {getMessage("api.signInLink")}
            </Link>
          ) : null}
          <Link className="text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("api.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
