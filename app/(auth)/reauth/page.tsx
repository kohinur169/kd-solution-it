// path: app/(auth)/reauth/page.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { readStepUpState, type StepUpState } from "@/lib/auth/step-up";
import { getMessage } from "@/lib/i18n/messages";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { ReauthForm } from "./reauth-form";

export const metadata: Metadata = {
  title: getMessage("reauth.title"),
  description: getMessage("reauth.description"),
};

/** The account is read on every request, so this page never renders another person's state. */
export const dynamic = "force-dynamic";

/**
 * What the screen may say.
 *
 * Three outcomes rather than a nullable state, for the reason the other signed-in screens have three:
 * "nobody is signed in", "the platform could not read the session" and "here is the freshness of this
 * session" are different sentences, and folding them into one null tells a signed out person their
 * session is broken.
 */
type ReauthScreenState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly stepUp: StepUpState };

/**
 * Read the freshness of the session that is asking.
 *
 * The server does it because the session is on the server: the two instants live on
 * `public.sessions`, and a browser that could claim freshness would be claiming the very thing the
 * guard exists to check.
 */
async function readScreenState(): Promise<ReauthScreenState> {
  try {
    const cookieHeader = (await headers()).get("cookie");
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    return { kind: "ready", stepUp: readStepUpState(actor, Date.now()) };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    return { kind: "unavailable" };
  }
}

/**
 * The step-up screen of section 22.
 *
 * A person arrives here because an action answered `403` with `reauth_required`: their session is
 * signed in and allowed, and the proof behind it is older than ten minutes. The screen asks for the
 * authenticator code (or a backup code) and nothing else - not the password, which the sign in
 * already proved, and not the device, which the session already names.
 *
 * When the proof is still fresh the screen says so instead of asking for a code that would prove
 * nothing, and the person can go back to what they were doing.
 */
export default async function ReauthPage(): Promise<ReactNode> {
  const state = await readScreenState();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <section className="w-full max-w-xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("reauth.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("reauth.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("reauth.description")}
        </p>

        {state.kind === "ready" ? (
          state.stepUp.satisfied ? (
            <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4" role="status">
              <h2 className="text-base font-semibold tracking-tight">
                {getMessage("reauth.alreadyFreshTitle")}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {getMessage("reauth.alreadyFreshBody")}
              </p>
            </div>
          ) : (
            <ReauthForm />
          )
        ) : (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("reauth.signedOut")
              : getMessage("reauth.unavailable")}
          </p>
        )}

        <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("reauth.home")}
          </Link>
        </nav>
      </section>
    </main>
  );
}
