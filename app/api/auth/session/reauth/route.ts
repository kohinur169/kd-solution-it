// path: app/api/auth/session/reauth/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { reauthenticateSession } from "@/lib/auth/step-up";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/** One code in JSON. */
const maximumBodyBytes = 1_024;

interface ReauthResponseBody {
  readonly status: "reauthenticated";
  /** Which code was accepted, so the screen can tell the person their backup set shrank. */
  readonly proof: "totp" | "backup_code";
  readonly freshUntilEpochMs: number;
  readonly remainingBackupCodes: number | null;
}

function readCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body)) {
    return null;
  }

  const code = (body as { readonly code?: unknown }).code;

  return typeof code === "string" ? code : null;
}

/**
 * Prove the second factor again, inside the signed-in session.
 *
 * Section 22 requires reauthentication before the actions a session alone may not perform, and this
 * is the one request that supplies it: no new cookie, no new session row, no new token - one instant
 * written on the row the caller already holds, and an audit entry that names it.
 *
 * ## Why this route asks for a proof as well
 *
 * It is a code-guessing surface with a live session behind it, which is exactly the shape STEP 050
 * guards: the request carries the device signature of the browser that made it, so a copied cookie
 * on another machine cannot use this endpoint to buy itself freshness. The device must also be
 * confirmed (STEP 052) - a device nobody has confirmed has no business proving anything.
 *
 * The answers are deliberately few: `200` with the new window, `422` with `field: "code"` for a code
 * that does not work (or for an account that never finished its enrolment), `403` for an unconfirmed
 * device, `423` while the account is locked, `401` without a session.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ReauthResponseBody>> => {
    // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
    // never reaches the body, the session or the work behind them.
    await enforceRateLimit({ request, scope: "session_reauth" }, getAuthRuntime());

    // STEP 057: a form post from another origin cannot read the token this compares.
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    // Read once as text, so the signature and the parser see the same bytes.
    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

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

    const code = readCode(body);

    if (code === null || code.trim().length < 6 || code.trim().length > 10) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "code", rule: "invalid_format" }],
      });
    }

    const outcome = await reauthenticateSession(
      {
        userId: actor.userId,
        companyId: actor.companyId,
        sessionId: actor.sessionId,
        code,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      {
        rest: runtime.rest,
        audit: runtime.audit,
        sessions: runtime.sessions,
        attempts: runtime.attempts,
        masterKey: runtime.masterKey,
        now: () => Date.now(),
      },
    );

    logger.info("session reauthenticated", {
      userId: actor.userId,
      sessionId: actor.sessionId,
      proof: outcome.proof,
    });

    return NextResponse.json(
      {
        status: outcome.status,
        proof: outcome.proof,
        freshUntilEpochMs: outcome.freshUntilEpochMs,
        remainingBackupCodes: outcome.remainingBackupCodes,
      } satisfies ReauthResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
