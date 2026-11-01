// path: app/(auth)/signin/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { clientEnv } from "@/lib/env/client";
import { getMessage } from "@/lib/i18n/messages";
import { SigninForm } from "./signin-form";

export const metadata: Metadata = {
  title: getMessage("signin.title"),
  description: getMessage("signin.description"),
};

/** Where a signed in merchant lands. The dashboard of STEP 056 replaces this path. */
const afterSigninPath = "/";

/**
 * The sign in screen.
 *
 * A server component with no data: the site key comes from the public environment and everything
 * else happens after the form is submitted. A sign in page that needed the database to render would
 * be unavailable exactly when a merchant most needs it.
 */
export default function SigninPage(): ReactNode {
  const siteKey = clientEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      <section className="w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("signin.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage("signin.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground sm:text-base">
          {getMessage("signin.description")}
        </p>

        <SigninForm afterSigninPath={afterSigninPath} siteKey={siteKey} />

        <p className="mt-8 border-t border-border pt-4 text-sm">
          {getMessage("signin.noAccount")}{" "}
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/signup">
            {getMessage("signin.createAccount")}
          </Link>
        </p>
      </section>
    </main>
  );
}
