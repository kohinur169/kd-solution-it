// path: app/api/auth/devices/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { enrolDeviceProofKey } from "@/lib/auth/device-enrolment";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import type { ProofKeyAlgorithm } from "@/lib/auth/proof-key";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** Two fields of base64url and an algorithm name. */
const maximumBodyBytes = 4_096;

interface EnrolledDeviceBody {
  readonly status: "enrolled" | "already_enrolled";
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly algorithm: ProofKeyAlgorithm;
  readonly label: string;
  readonly trusted: boolean;
}

/**
 * Register the public half of this browser's device proof key.
 *
 * Session scoped: the key belongs to the account whose cookie named the request, and `0009` gives it
 * exactly one account. A stranger cannot enrol a key for somebody else, because there is no field in
 * the body that says whose key it is.
 *
 * Answer shapes:
 *
 *   - `201` with `enrolled` when this call created the row;
 *   - `200` with `already_enrolled` when the account already has this exact key live, which is what
 *     a second tab or a retry after a lost answer looks like;
 *   - `409` when the account already holds the maximum number of devices;
 *   - `422` for a key that is not a key, a curve that does not match its algorithm, or a body with a
 *     field this endpoint does not have;
 *   - `401` with no session, `413` past 4 KiB, and the transport codes when the platform is the
 *     problem.
 *
 * The private half never reaches this route, and `trusted` is false on every row it writes: section
 * 22 trusts a new device only after the confirmation of STEP 052.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<EnrolledDeviceBody>> => {
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
        details: [{ field: "publicKey", rule: "invalid_key" }],
      });
    }

    const runtime = getAuthRuntime();
    // One of exactly two routes that may run before the cookie is bound: enrolling a device key is
    // what makes binding possible, so refusing an unbound session here would deadlock a new browser.
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
      allowUnbound: true,
    });

    const result = await enrolDeviceProofKey(
      {
        request: body,
        userAgent: readUserAgent(request.headers),
        remoteIp: readClientAddress(request.headers),
      },
      { userId: actor.userId, companyId: actor.companyId, sessionId: actor.sessionId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("device proof key registered", {
      userId: actor.userId,
      deviceId: result.device.deviceId,
      algorithm: result.device.algorithm,
      status: result.status,
    });

    const answer: EnrolledDeviceBody = {
      status: result.status,
      deviceId: result.device.deviceId,
      fingerprint: result.device.fingerprint,
      algorithm: result.device.algorithm,
      label: result.device.label,
      trusted: result.device.trusted,
    };

    return NextResponse.json(answer, {
      status: result.status === "enrolled" ? 201 : 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
