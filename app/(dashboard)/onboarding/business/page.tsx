// path: app/(dashboard)/onboarding/business/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  readBusinessProfile,
  type BusinessProfileSnapshot,
} from "@/services/kyc/business-profile";
import { BusinessForm } from "./business-form";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingBusiness.title"),
  description: getMessage("onboardingBusiness.description"),
};

/** The profile is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The business information step of section 5.
 *
 * ## What it is
 *
 * Section 5 says the merchant enters business information once and the platform sends it to every
 * processor. This page is that one entry point: the server reads the caller's own profile through
 * `services/kyc/business-profile.ts`, which holds the processor matrix and every field rule, and
 * hands the snapshot to the form. The page itself decides nothing about the data - it decides what to
 * print when the read is refused or fails.
 *
 * ## Why the four answers are kept apart
 *
 * A session that ended, an account that is not an owner, an outage and a profile that has simply not
 * been saved yet are four different facts. Printing the empty form for the second or the third would
 * invite a merchant to re-enter information that is already stored, so the page words each refusal as
 * itself - and shows the form only when the service answered with a snapshot, saved or not.
 *
 * ## Why the form is a client component
 *
 * It has to keep what is typed, mark the fields a refusal named, and replace the profile with the
 * saved values without a reload. The rules are not duplicated there: it sends the values and reads
 * the service's answer, so a field rule has one home.
 */
type BusinessPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: BusinessProfileSnapshot };

async function readBusinessState(): Promise<BusinessPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readBusinessProfile(
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

export default async function BusinessProfilePage(): Promise<ReactNode> {
  const state = await readBusinessState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingBusiness.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingBusiness.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingBusiness.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingBusiness.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <BusinessForm initial={state.snapshot} />
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingBusiness.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingBusiness.forbidden")
                : getMessage("onboardingBusiness.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingBusiness.backLink")}
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
