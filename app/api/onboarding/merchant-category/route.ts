// path: app/api/onboarding/merchant-category/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  saveMerchantCategory,
  type MerchantCategorySnapshot,
} from "@/services/kyc/merchant-category";

export const dynamic = "force-dynamic";

/** One four digit code. 1 KiB is generous for that and still bounded. */
const maximumBodyBytes = 1_024;

interface SaveCategoryBody {
  readonly status: "saved";
  readonly companyId: string;
  readonly mccCode: string | null;
  readonly mccTitle: string | null;
  readonly complete: boolean;
  readonly savedAtEpochMs: number | null;
}

/**
 * Section 5's merchant category code, over HTTP.
 *
 * ## One action, one field
 *
 * The body is `{ mcc_code }` and nothing else: the code the merchant chose, or an empty string to
 * clear it. The company is never in the body - the service takes it from the session - so a crafted
 * request cannot set another merchant's category, and a body that names a company is simply not read.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the parse, then the service, which applies
 * the `owner` role, the company scope, the four digit shape and the vocabulary check beside the write
 * they guard. A refusal names the field and the rule: `unknown_code` for a code the published list
 * does not carry, `retired_code` for one no longer offered.
 *
 * ## Why no device proof
 *
 * The same reason as the business profile of STEP 080 and the position of STEP 079: a merchant who
 * signed up minutes ago has no confirmed device, and this is a draft field on their own company's
 * row. The acts that change account security or another account's data keep STEP 050's proof.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<SaveCategoryBody>> => {
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
        details: [{ field: "mcc_code", rule: "invalid_format" }],
      });
    }

    const snapshot: MerchantCategorySnapshot = await saveMerchantCategory(
      {
        actor,
        input: body,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("merchant category saved", {
      userId: actor.userId,
      companyId: snapshot.companyId,
      mccCode: snapshot.mccCode,
      complete: snapshot.complete,
    });

    return NextResponse.json(
      {
        status: "saved",
        companyId: snapshot.companyId,
        mccCode: snapshot.mccCode,
        mccTitle: snapshot.mccTitle,
        complete: snapshot.complete,
        savedAtEpochMs: snapshot.savedAtEpochMs,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
