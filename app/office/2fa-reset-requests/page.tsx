// path: app/office/2fa-reset-requests/page.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  listTwoFactorResetRequests,
  TWO_FACTOR_RESET_OFFICE_ROLES,
  type TwoFactorResetRequestView,
} from "@/lib/auth/two-factor-reset";
import { getMessage } from "@/lib/i18n/messages";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { OfficeResetQueue } from "./office-reset-queue";

export const metadata: Metadata = {
  title: getMessage("officeReset.title"),
  description: getMessage("officeReset.description"),
};

/** The queue changes the moment somebody acts on it, so the page is read on every request. */
export const dynamic = "force-dynamic";

/**
 * The three answers this screen can give, kept apart.
 *
 * "Sign in", "this account may not decide" and "the queue is unreadable" are three different facts,
 * and a screen that folded them into an empty queue would tell a support worker the platform has no
 * work waiting when it may have plenty.
 */
type QueueState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly requests: readonly TwoFactorResetRequestView[] };

/**
 * Read the queue for the person asking.
 *
 * The permission check is inside `listTwoFactorResetRequests`, not here: a page that filtered roles
 * itself would be a second place the rule lives, and the route would be a third.
 */
async function readQueueState(): Promise<QueueState> {
  try {
    const cookieHeader = (await headers()).get("cookie");
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const requests = await listTwoFactorResetRequests(
      { actor, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: 100 },
      { rest: runtime.rest },
    );

    return { kind: "ready", requests };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "AUTHENTICATION_REQUIRED") {
        return { kind: "signed-out" };
      }

      if (error.code === "PERMISSION_DENIED") {
        return { kind: "forbidden" };
      }
    }

    return { kind: "unavailable" };
  }
}

/**
 * The office screen for two factor resets.
 *
 * The merchant's request is anonymous (they cannot sign in - that is the whole problem), so this page
 * is where a person appears: an office worker reads what the merchant reported, records the documents
 * they verified, and only then removes the second factor.
 */
export default async function OfficeResetRequestsPage(): Promise<ReactNode> {
  const state = await readQueueState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("officeReset.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("officeReset.title")}
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground sm:text-base">
          {getMessage("officeReset.description")}
        </p>

        {state.kind === "ready" ? (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">
              {getMessage("officeReset.queueTitle")}
            </h2>
            <OfficeResetQueue requests={state.requests} />
          </>
        ) : (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("officeReset.signedOut")
              : state.kind === "forbidden"
                ? getMessage("officeReset.forbidden")
                : getMessage("officeReset.unavailable")}
          </p>
        )}

        <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("officeReset.home")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
