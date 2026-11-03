// path: app/api/onboarding/merchant-holds/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { readMerchantPaymentHolds, type PaymentHoldQueue } from "@/services/kyc/payment-hold";

export const dynamic = "force-dynamic";

/**
 * The merchant's own payment holds, over HTTP: the transactions the underwriting hold criterion has
 * caught for their company, newest first, with the decision and reason once the office has made it.
 *
 * ## Why this is a GET and takes no parameter
 *
 * A read has no body to protect, so no CSRF token applies; the account still comes from the cookie.
 * The company is never in the query string: the service takes it from the session, so a merchant can
 * only ever read their own holds. Section 20 lets a sub-merchant see their own holds; the hold
 * criterion itself stays with the office.
 *
 * ## The order of the checks
 *
 * Session first, then the service, which applies the `owner` role and the company scope. The answer
 * is `no-store`: a decision lands between two reads, and a cached list would lie about it.
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

    const holds = await readMerchantPaymentHolds(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(holds, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
