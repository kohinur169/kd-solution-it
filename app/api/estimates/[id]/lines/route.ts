// path: app/api/estimates/[id]/lines/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { addEstimateLine, parseEstimateLine } from "@/services/estimates/estimate-lines";
import type { EstimateLineSnapshot } from "@/services/estimates/estimates";

export const dynamic = "force-dynamic";

/** Seven short fields for one line; 16 KiB holds the longest legal line twice over. */
const maximumBodyBytes = 16_384;

interface AddLineBody {
  readonly status: "created";
  readonly line: EstimateLineSnapshot;
}

/**
 * Add one line to a draft quote.
 *
 * ## Why the quote id is in the path
 *
 * The body carries the line and nothing else. The document the line belongs to is the path's, so a request
 * cannot add a line to a quote it did not name - and the service scopes that id to the caller's company,
 * which is what turns another merchant's id into a 404 rather than a write.
 *
 * ## The order of the checks
 *
 * CSRF first, then the declared length, then the session, then the JSON parse, then `parseEstimateLine`
 * (the create path's own parser, so a line added here is judged by exactly the seven rules a line typed
 * into a new quote is), then the service, which applies the `owner` role, re-reads the parent, refuses a
 * quote that has left `draft`, and appends the line at the end of the list.
 *
 * ## Why the answer carries the line and not the quote
 *
 * The editor already holds the document; what changed is one row. Returning the whole quote would make
 * every save re-render the total from a second source, and the two could disagree for one frame. The screen
 * recomputes its total from `line_total_minor`, which `0026` generated.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<AddLineBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > maximumBodyBytes) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

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
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "line", rule: "invalid_format" }] });
    }

    const estimateId = decodeURIComponent((await context.params).id);
    const line = await addEstimateLine(
      { actor, estimateId, line: parseEstimateLine(body) },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("estimate line added", {
      userId: actor.userId,
      estimateId,
      lineId: line.id,
      position: line.position,
    });

    return NextResponse.json(
      { status: "created", line },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
