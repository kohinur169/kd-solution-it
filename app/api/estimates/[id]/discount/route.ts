// path: app/api/estimates/[id]/discount/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { parseEstimateTotalsBody, updateEstimateTotals } from "@/services/estimates/estimate-lines";
import type { EstimateSnapshot } from "@/services/estimates/estimates";

export const dynamic = "force-dynamic";

/** Three short fields; 4 KiB holds the longest legal body many times over. */
const maximumBodyBytes = 4_096;

interface TotalsBody {
  readonly status: "updated";
  readonly totals: EstimateSnapshot["totals"];
}

/**
 * Change the quote-level discount and the tax of a draft.
 *
 * ## Why the two are one endpoint
 *
 * They are read together by a merchant as "the totals above the total", and they are written together
 * because `0117`'s coherence check refuses a basis without its percentage and a percentage without its
 * basis: two requests would leave a row between them that the column would not accept.
 *
 * ## Why this route is shorter than the invoice's
 *
 * The body is parsed by `parseEstimateTotalsBody` in the service, not here. Rule 11 asks for every input to
 * be validated on the server, and the server is the service: a route that parsed the money itself would make
 * the next caller of `updateEstimateTotals` - a job, the conversion in STEP 121, a gate - write its own
 * parser, and two parsers of one body drift. So this route decides only that the body is JSON and small
 * enough to read, and the service decides what the three fields mean.
 *
 * ## What cannot happen here
 *
 * A quote that has left `draft` answers `CONFLICT` before anything is written, so the totals a client was
 * asked to accept cannot move afterwards. A flat discount larger than the lines add up to is refused with
 * `discount` named, rather than arriving as a violation of `estimates_discount_check` after an UPDATE that
 * had already half-happened.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<TotalsBody>> => {
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
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "discount", rule: "invalid_format" }] });
    }

    const estimateId = decodeURIComponent((await context.params).id);
    const totals = await updateEstimateTotals(
      { actor, estimateId, totals: parseEstimateTotalsBody(body) },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("estimate totals changed", {
      userId: actor.userId,
      estimateId,
      basis: totals.discountBasis,
      totalMinor: totals.totalMinor,
    });

    return NextResponse.json(
      { status: "updated", totals },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
