// path: app/(public)/sitemap.ts
import type { MetadataRoute } from "next";
import { sitemapRoutes } from "@/components/public/seo";
import { getServerConfig } from "@/config/server";

/**
 * `GET /sitemap.xml`: one absolute URL per published public page.
 *
 * The rows come from the public route table, and the gate keeps that table equal to the pages that
 * exist, so this file cannot list a page nobody built and cannot omit one - which is the whole
 * value of generating it rather than writing it by hand.
 *
 * `force-dynamic` for the same reason the pages carry it: the address comes from the validated
 * environment, and a build machine must not have to know the production URL to compile. When the
 * caching STEP moves the shell's nonce out of the document, this handler can carry a `revalidate`
 * instead; until then a sitemap of a handful of rows is cheaper to render than to keep in a cache.
 */
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapRoutes(getServerConfig().appUrl);
}
