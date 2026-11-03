// path: app/api/onboarding/underwriting-mcc-tier/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  setMccRiskTier,
  type UnderwritingMccOverview,
} from "@/services/kyc/underwriting";

export const dynamic = "force-dynamic";

/** Two small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Set the risk tier of one merchant category code - the `risk_tier` column `0077` reserved for the
 * compliance team. The body is `{ "code": "5812", "tier": "high" }`; `unassigned` clears the tier
 * back to the seed state. The company is never in the body: the code list is platform scoped.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies `UNDERWRITING_MANAGE_ROLES`, validates the code as four digits before any query, refuses
 * a retired code with a conflict and writes one conditional update with a race check, audited under
 * `underwriting.mcc_tier_set`. The answer is the fresh MCC overview, `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<UnderwritingMccOverview>> => {
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

    const overview = await setMccRiskTier(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("mcc risk tier set", {
      userId: actor.userId,
      codes: overview.rows.length,
    });

    return NextResponse.json(overview, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
