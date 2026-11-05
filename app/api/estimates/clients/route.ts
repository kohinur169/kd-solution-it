// path: app/api/estimates/clients/route.ts
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
 * The clients the quote create form may offer, as JSON.
 *
 * ## Why this is the invoice's reader
 *
 * What a document form needs from the client book is one fact: which clients belong to this merchant, and
 * what the selector prints beside each name. That is not an invoice fact, it is a client-book fact, and
 * `listInvoiceClientOptions` is its one definition - the company comes from the session, the deleted rows
 * are excluded, only the four printed columns are selected, and the answer is capped with one extra row so
 * the screen knows the book continues. A second reader here would be a second cap and a second column list
 * to keep in step with the first.
 *
 * ## Why this is a read with no token
 *
 * It changes nothing and has no body to forge, so no CSRF token applies - the same reasoning the invoice's
 * selector gives. The session still comes from the cookie and never from the query string, and the company
 * comes from the session inside the service, so no request can name another merchant's book.
 *
 * ## Why the answer is never cached
 *
 * A client's name and email address are personal data. The answer is `no-store`, so no proxy between the
 * merchant and the server keeps a copy.
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
