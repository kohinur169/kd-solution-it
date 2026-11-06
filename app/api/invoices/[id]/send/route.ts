// path: app/api/invoices/[id]/send/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { sendInvoice } from "@/services/invoices/invoice-status";

export const dynamic = "force-dynamic";

interface SendResponseBody {
  readonly status: "sent";
  readonly invoiceId: string;
  readonly number: string;
  readonly issuedAt: string;
}

/**
 * Send a draft invoice: the draft becomes a numbered, issued document.
 *
 * The route is a boundary and nothing more: the CSRF token, the actor from the session and one call
 * into the service. The number, the issue instant, the guard, the re-read and the two entries are
 * inside `sendInvoice`, so a second caller cannot get a weaker issue by calling anything else. There is
 * no body: a document is either the draft the merchant edited or it is not, and no field of the request
 * can change that.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<SendResponseBody>> => {
    // STEP 057: the first thing a mutation checks, because it costs one string comparison.
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    // A send carries no body; a client that sends one is a client that means to change something it has
    // no field to change. Refuse the weight rather than ignore it.
    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const params = await context.params;
    const invoiceId = decodeURIComponent(params.id);

    const sent = await sendInvoice(
      { actor, invoiceId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice sent by the merchant", {
      invoiceId: sent.invoiceId,
      actorUserId: actor.userId,
    });

    return NextResponse.json(
      {
        status: "sent",
        invoiceId: sent.invoiceId,
        number: sent.number ?? "",
        issuedAt: sent.at,
      } satisfies SendResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
