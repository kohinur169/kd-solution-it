// path: app/(client-portal)/i/[token]/pay/charge/route.ts
import { NextResponse } from "next/server";
import { readClientAddress, readUserAgent } from "../../../../../../lib/auth/client-address.ts";
import { getAuthRuntime } from "../../../../../../lib/auth/runtime.ts";
import { AppError } from "../../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../../lib/logger/logger.ts";
import { requireCsrfToken } from "../../../../../../lib/security/csrf.ts";
import { chargePortalPayment } from "../../../../portal-payment.ts";
import {
  PORTAL_PAYMENT_MAXIMUM_BODY_BYTES,
  PORTAL_PAYMENT_RATE_LIMIT,
} from "../../../../portal-payment-fields.ts";
import { getPortalPaymentRuntime } from "../../../../portal-payment-runtime.ts";
import { readRequestActorOptionally } from "../../../../portal-invoice-runtime.ts";
import { enforcePortalRateLimit, portalRateLimitHeaders } from "../../../../portal-rate-limit.ts";

export const dynamic = "force-dynamic";

interface PaymentResponseBody {
  readonly status: "captured";
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly transactionId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly capturedAt: string;
}

/**
 * The card payment a client makes from a tokenized invoice link.
 *
 * The path is `pay/charge` rather than `pay`, because `pay` is the page: a Next.js segment cannot be a page
 * and a route at once, and the page is what a payer is sent to while this is what the page's form posts to.
 *
 * ## The order of the checks
 *
 *   1. The CSRF token, because it costs one string comparison and a forged request should not get as far as
 *      reading a body. The double submit token of STEP 037 works without a session, and the payment form
 *      asks `/api/auth/csrf` for one.
 *   2. The declared length, then the byte count of the body, before it is parsed. Two kilobytes is a token
 *      and a key; anything larger is a caller making the process hold a document to learn it is refused.
 *   3. The address, validated as an address: a charge with no payer address is evidence the platform would
 *      have to invent later.
 *   4. The rate limit, before the body is read: the counter is the only step that costs a database
 *      statement, and it is spent by attempts rather than by successes, which is the point of a limit.
 *   5. The body, then the service.
 *
 * ## What the body may contain
 *
 * A Collect.js token and an idempotency key. There is no field for a card number, an expiry or a CVV, and a
 * body carrying one is refused and audited by the service - the route does not need to know the list,
 * because the service owns that rule and its refusal is the same one every other caller meets.
 *
 * ## What the answer carries
 *
 * The amount that was charged, the payment and the provider's transaction id. No card detail, because there
 * is none to carry: the only card facts this platform could hold are the provider's own brand and last four,
 * and they belong to the record, not to a response.
 *
 * ## The answer a flagged card gets
 *
 * STEP 186. A payment the gateway answers with one of its four fraud codes is never a `201`: the service
 * refuses it, and this route lets the refusal through the platform's own envelope - `422` with the rule
 * `risk_rejected`, or `409` with `risk_suspicious` when the issuer asked the merchant to stop instead. The
 * card form reads the rule from `details[0]` and ends the page on the first of those, so a payer is told the
 * truth once rather than invited to try the same card again.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse<PaymentResponseBody>> => {
    const runtime = getPortalPaymentRuntime();

    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > PORTAL_PAYMENT_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const clientAddress = readClientAddress(request.headers);

    if (clientAddress === null) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }

    const userAgent = readUserAgent(request.headers);
    const limit = await enforcePortalRateLimit(
      PORTAL_PAYMENT_RATE_LIMIT,
      { clientAddress, userAgent, route: "/i/[token]/pay/charge" },
      { rest: runtime.rest, audit: runtime.audit },
    );

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_PAYMENT_MAXIMUM_BODY_BYTES) {
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

    // An identity check that costs nothing for the caller it is about: a payer has no session, while a
    // session belonging to the invoice's own company is refused by the service, because a seller cannot pay
    // their own invoice.
    const actor = await readRequestActorOptionally(request.headers.get("cookie"));

    const captured = await chargePortalPayment(
      {
        token,
        body,
        clientAddress,
        userAgent,
        actorCompanyId: actor?.companyId ?? null,
      },
      runtime,
    );

    logger.info("portal card payment captured", {
      invoiceId: captured.invoiceId,
      paymentId: captured.paymentId,
      companyId: captured.companyId,
      amountMinor: captured.amountMinor,
    });

    return NextResponse.json(
      {
        status: "captured",
        invoiceId: captured.invoiceId,
        paymentId: captured.paymentId,
        transactionId: captured.transactionId,
        amountMinor: captured.amountMinor,
        amountText: captured.amountText,
        capturedAt: captured.capturedAt,
      } satisfies PaymentResponseBody,
      { status: 201, headers: portalRateLimitHeaders(PORTAL_PAYMENT_RATE_LIMIT, limit) },
    );
  },
);
