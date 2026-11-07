// path: app/api/payments/refunds/[id]/cancel/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { cancelRefund, type RefundView } from "@/services/payments/refund";
import { getRefundRuntime } from "@/services/payments/refund-runtime";

export const dynamic = "force-dynamic";

/** A cancel carries no field, so any body at all is a caller that has misread the endpoint. */
const maximumBodyBytes = 512;

/**
 * Withdraw a refund the merchant asked for.
 *
 * The merchant's own act, and only while it is still `requested`: an approved refund is money the platform
 * has promised and a decided one is history, so both answer `409` with `refund_not_pending`. Another
 * merchant's refund is `404` rather than `403`, the rule every tenant-scoped read in this platform keeps.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<RefundView>> => {
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

    const parameters = await context.params;
    let refundId: string;

    try {
      refundId = decodeURIComponent(parameters.id);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const cancelled = await cancelRefund({ actor, refundId }, getRefundRuntime());

    logger.info("refund cancelled by merchant", {
      refundId: cancelled.id,
      paymentId: cancelled.paymentId,
      companyId: cancelled.companyId,
      actorUserId: actor.userId,
    });

    return NextResponse.json(cancelled, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
