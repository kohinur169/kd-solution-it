// path: components/public/verify.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatMessage, getMessage } from "../../lib/i18n/messages.ts";
import { footerColumns, headerRoutes, PUBLIC_ROUTES, sitemapEntries, type PublicRoute } from "./site.ts";
import {
  absoluteUrlOf,
  buildPublicMetadata,
  buildSiteMetadata,
  canonicalPathOf,
  OPEN_GRAPH_LOCALE,
  organizationStructuredData,
  pathProblem,
  PRIVATE_URL_PREFIXES,
  ROBOTS_PATH,
  robotsRoutes,
  SEO_LIMITS,
  serializeStructuredData,
  SITEMAP_PATH,
  siteBaseUrlOf,
  sitemapRoutes,
  websiteStructuredData,
} from "./seo.ts";

/**
 * The gate for STEP 231: the public shell, the route table and the SEO structure.
 *
 * ## What this proves
 *
 *   - **The table and the tree are the same set.** Every `page.tsx` under `app/(public)/` has an
 *     entry and every entry resolves to a page - in both directions, because a page without an
 *     entry is an orphan nobody links to and an entry without a page is a 404 in the navigation.
 *   - **The crawler rules know the application.** `PRIVATE_URL_PREFIXES` is recomputed from `app/`
 *     on every run and compared with the constant, so a STEP that adds a screen cannot leave it
 *     indexable, and a removed screen cannot leave a stale rule behind.
 *   - **A canonical is a path, never an address.** Absolute URLs, protocol relative paths, queries,
 *     fragments, traversal, whitespace, capitals and trailing slashes are all refused, which is the
 *     difference between telling a search engine what this page is and telling it about somebody
 *     else's host.
 *   - **The metadata block is complete for every kind of page**: the plain page, the home page that
 *     opts out of the title template, the article with its two dates, and the page that must not be
 *     indexed.
 *   - **Structured data cannot escape its script element.** A payload carrying `</script>` is
 *     serialised, parsed back and compared - the object survives, the markup does not.
 *   - **The shell is the shell**: the layout renders the header, the footer and the nonce-carrying
 *     structured data, no page is wrapped twice in a `<main>`, and the header does not repeat the
 *     theme control the root layout already renders.
 *
 * The gate reads files that a build would compile, but it executes the model: the route table, the
 * metadata builder, the serialiser and the crawler rules are plain TypeScript with no framework
 * import that survives to runtime, which is why this file can run under Node before a build.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

let checkCount = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(
    Object.is(actual, expected),
    `${description} (expected ${String(expected)}, got ${String(actual)})`,
  );
}

/** Structural equality for the metadata objects, which are plain records at runtime. */
function expectJson(actual: unknown, expected: unknown, description: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${description} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

async function walk(relativeDirectory: string, matches: (name: string) => boolean): Promise<readonly string[]> {
  const collected: string[] = [];

  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(join(repositoryRoot, relative), { withFileTypes: true });

    for (const entry of entries) {
      const next = `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        await visit(next);
        continue;
      }

      if (matches(entry.name)) {
        collected.push(next);
      }
    }
  };

  await visit(relativeDirectory);

  return collected.sort();
}

async function readRepositoryFile(relative: string): Promise<string> {
  return readFile(join(repositoryRoot, relative), "utf8");
}

async function exists(relative: string): Promise<boolean> {
  try {
    await readdir(join(repositoryRoot, relative));
    return true;
  } catch {
    try {
      await readFile(join(repositoryRoot, relative), "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Metadata as a plain record.
 *
 * `Metadata` is a union of a dozen shapes - an open graph object, an open graph article object, a
 * twitter object - so reading `type` off it directly is a narrow-union error rather than a check.
 * The gate inspects the object Next would receive, which is a record at runtime either way.
 */
function inspected(metadata: object): Record<string, unknown> {
  return metadata as unknown as Record<string, unknown>;
}

function isGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** The URL a page file serves, with the group segments dropped the way Next drops them. */
function urlOfPageFile(repositoryPath: string): string {
  const segments = repositoryPath
    .replace(/^app\//u, "")
    .replace(/\/?page\.tsx$/u, "")
    .split("/")
    .filter((segment) => segment.length > 0 && !isGroupSegment(segment));

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** The first path segment a non-public route serves, which is what `robots.txt` can prefix. */
function firstSegmentOf(repositoryPath: string): string | null {
  const segments = repositoryPath
    .replace(/^app\//u, "")
    .replace(/\/(?:page|route)\.tsx?$/u, "")
    .split("/")
    .filter((segment) => segment.length > 0 && !isGroupSegment(segment));

  return segments[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// 1. The route table and the tree
// ---------------------------------------------------------------------------------------------

const publicPageFiles = await walk("app/(public)", (name) => name === "page.tsx");
const publicUrls = publicPageFiles.map(urlOfPageFile);
const tablePaths = PUBLIC_ROUTES.map((route) => route.path);

expect(publicUrls.length > 0, "the group holds at least one page, because a shell with no page renders nowhere");

for (const url of publicUrls) {
  expect(
    tablePaths.includes(url),
    `the page at "${url}" is declared in the public route table, so navigation and sitemap offer it`,
  );
}

for (const route of PUBLIC_ROUTES) {
  expect(
    publicUrls.includes(route.path),
    `the table's entry "${route.path}" resolves to a page under app/(public)`,
  );
}

expectEqual(new Set(tablePaths).size, tablePaths.length, "no path is declared twice");
expectEqual(new Set(PUBLIC_ROUTES.map((route) => route.id)).size, PUBLIC_ROUTES.length, "no id is declared twice");

for (const route of PUBLIC_ROUTES) {
  expect(pathProblem(route.path) === null, `the table's path "${route.path}" is canonical`);
  expect(
    route.priority > 0 && route.priority <= 1,
    `"${route.path}" carries a priority a crawler can use (${String(route.priority)})`,
  );
  expect(
    ["daily", "weekly", "monthly"].includes(route.changeFrequency),
    `"${route.path}" carries a change frequency from the sitemap's own vocabulary`,
  );
}

expect(
  PUBLIC_ROUTES.some((route) => route.path === "/"),
  "the site has a home page, because every other page is reached from it",
);

// The seam this STEP creates: the home route lives in the group now.
expect(await exists("app/(public)/page.tsx"), "the home page is a page of the public group");
expect(!(await exists("app/page.tsx")), "and the foundation's placeholder at app/page.tsx is gone, so `/` has one owner");

// ---------------------------------------------------------------------------------------------
// 2. Navigation and footer
// ---------------------------------------------------------------------------------------------

const header = headerRoutes();

expect(header.length > 0, "the header offers at least one destination");
expectEqual(
  header.map((route) => route.id).join(","),
  PUBLIC_ROUTES.filter((route) => route.inHeader).map((route) => route.id).join(","),
  "the header keeps the table's order and its own flag",
);

for (const route of header) {
  expect(publicUrls.includes(route.path), `the header's "${route.path}" is a page that exists`);
}

const columns = footerColumns();

for (const column of columns) {
  expect(column.routes.length > 0, `the footer column "${column.section}" is rendered only when it holds a page`);
  expect(getMessage(column.heading).length > 0, `the column heading "${column.heading}" resolves in the catalog`);

  for (const route of column.routes) {
    expect(route.footer === column.section, `"${route.path}" is listed under "${column.section}"`);
  }
}

// The table holds one page today, so a filter that ignores its flag would look correct. These two
// synthetic rows are the smallest table that can tell "filters" from "returns everything".
const sampleRoute: PublicRoute = {
  id: "sample",
  path: "/sample",
  label: "publicSite.navHome",
  title: "brand.name",
  description: "brand.description",
  changeFrequency: "monthly",
  priority: 0.5,
  inHeader: true,
  footer: "product",
};
const syntheticRoutes: readonly PublicRoute[] = [
  { ...sampleRoute, id: "first", path: "/first", inHeader: true, footer: "product" },
  { ...sampleRoute, id: "second", path: "/second", inHeader: false, footer: "company" },
  { ...sampleRoute, id: "third", path: "/third", inHeader: false, footer: null },
];

expectEqual(
  headerRoutes(syntheticRoutes).map((route) => route.id).join(","),
  "first",
  "the header takes the routes that carry its flag and not the rest",
);
expectEqual(
  footerColumns(syntheticRoutes).map((column) => `${column.section}:${column.routes.map((route) => route.id).join("+")}`).join(" "),
  "product:first company:second",
  "the footer groups by section, keeps the table's order and leaves a column with no page out",
);

const footerBound = PUBLIC_ROUTES.filter((route) => route.footer !== null);

expectEqual(
  footerBound.length,
  columns.reduce((total, column) => total + column.routes.length, 0),
  "every footer bound route appears in exactly one column",
);

// ---------------------------------------------------------------------------------------------
// 3. The catalog the shell reads
// ---------------------------------------------------------------------------------------------

for (const route of PUBLIC_ROUTES) {
  for (const path of [route.label, route.title, route.description]) {
    let message = "";

    try {
      message = getMessage(path);
    } catch {
      failures.push(`the catalog has no message at "${path}"`);
    }

    expect(message.length > 0, `"${path}" is a sentence, not an empty string`);
  }
}

for (const label of ["publicSite.navLabel", "publicSite.navHome", "publicSite.signIn", "publicSite.createAccount", "publicSite.partnerNaming", "publicSite.legalNote"] as const) {
  expect(getMessage(label).length > 0, `the shell's "${label}" resolves`);
}

expect(
  formatMessage("publicSite.copyright", { year: 2026 }) === "Copyright 2026 KD Solution IT. All rights reserved.",
  "the copyright sentence formats its year and nothing else",
);

expect(
  getMessage("publicSite.partnerNaming").includes("Global Payout Partners") &&
    getMessage("publicSite.partnerNaming").includes("Local Payment Methods via Licensed Partners"),
  "the footer carries section 25's partner naming in both of its halves",
);

let copyrightNeedsYear = false;

try {
  getMessage("publicSite.copyright");
} catch {
  copyrightNeedsYear = true;
}

expect(
  copyrightNeedsYear,
  "the copyright sentence keeps its year placeholder, so the shell formats it rather than pasting it",
);

// ---------------------------------------------------------------------------------------------
// 4. A canonical path
// ---------------------------------------------------------------------------------------------

/**
 * Each refusal with the reason it must give.
 *
 * The reason is pinned, not just the refusal: a check that returns "not lowercase letters" for a
 * protocol relative path would still refuse it, and the next reader would not know which guard
 * caught it. Pinning the sentence keeps every branch of `pathProblem` alive and named.
 */
for (const [refused, reason] of [
  ["", "it is empty"],
  ["pricing", "it does not start with a slash"],
  ["//evil.example", "it is protocol relative, so it names another host"],
  ["/pricing?ref=x", "it carries a query or a fragment"],
  ["/pricing#top", "it carries a query or a fragment"],
  ["/pricing/", "it ends with a slash, so the same page has two addresses"],
  ["/pricing ", "it carries whitespace"],
  ["/Pricing", "it is not lowercase letters, digits, hyphens and slashes"],
  ["/./pricing", "it is not lowercase letters, digits, hyphens and slashes"],
  ["/pricing/-x", "it is not lowercase letters, digits, hyphens and slashes"],
  [`/${"a".repeat(SEO_LIMITS.maximumPathLength)}`, `it is longer than ${String(SEO_LIMITS.maximumPathLength)} characters`],
  ["/price list", "it carries whitespace"],
  ["/pricing\u00e9", "it carries a character outside printable ASCII"],
] as readonly (readonly [string, string])[]) {
  expectEqual(pathProblem(refused), reason, `"${refused}" is refused as a canonical path`);

  let thrown = false;

  try {
    canonicalPathOf(refused);
  } catch {
    thrown = true;
  }

  expect(thrown, `canonicalPathOf refuses "${refused}" rather than returning it`);
}

expect(
  pathProblem("/pricing/../admin") !== null,
  "a traversal is refused, whichever guard catches it",
);

for (const accepted of ["/", "/pricing", "/legal/refund-policy", "/blog/why-usd"]) {
  expect(pathProblem(accepted) === null, `"${accepted}" is accepted as a canonical path`);
  expectEqual(canonicalPathOf(accepted), accepted, `canonicalPathOf returns "${accepted}" unchanged`);
}

// ---------------------------------------------------------------------------------------------
// 5. The site address
// ---------------------------------------------------------------------------------------------

expectEqual(
  siteBaseUrlOf("https://example.test"),
  "https://example.test",
  "a plain https address is the site's base",
);
expectEqual(
  siteBaseUrlOf("https://example.test/kd/"),
  "https://example.test/kd",
  "a base with a path keeps its path and loses the trailing slash",
);
expectEqual(absoluteUrlOf("https://example.test", "/pricing"), "https://example.test/pricing", "and a path joins it once");

for (const refusedBase of ["not a url", "ftp://example.test", "https://example.test/?a=1", "https://example.test/#top"]) {
  let thrown = false;

  try {
    siteBaseUrlOf(refusedBase);
  } catch {
    thrown = true;
  }

  expect(thrown, `"${refusedBase}" is refused as the site's address`);
}

// ---------------------------------------------------------------------------------------------
// 6. The metadata block
// ---------------------------------------------------------------------------------------------

const websiteMetadata = buildPublicMetadata({
  title: "Pricing",
  description: "A description long enough to be a real meta description for a real public page.",
  path: "/pricing",
});

const website = inspected(websiteMetadata);

expectEqual(website["title"], "Pricing", "a page's title is its own title, templated by the layout");
expectEqual(
  (website["alternates"] as Record<string, unknown> | undefined)?.["canonical"],
  "/pricing",
  "the canonical is the page's path, relative to the metadata base",
);
const websiteGraph = website["openGraph"] as Record<string, unknown>;

expectEqual(websiteGraph["type"], "website", "a normal page is an open graph website");
expectEqual(websiteGraph["siteName"], "KD Solution IT", "and names the site");
expectEqual(websiteGraph["locale"], "en_US", "with the platform's open graph locale, spelled the way open graph requires");
expectEqual(OPEN_GRAPH_LOCALE, "en_US", "and the constant it reads is that spelling");
expectEqual((website["twitter"] as Record<string, unknown>)["card"], "summary_large_image", "and a large twitter card");
expectJson(
  website["robots"],
  { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
  "a public page is indexable by default, with the preview limits a search engine reads",
);

const homeMetadata = buildPublicMetadata({
  title: "KD Solution IT",
  description: "The brand's own description, which is what the home page publishes today.",
  path: "/",
  absoluteTitle: true,
});

expectJson(
  inspected(homeMetadata)["title"],
  { absolute: "KD Solution IT" },
  "the home page opts out of the title template, so the site's name is not appended twice",
);

const articleMetadata = buildPublicMetadata({
  title: "Why settlement takes seven days",
  description: "A description long enough to be a real meta description for a published article.",
  path: "/blog/why-settlement-takes-seven-days",
  type: "article",
  publishedTime: "2026-11-01T09:00:00.000Z",
  modifiedTime: "2026-11-05T09:00:00.000Z",
});

const articleGraph = inspected(articleMetadata)["openGraph"] as Record<string, unknown>;

expectEqual(articleGraph["type"], "article", "an article is an open graph article");
expectEqual(articleGraph["publishedTime"], "2026-11-01T09:00:00.000Z", "with the publish time it was given");
expectEqual(articleGraph["modifiedTime"], "2026-11-05T09:00:00.000Z", "and the update time");

const hiddenMetadata = buildPublicMetadata({
  title: "Thank you",
  description: "A description long enough to be a real meta description for a hidden public page.",
  path: "/contact/thanks",
  noIndex: true,
});

expectJson(
  inspected(hiddenMetadata)["robots"],
  { index: false, follow: false, nocache: true },
  "a no-index page asks not to be indexed",
);

const plainArticle = buildPublicMetadata({
  title: "An article without dates",
  description: "A description long enough to be a real meta description for a published article.",
  path: "/blog/undated",
  type: "article",
});

const plainGraph = inspected(plainArticle)["openGraph"] as Record<string, unknown>;

expect(
  !("publishedTime" in plainGraph) && !("modifiedTime" in plainGraph),
  "an article without dates carries no date keys at all, rather than keys holding undefined",
);

const siteMetadata = buildSiteMetadata("https://example.test/kd/", "KD Solution IT");

const siteBlock = inspected(siteMetadata);

expectEqual(
  String(siteBlock["metadataBase"]),
  "https://example.test/kd",
  "the layout's metadata base is the validated site address",
);
expectEqual(
  (siteBlock["title"] as Record<string, unknown>)["template"],
  "%s · KD Solution IT",
  "and the title template appends the site's name once",
);

// ---------------------------------------------------------------------------------------------
// 7. Structured data
// ---------------------------------------------------------------------------------------------

const organisation = organizationStructuredData("https://example.test");
const site = websiteStructuredData("https://example.test");

expectEqual(organisation["@context"], "https://schema.org", "the organisation block declares the schema context");
expectEqual(organisation["@type"], "Organization", "and its type");
expectEqual(organisation["name"], "KD Solution IT", "and the brand's name");
expectEqual(organisation["url"], "https://example.test/", "and the site's address");
expect(
  !("address" in organisation) && !("telephone" in organisation) && !("taxID" in organisation),
  "the organisation block invents no address, telephone number or tax id",
);

expectEqual(site["@type"], "WebSite", "the site block's type");
expectEqual(site["inLanguage"], "en", "and the language from the catalog");
expectEqual(site["url"], "https://example.test/", "and the address");

const hostile = serializeStructuredData({
  "@context": "https://schema.org",
  "@type": "Thing",
  name: "</script><img src=x onerror=alert(1)>",
});

expect(!hostile.includes("</script"), "a payload cannot close the script element it is written into");
expect(!hostile.includes("<"), "and no angle bracket survives the serialiser");
expectEqual(
  (JSON.parse(hostile) as Record<string, unknown>)["name"],
  "</script><img src=x onerror=alert(1)>",
  "while the value parses back to exactly what it was",
);

const separators = serializeStructuredData({ "@type": "Thing", name: "line\u2028break" });

expect(!separators.includes("\u2028"), "a line separator is escaped, because not every parser accepts it raw");
expectEqual(
  (JSON.parse(separators) as Record<string, unknown>)["name"],
  "line\u2028break",
  "and it still parses back to the same value",
);

expectEqual(
  serializeStructuredData({ "@type": "Thing", name: "a & b" }).includes("&"),
  false,
  "an ampersand is escaped too, so the block is safe inside HTML in any context",
);

// ---------------------------------------------------------------------------------------------
// 8. The crawler rules, recomputed from the tree
// ---------------------------------------------------------------------------------------------

const applicationFiles = await walk("app", (name) => name === "page.tsx" || name === "route.ts");
const robotsSource = await readRepositoryFile("app/robots.ts");
const sitemapSource = await readRepositoryFile("app/(public)/sitemap.ts");

expect(robotsSource.includes("robotsRoutes(getServerConfig().appUrl)"), "the robots handler serves the rules the model builds");
expect(!(await exists("app/(public)/robots.ts")), "and it lives at the app root, where the framework collects a robots file from");
expect(sitemapSource.includes("sitemapRoutes(getServerConfig().appUrl)"), "the sitemap handler serves the rows the model builds");
expect(robotsSource.includes('export const dynamic = "force-dynamic"'), "the robots handler renders per request, because the address comes from the environment");
expect(sitemapSource.includes('export const dynamic = "force-dynamic"'), "and so does the sitemap");
const derivedPrefixes = new Set<string>();

for (const file of applicationFiles) {
  if (file.startsWith("app/(public)/")) {
    continue;
  }

  const first = firstSegmentOf(file);

  if (first !== null) {
    derivedPrefixes.add(`/${first}`);
  }
}

const derived = [...derivedPrefixes].sort();
const declared = [...PRIVATE_URL_PREFIXES];

expectEqual(declared.length, new Set(declared).size, "no private prefix is declared twice");
expectEqual(
  [...declared].sort().join(" "),
  derived.join(" "),
  `the private prefix list equals the application's own first segments (declared ${String(declared.length)}, tree ${String(derived.length)})`,
);

for (const prefix of ["/api", "/admin", "/dashboard", "/i", "/e", "/p", "/signin"] as const) {
  expect(declared.includes(prefix), `"${prefix}" is closed to crawlers`);
}

for (const route of PUBLIC_ROUTES) {
  const shadowed = declared.find((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`));
  expect(shadowed === undefined, `the public page "${route.path}" is not inside a disallowed prefix (${shadowed ?? "none"})`);
}

const rules = robotsRoutes("https://example.test");
const rule = Array.isArray(rules.rules) ? rules.rules[0] : rules.rules;

expectEqual(rule?.userAgent, "*", "the crawler rules address every crawler");
expectEqual(rule?.allow, "/", "the public pages are open");
expectEqual(Array.isArray(rule?.disallow) ? (rule.disallow as readonly string[]).length : 0, declared.length, "every private prefix is closed");
expectEqual(rules.sitemap, "https://example.test/sitemap.xml", "and the rules name the sitemap");
expectEqual(SITEMAP_PATH, "/sitemap.xml", "the sitemap path is the one the rules point at");
expectEqual(ROBOTS_PATH, "/robots.txt", "and the rules live where crawlers look for them");

// ---------------------------------------------------------------------------------------------
// 9. The sitemap
// ---------------------------------------------------------------------------------------------

const sitemap = sitemapRoutes("https://example.test");
const sitemapUrls = sitemap.map((entry) => entry.url);

expectEqual(sitemapUrls.length, PUBLIC_ROUTES.length, "one sitemap row per published page");
expectEqual(new Set(sitemapUrls).size, sitemapUrls.length, "and every URL appears once");

for (const [index, entry] of sitemap.entries()) {
  const route = PUBLIC_ROUTES[index];

  if (route === undefined) {
    failures.push("the sitemap has a row the table does not");
    continue;
  }

  expectEqual(entry.url, `https://example.test${route.path}`, "the row's URL is the absolute page address");
  expectEqual(entry.changeFrequency, route.changeFrequency, "with the frequency the table declares");
  expectEqual(entry.priority, route.priority, "and its priority");
  expect(
    !entry.url.includes("?") && !entry.url.includes("#"),
    "a sitemap URL carries no query and no fragment",
  );
  expect(
    !("lastModified" in entry),
    "no row invents a last modified date: a date that is always now is a date a crawler ignores",
  );
  expect(
    declared.every((prefix) => !entry.url.endsWith(prefix)),
    "and never points at a private surface",
  );
}

expect(
  sitemapEntries().every((entry) => !("lastModified" in entry)),
  "and the rows the sitemap is built from carry no date either",
);

expectEqual(
  sitemapEntries().map((entry) => entry.path).join(","),
  PUBLIC_ROUTES.map((route: PublicRoute) => route.path).join(","),
  "the sitemap follows the table's order",
);

// ---------------------------------------------------------------------------------------------
// 10. The shell's source
// ---------------------------------------------------------------------------------------------

const layoutSource = await readRepositoryFile("app/(public)/layout.tsx");
const headerSource = await readRepositoryFile("components/public/public-header.tsx");
const footerSource = await readRepositoryFile("components/public/public-footer.tsx");
const structuredSource = await readRepositoryFile("components/public/structured-data.tsx");
const homeSource = await readRepositoryFile("app/(public)/page.tsx");

expect(layoutSource.includes("<PublicHeader"), "the public layout renders the site header");
expect(layoutSource.includes("<PublicFooter"), "and the footer");
expect(layoutSource.includes("<StructuredDataBlocks"), "and the structured data, so every page carries it");
expect(layoutSource.includes("CSP_NONCE_HEADER_NAME"), "the layout reads the content security policy nonce");
expect(layoutSource.includes('throw new Error("the Content Security Policy nonce is missing from the request")'), "and refuses a request without one");
expect(layoutSource.includes("buildSiteMetadata"), "the layout sets the metadata base and the title template");
expect(!layoutSource.includes("<main"), "the layout renders no main, because each page knows its own content shape");
expect(!layoutSource.includes("console."), "and it prints nothing");

expect(
  (homeSource.match(/<main/gu) ?? []).length === 1,
  "the home page renders exactly one main landmark",
);
expect(homeSource.includes("buildPublicMetadata"), "and its metadata through the shared builder");
expect(homeSource.includes("flex-1"), "and takes the height the shell leaves rather than a viewport of its own");

expect(headerSource.includes("<header"), "the site header is a header landmark");
expect(headerSource.includes("aria-label={getMessage(\"publicSite.navLabel\")}"), "with a labelled navigation");
expect(headerSource.includes("headerRoutes()"), "whose destinations come from the route table");
expect(headerSource.includes('href="/signin"'), "and a sign in action that exists");
expect(headerSource.includes('href="/signup"'), "and a create account action that exists");
expect(!headerSource.includes("ThemeToggle"), "the header does not repeat the theme control the root layout renders");
expect(!headerSource.includes("brand.name"), "and does not repeat the brand the root layout renders");

expect(footerSource.includes("<footer"), "the footer is a footer landmark");
expect(footerSource.includes("footerColumns()"), "with columns from the route table");
expect(footerSource.includes("publicSite.partnerNaming"), "and section 25's partner naming");
expect(footerSource.includes("publicSite.copyright"), "and the copyright line it formats with the year");

expect(structuredSource.includes("nonce={nonce}"), "a structured data block carries the nonce");
expect(
  !structuredSource.includes("dangerouslySetInnerHTML"),
  "and writes its payload as a text child, because a script element's content is not parsed as markup",
);
expect(structuredSource.includes("type=\"application/ld+json\""), "and declares its own script type");
expect(
  structuredSource.includes("{serializeStructuredData(block)}"),
  "and every block goes through the escaping serialiser at the point it is written",
);

for (const file of ["app/(public)/layout.tsx", "components/public/public-header.tsx", "components/public/public-footer.tsx", "components/public/structured-data.tsx"]) {
  expect(
    (await readRepositoryFile(file)).includes("// path: " + file),
    `${file} starts with its own path comment`,
  );
}

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`public site gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `public site gate passed: ${String(checkCount)} checks, the route table equal to the pages that exist, ` +
      "a canonical that is a path and never an address, structured data that cannot leave its script " +
      "element, and crawler rules recomputed from the application's own tree\n",
  );
}
