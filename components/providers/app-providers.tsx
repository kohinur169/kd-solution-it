// path: components/providers/app-providers.tsx
"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "./theme-provider";

/**
 * The client boundary of the application shell.
 *
 * The root layout is a Server Component, so the providers are collected here once and mounted
 * around the tree. Every provider added later (a toast host, a query client, a session context)
 * is added in this file, which keeps `app/layout.tsx` readable and keeps the client bundle
 * boundary in exactly one place.
 *
 * Only the theme provider exists today. It wraps `children`, which stay Server Components: they
 * are passed through as a prop and are not turned into client code.
 */
export function AppProviders({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return <ThemeProvider>{children}</ThemeProvider>;
}
