// path: app/(public)/layout.tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { PublicFooter } from "@/components/public/public-footer";
import { PublicHeader } from "@/components/public/public-header";
import { buildSiteMetadata, organizationStructuredData, websiteStructuredData } from "@/components/public/seo";
import { StructuredDataBlocks } from "@/components/public/structured-data";
import { getServerConfig } from "@/config/server";
import { getMessage } from "@/lib/i18n/messages";
import { CSP_NONCE_HEADER_NAME, isCspNonce } from "@/lib/security/csp";

/**
 * The public site's shell: the metadata base every page resolves against, the site header, the
 * content, the footer, and the two structured data blocks that say who publishes it.
 *
 * ## What the shell owns, and what it leaves alone
 *
 * The root layout owns the document, the theme, the skip link and the brand bar; this layout adds
 * the site's own header (destinations and account actions), its footer, and the address that every
 * relative URL in a page's metadata resolves against. It renders no main landmark: each page does,
 * because a page knows whether it has one article or three sections - and the office shell makes
 * the same split for the same reason.
 *
 * ## `metadataBase` is set here, once
 *
 * A canonical path is written relative (`/pricing`), and Next resolves it against `metadataBase`.
 * Reading it from `getServerConfig()` means the address is the one the validated environment
 * declares, not the `Host` header a request happened to carry - so a request sent to a proxy's
 * internal name, or to an attacker's host, cannot change the canonical a page publishes. It is
 * built in `generateMetadata` rather than in a module level constant, because the configuration
 * reads the environment lazily and a build machine must not need the runtime secrets.
 *
 * ## The title template
 *
 * `<title>` is `<the page's title> · KD Solution IT`, applied by this layout to every page below
 * it. The home page opts out of the template (it already names the site) through
 * `buildPublicMetadata`'s `absoluteTitle`, so the site's name never appears twice in one title.
 *
 * ## Why there is no `dynamic` export
 *
 * The root layout is already rendered per request - it needs a nonce for the pre-paint theme
 * script - so every route in this group inherits that and a `dynamic` declaration here would say
 * nothing new. The consequence is named in the STEP 231 handoff: public pages are not statically
 * cached yet, and the caching STEP is the one that has to move the theme script's nonce.
 *
 * ## The structured data needs the nonce
 *
 * A `script-src` policy applies to a JSON-LD block as much as to an executing script, so the nonce
 * is read here and passed down. The read is a no-op in practice: the root layout has already
 * refused the request if the proxy did not set one, and this layout keeps the same check rather
 * than assume the order of two files that do not import each other.
 */

const shellClasses = "flex flex-1 flex-col bg-background text-foreground";

export async function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata(getServerConfig().appUrl, getMessage("brand.name"));
}

export default async function PublicLayout({
  children,
}: Readonly<{ children: ReactNode }>): Promise<ReactNode> {
  const nonce = (await headers()).get(CSP_NONCE_HEADER_NAME);

  if (nonce === null || !isCspNonce(nonce)) {
    throw new Error("the Content Security Policy nonce is missing from the request");
  }

  const baseUrl = getServerConfig().appUrl;

  return (
    <div className={shellClasses}>
      <StructuredDataBlocks
        blocks={[organizationStructuredData(baseUrl), websiteStructuredData(baseUrl)]}
        nonce={nonce}
      />
      <PublicHeader />
      {children}
      <PublicFooter />
    </div>
  );
}
