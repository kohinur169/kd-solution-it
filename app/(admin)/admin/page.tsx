// path: app/(admin)/admin/page.tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { OfficeAccessPanel } from "@/components/office/office-access-panel";
import { decideOfficeAccess, officeAccessRedirect, officeWorkspaceOf } from "@/components/office/navigation";
import { getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";

/**
 * The office workspace index: who you are in the office, what that role may do, and where it may go.
 *
 * ## Why this page exists
 *
 * Section 2 gives every office role a dashboard and a permission set, and those dashboards arrive in
 * the STEPs after this one. What exists now is the shell and the two office screens the
 * authentication block built, so the entry page answers the three questions a person has when they
 * arrive: which roles this account holds, what each of them is allowed to do, and which screens
 * those roles open. It reads the same model the sidebar does, so the page and the navigation cannot
 * disagree about either the roles or the screens.
 *
 * ## The gate is the layout's, asked again
 *
 * The layout above has already decided. This page asks the same pure function again because a page
 * must not depend on the kindness of the component around it: if it were ever rendered outside the
 * group, it refuses in exactly the same way instead of printing an office roster to a merchant.
 * Both reads are the same cached value, so asking twice costs nothing.
 *
 * ## Nothing here is a promise
 *
 * Every link on this page is a page that exists - the gate resolves each one in the app tree. The
 * screens of the later office STEPs appear in the sidebar and on this page in the commit that adds
 * them, which is why `OFFICE_NAVIGATION` is the only place that knows a screen's address.
 */

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const sectionClasses = "flex flex-col gap-3 border-t border-border pt-6";

const headingClasses = "text-lg font-semibold tracking-tight";

const roleTermClasses = "text-sm font-semibold text-foreground";

const roleBodyClasses = "mt-1 text-sm text-muted-foreground";

const cardListClasses = "grid gap-3 sm:grid-cols-2";

const cardClasses =
  "flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-surface-foreground shadow-card";

const cardLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const cardDescriptionClasses = "text-sm text-muted-foreground";

const chainClasses =
  "rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground";

const homeLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export default async function OfficeWorkspacePage(): Promise<ReactNode> {
  const access = decideOfficeAccess(await readOfficeActor());
  const destination = officeAccessRedirect(access);

  if (destination !== null) {
    redirect(destination);
  }

  if (access.kind !== "allowed") {
    return <OfficeAccessPanel kind={access.kind === "denied" ? "denied" : "unavailable"} />;
  }

  const workspace = officeWorkspaceOf(access.roles);

  if (workspace === null) {
    return <OfficeAccessPanel kind="denied" />;
  }

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <h1 className={titleClasses}>{getMessage("office.workspaceTitle")}</h1>
        <p className={descriptionClasses}>{getMessage("office.workspaceDescription")}</p>
      </header>

      <section aria-labelledby="office-duties" className={sectionClasses}>
        <h2 className={headingClasses} id="office-duties">
          {getMessage("office.dutiesHeading")}
        </h2>
        <dl>
          {workspace.roles.map((role) => (
            <div className="mt-2 first:mt-0" key={role.role}>
              <dt className={roleTermClasses}>{getMessage(role.labelKey)}</dt>
              <dd className={roleBodyClasses}>{getMessage(role.charterKey)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="office-sections" className={sectionClasses}>
        <h2 className={headingClasses} id="office-sections">
          {getMessage("office.sectionsHeading")}
        </h2>
        <ul className={cardListClasses}>
          {workspace.sections.map((section) => (
            <li className={cardClasses} key={section.key}>
              <Link className={cardLinkClasses} href={section.href}>
                {getMessage(section.labelKey)}
              </Link>
              <p className={cardDescriptionClasses}>{getMessage(section.descriptionKey)}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className={chainClasses}>{getMessage("office.approvalChain")}</p>

      <Link className={homeLinkClasses} href="/">
        {getMessage("office.homeLink")}
      </Link>
    </div>
  );
}
