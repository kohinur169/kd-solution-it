// path: app/api/onboarding/business-profile/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  saveBusinessProfile,
  type BusinessProfileSnapshot,
} from "@/services/kyc/business-profile";

export const dynamic = "force-dynamic";

/** Seven short fields and a description. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

interface SaveProfileBody {
  readonly status: "saved";
  readonly companyId: string;
  readonly values: BusinessProfileSnapshot["values"];
  readonly coverage: BusinessProfileSnapshot["coverage"];
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly savedAtEpochMs: number | null;
  readonly completedAtEpochMs: number | null;
}

/**
 * Section 5's business information, over HTTP.
 *
 * ## One action, one body of fields
 *
 * The body is an object of field names to values, and the service refuses a key it does not know
 * rather than ignoring it - a form from another build must be told it is stale, not stored halfway.
 * The company never appears in the body: the service takes it from the session, so a crafted request
 * cannot write another merchant's profile.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the parse, then the service, which applies
 * the `owner` role, the company scope and every field rule beside the write they guard. A refusal
 * names every field that failed and the rule it broke, so the form can mark them all at once.
 *
 * ## Why no device proof
 *
 * The same reason as the onboarding position of STEP 079: a merchant who signed up minutes ago has no
 * confirmed device, and this is a draft on their own company's row. The acts that change account
 * security or another account's data keep STEP 050's proof; the gate of
 * `services/kyc/business-profile-verify.ts` asserts this route does not ask for it, so the decision
 * is recorded rather than implied.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<SaveProfileBody>> => {
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
        details: [{ field: "profile", rule: "invalid_format" }],
      });
    }

    const snapshot: BusinessProfileSnapshot = await saveBusinessProfile(
      {
        actor,
        input: body,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("business profile saved", {
      userId: actor.userId,
      companyId: snapshot.companyId,
      complete: snapshot.complete,
      missing: snapshot.missing.length,
    });

    return NextResponse.json(
      {
        status: "saved",
        companyId: snapshot.companyId,
        values: snapshot.values,
        coverage: snapshot.coverage,
        complete: snapshot.complete,
        missing: snapshot.missing,
        savedAtEpochMs: snapshot.savedAtEpochMs,
        completedAtEpochMs: snapshot.completedAtEpochMs,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
