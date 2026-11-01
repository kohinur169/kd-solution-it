// path: app/(auth)/2fa/reset/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { ResetRequestForm } from "./reset-request-form";

export const metadata: Metadata = {
  title: getMessage("resetRequest.title"),
  description: getMessage("resetRequest.description"),
};

/**
 * The recovery screen for a merchant who has lost the app and the backup codes.
 *
 * A server component with no data, like the sign in page, and for a stronger reason: the person who
 * needs this page cannot sign in, so the page must render without a session and without reading the
 * account it is about. Everything the platform knows stays behind the route.
 */
export default function TwoFactorResetPage(): ReactNode {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      <section className="w-full max-w-xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("resetRequest.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("resetRequest.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("resetRequest.description")}
        </p>

        <h2 className="mt-6 text-base font-semibold tracking-tight">
          {getMessage("resetRequest.stepsTitle")}
        </h2>
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          <li>{getMessage("resetRequest.stepContact")}</li>
          <li>{getMessage("resetRequest.stepDocuments")}</li>
          <li>{getMessage("resetRequest.stepReset")}</li>
          <li>{getMessage("resetRequest.stepEnrol")}</li>
        </ul>

        <ResetRequestForm />

        <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/signin">
            {getMessage("signin.title")}
          </Link>
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("resetRequest.home")}
          </Link>
        </nav>
      </section>
    </main>
  );
}
