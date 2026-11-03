// path: app/api/clients/list/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  listClients,
  parseClientListQuery,
  type ClientListQueryParameters,
} from "@/services/clients/client-list";

export const dynamic = "force-dynamic";

/** The parameters this route reads from the query string. Everything else is ignored. */
const CLIENT_LIST_PARAMETERS = ["search", "offset"] as const;

/**
 * Section 15's paginated client list, over HTTP.
 *
 * ## Why a GET with no token
 *
 * A page of a list is a read: it has no body to forge and it changes nothing, so no CSRF token
 * applies. The session still comes from the cookie and never from the query string, and the company
 * still comes from the session inside the service, so no request can name another merchant's book.
 *
 * ## What the route decides, and what it refuses to decide
 *
 * It reads two parameters and hands them to `parseClientListQuery`, which sanitises the term,
 * enforces its alphabet and lands the offset on the page grid. Anything else in the address bar is
 * ignored rather than refused, so a link carrying a parameter this build no longer reads still
 * opens. A refused value is not an error: the page widens to the whole book and reports what it
 * dropped, which is the honest answer to a mistyped search.
 *
 * ## Why the answer is never cached
 *
 * A client's name, company and email address are personal data, and the list changes between two
 * reads. The answer is `no-store`, so no proxy between the merchant and the server keeps a copy.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<Awaited<ReturnType<typeof listClients>>>> => {
    const parameters = new URL(request.url).searchParams;
    const sources: Record<string, string> = {};

    for (const name of CLIENT_LIST_PARAMETERS) {
      const value = parameters.get(name);

      if (value !== null) {
        sources[name] = value;
      }
    }

    const query = parseClientListQuery(sources as ClientListQueryParameters);
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const page = await listClients({ actor, query }, { rest: runtime.rest });

    return NextResponse.json(page, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
