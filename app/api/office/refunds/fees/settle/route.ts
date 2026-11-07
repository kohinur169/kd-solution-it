// path: app/api/office/refunds/fees/settle/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { sweepRefundFeeReturns, type RefundFeeSweepView } from "@/services/payments/refund-fee";
import { REFUND_FEE_MAXIMUM_BODY_BYTES } from "@/services/payments/refund-fee-fields";
import { getRefundFeeRuntime } from "@/services/payments/refund-fee-runtime";

export const dynamic = "force-dynamic";

/**
 * Run the section 18 pass now: apply the fee rule to the refunds that have not been answered yet.
 *
 * ## Why the desk has a button for a job
 *
 * The pass is what a scheduler would run, and this build registers no scheduled job with a database store
 * (STEP 011 built the runtime and the handoff of STEP 192 records the gap). Until one exists, the desk runs it:
 * the same function, bounded to fifty refunds by its own service, started by a person who can read the counts
 * it answers with. The execution route also applies the rule to the refund it just settled, so this button is
 * the reconciler rather than the primary path.
 *
 * ## Its guards, and why the second one is stricter than the screen's
 *
 * CSRF, the 512-byte ceiling, the session, then the device proof over the exact bytes. The service requires the
 * refund desk's role *and* a fresh second factor, because this is one press that writes money records for many
 * merchants at once: the same step-up an approval asks for, applied to a bulk act.
 *
 * The body is `{}`. There is nothing for a browser to choose: the rule comes from the setting, the queue from
 * the database, and a limit the client sent would be a bound the client could lift.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<RefundFeeSweepView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > REFUND_FEE_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (bodyText.length > REFUND_FEE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    requireTrustedDevice(
      await verifySensitiveRequest({ request, bodyText, actor }, { rest: runtime.rest, audit: runtime.audit }),
    );

    const sweep = await sweepRefundFeeReturns({ actor }, getRefundFeeRuntime());

    logger.info("refund fee pass ran", {
      examined: sweep.examined,
      returned: sweep.returned,
      retained: sweep.retained,
      actorUserId: actor.userId,
    });

    return NextResponse.json(sweep, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
