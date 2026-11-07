// path: app/api/payment-links/[id]/revoke/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { revokePortalPaymentLinkById } from "@/app/(client-portal)/portal-payment-link";
import { getPortalPaymentLinkRuntime } from "@/app/(client-portal)/portal-payment-link-runtime";

export const dynamic = "force-dynamic";

/** A revoke carries no field, so any body at all is a caller that has misread the endpoint. */
const maximumBodyBytes = 512;

interface RevokeResponseBody {
  readonly status: "revoked";
  readonly linkId: string;
  readonly revokedAt: string;
}

/**
 * Retire a payment link's token.
 *
 * The token stops working the moment this answers: the row keeps its digest only, the store's revoke is guarded
 * on the row the caller read, and the payer's next request finds no live credential and is told, in the words
 * every portal page uses for a link that does not verify, that the link cannot be opened.
 *
 * The route is a boundary and nothing more: the CSRF token, a body ceiling, the actor from the session, the id
 * from the path and one call into the service. The role, the tenant, the state and the audit entry are the
 * service's, so a second caller cannot get a weaker revoke by calling anything else. Another merchant's link is
 * `404`, never `403`, because a refusal that confirms a link exists is a refusal that leaks one.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<RevokeResponseBody>> => {
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

    const parameters = await context.params;
    let linkId: string;

    try {
      linkId = decodeURIComponent(parameters.id);
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND");
    }

    const revoked = await revokePortalPaymentLinkById({ actor, linkId }, getPortalPaymentLinkRuntime());

    logger.info("portal payment link revoked", {
      linkId: revoked.linkId,
      companyId: revoked.companyId,
      actorUserId: actor.userId,
    });

    return NextResponse.json(
      {
        status: "revoked",
        linkId: revoked.linkId,
        revokedAt: new Date(revoked.revokedAtEpochMs).toISOString(),
      } satisfies RevokeResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
