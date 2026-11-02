// path: app/(auth)/devices/confirm/page.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { readDeviceTrust, type DeviceTrustState } from "@/lib/auth/device-trust";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getMessage } from "@/lib/i18n/messages";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { DeviceConfirmForm } from "./device-confirm-form";

export const metadata: Metadata = {
  title: getMessage("deviceConfirm.title"),
  description: getMessage("deviceConfirm.description"),
};

/** The account is read on every request, so this page never renders another person's device. */
export const dynamic = "force-dynamic";

/**
 * What the screen is allowed to say.
 *
 * Four outcomes rather than a nullable state: "nobody is signed in", "the platform could not tell",
 * "this device is already confirmed" and "here is the device to confirm" are different sentences,
 * and a screen that folds them together tells a signed out person their device is broken.
 */
type ConfirmState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown-device" }
  | { readonly kind: "ready"; readonly trust: DeviceTrustState };

/**
 * Read the trust state of the device this session is bound to.
 *
 * The server does this because the session is on the server: the browser is not asked which device
 * it holds, and the page cannot be pointed at somebody else's device by a query string.
 */
async function readConfirmState(): Promise<ConfirmState> {
  try {
    const cookieHeader = (await headers()).get("cookie");
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const deviceId = actor.deviceProofKeyId;

    if (deviceId === null) {
      // A session with no device key is the state STEP 051 refuses everywhere; this screen can only
      // say so and send the browser back to the sign in that binds one.
      return { kind: "unknown-device" };
    }

    const trust = await readDeviceTrust(
      { userId: actor.userId, deviceId },
      { rest: runtime.rest },
    );

    return trust === null ? { kind: "unknown-device" } : { kind: "ready", trust };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    return { kind: "unavailable" };
  }
}

/**
 * The confirmation screen for a device nobody has confirmed yet.
 *
 * Section 23's alert is already on its way to the account's address by the time this page renders -
 * the session binding queued it - so the page's job is the second half: the authenticator code of
 * section 22, and one sentence about what an unrecognised sign in means. The device itself is not
 * named in a query string and not typed in by hand: it is the device this session is bound to, read
 * from `sessions.device_proof_key_id` on the server.
 */
export default async function DeviceConfirmPage(): Promise<ReactNode> {
  const state = await readConfirmState();

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <section className="w-full max-w-xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("deviceConfirm.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("deviceConfirm.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("deviceConfirm.description")}
        </p>

        {state.kind === "ready" ? (
          state.trust.trustedAtEpochMs === null ? (
            <DeviceConfirmForm label={state.trust.label} />
          ) : (
            <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4" role="status">
              <h2 className="text-base font-semibold tracking-tight">
                {getMessage("deviceConfirm.confirmedTitle")}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {getMessage("deviceConfirm.confirmedBody")}
              </p>
            </div>
          )
        ) : (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {state.kind === "signed-out"
              ? getMessage("deviceConfirm.signInRequired")
              : state.kind === "unknown-device"
                ? getMessage("deviceConfirm.unknownDevice")
                : getMessage("deviceConfirm.unavailable")}
          </p>
        )}

        <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/2fa">
            {getMessage("deviceConfirm.enrolLink")}
          </Link>
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("deviceConfirm.home")}
          </Link>
        </nav>
      </section>
    </main>
  );
}
