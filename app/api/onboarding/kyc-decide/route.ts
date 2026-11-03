// path: app/api/onboarding/kyc-decide/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { decideKycSubmission, type KycReviewDetail } from "@/services/kyc/kyc-review";

export const dynamic = "force-dynamic";

/** Three small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Approve or reject one KYC submission - the decision flow of section 5, STEP 093.
 *
 * The body is `{ "submission_id": "<uuid>", "decision": "approve"|"reject", "reason": "..." }`; the
 * reason is required on a rejection, the same trimmed 1..280 rule `0048` sets, because the merchant
 * reads it on their status screen. The company is never in the body: the service looks the submission
 * up by its id and scopes the write to the company that row belongs to.
 *
 * Approval is the final approval of ceo and super_admin (section 2 and section 5: final approval by
 * CEO or super_admin); rejection is the review work of the office roles. A submission still
 * `submitted` conflicts with `not_in_review` until it is opened; a decided one conflicts with
 * `already_decided`, because `0048` locks it. A four-eye submission is decided by a second reviewer
 * who is not the first (`same_reviewer` otherwise). The write is one conditional update by id +
 * company + `status=eq.in_review` + current version with a re-read race check, audited
 * `kyc_review.decided` - every KYC decision is audit logged.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service. The answer
 * is the full detail, `no-store`.
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

    const detail = await decideKycSubmission(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("kyc submission decided", {
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
