// path: components/public/public-header.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { headerRoutes } from "./site";

/**
 * The public site's primary navigation, and the two ways into an account.
 *
 * ## Why this is a `<header>` and not another brand bar
 *
 * The root layout already renders the document's chrome: the brand link and the theme switcher,
 * above every route. A public page must not repeat either of those - two brand links on one screen
 * is a duplicate destination a screen reader announces twice - so the site's own header carries
 * what the root does not: the destinations, and the account actions. The brand and the theme stay
 * where every other surface already finds them.
 *
 * ## Nothing here is a promise
 *
 * The links come from `headerRoutes()`, which is the route table filtered by its own `inHeader`
 * flag, and the gate resolves every path in that table to a `page.tsx`. A navigation item is
 * therefore a page that exists today, not a page somebody intends to write - which is why the
 * public site starts with one item and grows one item per STEP until STEP 237 closes the set.
 *
 * ## Both widths, both themes
 *
 * One DOM: a flex row that wraps at any width, so at 360 px the destinations and the actions sit on
 * two lines instead of pushing each other off the screen, and from `sm` they share one. Every
 * colour is a semantic token (`background`, `foreground`, `muted-foreground`, `primary`,
 * `primary-foreground`, `border`), so the header follows the theme with no conditional class; the
 * shell gate refuses a colour literal anywhere under `components/`.
 *
 * ## Focus
 *
 * Each link is a real anchor with a visible `focus-visible` ring, and the row wraps rather than
 * scrolls, so a keyboard user tabbing through the site never loses their place off screen. There
 * is no menu button and no client JavaScript: a desktop-class navigation that needs a script to
 * show two links would be the wrong trade at this stage of the site.
 */

const headerClasses = "border-b border-border bg-background";

const innerClasses =
  "mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6";

const navClasses = "flex flex-wrap items-center gap-1";

const navLinkClasses =
  "rounded-sm px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

const actionsClasses = "flex flex-wrap items-center gap-2";

const signInClasses =
  "rounded-md px-2 py-1 text-sm font-semibold text-foreground underline-offset-4 hover:text-primary " +
  "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

const createAccountClasses =
  "rounded-md border border-primary bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground " +
  "hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

export function PublicHeader(): ReactNode {
  const routes = headerRoutes();

  return (
    <header className={headerClasses}>
      <div className={innerClasses}>
        {routes.length === 0 ? null : (
          <nav aria-label={getMessage("publicSite.navLabel")} className={navClasses}>
            <ul className="flex flex-wrap items-center gap-1">
              {routes.map((route) => (
                <li key={route.id}>
                  <Link className={navLinkClasses} href={route.path}>
                    {getMessage(route.label)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={actionsClasses}>
          <Link className={signInClasses} href="/signin">
            {getMessage("publicSite.signIn")}
          </Link>
          <Link className={createAccountClasses} href="/signup">
            {getMessage("publicSite.createAccount")}
          </Link>
        </div>
      </div>
    </header>
  );
}
