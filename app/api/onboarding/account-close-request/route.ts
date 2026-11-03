// path: app/api/onboarding/account-close-request/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { requestAccountClosure, type ClosureRequestResult } from "@/services/kyc/account-lifecycle";

export const dynamic = "force-dynamic";

/** An optional note of at most 280 characters. 1 KiB is generous for that and still bounded */
const maximumBodyBytes = 1_024;

/**
 * The merchant's request to close the account, from the account screen of STEP 099. The body is `{ "note": "..." }` or empty; the company comes from the session. The service requires an active account and records the `0111` `closure_requested` event; the office closes through `/api/onboarding/account-close`.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies its roles and its state machine. The answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ClosureRequestResult>> => {
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

    const result = await requestAccountClosure(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("merchant account closure requested", {
      userId: actor.userId,
      companyId: result.companyId,
      state: result.state,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
