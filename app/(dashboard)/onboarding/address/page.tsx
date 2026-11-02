// path: app/(dashboard)/onboarding/address/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  readBusinessAddress,
  type BusinessAddressSnapshot,
} from "@/services/kyc/business-address";
import { AddressForm } from "./address-form";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingAddress.title"),
  description: getMessage("onboardingAddress.description"),
};

/** The address is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The address and contact step of section 5.
 *
 * ## What it is
 *
 * Section 5 lists the business address, the person name and the contact information among the fields
 * a merchant fills once, and `0105` stores them on the one business profile row. This page is the
 * onboarding surface of that section: the server reads the caller's own address through
 * `services/kyc/business-address.ts`, which holds the field rules, the enabled-country check and
 * the completion rule, and hands the snapshot - the stored values and the country dropdown - to the
 * form. The page itself decides nothing about the data; it decides what to print when the read is
 * refused or fails.
 *
 * ## Why the four answers are kept apart
 *
 * A session that ended, an account that is not an owner, an outage and a section that has simply not
 * been saved yet are four different facts. Printing the empty form for the second or the third would
 * invite a merchant to re-enter an address that is already stored, so the page words each refusal as
 * itself - and shows the form only when the service answered with a snapshot, saved or not.
 *
 * ## Why the form is a client component
 *
 * It has to keep what is typed, filter the country list as the merchant types, mark the fields a
 * refusal named, and replace the values with the saved ones without a reload. The rules are not
 * duplicated there: it sends the values and reads the service's answer, so a field rule has one home.
 */
type AddressPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: BusinessAddressSnapshot };

async function readAddressState(): Promise<AddressPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readBusinessAddress(
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

export default async function BusinessAddressPage(): Promise<ReactNode> {
  const state = await readAddressState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingAddress.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingAddress.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingAddress.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingAddress.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <AddressForm initial={state.snapshot} />
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingAddress.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingAddress.forbidden")
                : getMessage("onboardingAddress.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingAddress.backLink")}
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
