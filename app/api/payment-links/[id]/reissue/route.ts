// path: app/api/payment-links/[id]/reissue/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  reissuePortalPaymentLinkById,
  type ReissuedPortalPaymentLink,
} from "@/app/(client-portal)/portal-payment-link";
import { getPortalPaymentLinkRuntime } from "@/app/(client-portal)/portal-payment-link-runtime";

export const dynamic = "force-dynamic";

/** A reissue carries no field either, so the body is read only to be refused when it is too large. */
const maximumBodyBytes = 512;

interface ReissueResponseBody {
  readonly status: "reissued";
  readonly linkId: string;
  readonly token: string;
  readonly tokenId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly reissueCount: number;
}

/**
 * Mint a fresh credential for a link that is out of circulation.
 *
 * Only a revoked or expired link is reissuable, and a paid one never: the money has moved, and a second
 * credential for the same request would be a way to charge it again. The new token names the same row under a
 * new id, so the credential the merchant already shared stops resolving to anything at all - a payer holding the
 * old URL is told the link cannot be opened rather than that it was reissued.
 *
 * The answer carries the token, exactly as a creation's does, because this response is the only place the
 * merchant can ever see it. The console shows the URL and offers a copy button; nothing else on the platform can
 * recover it, and the row keeps only its digest.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<ReissueResponseBody>> => {
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

    const reissued: ReissuedPortalPaymentLink = await reissuePortalPaymentLinkById(
      { actor, linkId },
      getPortalPaymentLinkRuntime(),
    );

    logger.info("portal payment link reissued", {
      linkId: reissued.linkId,
      companyId: reissued.companyId,
      actorUserId: actor.userId,
      reissueCount: reissued.reissueCount,
    });

    return NextResponse.json(
      {
        status: "reissued",
        linkId: reissued.linkId,
        token: reissued.token,
        tokenId: reissued.tokenId,
        url: reissued.url,
        expiresAt: new Date(reissued.expiresAtEpochMs).toISOString(),
        reissueCount: reissued.reissueCount,
      } satisfies ReissueResponseBody,
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
