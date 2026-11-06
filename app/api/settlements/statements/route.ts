// path: app/api/settlements/statements/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { buildSettlementStatementPdf } from "@/services/invoices/settlement-statement-pdf";
import { buildSettlementStatement } from "@/services/invoices/settlement-statement";

export const dynamic = "force-dynamic";

/**
 * Section 17's settlement statement, as the file the merchant downloads: CSV by default, PDF when
 * the caller asks for it with `format=pdf`.
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
 * merchant opens - in a spreadsheet, or in a viewer. A JSON body would make the screen reassemble
 * the document it just asked for, and a document reassembled in a browser is a document a slow script
 * can change. The response is the file: `text/csv` or `application/pdf`, an attachment named with
 * the period it covers, `no-store` because the rows are one merchant's money.
 *
 * ## The one endpoint, the two forms
 *
 * The same statement, the same rules, the same auth - only the renderer differs. The `format`
 * parameter picks the file the merchant asked for, and nothing else: the period, the role, the
 * account and the entries are judged the same way whichever file comes back, because they are the
 * same statement. A caller that asked for a form the statement has no renderer for gets the CSV,
 * the statement's default, not a refusal - the forms are additions to the statement, not a
 * vocabulary the caller has to name exactly.
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

    const period = {
      from: parameters.get("from"),
      to: parameters.get("to"),
    };

    if (parameters.get("format") === "pdf") {
      const statement = await buildSettlementStatementPdf({ actor, ...period }, { rest: runtime.rest });

      // A response body must be backed by its own `ArrayBuffer`: the bytes the writer assembled are
      // handed to the platform as a copy, so no later read of a pooled allocation can reach into a
      // statement on its way to a merchant.
      return new NextResponse(statement.pdf.slice(), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${statement.filename}"`,
          "cache-control": "no-store",
        },
      });
    }

    const statement = await buildSettlementStatement({ actor, ...period }, { rest: runtime.rest });

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
