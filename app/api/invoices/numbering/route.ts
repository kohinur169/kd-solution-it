// path: app/api/invoices/numbering/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  getInvoiceNumberSettings,
  parseInvoiceNumberSettings,
  updateInvoiceNumberSettings,
  type InvoiceNumberSettings,
} from "@/services/invoices/invoice-numbering";

export const dynamic = "force-dynamic";

/** Five short fields; 4 KiB holds a prefix and a padding many times over. */
const maximumBodyBytes = 4_096;

interface SettingsBody {
  readonly status: "saved";
  readonly settings: InvoiceNumberSettings;
}

/**
 * The merchant's invoice numbering series.
 *
 * ## Why a read and a write share a path
 *
 * They address the same object - one merchant's series - and the write answers with what the read would: the
 * saved settings, including the preview number and the highest number already printed. A screen that had to
 * re-read after saving would show the old preview for a frame, and the preview is the only way a merchant sees
 * what their prefix and padding produce before an invoice carries it into the world.
 *
 * ## Why the GET carries no CSRF token
 *
 * It changes nothing. The session and the company come from the cookie, and `no-store` keeps a merchant's
 * numbering out of any shared cache.
 *
 * ## The order of the checks on the POST
 *
 * CSRF first, then the declared length, then the session, then the body's shape, then the service, which
 * applies the `owner` role and refuses a `next_number` that would reissue a number the merchant has already
 * printed.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<InvoiceNumberSettings>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });
  const settings = await getInvoiceNumberSettings({ actor }, { rest: runtime.rest, audit: runtime.audit });

  return NextResponse.json(settings, { status: 200, headers: { "cache-control": "no-store" } });
});

export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<SettingsBody>> => {
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
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "prefix", rule: "invalid_format" }] });
  }

  // The company is resolved before parsing because the parser has to read the merchant's printed numbers to
  // refuse a value that would reissue one - and that read must be scoped to the merchant asking.
  const settings = await parseInvoiceNumberSettings(body, {
    companyId: actor.companyId ?? "",
    rest: runtime.rest,
  });
  const saved = await updateInvoiceNumberSettings({ actor, settings }, { rest: runtime.rest, audit: runtime.audit });

  logger.info("invoice numbering settings saved", {
    userId: actor.userId,
    prefix: saved.prefix,
    nextNumber: saved.nextNumber,
    padding: saved.padding,
  });

  return NextResponse.json(
    { status: "saved", settings: saved },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
