// path: app/(dashboard)/onboarding/category/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  readMerchantCategory,
  type MerchantCategorySnapshot,
} from "@/services/kyc/merchant-category";
import { CategoryForm } from "./category-form";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingCategory.title"),
  description: getMessage("onboardingCategory.description"),
};

/** The category is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The merchant category code step of section 5.
 *
 * ## What it is
 *
 * Section 5 puts the Merchant Category Code in merchant onboarding and profile settings, and
 * `0104` stores it on the one business profile row, so this page is the onboarding surface of that
 * one field: the server reads the caller's own category through
 * `services/kyc/merchant-category.ts`, which holds the vocabulary read and every rule, and hands
 * the snapshot - the stored code, its title and the active dropdown - to the form. The page decides
 * nothing about the data; it decides what to print when the read is refused or fails.
 *
 * ## Why the four answers are kept apart
 *
 * A session that ended, an account that is not an owner, an outage and a category that has simply
 * not been chosen yet are four different facts. Printing the empty form for the second or the third
 * would invite a merchant to re-choose a code that is already stored, so the page words each refusal
 * as itself - and shows the form only when the service answered with a snapshot, saved or not.
 *
 * ## Why the form is a client component
 *
 * It has to filter the published list as the merchant types, mark the refusal the service named,
 * and replace the selection with the saved code without a reload. The rules are not duplicated
 * there: it sends `{ mcc_code }` and reads the service's answer, so a code rule has one home.
 */
type CategoryPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: MerchantCategorySnapshot };

async function readCategoryState(): Promise<CategoryPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readMerchantCategory(
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

export default async function MerchantCategoryPage(): Promise<ReactNode> {
  const state = await readCategoryState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingCategory.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingCategory.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingCategory.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingCategory.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <CategoryForm initial={state.snapshot} />
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingCategory.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingCategory.forbidden")
                : getMessage("onboardingCategory.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingCategory.backLink")}
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
