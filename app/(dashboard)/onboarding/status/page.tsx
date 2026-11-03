// path: app/(dashboard)/onboarding/status/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { readKycSummary, type KycSummarySnapshot } from "@/services/kyc/kyc-capture";
import { readMerchantLimit, type MerchantLimitSnapshot } from "@/services/kyc/merchant-limit";
import { StatusForm } from "./status-form";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingStatus.title"),
  description: getMessage("onboardingStatus.description"),
};

/** The summary is read per request, so a submit made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The KYC submission summary and status screen of section 5, for the merchant.
 *
 * ## What it is
 *
 * `readKycSummary` in `services/kyc/kyc-capture.ts` reads the company's latest submission, its
 * documents, its owners and its screening count, and answers only what the merchant may see:
 * `0048`'s own comment says the merchant only ever reads `status`, so the snapshot carries no
 * verification method, no provider reference, no screening row and no storage key or hash. The
 * submit button posts to `/api/onboarding/kyc-submit`, which moves the draft to `submitted`.
 *
 * ## Why the four answers are kept apart
 *
 * Same as the other step pages: a session that ended, an account that is not an owner, an outage
 * and a summary that has simply not been started yet are four different facts, and each is
 * worded as itself.
 */
type StatusPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: KycSummarySnapshot; readonly limit: MerchantLimitSnapshot };

async function readStatusState(): Promise<StatusPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readKycSummary(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    // STEP 091: the merchant's own starting monthly limit, created from the underwriting criteria
    // on first read, shown here so they know what they can transact before review raises it.
    const limit = await readMerchantLimit(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", snapshot, limit };
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

/** The catalog key of one submission status, or the unknown line when there is no submission yet. */
function statusKey(status: string | null): MessagePath {
  if (status === "draft") {
    return "onboardingStatus.statusDraft";
  }

  if (status === "submitted") {
    return "onboardingStatus.statusSubmitted";
  }

  if (status === "in_review") {
    return "onboardingStatus.statusInReview";
  }

  if (status === "approved") {
    return "onboardingStatus.statusApproved";
  }

  if (status === "rejected") {
    return "onboardingStatus.statusRejected";
  }

  return "onboardingStatus.statusUnknown";
}

/** The catalog key of one entry of the missing list. */
function missingKey(missing: string): MessagePath {
  return missing === "documents" ? "onboardingStatus.missingDocuments" : "onboardingStatus.missingScreening";
}

export default async function OnboardingStatusPage(): Promise<ReactNode> {
  const state = await readStatusState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingStatus.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingStatus.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingStatus.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingStatus.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <>
            <section className={sectionClasses}>
              <h2 className={sectionHeadingClasses}>{getMessage("onboardingStatus.statusHeading")}</h2>
              <p className={statusClasses(state.snapshot.status)} role="status">
                {getMessage(statusKey(state.snapshot.status))}
              </p>
              {state.snapshot.submittedAt === null ? null : (
                <p className={noteClasses}>
                  {formatMessage("onboardingStatus.submittedAtLine", { at: state.snapshot.submittedAt })}
                </p>
              )}
              {state.snapshot.decidedAt === null ? null : (
                <p className={noteClasses}>
                  {formatMessage("onboardingStatus.decidedAtLine", { at: state.snapshot.decidedAt })}
                </p>
              )}
              {state.snapshot.status === "rejected" && state.snapshot.decisionReason !== null ? (
                <div className="flex flex-col gap-1">
                  <h3 className={subsectionClasses}>{getMessage("onboardingStatus.decisionReasonHeading")}</h3>
                  <p className={alertClasses}>{state.snapshot.decisionReason}</p>
                </div>
              ) : null}
            </section>

            <section className={sectionClasses}>
              <h2 className={sectionHeadingClasses}>{getMessage("onboardingStatus.summaryHeading")}</h2>
              <ul className="flex flex-col gap-2 text-sm">
                <li>{formatMessage("onboardingStatus.docCountLine", { count: String(state.snapshot.documentCount) })}</li>
                <li>
                  {formatMessage("onboardingStatus.ownerCountLine", {
                    count: String(state.snapshot.ownerCount),
                    significant: String(state.snapshot.significantOwnerCount),
                  })}
                </li>
                <li>{formatMessage("onboardingStatus.screenedLine", { count: String(state.snapshot.screenedCount) })}</li>
              </ul>
            </section>

            <section className={sectionClasses}>
              <h2 className={sectionHeadingClasses}>{getMessage("onboardingStatus.limitHeading")}</h2>
              <p className={noteClasses}>
                {formatMessage("onboardingStatus.limitLine", {
                  limit: state.limit.monthlyLimit,
                  used: state.limit.usedAmount,
                  month: state.limit.monthKey,
                  remaining: state.limit.remainingAmount,
                })}
              </p>
            </section>

            <section className={sectionClasses}>
              <h2 className={sectionHeadingClasses}>{getMessage("onboardingStatus.missingHeading")}</h2>
              {state.snapshot.missing.length === 0 ? (
                <p className={noteClasses}>{getMessage("onboardingStatus.missingNone")}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {state.snapshot.missing.map((missing) => (
                    <li key={missing}>{getMessage(missingKey(missing))}</li>
                  ))}
                </ul>
              )}
              <StatusForm canSubmit={state.snapshot.canSubmit} />
            </section>
          </>
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingStatus.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingStatus.forbidden")
                : getMessage("onboardingStatus.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <>
              <Link className={linkClasses} href="/onboarding">
                {getMessage("onboardingStatus.backLink")}
              </Link>
              <Link className={linkClasses} href="/onboarding/documents">
                {getMessage("onboardingStatus.documentsLink")}
              </Link>
            </>
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

function statusClasses(status: string | null): string {
  return status === "approved"
    ? savedClasses
    : status === "rejected"
      ? alertClasses
      : "text-sm font-semibold";
}

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-sm font-medium text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const sectionClasses = "flex flex-col gap-3 rounded-md border border-border p-4";

const sectionHeadingClasses = "text-base font-semibold";

const subsectionClasses = "text-sm font-semibold";

const savedClasses = "text-sm text-primary";

const alertClasses = "text-sm text-destructive";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";
