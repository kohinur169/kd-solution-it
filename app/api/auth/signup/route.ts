// path: app/api/auth/signup/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { SIGNUP_ACCEPTANCE, type SignupAcceptance } from "@/lib/auth/disclosure";
import { registerMerchant } from "@/lib/auth/registration";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/** The largest signup body the route will read. A form of four fields is a few hundred bytes. */
const maximumBodyBytes = 8_192;


function readDeclaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");

  if (header === null) {
    return null;
  }

  const parsed = Number.parseInt(header, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Merchant signup.
 *
 * The route is a boundary and nothing else: it reads the address and the agent of the request, hands
 * the body to the registration service and answers. Every decision - the password shape, the
 * Turnstile challenge, which policies must be accepted, which rows are written - belongs to the
 * service, so the same behaviour is what the gate exercises and what a route cannot accidentally
 * vary.
 *
 * Answer shapes:
 *
 *   - `201` with `{"status":"verification_required"}` for **every** accepted form, whether the
 *     address was new or already registered. One body, one sentence, one status code: the answer is
 *     a property of the form and never of the directory (section 22 line 243). The mail that
 *     arrives, or does not, is the only thing that differs, and only the address holder sees it;
 *   - a `VALIDATION_FAILED` envelope for a form problem, an unaccepted policy or a failed challenge,
 *     with details that name fields and never values;
 *   - a `429`, `502` or `503` when the platform or the provider is the problem.
 *
 * The old `signed_up` variant is gone with it. A project that confirms addresses automatically
 * would otherwise answer a new address differently from a registered one, which is the leak in its
 * purest form; and the platform requires verification anyway (section 22), so the merchant is told
 * to check their mail either way.
 *
 * Rate limiting of this endpoint is STEP 055's: the route is written so that the limiter can wrap it
 * without changing the handler.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<SignupAcceptance>> => {
  // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
  // never reaches the body, the session or the work behind them.
  await enforceRateLimit({ request, scope: "signup" }, getAuthRuntime());

  // STEP 057: a form post from another origin cannot read the token this compares.
  requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

  const declaredLength = readDeclaredLength(request);

  if (declaredLength !== null && declaredLength > maximumBodyBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "form", rule: "invalid_json" }],
    });
  }

  const runtime = getAuthRuntime();
  const result = await registerMerchant(
    {
      request: body,
      remoteIp: readClientAddress(request.headers),
      userAgent: readUserAgent(request.headers),
    },
    {
      auth: runtime.client,
      admin: runtime.admin,
      rest: runtime.rest,
      policies: runtime.policies,
      turnstile: runtime.turnstile,
      breachCheck: runtime.breachCheck,
      audit: runtime.audit,
    },
  );

  // The log line is where the difference is allowed to exist, and it is narrower than it looks: a
  // duplicate records that an address was answered generically and not which address it was. The
  // body below is the same literal for both, so no reader of this function can vary it by accident.
  if (result.status === "created") {
    logger.info("merchant signup accepted", {
      userId: result.userId,
      companyId: result.companyId,
      verificationRequired: result.verificationRequired,
    });
  } else {
    logger.info("merchant signup answered without creating an account", { created: false });
  }

  return NextResponse.json(
    SIGNUP_ACCEPTANCE,
    {
      status: 201,
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    },
  );
});
