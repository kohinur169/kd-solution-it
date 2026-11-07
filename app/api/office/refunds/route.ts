// path: app/api/office/refunds/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { REFUND_QUEUE_LIMIT } from "@/services/payments/refund-fields";
import { listRefundQueue, type RefundView } from "@/services/payments/refund";
import { getRefundRuntime } from "@/services/payments/refund-runtime";

export const dynamic = "force-dynamic";

interface QueueResponseBody {
  readonly refunds: readonly RefundView[];
}

/**
 * The platform's refund approval queue.
 *
 * Section 19's "approval": a refund a merchant raised waits for the finance desk, and this is the list the
 * desk works from - every merchant's open refunds, oldest first, because the one somebody has waited
 * longest for belongs at the top. The read is `finance_ops` and `super_admin` only; a merchant's own list
 * is `app/api/payments/refunds`, which is scoped to its own company.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<QueueResponseBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  const requested = new URL(request.url).searchParams.get("limit");
  const parsed = requested === null ? Number.NaN : Number.parseInt(requested, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), REFUND_QUEUE_LIMIT) : REFUND_QUEUE_LIMIT;
  const refunds = await listRefundQueue({ actor, limit }, getRefundRuntime());

  return NextResponse.json(
    { refunds } satisfies QueueResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
