// path: app/api/products/list/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import type { CatalogueKind } from "@/services/products/catalogue-fields";
import {
  listCatalogueEntries,
  parseCatalogueListQuery,
  type CatalogueListPage,
  type CatalogueListQueryParameters,
} from "@/services/products/catalogue-list";

export const dynamic = "force-dynamic";

/** The parameters this route reads from the query string. Everything else is ignored. */
const CATALOGUE_LIST_PARAMETERS = ["search", "offset"] as const;

/**
 * Section 15's paginated catalogue list, over HTTP, built once for both catalogues.
 *
 * ## Why a GET with no token
 *
 * A page of a list is a read: it has no body to forge and it changes nothing, so no CSRF token
 * applies and this path is deliberately absent from `CSRF_PROTECTED_PATHS`. The session still comes
 * from the cookie and never from the query string, and the company still comes from the session
 * inside the service, so no request can name another merchant's catalogue.
 *
 * ## What the route decides, and what it refuses to decide
 *
 * It reads two parameters and hands them to `parseCatalogueListQuery`, which sanitises the term,
 * enforces its alphabet and lands the offset on the page grid. Anything else in the address bar is
 * ignored rather than refused, so a link carrying a parameter this build no longer reads still opens.
 * A refused value is not an error: the page widens to the whole catalogue and reports what it
 * dropped, which is the honest answer to a mistyped search.
 *
 * ## Why the answer is never cached
 *
 * A catalogue is a merchant's price list, and the list changes between two reads. The answer is
 * `no-store`, so no proxy between the merchant and the server keeps a copy.
 *
 * Exported as a factory for the same reason the write routes are: the second catalogue is this
 * request with a different table name.
 */
export function createCatalogueListRoute(kind: CatalogueKind) {
  return withErrorResponse(
    async (request: Request): Promise<NextResponse<CatalogueListPage>> => {
      const parameters = new URL(request.url).searchParams;
      const sources: Record<string, string> = {};

      for (const name of CATALOGUE_LIST_PARAMETERS) {
        const value = parameters.get(name);

        if (value !== null) {
          sources[name] = value;
        }
      }

      const query = parseCatalogueListQuery(sources as CatalogueListQueryParameters);
      const runtime = getAuthRuntime();
      const actor = await readRequestActor(request.headers.get("cookie"), {
        directory: runtime.directory,
        cookiePolicy: runtime.cookiePolicy,
        sessions: runtime.sessions,
        audit: runtime.audit,
      });

      const page = await listCatalogueEntries({ actor, kind, query }, { rest: runtime.rest });

      return NextResponse.json(page, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    },
  );
}

export const GET = createCatalogueListRoute("product");
