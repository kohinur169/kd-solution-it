// path: app/api/payments/disputes/[id]/response/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeView } from "@/services/disputes/dispute";
import { DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES } from "@/services/disputes/dispute-fields";
import { saveDisputeResponse } from "@/services/disputes/dispute-response";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/** The field a body that is not JSON is reported against, before the service ever sees it. */
const RESPONSE_FIELD = "response_text";

/** The body, with the ceiling checked before and after it is held. */
async function readBodyText(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  if (text.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: RESPONSE_FIELD, rule: "invalid_format" }] });
  }

  return text;
}

/**
 * The merchant's side of a dispute, at `/api/payments/disputes/[id]/response`.
 *
 * The route is the boundary and nothing else: CSRF, the ceiling, the session, the parse, one call. Everything
 * that decides whether the words may be written - the `owner` role, the merchant's own dispute, the three
 * clocks (decided, sent, closed) and the version guard - lives in `saveDisputeResponse`, so a second caller
 * cannot accept a late response by reaching the table another way.
 *
 * No device proof, and deliberately: a response is the merchant's own account of their own money, not a
 * decision about it. The office act that moves the deadline carries the proof, because that one changes the
 * time another person has to answer in.
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

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: RESPONSE_FIELD, rule: "invalid_format" }] });
    }

    const parameters = await context.params;
    let disputeId: string;

    try {
      disputeId = decodeURIComponent(parameters.id);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const saved = await saveDisputeResponse({ actor, disputeId, body }, getDisputeRuntime());

    logger.info("dispute response saved", {
      disputeId: saved.id,
      companyId: saved.companyId,
      // The length and the window, never the words: a merchant's account of a fraud investigation is not a
      // log line, and the row is where it belongs.
      responseLength: saved.responseText?.length ?? 0,
      responseSavedAt: saved.responseSavedAt,
      responseDueAt: saved.responseDueAt,
      actorUserId: actor.userId,
    });

    return NextResponse.json(saved, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
