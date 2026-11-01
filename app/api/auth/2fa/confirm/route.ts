// path: app/api/auth/2fa/confirm/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { getMessage } from "@/lib/i18n/messages";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { confirmTotpEnrolment } from "@/lib/auth/two-factor";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** A confirmation body is one code in JSON. */
const maximumBodyBytes = 1_024;

interface ConfirmResponseBody {
  readonly status: "enrolled";
  /** The ten codes, in the order they are shown. This is the only time they exist in clear. */
  readonly backupCodes: readonly string[];
}

/**
 * Confirm TOTP enrolment with the first code from the authenticator app.
 *
 * The code proves the app holds the secret, so this is the request that turns an enrolment in
 * progress into a second factor. On success the platform writes ten backup codes and answers with
 * them once; they are stored only as scrypt verifiers, so a later request cannot recover them and
 * the screen has to tell the person to keep them.
 *
 * A wrong code is `VALIDATION_FAILED` with `field: "code"`, which is the one refusal on this route
 * that a person can act on. Everything else - no session, an account that is already enrolled, an
 * enrolment that was never started - keeps the meaning it has elsewhere in the catalogue.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ConfirmResponseBody>> => {
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
        details: [{ field: "code", rule: "invalid_format" }],
      });
    }

    const code =
      typeof body === "object" && body !== null && "code" in body
        ? (body as { readonly code?: unknown }).code
        : undefined;

    if (typeof code !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "code", rule: "invalid_format" }],
      });
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
    });

    const result = await confirmTotpEnrolment(
      { userId: actor.userId, code },
      {
        rest: runtime.rest,
        audit: runtime.audit,
        masterKey: runtime.masterKey,
        issuer: getMessage("brand.name"),
      },
    );

    logger.info("totp enrolment confirmed", {
      userId: actor.userId,
      backupCodes: result.backupCodes.length,
    });

    return NextResponse.json(
      { status: "enrolled", backupCodes: result.backupCodes } satisfies ConfirmResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
