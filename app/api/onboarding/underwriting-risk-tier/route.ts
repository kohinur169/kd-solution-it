// path: app/api/onboarding/underwriting-risk-tier/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  updateUnderwritingRiskTier,
  type UnderwritingSettings,
} from "@/services/kyc/underwriting";

export const dynamic = "force-dynamic";

/** Three small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Save the cost of one MCC risk tier - the extra reserve percent and the longer hold in days - from
 * the underwriting screen of STEP 090. The body is `{ "tier": "low"|"medium"|"high",
 * "extra_reserve_percent": "5.00", "hold_days": 7 }`.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies `UNDERWRITING_MANAGE_ROLES`, validates the body and writes one conditional update with a
 * race check, audited under `underwriting.risk_tier_updated`. The company is never in the body: the
 * tiers are platform scoped. The answer is the fresh settings, `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<UnderwritingSettings>> => {
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

    const settings = await updateUnderwritingRiskTier(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("underwriting risk tier updated", {
      userId: actor.userId,
      tiers: settings.tiers.length,
    });

    return NextResponse.json(settings, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
