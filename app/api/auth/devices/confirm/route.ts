// path: app/api/auth/devices/confirm/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { confirmDeviceTrust } from "@/lib/auth/device-trust";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** A confirmation body is a device id and a code. */
const maximumBodyBytes = 1_024;

/**
 * The body of a confirmation.
 *
 * Strict, because both fields decide which row is written: an extra field is refused rather than
 * ignored, and the pair is held to the shapes `0009` and the authenticator code already accept.
 */
const confirmBodySchema = z
  .object({
    deviceId: z.string().min(1).max(64),
    code: z.string().trim().min(6).max(10),
  })
  .strict();

interface ConfirmDeviceResponseBody {
  readonly status: "trusted" | "already_trusted";
  readonly deviceId: string;
  readonly trustedAtEpochMs: number;
}

/**
 * Confirm the device this session is bound to, with the account's authenticator code.
 *
 * Section 22 asks for a second step before a new device is trusted, and section 23 asks that the
 * owner be told about the device in the first place. The alert happens when the session binds
 * (`/api/auth/session/rotate`); this route is the step that ends the state.
 *
 * ## Why this route does not refuse an untrusted device
 *
 * Every other authenticated route treats `trusted: false` as a reason to keep the dangerous actions
 * closed, and this one cannot: it is the request that opens them. What guards it instead is the
 * authenticator code, which is a factor the thief of a session does not have, and the binding of the
 * session to the device it is confirming, which is checked inside the service. A session on another
 * machine cannot be used to trust this one.
 *
 * ## The answers
 *
 *   - `200 { status: "trusted" }` - the code was right and the device is trusted from now on;
 *   - `200 { status: "already_trusted" }` - a second confirmation of a device that is already
 *     confirmed, which is not an error and writes nothing;
 *   - `422` with `field: "code"` - a wrong code, an expired challenge, an exhausted budget, or an
 *     account that has not finished enrolling its second factor. The four read differently in
 *     `rule` because each one asks the person for something different;
 *   - `403` - the session is bound to another device. The service answers this before it reads the
 *     code, so a refused caller learns nothing about the code it sent.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ConfirmDeviceResponseBody>> => {
    // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
    // never reaches the body, the session or the work behind them.
    await enforceRateLimit({ request, scope: "device_confirm" }, getAuthRuntime());

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
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "code", rule: "invalid_format" }],
      });
    }

    const parsedBody = confirmBodySchema.safeParse(body);

    if (!parsedBody.success) {
      const field = parsedBody.error.issues[0]?.path[0];

      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: field === "deviceId" ? "deviceId" : "code", rule: "invalid_format" }],
      });
    }

    const outcome = await confirmDeviceTrust(
      {
        userId: actor.userId,
        companyId: actor.companyId,
        deviceId: parsedBody.data.deviceId,
        sessionDeviceId: actor.deviceProofKeyId,
        code: parsedBody.data.code,
        ipAddress: readClientAddress(request.headers),
        userAgent: readUserAgent(request.headers),
      },
      {
        rest: runtime.rest,
        audit: runtime.audit,
        logger,
        masterKey: runtime.masterKey,
      },
    );

    logger.info("device trust confirmation", {
      userId: actor.userId,
      deviceId: outcome.deviceId,
      status: outcome.status,
    });

    return NextResponse.json(
      {
        status: outcome.status,
        deviceId: outcome.deviceId,
        trustedAtEpochMs: outcome.trustedAtEpochMs,
      } satisfies ConfirmDeviceResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
