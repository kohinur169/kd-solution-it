// path: app/api/onboarding/payment-hold-decide/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { decidePaymentHold, type PaymentHoldSnapshot } from "@/services/kyc/payment-hold";

export const dynamic = "force-dynamic";

/** Three small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Decide one held transaction - release it or reject it - from the payment hold queue of STEP 092.
 * The body is `{ "hold_id": "<uuid>", "decision": "release"|"reject", "reason": "..." }`; the reason
 * is required on a rejection, the same trimmed 1..280 rule `0049` sets for document rejections.
 *
 * The hold is resolved by id alone - never by company from the body - because the office acts across
 * merchants; the service applies `UNDERWRITING_MANAGE_ROLES` (manual payment review is the compliance
 * desk's work), validates the id as a UUID before any query, refuses a decided hold with a conflict,
 * and writes one conditional update with a race check, audited under `payment_hold.decided`.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service. The answer
 * is the fresh hold, `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<PaymentHoldSnapshot>> => {
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

    const hold = await decidePaymentHold(
      { actor, holdId: (body as { readonly hold_id?: unknown }).hold_id, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("payment hold decided", {
      userId: actor.userId,
      holdId: hold.id,
      status: hold.status,
    });

    return NextResponse.json(hold, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
