// path: app/(client-portal)/e/[token]/signature/route.ts
import { NextResponse } from "next/server";
import { readClientAddress, readUserAgent } from "../../../../../lib/auth/client-address.ts";
import { getAuthRuntime } from "../../../../../lib/auth/runtime.ts";
import { AppError } from "../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../lib/logger/logger.ts";
import { requireCsrfToken } from "../../../../../lib/security/csrf.ts";
import { decidePortalEstimate } from "../../../portal-estimate-decision.ts";
import {
  PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES,
  PORTAL_SIGNATURE_RATE_LIMIT,
  type PortalEstimateState,
} from "../../../portal-estimate-fields.ts";
import {
  getPortalInvoiceRuntime,
  readRequestActorOptionally,
} from "../../../portal-invoice-runtime.ts";
import { enforcePortalRateLimit, portalRateLimitHeaders } from "../../../portal-rate-limit.ts";

export const dynamic = "force-dynamic";

interface SignatureResponseBody {
  readonly status: "accepted" | "declined";
  readonly state: PortalEstimateState;
  readonly estimateId: string;
  readonly signatureId: string;
  readonly signerName: string;
  readonly decidedAt: string;
}

/**
 * The client's decision on a tokenized estimate, written from a link nobody signed in for.
 *
 * ## The same order as the invoice confirmation, for the same reasons
 *
 *   1. The CSRF token first: one string comparison, and a forged request should not reach the point of
 *      reading a body. The double submit token of STEP 037 works without a session, and the portal form
 *      fetches one from `/api/auth/csrf`.
 *   2. The declared length, then the byte count, before the body is parsed, so a caller cannot make the
 *      process hold a document to learn that the platform refuses it.
 *   3. The address, validated as an address: `0027`'s `ip` column is `inet`, and evidence without the
 *      address of the request that made it is weaker than the record claims to be.
 *   4. The rate limit, before the body is read. The counter is the only step that costs a database
 *      statement, and it is spent by attempts rather than successes, which is the point of a limit.
 *   5. The body, the service, and the answer.
 *
 * ## What the answer carries, and what it does not
 *
 * The decision, the state it produced and the identifiers the page can look its own state up by. No
 * address, no digest, no consent wording: the page re-reads the record from the database, and the stored
 * row is the only version of it the browser is allowed to show.
 *
 * ## Where the decision is applied
 *
 * `decidePortalEstimate` writes the evidence through STEP 022's `captureEstimateSignature` and then moves
 * the quote itself. This route decides nothing: it authenticates the caller by the token, reads the
 * request's own facts, and hands both to the service.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse<SignatureResponseBody>> => {
    const runtime = getPortalInvoiceRuntime();

    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const clientAddress = readClientAddress(request.headers);

    if (clientAddress === null) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }

    const userAgent = readUserAgent(request.headers);
    const limit = await enforcePortalRateLimit(
      PORTAL_SIGNATURE_RATE_LIMIT,
      { clientAddress, userAgent, route: "/e/[token]/signature" },
      { rest: runtime.rest, audit: runtime.audit },
    );

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_ESTIMATE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "decision", rule: "invalid_format" }],
      });
    }

    const parameters = await context.params;
    let token: string;

    try {
      token = decodeURIComponent(parameters.token);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    // An identity check that costs nothing for the caller it is about: a client has no session and is
    // exactly who this route is for. A session belonging to the estimate's own company is refused by the
    // service, because a merchant cannot sign their own offer.
    const actor = await readRequestActorOptionally(request.headers.get("cookie"));

    const decided = await decidePortalEstimate(
      {
        token,
        body,
        clientAddress,
        userAgent,
        actorCompanyId: actor?.companyId ?? null,
      },
      runtime,
    );

    logger.info("portal estimate decided by the client", {
      estimateId: decided.estimateId,
      companyId: decided.companyId,
      decision: decided.decision,
      state: decided.state,
    });

    return NextResponse.json(
      {
        status: decided.decision,
        state: decided.state,
        estimateId: decided.estimateId,
        signatureId: decided.signatureId,
        signerName: decided.signerName,
        decidedAt: decided.decidedAt,
      } satisfies SignatureResponseBody,
      { status: 201, headers: portalRateLimitHeaders(PORTAL_SIGNATURE_RATE_LIMIT, limit) },
    );
  },
);
