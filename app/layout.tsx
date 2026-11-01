// path: app/layout.tsx
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppProviders } from "@/components/providers/app-providers";
import { THEME_SCRIPT } from "@/components/providers/theme";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { getMessage } from "@/lib/i18n/messages";
import { en } from "@/lib/i18n/strings/en";
import { CSP_NONCE_HEADER_NAME, isCspNonce } from "@/lib/security/csp";
import "./globals.css";

/**
 * The root layout: the document, the theme and the application shell.
 *
 * Structure:
 *   - `<html>` carries the language and writing direction from the catalog, and
 *     `suppressHydrationWarning` because the pre-paint script adds the theme class before React
 *     hydrates;
 *   - the pre-paint script reads the stored theme in `<head>`, so a dark preference never paints
 *     a light page first;
 *   - the skip link is the first focusable element, and it targets the focusable wrapper around
 *     `children` (`app/page.tsx` already renders the one `<main>` of the page);
 *   - the header holds the brand link and the theme switcher, and nothing else: navigation to
 *     routes that do not exist yet would be a broken promise;
 *   - `AppProviders` is the single client boundary, mounted once around the tree.
 *
 * The pre-paint script is the one script tag this repository writes itself, so it is the one tag that
 * needs the Content Security Policy nonce by hand (`proxy.ts` sets up every policy, and the framework
 * stamps its own tags from the request header). A nonce that is missing is an error rather than a
 * warning: the script would be blocked, the page would paint the wrong theme, and the only sign would be
 * a line in a browser console. `force-dynamic` is declared because a prerendered document cannot carry
 * a per-response nonce; `lib/security/csp.ts` explains why that is the price of this policy.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: en.brand.name,
  description: en.brand.description,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

const skipLinkClasses =
  "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 " +
  "focus:rounded-md focus:border focus:border-border focus:bg-surface focus:px-4 focus:py-2 " +
  "focus:text-sm focus:font-semibold focus:text-foreground focus:shadow-card";

const headerClasses = "border-b border-border bg-surface";

const headerInnerClasses =
  "mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6";

const brandLinkClasses =
  "rounded-sm text-sm font-semibold tracking-tight text-foreground hover:text-primary";

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): Promise<ReactNode> {
  const nonce = (await headers()).get(CSP_NONCE_HEADER_NAME);

  if (nonce === null || !isCspNonce(nonce)) {
    throw new Error("the Content Security Policy nonce is missing from the request");
  }

  return (
    <html lang={en.locale.code} dir={en.locale.direction} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <AppProviders>
          <a href="#main-content" className={skipLinkClasses}>
            {getMessage("shell.skipToContent")}
          </a>
          <div className="flex min-h-dvh flex-col">
            <header className={headerClasses}>
              <div className={headerInnerClasses}>
                <Link href="/" aria-label={getMessage("shell.homeLink")} className={brandLinkClasses}>
                  {getMessage("brand.name")}
                </Link>
                <ThemeToggle />
              </div>
            </header>
            <div id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
              {children}
            </div>
          </div>
        </AppProviders>
      </body>
    </html>
  );
}
