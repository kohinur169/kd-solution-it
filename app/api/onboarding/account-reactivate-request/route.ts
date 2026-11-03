// path: app/api/onboarding/account-reactivate-request/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { requestReactivation, type ReactivationRequestResult } from "@/services/kyc/account-lifecycle";

export const dynamic = "force-dynamic";

/** No fields at all. 1 KiB is generous for that and still bounded */
const maximumBodyBytes = 1_024;

/**
 * The merchant's request to come back after a suspension, from the account screen of STEP 099. The body is empty: the company comes from the session and the request names the merchant's newest submission in the review pipeline, which the service requires to exist - the required documents are uploaded and submitted through the normal KYC flow first.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies its roles and its state machine. The answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ReactivationRequestResult>> => {
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

    try {
      JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "body", rule: "invalid_format" }],
      });
    }

    const result = await requestReactivation(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("merchant reactivation requested", {
      userId: actor.userId,
      companyId: result.companyId,
      kycSubmissionId: result.kycSubmissionId,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
