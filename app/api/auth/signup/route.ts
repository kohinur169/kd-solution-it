// path: app/api/auth/signup/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { registerMerchant } from "@/lib/auth/registration";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** The largest signup body the route will read. A form of four fields is a few hundred bytes. */
const maximumBodyBytes = 8_192;

interface SignupResponseBody {
  readonly status: "verification_required" | "signed_up";
}

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
 *   - `201` with `verification_required` when the provider sent a confirmation mail;
 *   - `201` with `signed_up` when the project confirms addresses automatically;
 *   - a `VALIDATION_FAILED` envelope for a form problem, an unaccepted policy or a failed challenge,
 *     with details that name fields and never values;
 *   - a `429`, `502` or `503` when the platform or the provider is the problem.
 *
 * Rate limiting of this endpoint is STEP 055's: the route is written so that the limiter can wrap it
 * without changing the handler.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<SignupResponseBody>> => {
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
      audit: runtime.audit,
    },
  );

  logger.info("merchant signup accepted", {
    userId: result.userId,
    companyId: result.companyId,
    verificationRequired: result.verificationRequired,
  });

  return NextResponse.json(
    { status: result.verificationRequired ? "verification_required" : "signed_up" },
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
