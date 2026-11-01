// path: app/api/auth/sessions/revoke/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { revokeOtherOwnSessions, revokeOwnSession } from "@/lib/auth/session-list";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** One session id, or one flag. */
const maximumBodyBytes = 1_024;

interface RevokeResponseBody {
  readonly status: "revoked";
  /** How many sessions were ended, so "every other session" says how much it did. */
  readonly revoked: number;
  /** True when the session that asked was the one ended, so the screen can send the person to sign in. */
  readonly currentSessionEnded: boolean;
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

/**
 * End one of the caller's sessions, or every session except the one asking.
 *
 * Section 22's "instant session revocation": the row is stamped with `revoked_at` and a reason, and
 * every reader in the platform - `readRequestActor` first - treats a revoked row as gone, so the
 * effect is the *next* request from that session rather than a promise to try later.
 *
 * ## Why it is signed but not stepped up
 *
 * Ending a session is a defensive act: somebody who thinks their laptop was stolen should be able to
 * close that door without first fetching an authenticator, and a wait is exactly the time the thief
 * is being given. The proof of STEP 050 is still required, because "which browser is asking" is what
 * stops a stolen cookie from ending the real owner's sessions, and STEP 052's device trust is
 * required with it, because a device nobody confirmed has no way in.
 *
 * The two shapes are mutually exclusive on purpose: a body that names a session and also asks for
 * "all others" is refused rather than guessed at.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<RevokeResponseBody>> => {
    // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
    // never reaches the body, the session or the work behind them.
    await enforceRateLimit({ request, scope: "session_revoke" }, getAuthRuntime());

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
        details: [{ field: "sessionId", rule: "invalid_format" }],
      });
    }

    const sessionId = readField(body, "sessionId");
    const allOthers = readField(body, "allOthers");

    if (sessionId !== undefined && allOthers !== undefined) {
      throw new AppError("VALIDATION_FAILED", {
        details: [
          { field: "sessionId", rule: "invalid_format" },
          { field: "allOthers", rule: "invalid_format" },
        ],
      });
    }

    if (sessionId === undefined && allOthers === undefined) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "sessionId", rule: "invalid_format" }],
      });
    }

    if (allOthers !== undefined && allOthers !== true) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "allOthers", rule: "invalid_format" }],
      });
    }

    if (sessionId !== undefined && typeof sessionId !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "sessionId", rule: "invalid_format" }],
      });
    }

    const dependencies = {
      rest: runtime.rest,
      audit: runtime.audit,
      sessions: runtime.sessions,
    };
    const ipAddress = readClientAddress(request.headers);
    const userAgent = readUserAgent(request.headers);

    if (typeof sessionId === "string") {
      const outcome = await revokeOwnSession(
        { actor, sessionId, ipAddress, userAgent },
        dependencies,
      );

      logger.info("session revoked by its owner", {
        userId: actor.userId,
        sessionId: outcome.sessionId,
        wasCurrent: outcome.wasCurrent,
      });

      return NextResponse.json(
        { status: "revoked", revoked: 1, currentSessionEnded: outcome.wasCurrent },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    const revoked = await revokeOtherOwnSessions({ actor, ipAddress, userAgent }, dependencies);

    logger.info("other sessions revoked by their owner", {
      userId: actor.userId,
      revoked,
    });

    return NextResponse.json(
      { status: "revoked", revoked, currentSessionEnded: false },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
