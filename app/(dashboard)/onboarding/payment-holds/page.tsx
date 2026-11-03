// path: app/(dashboard)/onboarding/payment-holds/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { readPaymentHoldQueue, type PaymentHoldQueue } from "@/services/kyc/payment-hold";
import { PaymentHoldsPanel } from "./payment-holds-panel";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingPaymentHolds.title"),
  description: getMessage("onboardingPaymentHolds.description"),
};

/** The queue is read per request, so a hold decided a moment ago already leaves it. */
export const dynamic = "force-dynamic";

/**
 * The payment hold review queue of section 5, STEP 092.
 *
 * ## What it is
 *
 * `services/kyc/payment-hold.ts` is the trigger and the queue over the `0108` table: the payment
 * core calls `holdLargeTransaction` per transaction, and every transaction at or above the `0106`
 * hold threshold lands here in status `held` until the desk releases or rejects it. The page lives
 * under the onboarding block's owned path and gates on the office roles through the service: any
 * other actor is refused there before a query runs, so this page makes no role decision of its own
 * beyond mapping the refusal to the forbidden panel.
 *
 * ## Why the four answers are kept apart
 *
 * Same as the other office screens: a session that ended, an account without an office role, an
 * outage and an empty queue are four different facts, and each is worded as itself.
 */
type HoldsPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly queue: PaymentHoldQueue };

async function readHoldsState(): Promise<HoldsPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const queue = await readPaymentHoldQueue(
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

/** The catalog key of one hold status. */
function holdStatusKey(status: string): MessagePath {
  if (status === "released") {
    return "onboardingPaymentHolds.statusReleased";
  }

  return status === "rejected" ? "onboardingPaymentHolds.statusRejected" : "onboardingPaymentHolds.statusHeld";
}

export default async function OnboardingPaymentHoldsPage(): Promise<ReactNode> {
  const state = await readHoldsState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingPaymentHolds.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingPaymentHolds.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingPaymentHolds.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingPaymentHolds.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <section className={sectionClasses}>
            <h2 className={sectionHeadingClasses}>{getMessage("onboardingPaymentHolds.queueHeading")}</h2>
            {state.queue.rows.length === 0 ? (
              <p className={noteClasses}>{getMessage("onboardingPaymentHolds.queueEmpty")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.queue.rows.map((row) => (
                  <li key={row.id} className={rowClasses}>
                    <span className="font-mono text-xs">{row.id}</span>
                    <span className="font-semibold">{getMessage(holdStatusKey(row.status))}</span>
                    <span className={noteClasses}>{formatMessage("onboardingPaymentHolds.amountLine", { amount: row.amount })}</span>
                    <span className={noteClasses}>
                      {formatMessage("onboardingPaymentHolds.companyLine", { company: row.companyId })}
                    </span>
                    <span className={noteClasses}>
                      {row.reference === null
                        ? getMessage("onboardingPaymentHolds.referenceNone")
                        : formatMessage("onboardingPaymentHolds.referenceLine", { reference: row.reference })}
                    </span>
                    <span className={noteClasses}>
                      {formatMessage("onboardingPaymentHolds.heldAtLine", { at: row.heldAt })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <PaymentHoldsPanel initial={state.queue} />
          </section>
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingPaymentHolds.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingPaymentHolds.forbidden")
                : getMessage("onboardingPaymentHolds.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingPaymentHolds.backLink")}
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
