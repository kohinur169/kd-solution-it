// path: app/api/onboarding/kyc-document-review/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { reviewKycDocument, type KycReviewDocument } from "@/services/kyc/kyc-review";

export const dynamic = "force-dynamic";

/** Three small fields. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

/**
 * Accept or reject one uploaded KYC document, from the document viewer of STEP 088.
 *
 * The body is `{ "document_id": "<uuid>", "decision": "accept" | "reject", "reason": "..." }`; the
 * reason is required exactly when the decision is `reject`, which is `0049`'s own rejection check.
 * The company is never in the body - the service looks the document up by its id and scopes the
 * write to the company that row belongs to. The service applies `KYC_REVIEW_OFFICE_ROLES`, writes
 * one conditional update with the version bumped, audits the decision, and answers the updated
 * document.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the JSON parse, then the service. The
 * answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<KycReviewDocument>> => {
    // STEP 057: a form post from another origin cannot read the token this compares.
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();
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
        details: [{ field: "body", rule: "invalid_format" }],
      });
    }

    const document = await reviewKycDocument(
      { actor, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("kyc document reviewed", {
      userId: actor.userId,
      documentId: document.id,
      status: document.status,
    });

    return NextResponse.json(document, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
