// path: components/public/public-footer.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { footerColumns } from "./site";

/**
 * The public site's footer: who we are, where the pages are, and who the partners are.
 *
 * ## The columns come from the route table, and an empty column is not rendered
 *
 * `footerColumns()` returns only the sections that hold a page, so the footer shows today exactly
 * what exists - the brand statement and the legal line - and grows a column the moment a STEP adds
 * a footer-bound route. Nothing here lists a destination that has no page behind it, for the same
 * reason the header does not.
 *
 * ## The partner line is a product requirement, not decoration
 *
 * FEATURE_LIST section 25 fixes how partners are named on public and merchant surfaces: *Global
 * Payout Partners* and *Local Payment Methods via Licensed Partners*. The sentence is in the
 * catalog rather than in this file, so the one place that decides the wording is the one place the
 * copy is reviewed, and every surface that shows it reads the same key.
 *
 * ## The year
 *
 * Rendered from the server clock with `formatMessage`, which refuses a template whose placeholder
 * it was not given. The page is rendered per request - the root layout needs a response-scoped
 * content security policy nonce - so the year is the year a visitor actually sees, including
 * across midnight on the first of January.
 *
 * ## Landmarks and layout
 *
 * One `<footer>`, therefore one content-information landmark, and no navigation landmark until a
 * column exists. The grid is one column on a phone and two from `sm`, and the legal line sits under
 * a rule, so the footer never pushes a small screen sideways. Colours are semantic tokens only.
 */

const footerClasses = "mt-auto border-t border-border bg-surface";

const innerClasses =
  "mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:justify-between";

const brandClasses = "max-w-md space-y-2";

const brandLinkClasses =
  "rounded-sm text-sm font-semibold tracking-tight text-foreground hover:text-primary " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

const descriptionClasses = "text-sm text-muted-foreground";

const columnsClasses = "flex flex-wrap gap-8";

const headingClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const columnLinkClasses =
  "rounded-sm text-sm text-foreground underline-offset-4 hover:text-primary hover:underline " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

const legalClasses = "border-t border-border";

const legalInnerClasses =
  "mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-6 sm:flex-row sm:items-center sm:justify-between";

export function PublicFooter(): ReactNode {
  const columns = footerColumns();
  const year = new Date().getFullYear();

  return (
    <footer className={footerClasses}>
      <div className={innerClasses}>
        <div className={brandClasses}>
          <Link className={brandLinkClasses} href="/">
            {getMessage("brand.name")}
          </Link>
          <p className={descriptionClasses}>{getMessage("brand.description")}</p>
          <p className={descriptionClasses}>{getMessage("publicSite.partnerNaming")}</p>
        </div>
        {columns.length === 0 ? null : (
          <div className={columnsClasses}>
            {columns.map((column) => (
              <nav aria-label={getMessage(column.heading)} key={column.section} className="space-y-2">
                <p className={headingClasses}>{getMessage(column.heading)}</p>
                <ul className="space-y-1">
                  {column.routes.map((route) => (
                    <li key={route.id}>
                      <Link className={columnLinkClasses} href={route.path}>
                        {getMessage(route.label)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        )}
      </div>
      <div className={legalClasses}>
        <div className={legalInnerClasses}>
          <p>{formatMessage("publicSite.copyright", { year })}</p>
          <p>{getMessage("publicSite.legalNote")}</p>
        </div>
      </div>
    </footer>
  );
}
