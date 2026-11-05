// path: app/api/settlements/statements/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { buildSettlementStatement } from "@/services/invoices/settlement-statement";

export const dynamic = "force-dynamic";

/**
 * Section 17's settlement statement, as the CSV file the merchant downloads.
 *
 * ## Why the read is a `GET` with no token and no body
 *
 * A statement changes nothing: the ledger it reads is append only, and the read is scoped to the
 * session's own merchant. A `GET` that parsed a body would be a read that a crafted body could turn
 * into a write, and the auth gate refuses it; a `GET` that demanded a token would demand one for
 * asking, and the token exists to prove a form is where it says it is. The session cookie is the
 * whole of the authorization, and it is the merchant's own.
 *
 * ## Why the file is answered, not a JSON body
 *
 * The screen's one job is to hand the merchant a file, and a file the browser saves is a file the
 * merchant opens in a spreadsheet. A JSON body would make the screen reassemble the document it just
 * asked for, and a document reassembled in a browser is a document a slow script can change. The
 * response is the file: `text/csv`, an attachment named with the period it covers, `no-store`
 * because the rows are one merchant's money.
 *
 * ## The order of the work
 *
 * The query is read, the session is read, and the service does the rest: the role, the period, the
 * account and the entries, each refusal its own sentence the screen words. The company never comes
 * from the query - there is no company on the query - because the statement is the session's
 * merchant's, and a crafted request cannot read into another merchant's book.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse> => {
    const parameters = new URL(request.url).searchParams;
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const statement = await buildSettlementStatement(
      {
        actor,
        from: parameters.get("from"),
        to: parameters.get("to"),
      },
      { rest: runtime.rest },
    );

    return new NextResponse(statement.csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${statement.filename}"`,
        "cache-control": "no-store",
      },
    });
  },
);
