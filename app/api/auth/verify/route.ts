// path: app/api/auth/verify/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { completeEmailVerification } from "@/lib/auth/email-verification";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** Where the browser lands after the link was followed. */
const verificationPagePath = "/verify";

function statusUrl(request: Request, status: string): URL {
  const url = new URL(verificationPagePath, request.url);

  url.searchParams.set("status", status);

  return url;
}

/**
 * The confirmation link target.
 *
 * Supabase sends `token_hash` and `type` to whatever the mail template points at. The template of
 * section 23 therefore points here, and this route is the only place a token is exchanged for a
 * session:
 *
 *   1. the token is verified by the provider, which is the proof that the mailbox is controlled;
 *   2. the platform row records the verification and an audit entry names it;
 *   3. the `__Host-kd_session` cookie is written and the browser is sent to a page that says so.
 *
 * Every failure that a browser can reach is a redirect and not a JSON envelope, because the person
 * following a mail is not an API client: an expired link and an unusable platform both say so on the
 * page. A failure the platform does not understand still reaches `withErrorResponse`, so the
 * envelope and the structured log of STEP 008 apply to it.
 */
export const GET = withErrorResponse(async (request: Request): Promise<Response> => {
  // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
  // never reaches the body, the session or the work behind them.
  await enforceRateLimit({ request, scope: "verify" }, getAuthRuntime());

  const url = new URL(request.url);
  const runtime = getAuthRuntime();

  try {
    const result = await completeEmailVerification(
      {
        tokenHash: url.searchParams.get("token_hash") ?? "",
        type: url.searchParams.get("type") ?? "",
        remoteIp: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      {
        auth: runtime.client,
        rest: runtime.rest,
        audit: runtime.audit,
        cookiePolicy: runtime.cookiePolicy,
      },
    );

    logger.info("email verification completed", {
      userId: result.userId,
      companyId: result.companyId,
    });

    const response = NextResponse.redirect(statusUrl(request, "verified"), 303);

    for (const cookie of result.cookies) {
      response.headers.append("set-cookie", cookie);
    }

    response.headers.set("cache-control", "no-store, max-age=0");

    return response;
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_FAILED") {
      logger.warn("email verification link was not accepted", { code: error.code });

      return NextResponse.redirect(statusUrl(request, "invalid"), 303);
    }

    if (
      error instanceof AppError &&
      (error.code === "DEPENDENCY_FAILED" || error.code === "TIMEOUT" || error.code === "SERVICE_UNAVAILABLE")
    ) {
      logger.warn("email verification could not reach the provider", { code: error.code });

      return NextResponse.redirect(statusUrl(request, "unavailable"), 303);
    }

    throw error;
  }
});
