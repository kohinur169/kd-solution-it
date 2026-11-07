// path: app/api/office/disputes/chargeback/apply/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { CHARGEBACK_APPLY_MAXIMUM_BODY_BYTES } from "@/services/disputes/chargeback-fields";
import { applyChargebackStep, parseApplyBody, type ChargebackStepView } from "@/services/disputes/chargeback-rate";
import { getChargebackRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/**
 * Take the chargeback step one merchant's numbers earn, at `/api/office/disputes/chargeback/apply`.
 *
 * The body is `{ "companyId": "<uuid>", "reason": "<sentence>" }`. Which step is taken is *not* in the body: the
 * service measures again, decides again, and refuses when the numbers earn nothing - so a browser that asks for a
 * suspension of a merchant at 0.10 percent reads the bar's own answer rather than a step it chose. That is also
 * why the route logs the step the service took rather than one it was told about.
 *
 * A warning and an extra reserve are recorded as `automatic`: the platform takes them, and a person pressing the
 * button is the clock, not the author. A suspension is `manual` and needs the officer's sentence, because `0111`
 * refuses a suspension with no actor and because stopping a merchant's business should carry a signature.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ChargebackStepView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declared = request.headers.get("content-length");

    if (declared !== null) {
      const parsed = Number.parseInt(declared, 10);

      if (Number.isFinite(parsed) && parsed > CHARGEBACK_APPLY_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > CHARGEBACK_APPLY_MAXIMUM_BODY_BYTES) {
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

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "chargeback", rule: "invalid_format" }],
      });
    }

    // Parsed here as well as in the service, so a body this route cannot name never costs the platform two full
    // counts of a merchant's window.
    const parsed = parseApplyBody(body);
    const step = await applyChargebackStep({ actor, body }, getChargebackRuntime());

    logger.info("chargeback step applied", {
      companyId: step.companyId,
      kind: step.kind,
      mode: step.mode,
      rateBps: step.rateBps,
      paymentsCount: step.paymentsCount,
      chargebacksCount: step.chargebacksCount,
      // The officer's sentence is not logged: what is recorded is that a sentence was given, and how long it was.
      reasonLength: parsed.reason?.length ?? 0,
      actorUserId: actor.userId,
    });

    return NextResponse.json(step);
  },
);
