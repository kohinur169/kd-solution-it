// path: app/api/onboarding/kyc-ubo/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { saveUbo, type KycPackSnapshot } from "@/services/kyc/kyc-capture";

export const dynamic = "force-dynamic";

/** Six short fields. 4 KiB is generous for that and still bounded. */
const maximumBodyBytes = 4_096;

/**
 * One beneficial owner of section 3's UBO policy, over HTTP.
 *
 * The body is the owner's name, date of birth, country, share in basis points and the hash of their
 * identity document - never the document number itself, which section 4 lists only as a hash. The
 * company never appears in the body: the service takes it from the session. The significant flag is
 * derived from the share (2500 basis points is 25 percent) and never taken from the body, and the
 * submission's total may not exceed 10000 basis points, which the service checks before the
 * `0050` guard has to.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies the `owner` role and the company scope beside the write they guard. A refusal names every
 * field that failed and the rule it broke; the answer is the whole pack, `no-store`.
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

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "ubo", rule: "invalid_format" }],
      });
    }

    const snapshot = await saveUbo(
      { actor, input: body as Parameters<typeof saveUbo>[0]["input"] },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("ubo captured", {
      userId: actor.userId,
      companyId: snapshot.companyId,
      ubos: snapshot.ubos.length,
    });

    return NextResponse.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
