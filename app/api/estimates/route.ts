// path: app/api/estimates/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { createEstimate, type EstimateSnapshot } from "@/services/estimates/estimates";

export const dynamic = "force-dynamic";

/**
 * The body ceiling.
 *
 * A quote is a client id, an expiry, three money fields and up to `INVOICE_MAXIMUM_LINES` lines of seven
 * short strings, so 256 KiB holds the longest legal body with room to spare and still bounds what one
 * request can make the server read. It is the invoice create's ceiling, because the two bodies are the same
 * shape with one field different.
 */
const maximumBodyBytes = 262_144;

interface CreateEstimateBody {
  readonly status: "created";
  readonly estimate: EstimateSnapshot;
}

/**
 * Section 16's quote create, over HTTP.
 *
 * ## The order of the checks
 *
 * CSRF first - a form post from another origin cannot read the token this compares - then the declared
 * length, then the session, then the JSON parse, then the service, which applies the `owner` role, reads
 * the company from the session (never from the body, so a crafted request cannot write into another
 * merchant's book) and validates every field before anything is written. The order is the one every mutating
 * route in this codebase uses, and the auth gate asserts it.
 *
 * ## Why the body is parsed here and validated in the service
 *
 * This route decides only that the body is JSON at all: a body that is not is a malformed request, and the
 * field it names is the document's own. What a valid quote *is* - the ceilings, the unit list, the money
 * rules, the expiry, the client's ownership - belongs to the service, because the same rules run when
 * another caller invokes it, and a route that validated would be a second, weaker definition.
 *
 * ## What this route cannot do
 *
 * The create schema has no `status`, no `number` and no `issued_at`, and it is `.strict()`, so a body that
 * sends one is refused rather than stripped. A quote therefore arrives as a draft every time: sending it,
 * numbering it and the signature that accepts it are STEP 120's routes, and nothing here can reach them.
 *
 * ## Why the answer is `no-store`
 *
 * A quote carries a client's name, address and the amounts they are being asked to agree to. No cache
 * between the merchant and the server may keep a copy of that.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<CreateEstimateBody>> => {
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
      // A chunked body declares no length, so the bound is enforced a second time on what arrived.
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
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "estimate", rule: "invalid_format" }],
      });
    }

    const estimate = await createEstimate(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("estimate created", {
      userId: actor.userId,
      companyId: estimate.companyId,
      estimateId: estimate.id,
      lineCount: estimate.lines.length,
    });

    return NextResponse.json(
      { status: "created", estimate },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
