// path: app/(client-portal)/p/[token]/charge/route.ts
import { NextResponse } from "next/server";
import { readClientAddress, readUserAgent } from "../../../../../lib/auth/client-address.ts";
import { getAuthRuntime } from "../../../../../lib/auth/runtime.ts";
import { AppError } from "../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../lib/logger/logger.ts";
import { requireCsrfToken } from "../../../../../lib/security/csrf.ts";
import { readRequestActorOptionally } from "../../../portal-invoice-runtime.ts";
import {
  PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES,
  PORTAL_PAYMENT_LINK_RATE_LIMIT,
} from "../../../portal-payment-link-fields.ts";
import { chargePortalPaymentLink } from "../../../portal-payment-link-checkout.ts";
import { getPortalPaymentLinkRuntime } from "../../../portal-payment-link-runtime.ts";
import { enforcePortalRateLimit, portalRateLimitHeaders } from "../../../portal-rate-limit.ts";
import { PORTAL_THREE_DS_RULES } from "../../../portal-three-ds-fields.ts";
import { getPortalThreeDsRuntime } from "../../../portal-three-ds-runtime.ts";

export const dynamic = "force-dynamic";

interface LinkChargeResponseBody {
  readonly status: "captured";
  readonly linkId: string;
  readonly paymentId: string;
  readonly transactionId: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly capturedAt: string;
}

/**
 * The card a payer makes on a general payment link.
 *
 * ## Why the path is `charge` under the link and not the link itself
 *
 * `p/[token]` is the page: a Next.js segment cannot be a page and a route at once, so the hosted checkout lives
 * at the page's address and this is what its form posts to - the same split, and the same reason, as
 * `i/[token]/pay/charge`.
 *
 * ## The order of the checks
 *
 *   1. The CSRF token, because it costs one string comparison. The double submit token works without a
 *      session, and the form asks `/api/auth/csrf` for one.
 *   2. The declared length, then the byte count, before the body is parsed: a Collect.js token and a key.
 *   3. The payer's address, validated as an address: a charge with no address is evidence the platform would
 *      have to invent later.
 *   4. The rate limit, spent by attempts rather than successes. Five attempts in ten minutes per address is
 *      the link's own counter, counted apart from the invoice charge's five, because a stolen link and a stolen
 *      invoice link are two different attacks on two different pages.
 *   5. The bank's step: a general link has no invoice, so it has no postal address and no client address to
 *      compare a payer against, and `payments_three_ds_capture_check` in `0037_payments.sql` therefore accepts
 *      a captured link payment already authenticated and by no other route. A deployment that cannot ask the
 *      issuer must not take the card, so this route refuses before it reads anything the payer typed.
 *   6. The body, then the service.
 *
 * ## What the answer carries
 *
 * The link, the payment, the provider's transaction and the amount. No card detail, because the platform has
 * none: the provider's brand and last four belong to the record, not to a response.
 *
 * ## The refusals a payer can meet here
 *
 * A dead link is `404` with `link_not_found` - never "revoked" or "expired", because a page that distinguishes
 * them tells whoever found a stolen link which of the merchant's actions closed it. A live link that is past
 * its date, revoked, or already paid is a `409` with `link_expired`, `link_revoked` or `link_paid`, and a
 * merchant's own session paying its own link is `409` with `self_payment`. Every card refusal STEP 186, 187 and
 * 188 already names arrives here unchanged, because this route runs the same processor they are wired into.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse<LinkChargeResponseBody>> => {
    const runtime = getPortalPaymentLinkRuntime();

    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const clientAddress = readClientAddress(request.headers);

    if (clientAddress === null) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }

    const userAgent = readUserAgent(request.headers);
    const limit = await enforcePortalRateLimit(
      PORTAL_PAYMENT_LINK_RATE_LIMIT,
      { clientAddress, userAgent, route: "/p/[token]/charge" },
      { rest: runtime.rest, audit: runtime.audit },
    );

    // The page renders by this same fact, so the endpoint refuses by it too: a form that a page withheld must
    // not be reachable by posting to it directly.
    const threeDs = getPortalThreeDsRuntime();
    const authenticationReady =
      threeDs.port !== null && threeDs.port.available && threeDs.recorder !== null && threeDs.recorder.durable;

    if (!authenticationReady) {
      throw new AppError("SERVICE_UNAVAILABLE", {
        details: [{ field: "payment", rule: PORTAL_THREE_DS_RULES.unavailable }],
      });
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES) {
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

    // An identity check that costs nothing for the caller it is about: a payer has no session, while the
    // session of the merchant that owns the link is refused by the service, because a seller cannot pay their
    // own link.
    const actor = await readRequestActorOptionally(request.headers.get("cookie"));

    const captured = await chargePortalPaymentLink(
      {
        token,
        body,
        clientAddress,
        userAgent,
        actorCompanyId: actor?.companyId ?? null,
      },
      runtime,
    );

    logger.info("portal payment link captured", {
      linkId: captured.linkId,
      paymentId: captured.paymentId,
      companyId: captured.companyId,
      amountMinor: captured.amountMinor,
      duplicate: captured.duplicate,
    });

    return NextResponse.json(
      {
        status: "captured",
        linkId: captured.linkId,
        paymentId: captured.paymentId,
        transactionId: captured.transactionId,
        amountMinor: captured.amountMinor,
        amountText: captured.amountText,
        capturedAt: captured.capturedAt,
      } satisfies LinkChargeResponseBody,
      {
        status: 201,
        headers: { ...portalRateLimitHeaders(PORTAL_PAYMENT_LINK_RATE_LIMIT, limit), "cache-control": "no-store" },
      },
    );
  },
);
