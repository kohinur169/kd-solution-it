// path: app/(dashboard)/onboarding/documents/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { readKycPack, type KycPackSnapshot } from "@/services/kyc/kyc-capture";
import { DocumentsForm } from "./documents-form";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingDocuments.title"),
  description: getMessage("onboardingDocuments.description"),
};

/** The pack is read per request, so an upload made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The documents step of section 5: uploads, beneficial owners and the screening run.
 *
 * ## What it is
 *
 * `0048`-`0051` hold the submission, its documents, its owners and its screenings; this page is the
 * merchant's surface over them, through `services/kyc/kyc-capture.ts`, which is the only reader and
 * writer of those rows. The page decides nothing about the data; it decides what to print when the
 * read is refused or fails, and hands the snapshot to the form.
 *
 * ## Why the four answers are kept apart
 *
 * Same as the other step pages: a session that ended, an account that is not an owner, an outage and
 * an empty pack are four different facts, and each is worded as itself.
 */
type DocumentsPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: KycPackSnapshot };

async function readDocumentsState(): Promise<DocumentsPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readKycPack(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", snapshot };
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

export default async function OnboardingDocumentsPage(): Promise<ReactNode> {
  const state = await readDocumentsState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingDocuments.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingDocuments.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingDocuments.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingDocuments.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <>
            <p className={noteClasses} role="status">
              {state.snapshot.documentsComplete
                ? getMessage("onboardingDocuments.stepCompleteLine")
                : getMessage("onboardingDocuments.stepTodoLine")}
            </p>
            <DocumentsForm initial={state.snapshot} />
          </>
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingDocuments.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingDocuments.forbidden")
                : getMessage("onboardingDocuments.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingDocuments.backLink")}
            </Link>
          )}
          <Link className={linkClasses} href="/sessions">
            {getMessage("onboarding.sessionsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("onboarding.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-sm font-medium text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";
