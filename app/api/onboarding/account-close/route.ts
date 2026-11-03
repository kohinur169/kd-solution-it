// path: app/api/onboarding/account-close/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getJobRuntime } from "@/lib/jobs/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { closeMerchantAccount, type ClosureResult } from "@/services/kyc/account-lifecycle";

export const dynamic = "force-dynamic";

/** The merchant and optionally the payout bank account. 8 KiB is generous for that and still bounded */
const maximumBodyBytes = 8_192;

/**
 * Close one merchant account, from the account review screen of STEP 099. The body is `{ "company_id": "<uuid>", "payout_bank_account_id": "<uuid>" }` with the bank account optional (the company's verified one is used when absent). The service records the `0111` `closed` event with the hold and chargeback release instants, places the chargeback reserve as a `0043` closure hold, schedules the remainder payout after the hold period, restricts the verified sub-merchants, queues the saved card token deletion and sets the owners to `closed`.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies its roles and its state machine. The answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ClosureResult>> => {
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

    const result = await closeMerchantAccount(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit, jobs: getJobRuntime() },
    );

    logger.info("merchant account closed", {
      userId: actor.userId,
      companyId: result.companyId,
      reserveHeldMinor: result.reserveHeldMinor,
      payoutMinor: result.payoutMinor,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
