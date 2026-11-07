// path: app/api/payments/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { REFUND_PAYMENT_LIST_LIMIT } from "@/services/payments/refund-fields";
import {
  listRefundablePayments,
  type RefundablePaymentView,
} from "@/services/payments/refund";
import { getRefundRuntime } from "@/services/payments/refund-runtime";

export const dynamic = "force-dynamic";

interface ListedResponseBody {
  readonly payments: readonly RefundablePaymentView[];
}

/**
 * The merchant's payments that can still take a refund, with the headroom on each.
 *
 * Section 19's interface needs a list a person can point at: a merchant cannot type the id of a payment it
 * has never seen. The read is bounded, tenant-scoped and filtered to the states a refund starts from, and
 * the two numbers beside each row are computed by the same function the request uses - so the amount the
 * screen offers and the amount the service will accept are one calculation rather than two that agree
 * today.
 *
 * The route answers a merchant's `owner` only, because every route into a refund does.
 */
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
  const limit = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), REFUND_PAYMENT_LIST_LIMIT)
    : REFUND_PAYMENT_LIST_LIMIT;
  const payments = await listRefundablePayments({ actor, limit }, getRefundRuntime());

  return NextResponse.json(
    { payments } satisfies ListedResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
