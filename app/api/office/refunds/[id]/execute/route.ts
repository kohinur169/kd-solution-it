// path: app/api/office/refunds/[id]/execute/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { REFUND_EXECUTION_MAXIMUM_BODY_BYTES } from "@/services/payments/refund-execution-fields";
import { executeRefund, type RefundExecutionView } from "@/services/payments/refund-execution";
import { getRefundExecutionRuntime } from "@/services/payments/refund-execution-runtime";

export const dynamic = "force-dynamic";

/**
 * Send one approved refund back through the provider that took the payment.
 *
 * ## Why this is a route and not the tail of an approval
 *
 * Approving a refund is a person saying the money should go back. Sending it is a second act with a different
 * failure mode: a provider can refuse, time out or accept and settle later, and each of those has to be visible
 * on its own rather than as a side effect of a signature. Keeping them apart also means an approval made while
 * the gateway is down stays approved instead of failing with it.
 *
 * ## The guards, in order
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes - an execution
 * authorises money to leave, so the browser signs what it sends - then the parse, then the service, which
 * applies the desk role, the `approved` status, the originating provider, the reference and the amount. The
 * body is only a courtesy: this route takes no field at all, and anything larger than a CSRF header is refused.
 *
 * ## What each answer means
 *
 * `200` with `outcome: "succeeded"` is money sent and the payment's refunded total written by the database;
 * `"pending"` is the provider working on it; `"unanswered"` is a call this platform will not call failed;
 * `"declined"` is the provider's own refusal, recorded on the refund. A refusal *before* the call is a `4xx` or
 * `503` with the rule, and it leaves the refund exactly as it was - `approved` means promised and not sent.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<RefundExecutionView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > REFUND_EXECUTION_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > REFUND_EXECUTION_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    requireTrustedDevice(
      await verifySensitiveRequest(
        { request, bodyText, actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    );

    const parameters = await context.params;
    let refundId: string;

    try {
      refundId = decodeURIComponent(parameters.id);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const execution = await executeRefund({ actor, refundId }, getRefundExecutionRuntime());

    logger.info("refund executed", {
      refundId: execution.refund.id,
      paymentId: execution.refund.paymentId,
      companyId: execution.refund.companyId,
      status: execution.refund.status,
      outcome: execution.outcome,
      provider: execution.providerKey,
      actorUserId: actor.userId,
    });

    return NextResponse.json(execution, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
