// path: app/api/payments/refunds/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { REFUND_LIST_LIMIT, REFUND_REQUEST_MAXIMUM_BODY_BYTES } from "@/services/payments/refund-fields";
import { listRefunds, requestRefund, type RefundView } from "@/services/payments/refund";
import { getRefundRuntime } from "@/services/payments/refund-runtime";

export const dynamic = "force-dynamic";

interface ListedResponseBody {
  readonly refunds: readonly RefundView[];
}

/** Read the body once, with the ceiling checked before and after it is held. */
async function readBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > REFUND_REQUEST_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > REFUND_REQUEST_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  if (text.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "payment_id", rule: "invalid_format" }] });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "payment_id", rule: "invalid_format" }] });
  }
}

/**
 * The merchant's refund desk: ask for one, and read what has been asked for.
 *
 * A request answers `201`, because it creates a row; the list answers `200`. Everything that decides
 * whether the request is allowed - the `owner` role, the merchant's own payment, the state the money must
 * be in, the amount against what is left, the reason's bounds - lives in `requestRefund`, so a second
 * caller cannot get a weaker refund by reaching the table another way. The route is the boundary: CSRF,
 * the ceiling, the session, the parse.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<RefundView>> => {
  requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

  const body = await readBody(request);
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  const refund = await requestRefund({ actor, body }, getRefundRuntime());

  logger.info("refund requested", {
    refundId: refund.id,
    paymentId: refund.paymentId,
    companyId: refund.companyId,
    amountMinor: refund.amountMinor,
    actorUserId: actor.userId,
  });

  return NextResponse.json(refund, { status: 201, headers: { "cache-control": "no-store" } });
});

/** The merchant's own refunds, newest first, with the status each one reached. */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<ListedResponseBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  const requested = new URL(request.url).searchParams.get("limit");
  const parsed = requested === null ? Number.NaN : Number.parseInt(requested, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), REFUND_LIST_LIMIT) : REFUND_LIST_LIMIT;
  const refunds = await listRefunds({ actor, limit }, getRefundRuntime());

  return NextResponse.json(
    { refunds } satisfies ListedResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
