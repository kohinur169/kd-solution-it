// path: app/api/office/refunds/[id]/decision/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { REFUND_DECISION_MAXIMUM_BODY_BYTES } from "@/services/payments/refund-fields";
import { decideRefund, type RefundView } from "@/services/payments/refund";
import { getRefundRuntime } from "@/services/payments/refund-runtime";

export const dynamic = "force-dynamic";

/** The decision, and an optional note. One word and a sentence. */
async function readBodyText(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > REFUND_DECISION_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > REFUND_DECISION_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  if (text.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "decision", rule: "invalid_format" }] });
  }

  return text;
}

/**
 * The finance desk's decision: approve a refund, or reject it.
 *
 * The route is a boundary: CSRF, the ceiling, the session, the device proof over the exact bytes, the
 * parse, one call. The `finance_ops` or
 * `super_admin` role, the four-eyes rule (`refund_self_decision`), the pending check and the re-check of
 * the payment's headroom are all inside `decideRefund`, so a second caller cannot approve more than the
 * payment holds by reaching the table its own way.
 *
 * An approval answers `200` with the refund now `approved`; a rejection answers `200` with it `cancelled`,
 * which is where `0038` records a refund that was decided against, and the chain entry says which of the
 * two happened.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<RefundView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const bodyText = await readBodyText(request);
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // A decision authorises money, so the browser signs these exact bytes: an altered body, a replayed
    // nonce or a device that was never enrolled stops here rather than at the service's own checks.
    requireTrustedDevice(
      await verifySensitiveRequest(
        { request, bodyText, actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "decision", rule: "invalid_format" }] });
    }

    const parameters = await context.params;
    let refundId: string;

    try {
      refundId = decodeURIComponent(parameters.id);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const decided = await decideRefund({ actor, refundId, body }, getRefundRuntime());

    logger.info("refund decided", {
      refundId: decided.id,
      paymentId: decided.paymentId,
      companyId: decided.companyId,
      status: decided.status,
      actorUserId: actor.userId,
    });

    return NextResponse.json(decided, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
