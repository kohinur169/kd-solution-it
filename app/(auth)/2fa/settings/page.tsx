// path: app/(auth)/2fa/settings/page.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { readTwoFactorStatus, type TwoFactorStatus } from "@/lib/auth/backup-codes";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getMessage } from "@/lib/i18n/messages";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { BackupCodesForm } from "./backup-codes-form";

export const metadata: Metadata = {
  title: getMessage("twoFactor.settingsTitle"),
  description: getMessage("twoFactor.settingsDescription"),
};

/** The account is read on every request, so this page is never prerendered with someone else's state. */
export const dynamic = "force-dynamic";

/**
 * What the panel is allowed to show.
 *
 * Three outcomes rather than a nullable status: "nobody is signed in", "the platform could not tell"
 * and "here is the account's state" are different sentences, and a screen that folds them into one
 * null tells a signed out person their account is broken.
 */
type SettingsState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly status: TwoFactorStatus };

/**
 * Read the state of the second factor for the person asking.
 *
 * This read is on the server because the session is: the browser never sees a handle it could reuse,
 * and the panel does not open with "loading" before telling someone whether their codes still work.
 * A refused session is not an error - it is the signed out sentence - and a dependency failure is
 * `unavailable`, so neither is reported as the other.
 */
async function readSettingsState(): Promise<SettingsState> {
  try {
    const cookieHeader = (await headers()).get("cookie");
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const status = await readTwoFactorStatus(
      { userId: actor.userId },
      { rest: runtime.rest, audit: runtime.audit, masterKey: runtime.masterKey },
    );

    return { kind: "ready", status };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    return { kind: "unavailable" };
  }
}

/**
 * The two factor settings screen.
 *
 * The state arrives from the server, and the one action on the screen - generating a fresh set of
 * backup codes - posts to `/api/auth/2fa/backup-codes` with the current authenticator code. Nothing
 * on this page can read an existing code, because nothing on the platform can: the column holds
 * scrypt verifiers and the page only ever counts them.
 */
export default async function TwoFactorSettingsPage(): Promise<ReactNode> {
  const state = await readSettingsState();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <section className="w-full max-w-xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("twoFactor.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("twoFactor.settingsTitle")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("twoFactor.settingsDescription")}
        </p>

        {state.kind === "ready" ? (
          <BackupCodesForm initialStatus={state.status} />
        ) : (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("twoFactor.signInRequired")
              : getMessage("twoFactor.unreadableResponse")}
          </p>
        )}

        <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/2fa">
            {getMessage("twoFactor.enrolLink")}
          </Link>
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("twoFactor.home")}
          </Link>
        </nav>
      </section>
    </main>
  );
}
