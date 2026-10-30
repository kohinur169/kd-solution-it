// path: app/global-error.tsx
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorPanel } from "@/components/ui/error-panel";
import { getMessage } from "@/lib/i18n/messages";
import { en } from "@/lib/i18n/strings/en";
import "./globals.css";

/**
 * Root error boundary.
 *
 * It replaces the root layout when the layout itself fails, so it must supply the document
 * elements and the stylesheet on its own: there is no `app/layout.tsx` around it, and the tokens
 * have to be loaded here or the page would be unstyled.
 *
 * It cannot host the theme provider or the header, so it follows the operating system theme. Both
 * actions are client side - a retry through the framework, and a link home - because this screen
 * is rendered by the router, not by a reload.
 */

const primaryActionClasses =
  "rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90";

export default function GlobalError({
  error,
  reset,
}: Readonly<{
  error: Error & { readonly digest?: string };
  reset: () => void;
}>): ReactNode {
  return (
    <html lang={en.locale.code} dir={en.locale.direction}>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <main className="flex min-h-dvh items-center justify-center px-4 py-10 sm:px-6">
          <ErrorPanel digest={error.digest ?? null}>
            <button
              type="button"
              className={primaryActionClasses}
              onClick={() => {
                reset();
              }}
            >
              {getMessage("errorScreen.retry")}
            </button>
            <Link href="/" className={primaryActionClasses}>
              {getMessage("errorScreen.home")}
            </Link>
          </ErrorPanel>
        </main>
      </body>
    </html>
  );
}
