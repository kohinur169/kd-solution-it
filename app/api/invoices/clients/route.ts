// path: app/api/invoices/clients/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  listInvoiceClientOptions,
  type InvoiceClientOptions,
} from "@/services/invoices/invoices";

export const dynamic = "force-dynamic";

/**
 * The clients the invoice create form may offer, as JSON.
 *
 * ## Why this is a read with no token
 *
 * It changes nothing and has no body to forge, so no CSRF token applies - the same reasoning the client
 * list's route gives. The session still comes from the cookie and never from the query string, and the
 * company comes from the session inside the service, so no request can name another merchant's book.
 *
 * ## Why the selector is a route rather than a server render
 *
 * The create form adds lines and changes the client as the merchant types, and a full page render per
 * keystroke would be a round trip of the whole document. The selector reads this once when it opens,
 * which is also why the answer is capped: it is a picker, not a search.
 *
 * ## Why the answer is never cached
 *
 * A client's name and email address are personal data. The answer is `no-store`, so no proxy between
 * the merchant and the server keeps a copy.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<InvoiceClientOptions>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const options = await listInvoiceClientOptions({ actor }, { rest: runtime.rest });

    return NextResponse.json(options, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
