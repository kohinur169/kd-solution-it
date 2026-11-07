// path: app/robots.ts
import type { MetadataRoute } from "next";
import { robotsRoutes } from "@/components/public/seo";
import { getServerConfig } from "@/config/server";

/**
 * `GET /robots.txt`: the public pages are open, every other surface is closed, and the sitemap is
 * named.
 *
 * This one file lives at the root of `app/` rather than inside the public group, and that is the
 * framework's rule rather than a preference: Next collects a sitemap from any route segment but a
 * `robots` file only from the root of the app directory, so a `robots.ts` inside `app/(public)/`
 * is a file that compiles into nothing. The group owns the rules it returns - the private prefix
 * list, the sitemap's address and the rules they produce all live in `components/public/seo.ts` -
 * and this handler is the two lines that serve them.
 *
 * The rules are built by `components/public/seo.ts`, which holds the one list of private prefixes
 * and is kept equal to the application's own route tree by the gate. That is deliberate: a crawler
 * file is read by machines and written by hand, which is the combination that rots. The tokenised
 * client portal prefixes (`/i`, `/e`, `/p`) are in that list because one indexed token URL is a
 * client's payment page in a search result.
 *
 * `force-dynamic` because the sitemap line must be the environment's real address.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return robotsRoutes(getServerConfig().appUrl);
}
