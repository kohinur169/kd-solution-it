// path: components/public/seo.ts
import type { Metadata, MetadataRoute } from "next";
import { en } from "../../lib/i18n/strings/en.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { PUBLIC_ROUTES, sitemapEntries, type PublicRoute } from "./site.ts";

/**
 * The public site's SEO: metadata, structured data, the sitemap and the crawler rules.
 *
 * ## Metadata is built, not pasted
 *
 * A marketing page that hand writes its `<title>`, description, canonical and open graph tags is
 * one page away from having none of them: the fourth page forgets the canonical, the fifth sets a
 * relative og:url that resolves wrong behind a proxy, the sixth indexes a staging build. So one
 * function builds the whole block from three facts - a title, a description and the path the page
 * lives at - and every page in this group calls it. The rules Next applies to the returned object
 * (the title template, the inherited `metadataBase`) stay Next's; this module never reaches into a
 * response.
 *
 * ## The path is validated, because a canonical that lies is worse than none
 *
 * `canonicalPathOf` refuses an absolute URL, a protocol relative path, a query, a fragment, a
 * traversal, whitespace, a non-ASCII character and a trailing slash. A canonical is the one hint
 * that tells a search engine "this is the page"; a canonical pointing at another host is how a
 * site quietly hands its ranking to somebody else, and it is usually produced by concatenating a
 * value that was never checked.
 *
 * ## Structured data is JSON, and JSON inside HTML is a script injection waiting to happen
 *
 * A `<script type="application/ld+json">` block ends at the first `</script`, so a value carrying
 * that sequence would break out of the block and become markup. `serializeStructuredData` escapes
 * `<`, `>` and `&` into their JSON unicode escapes - still valid JSON, no longer able to close a
 * tag - and the gate proves it by parsing the result back and comparing the object.
 *
 * ## The crawler rules are computed from the repository
 *
 * `PRIVATE_URL_PREFIXES` is every first path segment the application serves that is not a public
 * page: the dashboard, the office, the tokenised client portal, the API and the sign in screens.
 * It is written down here because `robots.txt` may not read the filesystem at request time, and
 * `components/public/verify.ts` recomputes it from `app/` on every verification run and fails when
 * the two disagree - so a STEP that adds a screen cannot forget to hide it, and this list cannot
 * rot into a stale copy. A public route that started with one of these prefixes is refused by the
 * gate too: a page the robots file disallows can never be indexed.
 *
 * ## What this module deliberately does not do
 *
 * It does not read the environment: the site's address is the caller's argument, so the whole file
 * is a pure function of its input and the gate can exercise it without a process. It does not
 * invent a `lastModified` (see `sitemapEntries`), and it does not add an open graph image, because
 * publishing a URL for an asset that does not exist is worse than an image-less card.
 */

/** The length a search result shows before it truncates. A hint, enforced by the gate. */
export const SEO_LIMITS = deepFreeze({
  maximumTitleLength: 60,
  minimumDescriptionLength: 50,
  maximumDescriptionLength: 160,
  maximumPathLength: 200,
});

/**
 * The open graph locale.
 *
 * Open graph wants a language and a territory; the catalog carries the language and the platform
 * trades in one currency from one market perspective, so the territory is the one the product's
 * English is written for.
 */
export const OPEN_GRAPH_LOCALE = "en_US";

/** Where the sitemap is served. Also the last line of `robots.txt`. */
export const SITEMAP_PATH = "/sitemap.xml";

/** Where the crawler rules are served. */
export const ROBOTS_PATH = "/robots.txt";

/**
 * Every first path segment the application serves that is not a public page.
 *
 * Sorted, deduplicated and frozen; `components/public/verify.ts` keeps it equal to the tree.
 */
export const PRIVATE_URL_PREFIXES: readonly string[] = deepFreeze([
  "/2fa",
  "/account-sessions",
  "/account-unlocks",
  "/admin",
  "/announcements",
  "/api",
  "/audit-log",
  "/ceo",
  "/clients",
  "/countries",
  "/dashboard",
  "/delegations",
  "/developers",
  "/devices",
  "/e",
  "/entitlements",
  "/estimates",
  "/gateways",
  "/i",
  "/invoices",
  "/office",
  "/onboarding",
  "/p",
  "/payments",
  "/plans",
  "/products",
  "/provisioning-alerts",
  "/reauth",
  "/services",
  "/sessions",
  "/settings",
  "/settlements",
  "/signin",
  "/signup",
  "/verify",
] satisfies readonly string[]);

/**
 * A canonical path, or a refusal.
 *
 * Called with a value a page author wrote, never with anything from a request: an invalid path is
 * a programming error that should fail the build and the first render loudly rather than publish a
 * canonical that points somewhere else.
 */
export function canonicalPathOf(path: string): string {
  const problem = pathProblem(path);

  if (problem !== null) {
    throw new Error(`"${path}" is not a canonical public path: ${problem}.`);
  }

  return path;
}

/** The reason a value cannot be a canonical path, or null when it can. Split out for the gate. */
export function pathProblem(path: string): string | null {
  if (path.length === 0) {
    return "it is empty";
  }

  if (path.length > SEO_LIMITS.maximumPathLength) {
    return `it is longer than ${String(SEO_LIMITS.maximumPathLength)} characters`;
  }

  if (!path.startsWith("/")) {
    return "it does not start with a slash";
  }

  if (path.startsWith("//")) {
    return "it is protocol relative, so it names another host";
  }

  if (path === "/") {
    return null;
  }

  if (path.endsWith("/")) {
    return "it ends with a slash, so the same page has two addresses";
  }

  if (/[?#]/u.test(path)) {
    return "it carries a query or a fragment";
  }

  if (/\s/u.test(path)) {
    return "it carries whitespace";
  }

  if (!/^[\x20-\x7e]+$/u.test(path)) {
    return "it carries a character outside printable ASCII";
  }

  // The pattern is the guard that also carries traversal: a dot cannot appear in a segment at all,
  // so `.` and `..` are refused here rather than by a loop that would never be reached. A segment
  // that starts or ends with a hyphen is refused for the same reason - it is not a word.
  if (!/^\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(path)) {
    return "it is not lowercase letters, digits, hyphens and slashes";
  }

  return null;
}

/**
 * A served resource's path (`/sitemap.xml`, `/robots.txt`), or a refusal.
 *
 * A page's path may not carry a dot - a canonical ending in `.xml` is a file, not a page - but the
 * two machine routes this STEP publishes are named by their extension, so they are validated by the
 * same rules with one letter more: a dot is allowed *inside* a segment, and a segment may not be
 * `.` or `..` either way.
 */
export function resourcePathOf(path: string): string {
  const problem = resourcePathProblem(path);

  if (problem !== null) {
    throw new Error(`"${path}" is not a canonical resource path: ${problem}.`);
  }

  return path;
}

function resourcePathProblem(path: string): string | null {
  const pageProblem = pathProblem(path);

  if (pageProblem === null) {
    return null;
  }

  if (!/^\/[a-z0-9]+(?:[-/.][a-z0-9]+)*$/u.test(path)) {
    return "it is not lowercase letters, digits, dots, hyphens and slashes";
  }

  if (/\/\.\.?\//u.test(path) || path.endsWith("/.") || path.endsWith("/..")) {
    return "it traverses";
  }

  return null;
}

/** The site's address, without a trailing slash, or a refusal. */
export function siteBaseUrlOf(baseUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`"${baseUrl}" is not a URL.`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`"${baseUrl}" is not an http or https address.`);
  }

  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`"${baseUrl}" carries a query or a fragment.`);
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

/** One absolute URL for a canonical path, which is the only way this module joins the two. */
export function absoluteUrlOf(baseUrl: string, path: string): string {
  return `${siteBaseUrlOf(baseUrl)}${canonicalPathOf(path)}`;
}

/** One absolute URL for a served resource, which is the sitemap's own address. */
export function absoluteResourceUrlOf(baseUrl: string, path: string): string {
  return `${siteBaseUrlOf(baseUrl)}${resourcePathOf(path)}`;
}

export interface PublicPageSeo {
  /** The page's own title. The site's name is appended by the layout's title template. */
  readonly title: string;
  readonly description: string;
  /** The canonical path the page lives at. */
  readonly path: string;
  /** `article` for a blog post, `website` for everything else. */
  readonly type?: "website" | "article";
  /** Publish and update times, only for an article. ISO 8601, validated by the gate. */
  readonly publishedTime?: string;
  readonly modifiedTime?: string;
  /** True when the title must not be templated - the home page, which already names the site. */
  readonly absoluteTitle?: boolean;
  /**
   * True for a page that must stay out of the index: a confirmation screen, a page for a link that
   * should not compete with the page it duplicates. A public shell defaults to indexable.
   */
  readonly noIndex?: boolean;
}

/**
 * The metadata block for one public page.
 *
 * The object is assembled rather than spread from optional values, because `exactOptionalPropertyTypes`
 * must not see an `undefined` where the type says a key is absent: an og:image of `undefined` and
 * an og:image that is not there are different things to a crawler.
 */
export function buildPublicMetadata(page: PublicPageSeo): Metadata {
  const canonical = canonicalPathOf(page.path);
  const title: Metadata["title"] =
    page.absoluteTitle === true ? { absolute: page.title } : page.title;

  const openGraph: Metadata["openGraph"] =
    page.type === "article"
      ? {
          type: "article",
          title: page.title,
          description: page.description,
          url: canonical,
          siteName: en.brand.name,
          locale: OPEN_GRAPH_LOCALE,
          ...(page.publishedTime === undefined ? {} : { publishedTime: page.publishedTime }),
          ...(page.modifiedTime === undefined ? {} : { modifiedTime: page.modifiedTime }),
        }
      : {
          type: "website",
          title: page.title,
          description: page.description,
          url: canonical,
          siteName: en.brand.name,
          locale: OPEN_GRAPH_LOCALE,
        };

  return {
    title,
    description: page.description,
    alternates: { canonical },
    openGraph,
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
    },
    robots:
      page.noIndex === true
        ? { index: false, follow: false, nocache: true }
        : {
            index: true,
            follow: true,
            "max-image-preview": "large",
            "max-snippet": -1,
            "max-video-preview": -1,
          },
  };
}

/** The site's metadata: the address every relative URL resolves against, and the title template. */
export function buildSiteMetadata(baseUrl: string, defaultTitle: string): Metadata {
  return {
    metadataBase: new URL(siteBaseUrlOf(baseUrl)),
    title: {
      default: defaultTitle,
      template: `%s · ${en.brand.name}`,
    },
    applicationName: en.brand.name,
    referrer: "strict-origin-when-cross-origin",
  };
}

/** A JSON-LD object. Values are JSON by construction; the serializer is the only writer. */
export type StructuredData = Readonly<Record<string, unknown>>;

/**
 * The organisation the site belongs to.
 *
 * Only facts the platform actually holds: a name, a description and its address. No address,
 * telephone number, tax id or founding date is invented, because false structured data is a
 * manual action waiting to happen and a support ticket from somebody who rang a number that is not
 * ours.
 */
export function organizationStructuredData(baseUrl: string): StructuredData {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: en.brand.name,
    description: en.brand.description,
    url: absoluteUrlOf(baseUrl, "/"),
  };
}

/** The site itself, so a search engine can name it in a result and know its language. */
export function websiteStructuredData(baseUrl: string): StructuredData {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: en.brand.name,
    url: absoluteUrlOf(baseUrl, "/"),
    inLanguage: en.locale.code,
    publisher: {
      "@type": "Organization",
      name: en.brand.name,
      url: absoluteUrlOf(baseUrl, "/"),
    },
  };
}

/**
 * A JSON-LD object as a string that cannot close the script element it is written into.
 *
 * `JSON.stringify` already escapes quotes and backslashes; what it does not escape is HTML. The
 * three replacements below turn the only characters that matter into their JSON unicode escapes,
 * which parse back to the same characters - so the data is unchanged and the markup is safe. The
 * two line separators are escaped as well, because a JSON string may legally contain them and a
 * JavaScript parser that predates the JSON superset would not.
 */
export function serializeStructuredData(data: StructuredData): string {
  return JSON.stringify(data)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

/**
 * The crawler rules: the public pages are open, everything else is closed, and the sitemap is named.
 *
 * `allow: "/"` is not enough on its own - a `Disallow` outranks an `Allow` for the same path, and
 * the longest matching rule wins - which is why every private prefix is listed explicitly rather
 * than relying on a catch-all. The tokenised client portal (`/i`, `/e`, `/p`) is in the list for a
 * stronger reason than tidiness: those URLs are a client's credential, and one indexed link to one
 * of them is a payment page in a search result.
 */
export function robotsRoutes(baseUrl: string): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...PRIVATE_URL_PREFIXES] }],
    sitemap: absoluteResourceUrlOf(baseUrl, SITEMAP_PATH),
  };
}

/** The sitemap: one absolute URL per published page, in the table's order. */
export function sitemapRoutes(
  baseUrl: string,
  routes: readonly PublicRoute[] = PUBLIC_ROUTES,
): MetadataRoute.Sitemap {
  return sitemapEntries(routes).map((entry) => ({
    url: absoluteUrlOf(baseUrl, entry.path),
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
  }));
}
