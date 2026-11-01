// path: components/office/admin-shell.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { getMessage } from "@/lib/i18n/messages";
import { OFFICE_HOME_PATH, officeRoleLabelKey, type OfficeRole, type OfficeSection } from "./navigation";
import { OfficeNav, type OfficeNavItem } from "./office-nav";

/**
 * The office shell: a topbar, a sidebar and the one content landmark, wrapped around every office
 * screen the `app/(admin)` group renders.
 *
 * ## What the shell is responsible for
 *
 * The account has already been decided by the layout that renders this component, so nothing here
 * questions it again: the roles and the sections arrive as values, and the shell only says who is
 * signed in and where they may go. That keeps the security decision in one function
 * (`decideOfficeAccess`) and the presentation in one component, and it means the shell has no data
 * access of its own - it is a React tree with props.
 *
 * ## Landmarks and order
 *
 * The document already has the skip link of the root layout, which points at the wrapper around
 * this shell. Inside it the order is `header`, then `nav`, then `main`, which is the order a screen
 * reader announces and the order Tab walks: identity first, then destinations, then the page. There
 * is exactly one main landmark and exactly one navigation landmark here, so a page below must not
 * render either -
 * a second landmark with the same meaning is a navigation a keyboard user has to pass twice.
 *
 * ## Both themes, both widths
 *
 * Every colour is a semantic token (`surface`, `foreground`, `muted-foreground`, `border`,
 * `secondary`), so the shell follows the theme with no conditional class of its own; the shell gate
 * refuses a colour literal anywhere under `components/`. The layout is one DOM reflowed at `lg`:
 * the sidebar becomes the top strip below the topbar, and `min-w-0` keeps a wide table inside
 * `main` from pushing the sidebar off the screen. No width is fixed in pixels, so the same markup
 * serves a phone, a tablet and a desktop.
 *
 * ## The session keeps rotating
 *
 * `SessionKeeper` is mounted once, here, rather than on each screen: section 22's rotation is a
 * property of being signed in, not of a page.
 */

export interface AdminShellProperties {
  /** The office roles the account holds, in the migration's order. */
  readonly roles: readonly OfficeRole[];
  /** The screens those roles open. Every one of them is a page the gate resolved. */
  readonly sections: readonly OfficeSection[];
  readonly children: ReactNode;
}

const shellClasses = "flex min-h-dvh flex-col bg-background text-foreground";

const headerClasses = "border-b border-border bg-surface";

const headerInnerClasses =
  "mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between";

const brandClasses =
  "w-fit rounded-sm text-sm font-semibold tracking-tight text-foreground hover:text-primary focus-visible:ring-2 focus-visible:ring-primary";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const roleListClasses = "flex flex-wrap items-center gap-2";

const roleChipClasses =
  "rounded-pill border border-border bg-background px-3 py-1 text-xs font-semibold text-muted-foreground";

const bodyClasses = "mx-auto flex w-full max-w-7xl flex-1 flex-col lg:flex-row";

const sidebarClasses =
  "border-b border-border bg-surface lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r";

const contentClasses = "min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8";

export function AdminShell({ roles, sections, children }: AdminShellProperties): ReactNode {
  const items: readonly OfficeNavItem[] = sections.map((section) => ({
    key: section.key,
    href: section.href,
    label: getMessage(section.labelKey),
  }));

  return (
    <div className={shellClasses}>
      <SessionKeeper />
      <header className={headerClasses}>
        <div className={headerInnerClasses}>
          <div className="flex min-w-0 flex-col gap-1">
            <Link className={brandClasses} href={OFFICE_HOME_PATH}>
              {getMessage("brand.name")}
            </Link>
            <p className={eyebrowClasses}>{getMessage("office.eyebrow")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ul aria-label={getMessage("office.rolesHeading")} className={roleListClasses}>
              {roles.map((role) => (
                <li className={roleChipClasses} key={role}>
                  {getMessage(officeRoleLabelKey(role))}
                </li>
              ))}
            </ul>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className={bodyClasses}>
        <aside className={sidebarClasses}>
          <OfficeNav items={items} label={getMessage("office.navLabel")} />
        </aside>
        <main className={contentClasses}>{children}</main>
      </div>
    </div>
  );
}
