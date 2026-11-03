// path: app/api/onboarding/account-suspend/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { suspendMerchant, type SuspendResult } from "@/services/kyc/account-lifecycle";

export const dynamic = "force-dynamic";

/** The merchant, the suspension reason and the required reactivation documents. 8 KiB is generous for that and still bounded */
const maximumBodyBytes = 8_192;

/**
 * Suspend one merchant account, from the account review screen of STEP 099. The body is `{ "company_id": "<uuid>", "reason": "risk"|"chargeback_program"|"billing"|"manual", "required_documents": ["..."] }`; the service applies the office roles, refuses a non-active account with a conflict, records the `0111` `suspended` event and sets the owners' `0003` status to `suspended`.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service, which
 * applies its roles and its state machine. The answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<SuspendResult>> => {
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

    const result = await suspendMerchant(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("merchant account suspended", {
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
