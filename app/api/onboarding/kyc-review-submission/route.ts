// path: app/api/onboarding/kyc-review-submission/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { readKycReviewDetail, type KycReviewDetail } from "@/services/kyc/kyc-review";

export const dynamic = "force-dynamic";

/**
 * One submission's full review detail - the document viewer - over HTTP.
 *
 * ## Why this is a GET and reads the id from the query string
 *
 * A read has no body to protect, so no CSRF token applies; the account comes from the cookie. The
 * `id` parameter names the submission - never a company: the service looks the row up by its id,
 * then scopes every later query to the company that row belongs to, so a foreign id is answered
 * with `RESOURCE_NOT_FOUND` rather than with another merchant's rows. The service validates the
 * parameter as a UUID before any query runs and applies `KYC_REVIEW_OFFICE_ROLES`; every office read
 * of one submission appends one `kyc_review.read_by_office` audit entry.
 *
 * ## The order of the checks
 *
 * Session first, then the service, which validates the parameter and applies the roles. The answer
 * is `no-store`.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<KycReviewDetail>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const submissionId = new URL(request.url).searchParams.get("id") ?? undefined;
    const detail = await readKycReviewDetail(
      { actor, submissionId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(detail, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
