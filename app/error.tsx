// path: app/error.tsx
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorPanel } from "@/components/ui/error-panel";
import { getMessage } from "@/lib/i18n/messages";

/**
 * Segment error boundary.
 *
 * Next.js renders this inside the root layout, so the document, the theme and the header are
 * still there; only the failed segment is replaced. The retry button calls the `reset` the
 * framework provides, which re-renders the segment without a full page load.
 *
 * The thrown error is deliberately not displayed and not logged here: a client component cannot
 * reach the structured logger, and the message can contain internals. The digest is the
 * reference a merchant quotes to support, and the server has already logged the cause.
 */

const primaryActionClasses =
  "rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90";

const secondaryActionClasses =
  "rounded-pill border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-accent";

export default function ErrorScreen({
  error,
  reset,
}: Readonly<{
  error: Error & { readonly digest?: string };
  reset: () => void;
}>): ReactNode {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-6">
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
        <Link href="/" className={secondaryActionClasses}>
          {getMessage("errorScreen.home")}
        </Link>
      </ErrorPanel>
    </main>
  );
}
