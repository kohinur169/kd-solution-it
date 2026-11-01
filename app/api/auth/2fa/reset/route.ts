// path: app/api/auth/2fa/reset/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { requestTwoFactorReset } from "@/lib/auth/two-factor-reset";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** An address and a reason. */
const maximumBodyBytes = 4_096;

interface ResetResponseBody {
  readonly status: "accepted";
}

/**
 * A merchant asks the office to reset the second factor on their account.
 *
 * Anonymous by necessity: the person who cannot sign in is the person this route serves. The answer
 * is one sentence and one status code, whatever the platform found, because the alternative - "no
 * such account" beside "we will be in touch" - turns a recovery form into an account directory.
 *
 * The rate limit of STEP 055 sits in front of this route; until then the body bound, the bounded
 * reason and the one-live-request index are what keep it from being a lever.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ResetResponseBody>> => {
    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "reason", rule: "invalid_format" }],
      });
    }

    const runtime = getAuthRuntime();
    const result = await requestTwoFactorReset(
      {
        request: body,
        remoteIp: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    // The log line names no address: a recovery form that writes addresses to a log is a second
    // place a stranger's data lives.
    logger.info("two factor reset requested", { accepted: result.accepted });

    return NextResponse.json({ status: "accepted" } satisfies ResetResponseBody, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  },
);
