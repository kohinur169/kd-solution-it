// path: app/api/onboarding/kyc-document/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { KYC_DOCUMENT_MAXIMUM_BYTES } from "@/services/kyc/kyc-capture";
import {
  saveKycDocument,
  type KycPackSnapshot,
} from "@/services/kyc/kyc-capture";

export const dynamic = "force-dynamic";

/**
 * One KYC document, as multipart form data.
 *
 * ## Why multipart and not JSON
 *
 * The bytes are the payload; base64 in a JSON body would spend a third of the bandwidth on
 * encoding and still have to be decoded before the magic bytes can be read. The form carries the
 * file plus the three text fields (`document_type`, `issued_at`, `expires_at`), and the route reads
 * the bytes once and hands them to the service, which is the only place that validates them.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length (the file ceiling of `0057` plus one MiB of form overhead), then
 * the session, then the form parse, then the service - which applies the `owner` role and the
 * company scope and validates the bytes against the declared type before anything is recorded.
 * A refusal names the field and the rule; the answer is the whole pack, `no-store`.
 *
 * ## Why no device proof
 *
 * Same reason as the other onboarding forms: this is a draft on the merchant's own submission.
 */

/** The file ceiling plus the form fields around it. The service re-checks the file's own size. */
const maximumBodyBytes = KYC_DOCUMENT_MAXIMUM_BYTES + 1_048_576;

function formText(form: FormData, key: string): unknown {
  const value = form.get(key);

  return typeof value === "string" ? value : undefined;
}

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<KycPackSnapshot>> => {
    // STEP 057: a form post from another origin cannot read the token this compares.
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
    const snapshot = await saveKycDocument(
      {
        actor,
        input: {
          document_type: formText(form, "document_type"),
          file_name: file.name,
          declared_content_type: file.type,
          bytes,
          issued_at: formText(form, "issued_at"),
          expires_at: formText(form, "expires_at"),
        },
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("kyc document recorded", {
      userId: actor.userId,
      companyId: snapshot.companyId,
      documents: snapshot.documents.length,
      ipAddress: readClientAddress(request.headers),
      userAgent: readUserAgent(request.headers),
    });

    return NextResponse.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
