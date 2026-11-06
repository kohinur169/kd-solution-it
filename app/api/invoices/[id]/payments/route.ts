// path: app/api/invoices/[id]/payments/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { priceFromMinor } from "@/services/products/price";
import { recordInvoicePayment } from "@/services/invoices/invoice-status";

export const dynamic = "force-dynamic";

/** One amount in its typed form needs little room; the ceiling exists so a body is a field, not a file. */
const maximumBodyBytes = 256;

interface PaymentResponseBody {
  readonly status: "partially_paid" | "paid";
  readonly invoiceId: string;
  readonly number: string | null;
  readonly paid: string;
  readonly remaining: string;
  readonly at: string;
}

/**
 * Record a payment on an issued invoice: the money and the state move together.
 *
 * The route is a boundary and nothing more: the CSRF token, a body ceiling, the actor from the
 * session, the shape of one field and one call into the service. The minimum, the remaining ceiling,
 * the guard, the re-read and the two entries are inside `recordInvoicePayment`, so a second caller
 * cannot get a weaker recording by calling anything else. The answer names the money the document
 * now holds, in the one form the platform prints, and nothing else.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<PaymentResponseBody>> => {
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

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "invalid_format" }] });
    }

    const amount = typeof body === "object" && body !== null ? (body as { readonly amount?: unknown }).amount : undefined;

    // A payment without an amount is a payment that pays nothing; the service refuses it, and the
    // route says so with the same field the screen marks.
    if (typeof amount !== "string") {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "invalid_format" }] });
    }

    const params = await context.params;
    const invoiceId = decodeURIComponent(params.id);

    const recorded = await recordInvoicePayment(
      { actor, invoiceId, amount },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("payment recorded on the invoice by the merchant", {
      invoiceId: recorded.invoiceId,
      actorUserId: actor.userId,
    });

    return NextResponse.json(
      {
        status: recorded.to,
        invoiceId: recorded.invoiceId,
        number: recorded.number,
        paid: priceFromMinor(recorded.paidMinor),
        remaining: priceFromMinor(recorded.remainingMinor),
        at: recorded.at,
      } satisfies PaymentResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
