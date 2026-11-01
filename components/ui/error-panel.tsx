// path: components/ui/error-panel.tsx
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";

/**
 * The visual body shared by the two error screens.
 *
 * `app/error.tsx` (a segment failed) and `app/global-error.tsx` (the root layout itself failed)
 * show the same words and the same tokens, so the copy lives here once and the actions differ at
 * the call site: a segment can retry through the router, a broken root can only reload the page.
 *
 * The panel never receives the thrown message. It receives the reference the framework exposes,
 * because STEP 008's rule applies to a screen as much as to a response: the raw error reaches the
 * log, the reader gets a short reference they can quote.
 */

export function ErrorPanel({
  digest,
  children,
}: Readonly<{ digest: string | null; children: ReactNode }>): ReactNode {
  return (
    <section
      role="alert"
      className="w-full max-w-lg rounded-card border border-border bg-surface p-6 shadow-card sm:p-8"
    >
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {getMessage("errorScreen.title")}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {getMessage("errorScreen.description")}
      </p>
      {digest === null ? null : (
        <p className="mt-4 rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
          {getMessage("errorScreen.referenceLabel")}: {digest}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}
