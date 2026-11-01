// path: app/api/office/sessions/revoke/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { revokeAccountSession } from "@/lib/auth/session-list";
import { requireFreshReauthentication } from "@/lib/auth/step-up";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** An account id and a session id. */
const maximumBodyBytes = 1_024;

interface OfficeRevokeResponseBody {
  readonly status: "revoked";
  readonly userId: string;
  readonly sessionId: string;
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

/**
 * The office revoke: end one session of an account the officer does not own.
 *
 * Unlike the owner's own revoke, this one does require the fresh window of STEP 053. The difference
 * is not the write - both stamp one row - but whose door is being closed: an officer signing a
 * merchant out of every device is a disruptive act on somebody else's account, and section 22 names
 * exactly those among the actions a stale session may not perform. A stolen office cookie can
 * therefore read nothing fresh and end nothing.
 *
 * The service checks the role, the ownership of the session by the named account, and writes
 * `ADMIN_REVOKED` with the officer as the actor, so the audit trail answers "who ended this" in one
 * entry.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<OfficeRevokeResponseBody>> => {
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

    // Asked after the proof and the device trust, so a session that may not act here at all never
    // learns how fresh it is.
    requireFreshReauthentication(actor);

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "sessionId", rule: "invalid_format" }],
      });
    }

    const userId = readField(body, "userId");
    const sessionId = readField(body, "sessionId");

    if (typeof userId !== "string" || typeof sessionId !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [
          ...(typeof userId === "string" ? [] : [{ field: "userId", rule: "invalid_format" }]),
          ...(typeof sessionId === "string" ? [] : [{ field: "sessionId", rule: "invalid_format" }]),
        ],
      });
    }

    const outcome = await revokeAccountSession(
      {
        actor,
        userId,
        sessionId,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      { rest: runtime.rest, audit: runtime.audit, sessions: runtime.sessions },
    );

    logger.info("session revoked by the office", {
      actorUserId: actor.userId,
      subjectUserId: userId,
      sessionId: outcome.sessionId,
    });

    return NextResponse.json(
      { status: "revoked", userId, sessionId: outcome.sessionId },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
