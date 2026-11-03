// path: app/(dashboard)/onboarding/kyc-review/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { readKycReviewQueue, type KycReviewQueue } from "@/services/kyc/kyc-review";
import { KycReviewQueuePanel } from "./kyc-review-queue";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingKycReview.title"),
  description: getMessage("onboardingKycReview.description"),
};

/** The queue is read per request, so a submit made a moment ago already shows here. */
export const dynamic = "force-dynamic";

/**
 * The compliance KYC review queue of section 5, STEP 088.
 *
 * ## What it is
 *
 * `services/kyc/kyc-review.ts` is the office side of the `0048`-`0051` tables: the queue of every
 * `submitted` or `in_review` submission, and the detail - documents with their storage keys and
 * hashes, owners, screening results - that the reviewer works from. The page lives under the
 * onboarding block's owned path and gates on the office roles through the service: any other actor
 * is refused there before a query runs, so this page makes no role decision of its own beyond
 * mapping the refusal to the forbidden panel.
 *
 * ## Why the four answers are kept apart
 *
 * Same as the merchant screens: a session that ended, an account without an office role, an
 * outage and a queue that is simply empty are four different facts, and each is worded as itself.
 */
type ReviewPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly queue: KycReviewQueue };

async function readReviewState(): Promise<ReviewPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const queue = await readKycReviewQueue(
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

/** The catalog key of one queued status. */
function queueStatusKey(status: string): MessagePath {
  return status === "in_review" ? "onboardingKycReview.statusInReview" : "onboardingKycReview.statusSubmitted";
}

export default async function OnboardingKycReviewPage(): Promise<ReactNode> {
  const state = await readReviewState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingKycReview.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingKycReview.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingKycReview.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingKycReview.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <section className={sectionClasses}>
            <h2 className={sectionHeadingClasses}>{getMessage("onboardingKycReview.queueHeading")}</h2>
            {state.queue.rows.length === 0 ? (
              <p className={noteClasses}>{getMessage("onboardingKycReview.queueEmpty")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.queue.rows.map((row) => (
                  <li key={row.submissionId} className={rowClasses}>
                    <span className="font-mono text-xs">{row.submissionId}</span>
                    <span className="font-semibold">{getMessage(queueStatusKey(row.status))}</span>
                    <span className={noteClasses}>
                      {row.submittedAt === null
                        ? getMessage("onboardingKycReview.statusSubmitted")
                        : formatMessage("onboardingKycReview.submittedAtLine", { at: row.submittedAt })}
                    </span>
                    <span className={noteClasses}>
                      {formatMessage("onboardingKycReview.countsLine", {
                        documents: String(row.documentCount),
                        owners: String(row.ownerCount),
                        screened: String(row.screenedCount),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <KycReviewQueuePanel initial={state.queue} />
          </section>
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingKycReview.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingKycReview.forbidden")
                : getMessage("onboardingKycReview.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingKycReview.backLink")}
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

const sectionClasses = "flex flex-col gap-3 rounded-md border border-border p-4";

const sectionHeadingClasses = "text-base font-semibold";

const rowClasses = "flex flex-col gap-1 rounded-sm border border-border p-3 sm:flex-row sm:items-center sm:gap-4";

const alertClasses = "text-sm text-destructive";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";
