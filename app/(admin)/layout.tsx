// path: app/(admin)/layout.tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/office/admin-shell";
import { OfficeAccessPanel } from "@/components/office/office-access-panel";
import { decideOfficeAccess, officeAccessRedirect } from "@/components/office/navigation";
import { getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "./office-actor";
import { readOfficeAnnouncements } from "./office-announcements";

/**
 * The office shell, and the one permission check every office screen inherits.
 *
 * ## One gate, not one per screen
 *
 * A screen that forgets to ask who is looking at it is the classic way an office leaks. So the
 * question is asked here, once, by the layout that wraps every route of this group: an anonymous
 * request is sent to the sign in form, an account that could not be read sees the outage panel, an
 * account without an office role is refused, and an office account that still owes a second factor
 * is sent to the enrolment screen. The pages below receive a browser that has already been decided,
 * which is why they contain no role check of their own and why a later office STEP cannot forget
 * one.
 *
 * ## The decision is a function, not a branch here
 *
 * `decideOfficeAccess` is a pure function over the three states of an account, and
 * `officeAccessRedirect` names the two places it can send the browser. The gate exercises all five
 * outcomes of the pair without a request, and the layout stays the thin adapter it should be: read
 * the account, ask the function, render or redirect.
 *
 * ## The banner the shell carries
 *
 * Section 24's announcements are shown by the shell rather than by a screen, so the layout reads the
 * ones this person has not dismissed and passes them down. An announcement table that cannot be read
 * answers an empty list rather than an outage - see `./office-announcements.ts` - because a courtesy
 * laid over the office must never be able to close it.
 *
 * ## Why `force-dynamic`
 *
 * The answer depends on a cookie and on a directory read, and the root layout needs a
 * per-response Content Security Policy nonce for its pre-paint script. A prerendered office page
 * could carry neither, so every route in this group is rendered per request - which is what a
 * dashboard behind a session is anyway.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: getMessage("office.workspaceTitle"),
  description: getMessage("office.workspaceDescription"),
};

export default async function AdminLayout({
  children,
}: Readonly<{ children: ReactNode }>): Promise<ReactNode> {
  const access = decideOfficeAccess(await readOfficeActor());
  const destination = officeAccessRedirect(access);

  if (destination !== null) {
    redirect(destination);
  }

  if (access.kind === "allowed") {
    // The account is read again from the cache rather than from the decision, because the popup needs
    // the company and the person it is for, not only the roles. `readOfficeActor` is memoised per
    // request, so the second call costs nothing.
    const announcements = await readOfficeAnnouncements();

    return (
      <AdminShell announcements={announcements} roles={access.roles} sections={access.sections}>
        {children}
      </AdminShell>
    );
  }

  return <OfficeAccessPanel kind={access.kind === "denied" ? "denied" : "unavailable"} />;
}
