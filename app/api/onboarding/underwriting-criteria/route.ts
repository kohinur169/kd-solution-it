// path: app/api/onboarding/underwriting-criteria/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  updateUnderwritingCriteria,
  type UnderwritingSettings,
} from "@/services/kyc/underwriting";

export const dynamic = "force-dynamic";

/** Four small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Save the four underwriting criteria of section 5, over HTTP: the starting monthly transaction
 * limit for new merchants, the required bank statement period, and the hold on unusually large
 * transactions with its threshold. The body is `{ "starting_monthly_limit": "2500.00",
 * "bank_statement_months": 6, "large_transaction_hold_enabled": false,
 * "large_transaction_hold_threshold": "50000" }`.
 *
 * ## Why this is a POST-only route
 *
 * The read side needs no route: the screen reads the one criteria row and the three tier rows
 * server-side through the service (`underwriting-mcc` is the one GET, for the code list), and the
 * auth gate keeps every mutation route POST-only so the token check is provably first in the file.
 * The criteria are platform scoped - one row, `company_id` null - so no company ever comes from a
 * query string or a body. The service applies `UNDERWRITING_MANAGE_ROLES` and refuses any other
 * actor before a single query runs.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * validates the body again and writes one conditional update with a race check, audited under
 * `underwriting.criteria_updated`. The answer is the fresh settings, `no-store`: the criteria
 * change the rules every later request is judged by, and a cached answer would lie.
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

    const settings = await updateUnderwritingCriteria(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("underwriting criteria updated", {
      userId: actor.userId,
      startingMonthlyLimit: settings.criteria.startingMonthlyLimit,
      bankStatementMonths: settings.criteria.bankStatementMonths,
      largeHoldEnabled: settings.criteria.largeHoldEnabled,
      largeHoldThreshold: settings.criteria.largeHoldThreshold,
    });

    return NextResponse.json(settings, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
