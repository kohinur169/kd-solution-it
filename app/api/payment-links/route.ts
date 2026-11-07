// path: app/api/payment-links/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES, PORTAL_PAYMENT_LINK_PAGE_LIMIT } from "@/app/(client-portal)/portal-payment-link-fields";
import {
  createPortalPaymentLink,
  listPortalPaymentLinks,
  type CreatedPortalPaymentLink,
  type PortalPaymentLinkView,
} from "@/app/(client-portal)/portal-payment-link";
import { getPortalPaymentLinkRuntime } from "@/app/(client-portal)/portal-payment-link-runtime";

export const dynamic = "force-dynamic";

interface CreatedResponseBody {
  readonly status: "created";
  readonly linkId: string;
  readonly token: string;
  readonly tokenId: string;
  readonly url: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly description: string;
  readonly reference: string | null;
  readonly expiresAt: string;
}

interface ListedResponseBody {
  readonly links: readonly {
    readonly linkId: string;
    readonly amountMinor: string;
    readonly amountText: string;
    readonly currency: string;
    readonly description: string;
    readonly reference: string | null;
    readonly state: string;
    readonly expiresAt: string;
    readonly paidAt: string | null;
  }[];
}

/** The body of a creation, read loosely here and validated strictly by the service. */
function bodyOf(text: string): unknown {
  if (text.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "invalid_format" }] });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "invalid_format" }] });
  }
}

/** The ceiling, checked twice: the declared length before the body is held, and the bytes after. */
async function readBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  return bodyOf(text);
}

/**
 * Make one general payment link.
 *
 * The route is a boundary and nothing more: the CSRF token, the body ceiling, the actor from the session, and
 * one call into the service. The plan entitlement, the amount's two bounds and the provider's cents, the
 * description and the lifetime, the role and the tenant are all inside `createPortalPaymentLink`, so a second
 * caller cannot get a weaker link by calling anything else.
 *
 * The token comes back exactly once. It is the link's whole secret, the row keeps only its digest, and a
 * response is the only place a merchant ever receives it: re-reading the list cannot recover it, which is why
 * the console shows the URL on the creation and replaces it with an offer to reissue afterwards.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<CreatedResponseBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const body = await readBody(request);
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const created: CreatedPortalPaymentLink = await createPortalPaymentLink({ actor, body }, getPortalPaymentLinkRuntime());

    logger.info("portal payment link created", {
      linkId: created.linkId,
      companyId: created.companyId,
      amountMinor: created.amountMinor,
      actorUserId: actor.userId,
    });

    return NextResponse.json(
      {
        status: "created",
        linkId: created.linkId,
        token: created.token,
        tokenId: created.tokenId,
        url: created.url,
        amountMinor: created.amountMinor,
        amountText: created.amountText,
        description: created.description,
        reference: created.reference,
        expiresAt: new Date(created.expiresAtEpochMs).toISOString(),
      } satisfies CreatedResponseBody,
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);

/**
 * The merchant's links, newest first.
 *
 * A limited read rather than a paginated one: a merchant's live links are a handful, and the cap is the page
 * size `listPortalPaymentLinks` already applies. Nothing here is a token: the list carries the link's id, its
 * amount and its state, and there is no column on the row that could reconstruct the URL.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<ListedResponseBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  const requested = new URL(request.url).searchParams.get("limit");
  const parsed = requested === null ? Number.NaN : Number.parseInt(requested, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), PORTAL_PAYMENT_LINK_PAGE_LIMIT) : PORTAL_PAYMENT_LINK_PAGE_LIMIT;

  const links = await listPortalPaymentLinks({ actor, limit }, getPortalPaymentLinkRuntime());

  return NextResponse.json(
    {
      links: links.map((link: PortalPaymentLinkView & { readonly createdAtEpochMs: number }) => ({
        linkId: link.linkId,
        amountMinor: link.amountMinor,
        amountText: link.amountText,
        currency: link.currency,
        description: link.description,
        reference: link.reference,
        state: link.state,
        expiresAt: new Date(link.expiresAtEpochMs).toISOString(),
        paidAt: link.paidAtEpochMs === null ? null : new Date(link.paidAtEpochMs).toISOString(),
      })),
    } satisfies ListedResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
