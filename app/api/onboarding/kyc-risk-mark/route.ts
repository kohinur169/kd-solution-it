// path: app/api/onboarding/kyc-risk-mark/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { markKycSubmissionRisk, type KycReviewDetail } from "@/services/kyc/kyc-review";

export const dynamic = "force-dynamic";

/** Three small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Mark one KYC submission high risk and/or four-eye required, from the review queue of STEP 089.
 *
 * Section 5: large or high-risk merchants need two reviewers, and `0048` then requires a decided
 * row to name a second reviewer who is not the first. The body is `{ "submission_id": "<uuid>",
 * "high_risk": true|false, "four_eye_required": true|false }`; high risk always forces four-eye.
 * The company is never in the body - the service resolves it from the row. A decided submission is
 * locked by `0048`'s guard and is refused with a conflict rather than written.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies the office roles and validates the id as a UUID before any query. The answer is
 * `no-store`.
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

    const detail = await markKycSubmissionRisk(
      { actor, submissionId: (body as { readonly submission_id?: unknown }).submission_id, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("kyc submission risk marked", {
      userId: actor.userId,
      submissionId: detail.submissionId,
      highRisk: detail.highRisk,
      fourEyeRequired: detail.fourEyeRequired,
    });

    return NextResponse.json(detail, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
