// path: app/api/auth/2fa/backup-codes/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { regenerateBackupCodes } from "@/lib/auth/backup-codes";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

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
    // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
    // never reaches the body, the session or the work behind them.
    await enforceRateLimit({ request, scope: "backup_codes" }, getAuthRuntime());

    // STEP 057: a form post from another origin cannot read the token this compares.
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    // The body is read once, as text, because the signature covers these exact bytes: a parse
    // followed by a re-serialise would verify a different document from the one that was signed.
    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // Before the parser sees a byte: a tampered body fails the proof, not a schema.
    // STEP 052: the proof says which device, and a device nobody has confirmed gets no way in.
    // The refusal is `PERMISSION_DENIED`, so the screen can send the merchant to the confirmation
    // instead of asking for a password that would change nothing.
    requireTrustedDevice(
      await verifySensitiveRequest(
        { request, bodyText, actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
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
