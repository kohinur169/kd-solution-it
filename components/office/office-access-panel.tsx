// path: components/office/office-access-panel.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";

/**
 * The two screens the office shows instead of itself: an account without an office role, and an
 * account that could not be read.
 *
 * Both are rendered *without* the shell, and that is the point. A sidebar is a list of destinations
 * for someone who may travel; offering it to an account that was refused would be the navigation
 * asking a question the decision already answered, and offering it during an outage would suggest
 * the office is merely empty rather than unreadable. Each panel therefore has its own main landmark,
 * one
 * heading, one sentence, and one way out: the platform home page.
 *
 * The two are kept apart for the same reason the decision keeps them apart - "you are not staff"
 * and "we could not read your account" are different facts, and only one of them is the visitor's
 * to act on.
 */

export type OfficeAccessPanelKind = "denied" | "unavailable";

export interface OfficeAccessPanelProperties {
  readonly kind: OfficeAccessPanelKind;
}

const mainClasses =
  "mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-12 text-foreground sm:px-6 lg:py-16";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const bodyClasses = "text-sm text-muted-foreground sm:text-base";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export function OfficeAccessPanel({ kind }: OfficeAccessPanelProperties): ReactNode {
  const titleKey = kind === "denied" ? "office.accessDeniedTitle" : "office.unavailableTitle";
  const bodyKey = kind === "denied" ? "office.accessDeniedBody" : "office.unavailableBody";

  return (
    <main className={mainClasses}>
      <p className={eyebrowClasses}>{getMessage("office.eyebrow")}</p>
      <h1 className={titleClasses}>{getMessage(titleKey)}</h1>
      <p {...(kind === "unavailable" ? { role: "alert" as const } : {})} className={bodyClasses}>
        {getMessage(bodyKey)}
      </p>
      <Link className={linkClasses} href="/">
        {getMessage("office.homeLink")}
      </Link>
    </main>
  );
}
