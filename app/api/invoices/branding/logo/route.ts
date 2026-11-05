// path: app/api/invoices/branding/logo/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { UPLOAD_POLICIES } from "@/lib/security/upload";
import {
  uploadInvoiceLogo,
  type InvoiceBrandingSnapshot,
} from "@/services/invoices/invoice-branding";
import { invoicePdfDependencies } from "@/services/invoices/invoice-pdf-document";

export const dynamic = "force-dynamic";

/**
 * One merchant logo, as multipart form data, and the invoice branding it becomes.
 *
 * ## Why multipart and not JSON
 *
 * The bytes are the payload. Base64 in a JSON body would spend a third of the bandwidth on encoding and
 * still have to be decoded before the magic bytes could be read, and the magic bytes are the whole of the
 * upload's first question. This is the same door `app/api/onboarding/kyc-document/route.ts` opens.
 *
 * ## Why this route adopts the logo as well as storing it
 *
 * STEP 105 built the storage category and deliberately stopped there - no migration, no routes, no UI - so
 * nothing could say which logo an invoice prints. A merchant who uploads a picture and is then asked to go
 * and select it somewhere else has been given two steps for one intention, and the second step is where
 * people stop. So a verified upload that *can* be drawn becomes the invoice logo in the same request, and
 * the answer says so.
 *
 * ## Why an upload can succeed and still not be adopted
 *
 * Two honest cases. A WebP is stored - the platform allows it for a logo, and a web page can use it - but a
 * PDF cannot draw one, so the invoice logo stays the file that prints and the merchant is told at once. And
 * an upload whose declared type did not match its own bytes is quarantined by the storage layer, which is
 * exactly the file that must never be printed on a document a client keeps. Neither case is an error: the
 * upload happened, the branding did not change, and the answer carries both facts.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length (the logo ceiling plus a mebibyte of form overhead), then the session, then
 * the form parse, then the service - which applies the `owner` role, validates the bytes against the
 * `company_logo` policy, seals and records them, and only then decides about the branding row.
 */
const maximumBodyBytes = UPLOAD_POLICIES.company_logo.maximumBytes + 1_048_576;

interface LogoBody {
  readonly status: "uploaded";
  /** True when this file is now the one the merchant's invoices print. */
  readonly adopted: boolean;
  /** True when the bytes were kept aside because they did not match the format they claimed. */
  readonly quarantined: boolean;
  readonly snapshot: InvoiceBrandingSnapshot;
}

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<LogoBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let form: FormData;

    try {
      form = await request.formData();
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "file", rule: "file_not_acceptable" }],
      });
    }

    const file = form.get("file");

    if (!(file instanceof File) || file.size === 0) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "file", rule: "file_not_acceptable" }],
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await uploadInvoiceLogo(
      { actor, fileName: file.name, declaredType: file.type, bytes },
      invoicePdfDependencies(),
    );

    logger.info("invoice logo uploaded", {
      userId: actor.userId,
      byteSize: bytes.length,
      adopted: result.adopted,
      quarantined: result.refusal === "quarantined",
    });

    return NextResponse.json(
      {
        status: "uploaded",
        adopted: result.adopted,
        quarantined: result.refusal === "quarantined",
        snapshot: result.snapshot,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
