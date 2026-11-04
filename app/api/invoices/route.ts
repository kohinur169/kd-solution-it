// path: app/api/invoices/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { createInvoice, type InvoiceSnapshot } from "@/services/invoices/invoices";

export const dynamic = "force-dynamic";

/**
 * The body ceiling.
 *
 * An invoice is a client id, three money fields and up to `INVOICE_MAXIMUM_LINES` lines of seven short
 * strings, so 256 KiB holds the longest legal body with room to spare and still bounds what one request
 * can make the server read.
 */
const maximumBodyBytes = 262_144;

interface CreateInvoiceBody {
  readonly status: "created";
  readonly invoice: InvoiceSnapshot;
}

/**
 * Section 16's invoice create, over HTTP.
 *
 * ## The order of the checks
 *
 * CSRF first - a form post from another origin cannot read the token this compares - then the declared
 * length, then the session, then the JSON parse, then the service, which applies the `owner` role, reads
 * the company from the session (never from the body, so a crafted request cannot write into another
 * merchant's book) and validates every field with the Zod schema before anything is written. The order
 * is the one every mutating route in this codebase uses, and the gate asserts it.
 *
 * ## Why the body is parsed here and validated in the service
 *
 * This route decides only that the body is JSON at all: a body that is not is a malformed request, and
 * the field it names is the document's own. What a valid invoice *is* - the ceilings, the unit list, the
 * money rules, the client's ownership - belongs to the service, because the same rules run when another
 * caller invokes it, and a route that validated would be a second, weaker definition.
 *
 * ## Why the answer is `no-store`
 *
 * An invoice carries a client's name, address and the amounts they owe. No cache between the merchant
 * and the server may keep a copy of that.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<CreateInvoiceBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > maximumBodyBytes) {
      // A chunked body declares no length, so the bound is enforced a second time on what arrived.
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "invoice", rule: "invalid_format" }],
      });
    }

    const invoice = await createInvoice(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice created", {
      userId: actor.userId,
      companyId: invoice.companyId,
      invoiceId: invoice.id,
      lineCount: invoice.lines.length,
    });

    return NextResponse.json(
      { status: "created", invoice },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
