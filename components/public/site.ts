// path: components/public/site.ts
import type { MessagePath } from "../../lib/i18n/messages.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The public site's route model: every public page the platform publishes, in one list.
 *
 * ## One list, three readers
 *
 * The header, the footer, the sitemap and the search engine rules all answer "which pages exist",
 * and they must answer it the same way. A header that offers a link the sitemap omits hides a
 * page; a sitemap that lists a path the header never shows is a page nobody can reach. So the
 * answer lives here once, and `components/public/verify.ts` resolves every entry to a `page.tsx`
 * under `app/(public)/` **and** every page back to an entry - in both directions, because a page
 * added without an entry is a page no navigation offers and no sitemap lists, which is how a
 * marketing site grows an orphan.
 *
 * ## Only pages that exist
 *
 * STEP 231 is the shell and the structure: it ships the home route and nothing else. STEPs 232 to
 * 237 each add their page and their entry in the same commit - the gate refuses the entry without
 * the page, so a nav item is never a promise of something that is not there. That is the same rule
 * `components/office/navigation.ts` follows for the office sidebar, and for the same reason.
 *
 * ## The shape of an entry
 *
 * Every user facing word is a catalog path rather than a string, so a missing sentence is a
 * compile error at this table and a gate failure at runtime. `changeFrequency` and `priority` are
 * the two suggestions a sitemap may carry; they are a crawl hint, never a ranking trick, and the
 * gate keeps the priority a number between zero and one.
 *
 * ## Why the imports carry their `.ts` extension
 *
 * The gate imports this module under plain Node, which resolves a specifier that names the file
 * exactly. The `.tsx` components beside it are compiled by Next and use the `@/` alias like every
 * other screen.
 */

/** How often a public page is expected to change. A sitemap hint, not a promise. */
export type PublicChangeFrequency = "daily" | "weekly" | "monthly";

/** The footer columns. A route sits in one, or in none when it is reached from the header only. */
export type PublicFooterSection = "product" | "company" | "resources";

export interface PublicRoute {
  /** Stable identifier, used as the React key and in the gate's messages. */
  readonly id: string;
  /** The canonical path, starting with a slash and without a trailing one. `/` for the home page. */
  readonly path: string;
  /** Nav label, for the header and the footer column. */
  readonly label: MessagePath;
  /** The `<title>` of the page, before the template that names the site. */
  readonly title: MessagePath;
  /** The meta description of the page. */
  readonly description: MessagePath;
  readonly changeFrequency: PublicChangeFrequency;
  /** Sitemap priority between 0 and 1. Zero would mean "do not crawl", so it is never used. */
  readonly priority: number;
  /** True when the page earns a place in the primary navigation. */
  readonly inHeader: boolean;
  /** The footer column it belongs to, or `null` for a page that is linked from the header only. */
  readonly footer: PublicFooterSection | null;
}

/** The group the public pages live in, relative to the repository root. */
export const PUBLIC_ROUTE_GROUP = "app/(public)";

/** The path the public site starts at. */
export const PUBLIC_HOME_PATH = "/";

/**
 * Every published public page.
 *
 * The home page is the only entry STEP 231 can honestly declare, and its copy is the catalog's
 * brand copy on purpose: STEP 232 replaces the home page's content with CMS content and moves this
 * entry's title and description to the sentences that content supplies.
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = deepFreeze([
  {
    id: "home",
    path: PUBLIC_HOME_PATH,
    label: "publicSite.navHome",
    title: "brand.name",
    description: "brand.description",
    changeFrequency: "weekly",
    priority: 1,
    inHeader: true,
    footer: null,
  },
] satisfies readonly PublicRoute[]);

const footerSections: readonly PublicFooterSection[] = deepFreeze([
  "product",
  "company",
  "resources",
] satisfies readonly PublicFooterSection[]);

/** The pages the primary navigation offers, in the order the table lists them. */
export function headerRoutes(routes: readonly PublicRoute[] = PUBLIC_ROUTES): readonly PublicRoute[] {
  return routes.filter((route) => route.inHeader);
}

export interface PublicFooterColumn {
  readonly section: PublicFooterSection;
  readonly heading: MessagePath;
  readonly routes: readonly PublicRoute[];
}

/** The footer's columns, each with the pages it holds. A column with no page is not returned. */
export function footerColumns(routes: readonly PublicRoute[] = PUBLIC_ROUTES): readonly PublicFooterColumn[] {
  const columns: PublicFooterColumn[] = [];

  for (const section of footerSections) {
    const held = routes.filter((route) => route.footer === section);

    if (held.length > 0) {
      columns.push({ section, heading: `publicSite.footer.${section}`, routes: held });
    }
  }

  return columns;
}

/** The route that owns a path, or undefined when no public page is published there. */
export function routeOfPath(
  path: string,
  routes: readonly PublicRoute[] = PUBLIC_ROUTES,
): PublicRoute | undefined {
  return routes.find((route) => route.path === path);
}

export interface PublicSitemapEntry {
  readonly path: string;
  readonly changeFrequency: PublicChangeFrequency;
  readonly priority: number;
}

/**
 * The sitemap's rows, in table order.
 *
 * Only the path, the change hint and the priority travel: the absolute URL is built by
 * `components/public/seo.ts`, which is the one module that knows the site's address. No
 * `lastModified` is invented here - a date that is "now" on every request is a date a crawler
 * learns to ignore, and a real one arrives with the CMS in STEP 232.
 */
export function sitemapEntries(
  routes: readonly PublicRoute[] = PUBLIC_ROUTES,
): readonly PublicSitemapEntry[] {
  return routes.map((route) => ({
    path: route.path,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
