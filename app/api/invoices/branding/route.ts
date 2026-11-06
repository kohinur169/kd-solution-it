// path: app/api/invoices/branding/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { invoicePdfDependencies } from "@/services/invoices/invoice-pdf-document";
import {
  parseInvoiceBrandingInput,
  readInvoiceBranding,
  updateInvoiceBranding,
  type InvoiceBrandingSnapshot,
} from "@/services/invoices/invoice-branding";

export const dynamic = "force-dynamic";

/** Ten short fields and two notes of at most 300 characters: 8 KiB holds the whole form twice over. */
const maximumBodyBytes = 8_192;

interface BrandingBody {
  readonly status: "saved";
  readonly snapshot: InvoiceBrandingSnapshot;
}

/**
 * The merchant's invoice branding: section 16 line 184, "Merchants can set their own logo and invoice
 * branding".
 *
 * ## Why a read and a write share a path
 *
 * They address the same object - one merchant's brand - and the write answers with what the read would: the
 * saved settings, the facts they were applied to, and the preview those two produce. A screen that had to
 * re-read after saving would show the old preview for a frame, and the preview is the only way a merchant
 * sees what their tagline and their toggles put on a document before a client does.
 *
 * ## Why the GET carries no CSRF token
 *
 * It changes nothing. The session and the company come from the cookie, and `no-store` keeps a merchant's
 * tax id and a short-lived URL for their logo out of any shared cache.
 *
 * ## The order of the checks on the POST
 *
 * CSRF first, then the declared length, then the session, then the body's shape, then the service - which
 * applies the `owner` role, proves a newly chosen logo can actually be drawn on a PDF, and refuses a save
 * whose version the row has outgrown. A forged request costs a string comparison and never reaches a query.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<InvoiceBrandingSnapshot>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const snapshot = await readInvoiceBranding({ actor }, invoicePdfDependencies());

    return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
  },
);

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<BrandingBody>> => {
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

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "branding", rule: "invalid_format" }],
      });
    }

    const values = parseInvoiceBrandingInput(body);
    const snapshot = await updateInvoiceBranding({ actor, values }, invoicePdfDependencies());

    logger.info("invoice branding saved", {
      userId: actor.userId,
      nameStyle: snapshot.settings.nameStyle,
      showLogo: snapshot.settings.showLogo,
      hasLogo: snapshot.settings.logoFileId !== null,
      hasTagline: snapshot.settings.tagline !== null,
      hasFooterNote: snapshot.settings.footerNote !== null,
      hasAccent: snapshot.settings.accentColour !== null,
    });

    return NextResponse.json(
      { status: "saved", snapshot },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
