// path: app/(auth)/2fa/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { TwoFactorForm } from "./two-factor-form";

export const metadata: Metadata = {
  title: getMessage("twoFactor.title"),
  description: getMessage("twoFactor.description"),
};

/**
 * The two factor enrolment screen.
 *
 * A server component with no data, for the same reason the sign in page has none: the enrolment
 * secret must not exist until the person asks for it, and a page that rendered it would put it in a
 * document that a proxy or a browser cache might keep. The form below is the only caller of the two
 * routes, and the secret it shows lives in that component's memory for as long as the tab does.
 */
export default function TwoFactorPage(): ReactNode {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      <section className="w-full max-w-xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("twoFactor.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("twoFactor.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("twoFactor.description")}
        </p>

        <TwoFactorForm />

        <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link
            className="font-semibold text-primary underline-offset-4 hover:underline"
            href="/2fa/settings"
          >
            {getMessage("twoFactor.settingsLink")}
          </Link>
          <Link
            className="font-semibold text-primary underline-offset-4 hover:underline"
            href="/2fa/reset"
          >
            {getMessage("resetRequest.link")}
          </Link>
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("twoFactor.home")}
          </Link>
        </nav>
      </section>
    </main>
  );
}
