// path: app/api/onboarding/progress/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { saveOnboardingStep, type OnboardingProgress } from "@/services/kyc/onboarding-progress";

export const dynamic = "force-dynamic";

/** One step name. 1 KiB is generous for that and still bounded. */
const maximumBodyBytes = 1_024;

interface SaveProgressBody {
  readonly status: "saved";
  readonly companyId: string;
  readonly currentStep: string;
  readonly savedAtEpochMs: number | null;
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

/**
 * Section 5's onboarding position, over HTTP: the shell remembers which step the merchant was on.
 *
 * ## One field, one act
 *
 * The body is `{ step }` and nothing else. The company is never in the body - the service takes it
 * from the session - so a crafted request cannot move another merchant's wizard, and a body that
 * names a company is simply not read.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the parse, then the service, which applies
 * the `owner` role and the step vocabulary beside the write they guard. A refusal names a field and
 * a rule: an unknown step is `422` naming `step`, a role without a company of its own is `403`, and a
 * stranger is `401` from the actor reader.
 *
 * ## Why no device proof and no second factor here
 *
 * Section 5's onboarding is a merchant filling in their own company's draft on the device they signed
 * in on, and a merchant who has just signed up has no confirmed device yet - requiring one would
 * block the first save of the wizard it is meant to open. The acts that change the account's security
 * or another account's data are the ones STEP 050's proof guards; this one writes a position on the
 * caller's own row and is bounded by the CSRF token, the session and the company scope.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<SaveProgressBody>> => {
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
        details: [{ field: "step", rule: "unknown_step" }],
      });
    }

    const step = readField(body, "step");

    if (typeof step !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "step", rule: "unknown_step" }],
      });
    }

    const progress: OnboardingProgress = await saveOnboardingStep(
      {
        actor,
        step,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("onboarding position saved", {
      userId: actor.userId,
      companyId: progress.companyId,
      step: progress.currentStep,
    });

    return NextResponse.json(
      {
        status: "saved",
        companyId: progress.companyId,
        currentStep: progress.currentStep,
        savedAtEpochMs: progress.updatedAtEpochMs,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
