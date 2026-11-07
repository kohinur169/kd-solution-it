// path: app/(client-portal)/i/[token]/acceptance/route.ts
import { NextResponse } from "next/server";
import { readClientAddress, readUserAgent } from "../../../../../lib/auth/client-address.ts";
import { getAuthRuntime } from "../../../../../lib/auth/runtime.ts";
import { readRequestActorOptionally } from "../../../portal-invoice-runtime.ts";
import { capturePortalInvoiceAcceptance } from "../../../portal-invoice-evidence.ts";
import { enforcePortalAcceptanceRateLimit, portalRateLimitHeaders } from "../../../portal-invoice-rate-limit.ts";
import { getPortalInvoiceRuntime } from "../../../portal-invoice-runtime.ts";
import { AppError } from "../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../lib/logger/logger.ts";
import { requireCsrfToken } from "../../../../../lib/security/csrf.ts";
import { PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES } from "../../../portal-invoice-fields.ts";

export const dynamic = "force-dynamic";

interface AcceptanceResponseBody {
  readonly status: "accepted";
  readonly acceptanceId: string;
  readonly invoiceId: string;
  readonly statement: string;
  readonly acceptedAt: string;
}

/**
 * The buyer's confirmation, written from a link nobody signed in for.
 *
 * ## The order of the checks, and why it is that order
 *
 *   1. The CSRF token, because it costs one string comparison and a forged request should not get as far
 *      as reading a body. The portal form has no session, and it does not need one: the double submit
 *      token of STEP 037 works for exactly this case, and `/api/auth/csrf` issues one without a login.
 *   2. The declared length and then the byte count of the body, before it is parsed, so a caller cannot
 *      make the process hold a large document to learn that the platform refuses it.
 *   3. The address, from the proxy headers and validated as an address: `0122`'s `ip` column is `inet`
 *      and the evidence is weaker without it, so a request that cannot be geolocated at all is refused
 *      rather than stored anonymously.
 *   4. The rate limit, before the body is read: the counter is the only check that costs a database
 *      statement, and it is spent by attempts rather than by successes, which is the point of a limit.
 *   5. The body, the service, and the answer.
 *
 * ## What the answer carries
 *
 * The identifiers the buyer's page needs to re-read its own state, and nothing the evidence holds: no
 * name, no address and no digest. The page refreshes itself from a fresh read, which is the only version
 * of the confirmation the browser is allowed to show.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse<AcceptanceResponseBody>> => {
    const runtime = getPortalInvoiceRuntime();

    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const clientAddress = readClientAddress(request.headers);

    if (clientAddress === null) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }

    const userAgent = readUserAgent(request.headers);
    const decision = await enforcePortalAcceptanceRateLimit(
      { clientAddress, userAgent },
      { rest: runtime.rest, audit: runtime.audit },
    );

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "confirmation", rule: "invalid_format" }],
      });
    }

    const parameters = await context.params;
    let token: string;

    try {
      token = decodeURIComponent(parameters.token);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    // An identity check that costs nothing for the caller it is about: a buyer has no session and is
    // exactly who this route is for, while a session belonging to the invoice's own company is refused
    // by the service below, because a seller cannot confirm their own delivery.
    const actor = await readRequestActorOptionally(request.headers.get("cookie"));

    const captured = await capturePortalInvoiceAcceptance(
      {
        token,
        body,
        clientAddress,
        userAgent,
        actorCompanyId: actor?.companyId ?? null,
      },
      { rest: runtime.rest, audit: runtime.audit, tokenKeys: runtime.tokenKeys },
    );

    logger.info("portal invoice accepted by the buyer", {
      invoiceId: captured.invoiceId,
      acceptanceId: captured.acceptanceId,
      companyId: captured.companyId,
    });

    return NextResponse.json(
      {
        status: "accepted",
        acceptanceId: captured.acceptanceId,
        invoiceId: captured.invoiceId,
        statement: captured.statement,
        acceptedAt: captured.acceptedAt,
      } satisfies AcceptanceResponseBody,
      { status: 201, headers: portalRateLimitHeaders(decision) },
    );
  },
);
