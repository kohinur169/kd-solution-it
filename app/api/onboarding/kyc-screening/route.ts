// path: app/api/onboarding/kyc-screening/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { runKycScreening, type KycPackSnapshot } from "@/services/kyc/kyc-capture";

export const dynamic = "force-dynamic";

/** No fields at all. 1 KiB is generous for that and still bounded. */
const maximumBodyBytes = 1_024;

/**
 * The manual sanctions and PEP screening of section 3, executed over HTTP by the merchant.
 *
 * The body is empty: the subjects are the company and the UBOs already captured on its draft
 * submission, and the company never comes from the request - the service takes it from the
 * session. The service records one `sanctions_screenings` row per subject and audits the run; the
 * answer is the whole pack, which carries only how many subjects were screened, never a result,
 * because section 5 lets the merchant see the verification status and nothing else.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies the `owner` role and the company scope. The answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<KycPackSnapshot>> => {
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
        details: [{ field: "screening", rule: "invalid_format" }],
      });
    }

    const snapshot = await runKycScreening(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("kyc screening run", {
      userId: actor.userId,
      companyId: snapshot.companyId,
      screened: snapshot.screenedCount,
    });

    return NextResponse.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
