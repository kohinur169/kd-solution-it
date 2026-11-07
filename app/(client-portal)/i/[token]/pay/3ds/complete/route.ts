// path: app/(client-portal)/i/[token]/pay/3ds/complete/route.ts
import { NextResponse } from "next/server";
import { readClientAddress, readUserAgent } from "../../../../../../../lib/auth/client-address.ts";
import { getAuthRuntime } from "../../../../../../../lib/auth/runtime.ts";
import { AppError, isAppError } from "../../../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../../../lib/logger/logger.ts";
import { csrfPolicy, readCsrfCookie, requireCsrfToken } from "../../../../../../../lib/security/csrf.ts";
import {
  PORTAL_PAYMENT_RULES,
  PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION,
} from "../../../../../portal-payment-fields.ts";
import {
  PORTAL_THREE_DS_MAXIMUM_BODY_BYTES,
  PORTAL_THREE_DS_RATE_LIMIT,
  PORTAL_THREE_DS_RESULT_FIELDS,
  PORTAL_THREE_DS_RESULT_PATH,
  PORTAL_THREE_DS_RULES,
  portalThreeDsResultStateOf,
} from "../../../../../portal-three-ds-fields.ts";
import { completePortalThreeDs } from "../../../../../portal-three-ds.ts";
import { getPortalThreeDsRuntime } from "../../../../../portal-three-ds-runtime.ts";
import { readRequestActorOptionally } from "../../../../../portal-invoice-runtime.ts";
import { enforcePortalRateLimit } from "../../../../../portal-rate-limit.ts";

export const dynamic = "force-dynamic";

/**
 * The issuer's return: the cardholder's answer to a 3D Secure challenge, and what it means for the money.
 *
 * ## Why this route is different from every other mutating route
 *
 * It is the one place in the platform where a third party posts to a state-changing URL in a browser that may
 * hold no cookie at all. Two consequences, both deliberate:
 *
 *   1. **The session is optional and the CSRF token is required exactly when there is one.** CSRF defends
 *      ambient authority: a signed-in merchant's browser must present the double-submit token, because
 *      otherwise another site could make that session finish a challenge. A payer has no session, and the
 *      request's authority is the sealed handle in its body, which no other site can forge - so the check is
 *      the handle, and asking a cardholder to hold a CSRF cookie through a bank's redirect would break the
 *      flow for no gain.
 *   2. **The answer is a redirect, not a body.** The issuer posts a form; the cardholder's browser is looking
 *      at whatever this returns. So the payment is settled here and the browser is sent to a page that says
 *      what happened - a JSON envelope at the end of a bank's flow is a blank screen with braces on it.
 *
 * ## What it reads
 *
 * Exactly `PaRes` and `MD`, and nothing else: the flow's parser refuses a third field, a control character, an
 * empty value and anything longer than the ceilings. `PaRes` is the issuer's answer and is passed to the
 * provider unread; `MD` is this platform's sealed handle, and the only thing that says which payment the
 * answer belongs to.
 *
 * ## Why a replay is not a second payment
 *
 * The handle is claimed once. A second arrival for the same challenge is refused as a replay, and even if it
 * were not, the charge behind it carries the payer's own idempotency key, so the second attempt answers the
 * first payment instead of making another.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse> => {
    const runtime = getPortalThreeDsRuntime();
    const policy = getAuthRuntime().cookiePolicy;

    // The token is required when the browser carries a session, because that is the authority a cross-site
    // request could borrow. A cardholder mid-challenge has none, and the sealed handle is the authority here.
    if (readCsrfCookie(request.headers.get("cookie"), csrfPolicy({ secure: policy.secure })) !== null) {
      requireCsrfToken(request, { secure: policy.secure });
    }

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
    await enforcePortalRateLimit(
      PORTAL_THREE_DS_RATE_LIMIT,
      { clientAddress, userAgent, route: "/i/[token]/pay/3ds/complete" },
      { rest: runtime.payment.rest, audit: runtime.payment.audit },
    );

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_THREE_DS_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const parameters = await context.params;
    let token: string;

    try {
      token = decodeURIComponent(parameters.token);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const actor = await readRequestActorOptionally(request.headers.get("cookie"));
    const resultPath = `/i/${encodeURIComponent(token)}${PORTAL_THREE_DS_RESULT_PATH}`;

    try {
      const completed = await completePortalThreeDs(
        {
          token,
          body: readChallengeResult(bodyText),
          clientAddress,
          userAgent,
          actorCompanyId: actor?.companyId ?? null,
        },
        runtime,
      );

      if (completed.status === "review") {
        return redirect(request, `${resultPath}?state=review`);
      }

      logger.info("portal card payment captured after a 3DS challenge", {
        invoiceId: completed.payment.invoiceId,
        paymentId: completed.payment.paymentId,
        companyId: completed.payment.companyId,
        outcome: completed.outcome,
        basis: completed.basis,
      });

      return redirect(request, `${resultPath}?state=captured`);
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }

      const rule = error.details[0]?.rule ?? PORTAL_PAYMENT_RULES.notPayable;

      // An unknown outcome is written down here rather than by the flow, because the flow refuses before it
      // can settle: the answer may still arrive, and a reconciliation needs the fact that one was promised.
      if (rule === PORTAL_PAYMENT_RULES.outcomeUnknown) {
        logger.warn("portal 3DS completion could not be confirmed", {
          rule,
          route: "/i/[token]/pay/3ds/complete",
          action: PORTAL_PAYMENT_UNKNOWN_AUDIT_ACTION,
        });
      }

      return redirect(request, `${resultPath}?state=${portalThreeDsResultStateOf(rule)}`);
    }
  },
);

/** A 303 to a path of this deployment, built against the request so no host header decides it. */
function redirect(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), { status: 303 });
}

/**
 * The issuer's form, as an object the flow can parse.
 *
 * The body is `application/x-www-form-urlencoded` because a form is what a bank posts. Exactly the two fields
 * the flow names are kept: a repeated field is refused rather than resolved, because the second value of a
 * field is how a form is made to say two things at once.
 */
function readChallengeResult(bodyText: string): unknown {
  const parsed = new URLSearchParams(bodyText);
  const kept: Record<string, string> = Object.create(null) as Record<string, string>;

  for (const [key, value] of parsed) {
    if (!(PORTAL_THREE_DS_RESULT_FIELDS as readonly string[]).includes(key)) {
      continue;
    }

    if (Object.hasOwn(kept, key)) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: key, rule: PORTAL_THREE_DS_RULES.resultInvalid }],
      });
    }

    kept[key] = value;
  }

  if (!Object.hasOwn(kept, "PaRes") || !Object.hasOwn(kept, "MD")) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "PaRes", rule: PORTAL_THREE_DS_RULES.resultInvalid }],
    });
  }

  return kept;
}
