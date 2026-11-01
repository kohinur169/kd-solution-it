// path: app/api/auth/2fa/backup-codes/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { regenerateBackupCodes } from "@/lib/auth/backup-codes";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** One code in JSON. */
const maximumBodyBytes = 1_024;

interface RegenerateResponseBody {
  readonly backupCodes: readonly string[];
  readonly replaced: number;
}

/**
 * Replace the account's backup codes with a fresh set of ten.
 *
 * Two proofs are required and both are checked before anything is written: the session cookie says
 * which account is asking, and the current authenticator code says the person still holds the
 * second factor. A session alone is not enough - a set of ten codes is ten new ways in, and a stolen
 * session must not be able to mint them.
 *
 * The answer is the only time these codes exist in clear: the platform stores scrypt verifiers, so
 * a second request cannot recover them and the screen says so before the person leaves it.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<RegenerateResponseBody>> => {
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

    const result = await regenerateBackupCodes(
      { userId: actor.userId, code },
      { rest: runtime.rest, audit: runtime.audit, masterKey: runtime.masterKey },
    );

    logger.info("backup codes regenerated", {
      userId: actor.userId,
      issued: result.backupCodes.length,
      replaced: result.replaced,
    });

    return NextResponse.json(
      { backupCodes: result.backupCodes, replaced: result.replaced } satisfies RegenerateResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
