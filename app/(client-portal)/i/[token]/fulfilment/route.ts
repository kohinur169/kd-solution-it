// path: app/(client-portal)/i/[token]/fulfilment/route.ts
import { NextResponse } from "next/server";
import { getAuthRuntime } from "../../../../../lib/auth/runtime.ts";
import { readRequestActor } from "../../../../../lib/auth/request-actor.ts";
import { AppError } from "../../../../../lib/errors/app-error.ts";
import { withErrorResponse } from "../../../../../lib/errors/respond.ts";
import { logger } from "../../../../../lib/logger/logger.ts";
import { requireCsrfToken } from "../../../../../lib/security/csrf.ts";
import { PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES } from "../../../portal-invoice-fields.ts";
import { recordPortalInvoiceFulfilment } from "../../../portal-invoice-evidence.ts";
import { getPortalInvoiceRuntime } from "../../../portal-invoice-runtime.ts";

export const dynamic = "force-dynamic";

interface FulfilmentResponseBody {
  readonly status: "recorded";
  readonly fulfilmentId: string;
  readonly invoiceId: string;
  readonly kind: string;
  readonly method: string;
  readonly occurredAt: string;
  readonly replaced: boolean;
}

/**
 * The merchant's delivery record, written through the client's own link.
 *
 * This route is the one surface of STEP 181 that requires a session, and it requires more than a session:
 * the service behind it takes the `owner` role, the actor's company, and the token's own company, and
 * refuses unless all three name the same account. So an owner holding somebody else's link gets
 * `PERMISSION_DENIED`, and a buyer holding the link gets `AUTHENTICATION_REQUIRED` - neither of which is a
 * panel the page shows them.
 *
 * It is a route under `i/[token]` rather than one of the merchant's API routes on purpose: STEP 181 owns
 * `app/(client-portal)/`, and the evidence it writes belongs to this page's flow. The CSRF token, the body
 * ceiling and the adapter into the service are exactly those of `app/api/invoices/[id]/void/route.ts`, so
 * nothing about this endpoint is a second kind of mutation.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly token: string }> },
  ): Promise<NextResponse<FulfilmentResponseBody>> => {
    const auth = getAuthRuntime();

    requireCsrfToken(request, { secure: auth.cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: auth.directory,
      cookiePolicy: auth.cookiePolicy,
      sessions: auth.sessions,
      audit: auth.audit,
    });

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "fulfilment", rule: "invalid_format" }],
      });
    }

    const parameters = await context.params;
    let token: string;

    try {
      token = decodeURIComponent(parameters.token);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const runtime = getPortalInvoiceRuntime();
    const recorded = await recordPortalInvoiceFulfilment(
      { actor, token, body },
      { rest: runtime.rest, audit: runtime.audit, tokenKeys: runtime.tokenKeys },
    );

    logger.info("portal invoice fulfilment recorded", {
      invoiceId: recorded.invoiceId,
      fulfilmentId: recorded.fulfilment.id,
      actorUserId: actor.userId,
      replaced: recorded.replaced,
    });

    return NextResponse.json(
      {
        status: "recorded",
        fulfilmentId: recorded.fulfilment.id,
        invoiceId: recorded.invoiceId,
        kind: recorded.fulfilment.kind,
        method: recorded.fulfilment.method,
        occurredAt: recorded.fulfilment.occurredAt,
        replaced: recorded.replaced,
      } satisfies FulfilmentResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
