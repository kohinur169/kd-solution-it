// path: app/api/office/disputes/[id]/deadline/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeView } from "@/services/disputes/dispute";
import { extendDisputeDeadline } from "@/services/disputes/dispute-response";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/** The field a malformed extension body is reported against. */
const WINDOW_FIELD = "response_window_hours";

/** The largest extension body: one number and two braces. */
const DISPUTE_DEADLINE_MAXIMUM_BODY_BYTES = 512;

/** The body, with the ceiling checked before and after it is held. */
async function readBodyText(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > DISPUTE_DEADLINE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > DISPUTE_DEADLINE_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  if (text.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: WINDOW_FIELD, rule: "invalid_format" }] });
  }

  return text;
}

/**
 * Section 19's extension of a dispute deadline, at `/api/office/disputes/[id]/deadline`.
 *
 * One act: a super administrator answers "48 hours" on a dispute whose window is still open, and the window and
 * the deadline move together. Three guards on the route - CSRF, the device proof over these exact bytes, the
 * session - and three inside `extendDisputeDeadline`: the role, the satisfied second factor, and the row's own
 * state (decided, sent and closed are each their own refusal).
 *
 * The device proof is here because this act changes the time *another person* has to answer in. The merchant's
 * own save does not carry one for the same reason in reverse: it spends nobody else's time.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const bodyText = await readBodyText(request);
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // The browser signs these exact bytes: an altered window, a replayed nonce or an unenrolled device stops
    // here rather than at the service's own checks.
    requireTrustedDevice(
      await verifySensitiveRequest(
        { request, bodyText, actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: WINDOW_FIELD, rule: "invalid_format" }] });
    }

    const parameters = await context.params;
    let disputeId: string;

    try {
      disputeId = decodeURIComponent(parameters.id);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const extended = await extendDisputeDeadline({ actor, disputeId, body }, getDisputeRuntime());

    logger.info("dispute deadline extended", {
      disputeId: extended.id,
      companyId: extended.companyId,
      responseWindowHours: extended.responseWindowHours,
      responseDueAt: extended.responseDueAt,
      actorUserId: actor.userId,
    });

    return NextResponse.json(extended, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
