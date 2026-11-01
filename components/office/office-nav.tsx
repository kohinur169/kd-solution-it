// path: components/office/office-nav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The office navigation: one list of links, in the sidebar on a wide screen and under the topbar
 * on a narrow one.
 *
 * ## One list, two shapes
 *
 * The same navigation element is rendered once and reflowed by the stylesheet: a row that scrolls
 * sideways under the topbar, and a column in the sidebar from `lg` upwards. Nothing is removed,
 * duplicated or moved into a menu a keyboard cannot reach, so every entry is one Tab stop at every
 * width and the reading order never changes. A second copy for mobile would mean two landmarks with
 * the same name, which a screen reader reads twice.
 *
 * ## Where the current page is said
 *
 * `aria-current="page"` is the only thing JavaScript decides here: the browser knows its own
 * address, and the server does not. The label text is passed in already translated, so the string
 * catalog stays out of the client bundle.
 *
 * The entry for a parent path stays current on its children (`/office/sessions` stays current on
 * `/office/sessions/anything`), because an office screen with a detail page is still that screen.
 */

export interface OfficeNavItem {
  readonly key: string;
  /** The path the entry opens. It is a real page: the gate resolves it in the app tree. */
  readonly href: string;
  /** The label, already read from the catalog by the server component. */
  readonly label: string;
}

export interface OfficeNavProperties {
  /** The entries this account may open, in the order the sidebar shows them. */
  readonly items: readonly OfficeNavItem[];
  /** The accessible name of the landmark, so a second navigation would be distinguishable. */
  readonly label: string;
}

const listClasses = "flex items-center gap-1 lg:flex-col lg:items-stretch";

const linkBaseClasses =
  "flex items-center whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors " +
  "focus-visible:ring-2 focus-visible:ring-primary";

const activeLinkClasses = `${linkBaseClasses} bg-secondary font-semibold text-secondary-foreground`;

const idleLinkClasses = `${linkBaseClasses} text-muted-foreground hover:bg-accent hover:text-accent-foreground`;

/** True when the entry names this page, or the page this one is nested under. */
function isCurrent(pathname: string | null, href: string): boolean {
  if (pathname === null) {
    return false;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OfficeNav({ items, label }: OfficeNavProperties): ReactNode {
  const pathname = usePathname();

  return (
    <nav
      aria-label={label}
      className="w-full overflow-x-auto px-4 py-3 lg:overflow-visible lg:px-4 lg:py-6"
    >
      <ul className={listClasses}>
        {items.map((item) => {
          const current = isCurrent(pathname, item.href);

          return (
            <li key={item.key}>
              <Link
                {...(current ? { "aria-current": "page" as const } : {})}
                className={current ? activeLinkClasses : idleLinkClasses}
                href={item.href}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
