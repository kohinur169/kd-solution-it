// path: app/(client-portal)/i/[token]/pay/3ds/route.ts
import { NextResponse } from "next/server";
import { readClientAddress, readUserAgent } from "../../../../../../lib/auth/client-address.ts";
import { getAuthRuntime } from "../../../../../../lib/auth/runtime.ts";
import { AppError } from "../../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../../lib/logger/logger.ts";
import { requireCsrfToken } from "../../../../../../lib/security/csrf.ts";
import {
  PORTAL_THREE_DS_MAXIMUM_BODY_BYTES,
  PORTAL_THREE_DS_RATE_LIMIT,
} from "../../../../portal-three-ds-fields.ts";
import { startPortalThreeDs } from "../../../../portal-three-ds.ts";
import { getPortalThreeDsRuntime } from "../../../../portal-three-ds-runtime.ts";
import { readRequestActorOptionally } from "../../../../portal-invoice-runtime.ts";
import { enforcePortalRateLimit, portalRateLimitHeaders } from "../../../../portal-rate-limit.ts";

export const dynamic = "force-dynamic";

/** What starting authentication can answer: the money, or the issuer's page. */
interface ThreeDsStartResponseBody {
  readonly status: "captured" | "challenge";
  readonly invoiceId: string;
  readonly amountText: string;
  /** Present on a challenge: where the payer's browser goes, what it posts, and where it comes back. */
  readonly acsUrl?: string;
  readonly paReq?: string;
  readonly md?: string;
  readonly termUrl?: string;
  readonly expiresAt?: string;
  /** Present when the money was taken: the payment and the provider's transaction. */
  readonly paymentId?: string;
  readonly transactionId?: string;
  readonly capturedAt?: string;
}

/**
 * Ask the card's issuer to authenticate it before anything is charged.
 *
 * ## Why this route exists rather than a branch in the charge
 *
 * Section 18 asks for 3D Secure on every payment where possible, and the redirect half of that asks a
 * question the charge cannot: the cardholder has to leave this site and come back. A charge route that
 * returned "go to your bank" would be a charge route whose answer is not a payment; this one's answer is an
 * instruction, and the payment is made afterwards by the same service the pay page already posts to.
 *
 * ## The order of the checks
 *
 * The same five the charge uses, in the same order and for the same reasons: the CSRF token because it is
 * one comparison, the declared length and then the byte count before anything is parsed, the address
 * because an authentication with no payer address is evidence nobody can reconcile, the counter because it
 * is the only step that costs a statement, and only then the body. The counter is this step's own
 * (`portal_3ds`, ten per ten minutes), counted apart from the charge's five, because a challenge that never
 * reaches a charge is not a charge attempt.
 *
 * ## What the body may contain
 *
 * The same two fields the charge takes - a Collect.js token and an idempotency key - parsed by the same
 * parser, so a body carrying a card field is refused here by exactly the rule that refuses it there.
 *
 * ## What the answer carries
 *
 * On a challenge: the issuer's address, the issuer's request, this platform's sealed handle and the address
 * the issuer returns the payer to. All four are needed by the browser and none is a secret of this platform's
 * making - the handle is sealed, and the issuer's request is opaque base64 this site never reads. Nothing in
 * the answer is card data, because the platform has none.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse<ThreeDsStartResponseBody>> => {
    const runtime = getPortalThreeDsRuntime();

    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const declared = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(declared) && declared > PORTAL_THREE_DS_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const clientAddress = readClientAddress(request.headers);

    if (clientAddress === null) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }

    const userAgent = readUserAgent(request.headers);
    const limit = await enforcePortalRateLimit(
      PORTAL_THREE_DS_RATE_LIMIT,
      { clientAddress, userAgent, route: "/i/[token]/pay/3ds" },
      { rest: runtime.payment.rest, audit: runtime.payment.audit },
    );

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_THREE_DS_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "collectjs_token", rule: "invalid_format" }],
      });
    }

    const parameters = await context.params;
    let token: string;

    try {
      token = decodeURIComponent(parameters.token);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    // Optional, and used for one decision: a session belonging to the invoice's own company cannot pay it.
    const actor = await readRequestActorOptionally(request.headers.get("cookie"));

    const started = await startPortalThreeDs(
      {
        token,
        body,
        clientAddress,
        userAgent,
        acceptLanguage: request.headers.get("accept-language"),
        origin: new URL(request.url).origin,
        actorCompanyId: actor?.companyId ?? null,
      },
      runtime,
    );

    if (started.status === "captured") {
      logger.info("portal card payment captured after frictionless authentication", {
        invoiceId: started.payment.invoiceId,
        paymentId: started.payment.paymentId,
        companyId: started.payment.companyId,
      });

      return NextResponse.json(
        {
          status: "captured",
          invoiceId: started.payment.invoiceId,
          amountText: started.payment.amountText,
          paymentId: started.payment.paymentId,
          transactionId: started.payment.transactionId,
          capturedAt: started.payment.capturedAt,
        } satisfies ThreeDsStartResponseBody,
        { status: 201, headers: portalRateLimitHeaders(PORTAL_THREE_DS_RATE_LIMIT, limit) },
      );
    }

    logger.info("portal card payment challenged by its issuer", {
      invoiceId: started.invoiceId,
      companyId: started.companyId,
      expiresAt: started.expiresAt,
    });

    return NextResponse.json(
      {
        status: "challenge",
        invoiceId: started.invoiceId,
        amountText: started.amountText,
        acsUrl: started.acsUrl,
        paReq: started.paReq,
        md: started.md,
        termUrl: started.termUrl,
        expiresAt: started.expiresAt,
      } satisfies ThreeDsStartResponseBody,
      { status: 200, headers: portalRateLimitHeaders(PORTAL_THREE_DS_RATE_LIMIT, limit) },
    );
  },
);
