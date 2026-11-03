// path: app/api/onboarding/payment-holds/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { readPaymentHoldQueue, type PaymentHoldQueue } from "@/services/kyc/payment-hold";

export const dynamic = "force-dynamic";

/**
 * The payment hold review queue of section 5, over HTTP: every transaction the `0106` hold criterion
 * has caught, oldest first, across all merchants.
 *
 * ## Why this is a GET and takes no parameter
 *
 * A read has no body to protect, so no CSRF token applies; the account still comes from the cookie
 * and never from the request, and no company comes from the query string - the queue is every held
 * transaction of every merchant, which is exactly what the office roles are for. The service applies
 * `UNDERWRITING_READ_ROLES` and refuses any other actor before a single query runs.
 *
 * ## The order of the checks
 *
 * Session first, then the service. The answer is `no-store`: a hold is decided between two reads, and
 * a cached queue would lie about what is waiting.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<PaymentHoldQueue>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const queue = await readPaymentHoldQueue(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(queue, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
