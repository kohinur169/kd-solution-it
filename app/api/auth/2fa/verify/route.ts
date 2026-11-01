// path: app/api/auth/2fa/verify/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { completeTwoFactorChallenge } from "@/lib/auth/two-factor-login";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** One handle and one code. */
const maximumBodyBytes = 2_048;

interface VerifyResponseBody {
  readonly status: "signed_in";
  readonly deviceProofRequired: boolean;
  /** Which credential answered the second factor. The screen says so; nothing else reads it. */
  readonly secondFactor: "totp" | "backup_code";
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }

  const value = (body as Readonly<Record<string, unknown>>)[key];

  return typeof value === "string" ? value : null;
}

/**
 * The second factor step of sign in.
 *
 * The password route answered `two_factor_required` with a handle and wrote no cookie; this route
 * presents that handle and a code, and only a correct one produces a session. The cookie is written
 * here and nowhere else on this path, which is what makes the step a step rather than a redirect.
 *
 * A refusal is the same `AUTHENTICATION_REQUIRED` envelope a wrong password produces, so this route
 * never distinguishes an expired challenge from a wrong code from a challenge that never existed.
 * The attempt row is written by the service, with `factor = 'totp'`, so the lock of STEP 045 counts
 * these failures beside password failures without a second recorder.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<VerifyResponseBody>> => {
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
      throw new AppError("AUTHENTICATION_REQUIRED");
    }

    const challengeToken = readString(body, "challengeToken");
    const code = readString(body, "code");

    if (challengeToken === null || code === null) {
      throw new AppError("AUTHENTICATION_REQUIRED");
    }

    const runtime = getAuthRuntime();
    const result = await completeTwoFactorChallenge(
      {
        challengeToken,
        code,
        remoteIp: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      {
        rest: runtime.rest,
        audit: runtime.audit,
        attempts: runtime.attempts,
        cookiePolicy: runtime.cookiePolicy,
        masterKey: runtime.masterKey,
      },
    );

    logger.info("second factor accepted", {
      userId: result.userId,
      method: result.method,
    });

    const response = NextResponse.json(
      {
        status: "signed_in",
        deviceProofRequired: result.deviceProofRequired,
        secondFactor: result.method,
      } satisfies VerifyResponseBody,
      {
        status: 200,
        headers: {
          "cache-control": "no-store, max-age=0",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );

    for (const cookie of result.cookies) {
      response.headers.append("set-cookie", cookie);
    }

    return response;
  },
);
