// path: app/api/onboarding/kyc-review-open/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { openKycReview, type KycReviewDetail } from "@/services/kyc/kyc-review";

export const dynamic = "force-dynamic";

/** One field, a UUID. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Open a submitted KYC submission for review, from the compliance queue of STEP 088.
 *
 * The body is `{ "submission_id": "<uuid>" }`; the company is never in the body - the service looks
 * the submission up by its id and scopes every later query to the company that row belongs to. The
 * service applies `KYC_REVIEW_OFFICE_ROLES`, moves `submitted` to `in_review` with the reviewer
 * named through one conditional update, audits the open, and answers the full detail so the
 * reviewer's screen can redraw from one call.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service. The
 * answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<KycReviewDetail>> => {
    // STEP 057: a form post from another origin cannot read the token this compares.
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "body", rule: "invalid_format" }],
      });
    }

    const detail = await openKycReview(
      { actor, submissionId: (body as { readonly submission_id?: unknown }).submission_id },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("kyc review opened", {
      userId: actor.userId,
      submissionId: detail.submissionId,
      status: detail.status,
    });

    return NextResponse.json(detail, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
