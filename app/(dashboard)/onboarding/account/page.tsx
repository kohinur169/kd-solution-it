// path: app/(dashboard)/onboarding/account/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import {
  readMerchantAccountState,
  type AccountState,
  type AccountStateSnapshot,
} from "@/services/kyc/account-lifecycle";
import { AccountForm } from "./account-form";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingAccount.title"),
  description: getMessage("onboardingAccount.description"),
};

/** The account state is read per request, so a decision made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The merchant's own account screen of FEATURE_LIST section 13, STEP 099.
 *
 * ## What it is
 *
 * `readMerchantAccountState` in `services/kyc/account-lifecycle.ts` reads the company's `0111`
 * lifecycle events and answers the merchant-safe snapshot: the state, the suspension reason, the
 * required reactivation documents and the closure schedule. The company comes from the session,
 * never from the address. A suspended merchant sees what to submit and can request reactivation
 * once a submission is in the review pipeline; an active merchant can request closure. The office
 * decisions live on the office's own screen (`/onboarding/account-review`).
 *
 * ## Why the four answers are kept apart
 *
 * Same as the other merchant screens: a session that ended, an account that is not an owner, an
 * outage and a screen that has simply not loaded are four different facts, each worded as itself.
 */
type AccountPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: AccountStateSnapshot };

async function readAccountState(): Promise<AccountPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readMerchantAccountState(
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

/** The catalog key of one account state. */
function stateKey(state: AccountState): MessagePath {
  if (state === "active") {
    return "onboardingAccount.stateActive";
  }

  if (state === "suspended") {
    return "onboardingAccount.stateSuspended";
  }

  if (state === "reactivation_requested") {
    return "onboardingAccount.stateReactivationRequested";
  }

  if (state === "closure_requested") {
    return "onboardingAccount.stateClosureRequested";
  }

  return "onboardingAccount.stateClosed";
}

/** The catalog key of one suspension reason. */
function reasonKey(reason: string | null): MessagePath | null {
  if (reason === "risk") {
    return "onboardingAccount.reasonRisk";
  }

  if (reason === "chargeback_program") {
    return "onboardingAccount.reasonChargebackProgram";
  }

  if (reason === "billing") {
    return "onboardingAccount.reasonBilling";
  }

  if (reason === "manual") {
    return "onboardingAccount.reasonManual";
  }

  return null;
}

export default async function OnboardingAccountPage(): Promise<ReactNode> {
  const state = await readAccountState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingAccount.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingAccount.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingAccount.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingAccount.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <>
            <section className={sectionClasses}>
              <h2 className={sectionHeadingClasses}>{getMessage("onboardingAccount.stateHeading")}</h2>
              <p className={statusClasses(state.snapshot.state)} role="status">
                {getMessage(stateKey(state.snapshot.state))}
              </p>
              {state.snapshot.since === null ? null : (
                <p className={noteClasses}>
                  {formatMessage("onboardingAccount.sinceLine", { at: state.snapshot.since })}
                </p>
              )}
              {state.snapshot.reason === null ? null : (
                <div className="flex flex-col gap-1">
                  <h3 className={subsectionClasses}>{getMessage("onboardingAccount.reasonHeading")}</h3>
                  <p className={noteClasses}>
                    {getMessage(reasonKey(state.snapshot.reason) ?? "onboardingAccount.reasonManual")}
                  </p>
                </div>
              )}
            </section>

            {state.snapshot.state === "suspended" ? (
              <section className={sectionClasses}>
                <h2 className={sectionHeadingClasses}>{getMessage("onboardingAccount.requiredDocsHeading")}</h2>
                {state.snapshot.requiredDocuments.length === 0 ? (
                  <p className={noteClasses}>{getMessage("onboardingAccount.requiredDocsNone")}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {state.snapshot.requiredDocuments.map((document) => (
                      <li key={document}>{document}</li>
                    ))}
                  </ul>
                )}
                <p className={noteClasses}>{getMessage("onboardingAccount.reactivationNote")}</p>
                <AccountForm state={state.snapshot.state} reactivationReady={state.snapshot.reactivationReady} />
              </section>
            ) : null}

            {state.snapshot.state === "active" ? (
              <section className={sectionClasses}>
                <h2 className={sectionHeadingClasses}>{getMessage("onboardingAccount.closureHeading")}</h2>
                <p className={noteClasses}>{getMessage("onboardingAccount.closureNote")}</p>
                <AccountForm state={state.snapshot.state} reactivationReady={state.snapshot.reactivationReady} />
              </section>
            ) : null}

            {state.snapshot.state === "closed" ? (
              <section className={sectionClasses}>
                <h2 className={sectionHeadingClasses}>{getMessage("onboardingAccount.closureScheduleHeading")}</h2>
                {state.snapshot.holdReleaseAt === null ? null : (
                  <p className={noteClasses}>
                    {formatMessage("onboardingAccount.payoutAtLine", { at: state.snapshot.holdReleaseAt })}
                  </p>
                )}
                {state.snapshot.chargebackHoldReleaseAt === null ? null : (
                  <p className={noteClasses}>
                    {formatMessage("onboardingAccount.chargebackHoldLine", {
                      at: state.snapshot.chargebackHoldReleaseAt,
                    })}
                  </p>
                )}
                <p className={noteClasses}>{getMessage("onboardingAccount.tokensDeletedLine")}</p>
              </section>
            ) : null}
          </>
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingAccount.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingAccount.forbidden")
                : getMessage("onboardingAccount.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding/status">
              {getMessage("onboardingAccount.backLink")}
            </Link>
          )}
          <Link className={linkClasses} href="/onboarding/documents">
            {getMessage("onboardingAccount.documentsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("onboarding.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}

function statusClasses(state: AccountState): string {
  return state === "active"
    ? savedClasses
    : state === "suspended" || state === "closed"
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
