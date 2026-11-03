// path: app/(dashboard)/onboarding/underwriting/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  readUnderwritingMccOverview,
  readUnderwritingSettings,
  type UnderwritingMccOverview,
  type UnderwritingSettings,
} from "@/services/kyc/underwriting";
import { UnderwritingPanel } from "./underwriting-panel";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingUnderwriting.title"),
  description: getMessage("onboardingUnderwriting.description"),
};

/** The criteria are read per request, so a save made a moment ago already shows here. */
export const dynamic = "force-dynamic";

/**
 * The underwriting criteria screen of section 5, STEP 090.
 *
 * ## What it is
 *
 * `services/kyc/underwriting.ts` is the office side of the `0106` tables: the one criteria row and
 * the three tier rows, plus the MCC overview that lists category codes with the tier compliance set
 * on them and how many merchant profiles carry each. The page lives under the onboarding block's
 * owned path and gates on the office roles through the service: any other actor is refused there
 * before a query runs, so this page makes no role decision of its own beyond mapping the refusal
 * to the forbidden panel.
 *
 * ## Why the four answers are kept apart
 *
 * Same as the merchant screens: a session that ended, an account without an office role, an
 * outage and a screen that is simply ready are four different facts, and each is worded as itself.
 */
type UnderwritingPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly settings: UnderwritingSettings; readonly mcc: UnderwritingMccOverview };

async function readUnderwritingState(): Promise<UnderwritingPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const [settings, mcc] = await Promise.all([
      readUnderwritingSettings(
        { actor: actorState.actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
      readUnderwritingMccOverview(
        { actor: actorState.actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    ]);

    return { kind: "ready", settings, mcc };
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

export default async function OnboardingUnderwritingPage(): Promise<ReactNode> {
  const state = await readUnderwritingState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingUnderwriting.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingUnderwriting.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingUnderwriting.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingUnderwriting.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <UnderwritingPanel initialSettings={state.settings} initialMcc={state.mcc} />
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingUnderwriting.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingUnderwriting.forbidden")
                : getMessage("onboardingUnderwriting.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingUnderwriting.backLink")}
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
