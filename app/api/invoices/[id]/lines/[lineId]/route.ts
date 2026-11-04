// path: app/api/invoices/[id]/lines/[lineId]/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { parseInvoiceLine } from "@/services/invoices/invoices";
import {
  removeInvoiceLine,
  updateInvoiceLine,
  type InvoiceLine,
} from "@/services/invoices/invoice-lines";

export const dynamic = "force-dynamic";

/** Seven short fields for one line; 16 KiB holds the longest legal line twice over. */
const maximumBodyBytes = 16_384;

interface LineBody {
  readonly status: "updated";
  readonly line: InvoiceLine;
}

interface RemovalBody {
  readonly status: "deleted";
  readonly removedLineId: string;
  readonly lines: readonly InvoiceLine[];
}

/** Both ids from the path, decoded. The body names neither. */
async function idsOf(
  context: { readonly params: Promise<{ readonly id: string; readonly lineId: string }> },
): Promise<{ readonly invoiceId: string; readonly lineId: string }> {
  const params = await context.params;

  return {
    invoiceId: decodeURIComponent(params.id),
    lineId: decodeURIComponent(params.lineId),
  };
}

/**
 * One line of a draft: `POST` replaces it, `DELETE` removes it.
 *
 * ## Why the path carries both ids
 *
 * A line id alone would let a request edit a line of an invoice it never named; the service refuses that
 * case with a 404, but naming both makes the refusal the shape of the URL rather than a rule a reader has
 * to trust. It also makes each request's target completely described by its address.
 *
 * ## Why the body replaces the whole line
 *
 * A line is seven values that only mean something together, and the editor holds all seven. A partial body
 * would need a merge, a merge would need to know which fields are absent versus cleared, and the create
 * path has no such rule - so a partial edit is not something this endpoint offers. `position` is absent
 * for the same reason: `POST /move` owns it.
 *
 * ## Why the removal answers with the surviving lines
 *
 * Removing a line closes the gap it leaves, so the positions after it change. Returning the whole list is
 * how the editor learns the new order without a second read that could race the first.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string; readonly lineId: string }> },
  ): Promise<NextResponse<LineBody>> => {
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
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "line", rule: "invalid_format" }] });
    }

    const ids = await idsOf(context);
    const line = await updateInvoiceLine(
      { actor, invoiceId: ids.invoiceId, lineId: ids.lineId, line: parseInvoiceLine(body) },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice line updated", {
      userId: actor.userId,
      invoiceId: ids.invoiceId,
      lineId: line.id,
      position: line.position,
    });

    return NextResponse.json(
      { status: "updated", line },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);

/**
 * Remove one line of a draft.
 *
 * No body, so the token travels in the header - which is exactly what `csrfHeaders()` puts there. The
 * path is on the protected list because this file exports a `POST`; the guard applies to the path, not to
 * one method, so the `DELETE` is covered by the same entry.
 */
export const DELETE = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string; readonly lineId: string }> },
  ): Promise<NextResponse<RemovalBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const ids = await idsOf(context);
    const result = await removeInvoiceLine(
      { actor, invoiceId: ids.invoiceId, lineId: ids.lineId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice line removed", {
      userId: actor.userId,
      invoiceId: ids.invoiceId,
      lineId: result.removedLineId,
    });

    return NextResponse.json(
      { status: "deleted", removedLineId: result.removedLineId, lines: result.lines },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
