// path: app/api/onboarding/merchant-limit-set/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { updateMerchantLimit, type MerchantLimitSnapshot } from "@/services/kyc/merchant-limit";

export const dynamic = "force-dynamic";

/** Two small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Set one merchant's monthly transaction limit after review, from the underwriting side of STEP 091.
 * The body is `{ "company_id": "<uuid>", "monthly_limit": "5000.00" }`.
 *
 * The merchant's own limit is born from the `0106` criteria the first time they read it; this route is
 * the office's raise or lower after review, allowed to `compliance_kyc` and `super_admin` only. The
 * service resolves the row by the company in the body (never by session - the office acts across
 * companies), validates the limit against the same ceiling the criteria carry, and writes one
 * conditional update with a race check, audited under `merchant_limit.updated`.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service. The answer
 * is the fresh limit snapshot, `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<MerchantLimitSnapshot>> => {
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

    const limit = await updateMerchantLimit(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("merchant transaction limit updated", {
      userId: actor.userId,
      companyId: limit.companyId,
      monthlyLimit: limit.monthlyLimit,
    });

    return NextResponse.json(limit, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
