// path: app/api/office/disputes/chargeback/clear/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { CHARGEBACK_APPLY_MAXIMUM_BODY_BYTES } from "@/services/disputes/chargeback-fields";
import {
  clearChargebackAction,
  parseClearBody,
  type ChargebackStepView,
} from "@/services/disputes/chargeback-rate";
import { getChargebackRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/**
 * Lift a warning or an extra reserve, at `/api/office/disputes/chargeback/clear`.
 *
 * The body is `{ "companyId": "<uuid>", "kind": "warning" | "reserve", "note": "<why>" }`. Section 18 does not
 * describe coming back down the ladder, and this route is deliberately narrow about it: only the two steps the
 * platform took on its own may be cleared, only once, and never a suspension - a suspended merchant returns
 * through `0111`'s reactivation, which asks for documents and records who let them back. `0128`'s guard enforces
 * the same three rules, so a caller that skipped this service writes nothing.
 *
 * The thresholds need no change for a clearing: the ladder is about rates crossing bars, and a merchant whose rate
 * came back under the warning bar is a merchant the platform should stop watching. The row keeps its measurement,
 * so the history still shows what it was warned about and when it came off.
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

    const parsed = parseClearBody(body);
    const step = await clearChargebackAction({ actor, body }, getChargebackRuntime());

    logger.info("chargeback step cleared", {
      companyId: step.companyId,
      kind: step.kind,
      rateBps: step.rateBps,
      // The officer's sentence is recorded on the row and in the chain as a length, never as the words.
      noteLength: parsed.note.length,
      actorUserId: actor.userId,
    });

    return NextResponse.json(step);
  },
);
