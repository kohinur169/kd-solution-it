// path: app/(dashboard)/onboarding/account-review/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { readAccountReviewQueue, type AccountQueue } from "@/services/kyc/account-lifecycle";
import { AccountReviewQueuePanel } from "./account-review-queue";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingAccountReview.title"),
  description: getMessage("onboardingAccountReview.description"),
};

/** The queue is read per request, so an event recorded a moment ago already shows here. */
export const dynamic = "force-dynamic";

/**
 * The office account review queue of FEATURE_LIST section 13, STEP 099.
 *
 * `readAccountReviewQueue` in `services/kyc/account-lifecycle.ts` lists every merchant account in an
 * open state - suspended, reactivation requested, closure requested - newest event per merchant.
 * The page lives under the onboarding block's owned path and gates on the office roles through the
 * service: any other actor is refused there before a query runs, so this page maps the refusal to
 * the forbidden panel. From a row the office accepts a reactivation or closes the account; the
 * suspend form at the bottom opens a suspension for any merchant.
 */
type AccountReviewPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly queue: AccountQueue };

async function readQueueState(): Promise<AccountReviewPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const queue = await readAccountReviewQueue(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", queue };
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

export default async function OnboardingAccountReviewPage(): Promise<ReactNode> {
  const state = await readQueueState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingAccountReview.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingAccountReview.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingAccountReview.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingAccountReview.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <AccountReviewQueuePanel rows={state.queue.rows} />
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingAccountReview.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingAccountReview.forbidden")
                : getMessage("onboardingAccountReview.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding/kyc-review">
              {getMessage("onboardingAccountReview.kycReviewLink")}
            </Link>
          )}
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
