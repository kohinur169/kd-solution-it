// path: app/api/onboarding/kyc-review/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { readKycReviewQueue, type KycReviewQueue } from "@/services/kyc/kyc-review";

export const dynamic = "force-dynamic";

/**
 * The compliance KYC review queue of section 5, over HTTP.
 *
 * ## Why this is a GET and takes no parameter
 *
 * A read has no body to protect, so no CSRF token applies; the account still comes from the cookie
 * and never from the request, and no company comes from the query string - the queue is every open
 * submission of every merchant, which is exactly what the office roles are for. The service
 * applies `KYC_REVIEW_OFFICE_ROLES` and refuses any other actor before a single query runs.
 *
 * ## The order of the checks
 *
 * Session first, then the service. The answer is `no-store`: a submission moves between two reads
 * and a cached queue would lie about what is waiting.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<KycReviewQueue>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const queue = await readKycReviewQueue(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(queue, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
