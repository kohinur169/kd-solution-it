// path: app/api/auth/session/rotate/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { encodeSessionCookies } from "@/lib/auth/cookies";
import { readBoundSession } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { issueSessionToken } from "@/lib/auth/session-rotation";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** A rotation body is one identifier. */
const maximumBodyBytes = 1_024;

/**
 * The device id the browser says it is.
 *
 * Strict, because the value decides which row a session is bound to: an extra field is refused
 * rather than ignored, and the identifier is held to the shape `0010` accepts. The value is not
 * trusted - it is looked up among the live keys of this account, and a device that is not one of
 * them refuses the binding rather than creating a session that names somebody else's key.
 */
const rotationBodySchema = z
  .object({
    deviceId: z.string().min(1).max(64),
  })
  .strict();

interface RotationResponseBody {
  readonly status: "bound" | "rotated" | "current";
  readonly expiresAtEpochMs: number;
}

/**
 * Bind this browser to a device, or rotate the session it already holds.
 *
 * Section 22's rotating token needs one endpoint that can hand the browser a new one, and a cookie
 * can only be written from a route handler: a server component cannot set one. This is that route.
 *
 * It answers three things and issues a token for two of them:
 *
 *   - `bound`, when the cookie carried no platform session yet. This is the first request after the
 *     sign in and after the enrolment of STEP 049, and the row it writes names the device.
 *   - `rotated`, when the session is bound and old enough that the token should be replaced. The
 *     replaced row is revoked as `ROTATED`; presenting it again later is a replay.
 *   - `current`, when the session is bound and younger than the rotation interval, or when the token
 *     presented is inside the grace window of a rotation that already happened. Nothing is issued
 *     and the cookie the browser holds stays as it is.
 *
 * `allowUnbound` is the whole reason this route exists in the form it does: it is one of exactly two
 * routes that may run before a browser has a device key, because it is the route that ends that
 * state. Every other route refuses an unbound cookie.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<RotationResponseBody>> => {
    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    // The session first: a stranger with no cookie learns nothing from the shape of a body this
    // route would refuse anyway, and one answer is one answer.
    const runtime = getAuthRuntime();
    const session = await readBoundSession(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
      allowUnbound: true,
    });

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "deviceId", rule: "invalid_format" }],
      });
    }

    const parsedBody = rotationBodySchema.safeParse(body);

    if (!parsedBody.success) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "deviceId", rule: "invalid_format" }],
      });
    }

    // The device has to be a live key of this account, or the session would be bound to a row this
    // person does not own. The composite foreign key in `0010` would refuse it anyway; answering a
    // form-shaped refusal here keeps that from surfacing as a dependency failure.
    const devices = await runtime.rest.select(
      "device_proof_keys",
      `select=id&id=eq.${encodeURIComponent(parsedBody.data.deviceId)}` +
        `&user_id=eq.${encodeURIComponent(session.actor.userId)}` +
        "&revoked_at=is.null&deleted_at=is.null&limit=1",
      z.object({ id: z.string().min(1).max(64) }),
    );

    if (devices.length === 0) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "deviceId", rule: "unknown_device" }],
      });
    }

    const outcome = await issueSessionToken(
      {
        presentedToken: session.sessionToken,
        userId: session.actor.userId,
        companyId: session.actor.companyId,
        deviceProofKeyId: parsedBody.data.deviceId,
        assuranceLevel: session.actor.assuranceLevel,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
        claimSessionId: session.payload.sessionId ?? null,
      },
      { sessions: runtime.sessions, audit: runtime.audit },
    );

    if (outcome.kind === "refused") {
      // The reason is not part of the answer: a replay, an ended session and a device mismatch all
      // read the same, and the audit entry written by the service says which one happened.
      logger.warn("session rotation refused", {
        userId: session.actor.userId,
        reason: outcome.reason,
      });

      throw new AppError("AUTHENTICATION_REQUIRED");
    }

    if (outcome.kind === "current") {
      return NextResponse.json(
        { status: "current", expiresAtEpochMs: outcome.expiresAtEpochMs } satisfies RotationResponseBody,
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    // The new token replaces one field of the payload. The provider's pair is carried forward
    // exactly as the verified cookie held it - reissuing it is not this route's business - and the
    // expiry stays the provider's, because that is what decides when the access token stops working.
    // The session row adds its own expiry and the family's ceiling underneath it.
    const cookies = encodeSessionCookies(
      runtime.cookiePolicy,
      {
        ...session.payload,
        // Only the session token changes. `sessionId` in the payload is the provider's claim, and
        // `readSession` refuses a payload whose claim disagrees with the claims inside the token:
        // rewriting it here would invalidate the cookie this route just wrote.
        sessionToken: outcome.token,
      },
      Date.now(),
    );

    logger.info("session token issued", {
      userId: session.actor.userId,
      status: outcome.kind,
      sessionId: outcome.sessionId,
    });

    const response = NextResponse.json(
      { status: outcome.kind, expiresAtEpochMs: outcome.expiresAtEpochMs } satisfies RotationResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );

    for (const cookie of cookies) {
      response.headers.append("set-cookie", cookie);
    }

    return response;
  },
);

