// path: app/(dashboard)/onboarding/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import {
  readOnboardingProgress,
  type OnboardingProgress,
} from "@/services/kyc/onboarding-progress";
import { ONBOARDING_STEP_COUNT, onboardingStepIndex } from "@/services/kyc/onboarding-steps";
import { OnboardingWizard } from "./onboarding-wizard";
import { readOwnerActor } from "./owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboarding.title"),
  description: getMessage("onboarding.description"),
};

/** The position is written from the page itself, so the page is read on every request. */
export const dynamic = "force-dynamic";

/**
 * Section 5's onboarding wizard shell.
 *
 * ## What this page is, and what it is not
 *
 * Section 5 describes one long form a merchant fills once - business information, address, category,
 * website, documents, review - and the forms themselves are the STEPs that follow this one. This page
 * is the frame around them: the six steps, which one the merchant is on, which are finished, and a
 * control that remembers where the merchant wants to work. Everything it knows about the row comes
 * from `services/kyc/onboarding-progress.ts`, which is the only reader of `0102`.
 *
 * ## Why the four refusals are kept apart
 *
 * "Nobody is signed in", "this account is not a merchant", "the row could not be read" and "nothing
 * is saved yet" are four different facts, and an empty wizard would tell a merchant whose company
 * row failed to load that their onboarding had been reset. So a refusal is the sign in link, a role
 * that is not `owner` is an answer, an outage is an outage, and only the row's own absence is worded
 * as "nothing is saved yet".
 *
 * ## Why the page prints no role
 *
 * The `owner` role is asked inside the service, next to the company scope and the write it guards, so
 * this page cannot offer a step to an account the service would refuse. It asks the reader for the
 * actor, passes it on, and words whatever answer comes back.
 */

type OnboardingStateKind = "signed-out" | "forbidden" | "unavailable" | "ready";

interface OnboardingState {
  readonly kind: OnboardingStateKind;
  readonly progress: OnboardingProgress | null;
}

async function readOnboardingState(): Promise<OnboardingState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", progress: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", progress: null };
  }

  const runtime = getAuthRuntime();

  try {
    const progress = await readOnboardingProgress(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", progress };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out", progress: null };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden", progress: null };
    }

    return { kind: "unavailable", progress: null };
  }
}

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const headingClasses = "text-xl font-semibold tracking-tight";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const metaClasses = "flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** One instant, printed the way every screen in this platform prints one: UTC, seconds cut. */
function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

export default async function OnboardingPage(): Promise<ReactNode> {
  const state = await readOnboardingState();
  const progress = state.progress;

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboarding.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboarding.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboarding.description")}</p>
          <p className={noteClasses}>{getMessage("onboarding.guardNote")}</p>
        </header>

        {progress === null ? (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboarding.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboarding.forbidden")
                : getMessage("onboarding.unavailable")}
          </p>
        ) : (
          <>
            <p className={metaClasses}>
              <span>
                {formatMessage("onboarding.progressLine", {
                  current: onboardingStepIndex(progress.currentStep) + 1,
                  total: ONBOARDING_STEP_COUNT,
                  done: progress.completedCount,
                })}
              </span>
              <span>
                {progress.saved && progress.updatedAtEpochMs !== null
                  ? formatMessage("onboarding.savedLine", {
                      at: instantOf(progress.updatedAtEpochMs),
                    })
                  : getMessage("onboarding.unsavedLine")}
              </span>
            </p>

            <section aria-labelledby="onboarding-steps" className="flex flex-col gap-3">
              <h2 className={headingClasses} id="onboarding-steps">
                {getMessage("onboarding.listHeading")}
              </h2>
              <p className={descriptionClasses}>{getMessage("onboarding.listDescription")}</p>
              <OnboardingWizard progress={progress} />
            </section>
          </>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : null}
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
