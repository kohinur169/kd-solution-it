// path: app/api/invoices/[id]/void/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { INVOICE_VOID_REASON_LIMITS, voidInvoice } from "@/services/invoices/invoice-status";

export const dynamic = "force-dynamic";

/** One optional short sentence; a reason of its own maximum length needs no ceiling beyond it. */
const maximumBodyBytes = 1_024;

interface VoidResponseBody {
  readonly status: "voided";
  readonly invoiceId: string;
  readonly at: string;
}

/**
 * Void an open invoice: a draft, or anything issued that is not yet paid, becomes void.
 *
 * The route is a boundary and nothing more: the CSRF token, a body ceiling, the actor from the session,
 * the shape of one field and one call into the service. The paid lock, the terminal check, the guard,
 * the re-read and the two entries are inside `voidInvoice`, so a second caller cannot get a weaker void
 * by calling anything else. The answer names the document and the instant and nothing else: the reason
 * is the merchant's words for the timeline, and it is not echoed back through the response.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<VoidResponseBody>> => {
    // STEP 057: the first thing a mutation checks, because it costs one string comparison.
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

    let reason: unknown;

    if (bodyText.trim().length > 0) {
      let body: unknown;

      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        throw new AppError("VALIDATION_FAILED", { details: [{ field: "reason", rule: "invalid_format" }] });
      }

      reason = typeof body === "object" && body !== null ? (body as { readonly reason?: unknown }).reason : undefined;
    }

    if (
      reason !== undefined &&
      reason !== null &&
      (typeof reason !== "string" ||
        reason.trim().length > INVOICE_VOID_REASON_LIMITS.max)
    ) {
      // The service parses the reason with its own bounds; the route refuses the obviously wrong shape
      // before it spends the read.
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "reason", rule: "invalid_format" }],
      });
    }

    const params = await context.params;
    const invoiceId = decodeURIComponent(params.id);

    const voided = await voidInvoice(
      { actor, invoiceId, reason },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice voided by the merchant", {
      invoiceId: voided.invoiceId,
      actorUserId: actor.userId,
    });

    return NextResponse.json(
      { status: "voided", invoiceId: voided.invoiceId, at: voided.at } satisfies VoidResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
