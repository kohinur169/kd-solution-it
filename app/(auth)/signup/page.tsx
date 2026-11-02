// path: app/(auth)/signup/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { POLICY_KEYS } from "@/lib/auth/policies";
import { clientEnv } from "@/lib/env/client";
import { getMessage } from "@/lib/i18n/messages";
import { en } from "@/lib/i18n/strings/en";
import { SignupForm, type PolicyLabel } from "./signup-form";

export const metadata: Metadata = {
  title: getMessage("signup.title"),
  description: getMessage("signup.description"),
};

/**
 * The merchant signup screen.
 *
 * A server component with no data of its own: the twelve policy names come from the string catalog,
 * the Turnstile site key from the public environment, and everything else happens in the form after
 * it is submitted. That keeps the page renderable when the database is unreachable, which matters
 * for the one screen a stranger sees first.
 *
 * The policy list is the closed vocabulary of `0052`, rendered from the catalog rather than from a
 * query, so the form cannot offer a policy the acceptance table would refuse.
 */
const policyLabels: readonly PolicyLabel[] = POLICY_KEYS.map((key) => ({
  key,
  label: en.policies[key],
}));

export default function SignupPage(): ReactNode {
  const siteKey = clientEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      <section className="w-full max-w-2xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("signup.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("signup.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("signup.description")}
        </p>

        <SignupForm policies={policyLabels} siteKey={siteKey} />

        <p className="mt-8 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("verify.home")}
          </Link>
        </p>
      </section>
    </main>
  );
}
