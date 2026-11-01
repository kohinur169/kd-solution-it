// path: app/api/auth/signin/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { signInMerchant } from "@/lib/auth/signin";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** A sign in body is three short fields. */
const maximumBodyBytes = 4_096;

interface SignedInResponseBody {
  readonly status: "signed_in";
  readonly deviceProofRequired: boolean;
}

interface TwoFactorResponseBody {
  readonly status: "two_factor_required";
  readonly deviceProofRequired: boolean;
  /** The handle of the challenge, presented with the code. Not a session. */
  readonly challengeToken: string;
  readonly expiresAtEpochMs: number;
}

type SigninResponseBody = SignedInResponseBody | TwoFactorResponseBody;

function readDeclaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");

  if (header === null) {
    return null;
  }

  const parsed = Number.parseInt(header, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Password sign in.
 *
 * The route is a boundary: it reads the address and the agent, refuses an oversized body and hands
 * the rest to `signInMerchant`. Every refusal a stranger can cause is the same
 * `AUTHENTICATION_REQUIRED` envelope, and the session cookie is written only when the service
 * returned one - after the audit entry and the attempt row.
 *
 * The attempt row is deliberately written by the service rather than the route: a route that
 * records and a route that forgets would make the lock of STEP 045 depend on which handler answered.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<SigninResponseBody>> => {
  const declaredLength = readDeclaredLength(request);

  if (declaredLength !== null && declaredLength > maximumBodyBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new AppError("AUTHENTICATION_REQUIRED");
  }

  const runtime = getAuthRuntime();
  const result = await signInMerchant(
    {
      request: body,
      remoteIp: readClientAddress(request.headers),
      userAgent: readUserAgent(request.headers),
    },
    {
      auth: runtime.client,
      rest: runtime.rest,
      turnstile: runtime.turnstile,
      attempts: runtime.attempts,
      audit: runtime.audit,
      cookiePolicy: runtime.cookiePolicy,
      masterKey: runtime.masterKey,
    },
  );

  logger.info(
    result.outcome === "signed_in" ? "merchant signed in" : "merchant challenged for the second factor",
    {
      userId: result.userId,
      device: result.device.label,
      deviceProofRequired: result.deviceProofRequired,
    },
  );

  // A challenge is not a session: the answer says what to do next and writes no cookie. The
  // `set-cookie` loop below sees an empty list, which is exactly the property this STEP needs.
  const responseBody: SigninResponseBody =
    result.outcome === "signed_in"
      ? { status: "signed_in", deviceProofRequired: result.deviceProofRequired }
      : {
          status: "two_factor_required",
          deviceProofRequired: result.deviceProofRequired,
          challengeToken: result.challengeToken,
          expiresAtEpochMs: result.expiresAtEpochMs,
        };
  const response = NextResponse.json(
    responseBody,
    {
      status: 200,
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    },
  );

  if (result.outcome === "signed_in") {
    for (const cookie of result.cookies) {
      response.headers.append("set-cookie", cookie);
    }
  }

  return response;
});
