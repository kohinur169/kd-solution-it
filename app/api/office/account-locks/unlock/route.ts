// path: app/api/office/account-locks/unlock/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { unlockAccountLock } from "@/lib/auth/account-unlock";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** A lock id, a note of at most 280 characters and one confirmation flag. */
const maximumBodyBytes = 4_096;

interface UnlockResponseBody {
  readonly status: "unlocked";
  readonly userId: string;
  readonly unlockedAt: string;
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

/**
 * The office unlock of section 22.
 *
 * The route is a boundary and nothing more: a body ceiling, a JSON parse, the shape of three fields,
 * the actor from the session cookie and one call into the service. Every decision that matters - the
 * role, the second factor, the contact confirmation, the open lock, the audit entry - is inside
 * `unlockAccountLock`, so a second caller (STEP 078's screen, STEP 053's step-up guard) cannot get a
 * weaker version of this endpoint by calling the service directly.
 *
 * The answer is deliberately small: the account that was unlocked and the instant it happened. It
 * carries no address and no note, so the response of an office action never becomes a way to read a
 * merchant's record.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<UnlockResponseBody>> => {
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
        details: [{ field: "lockId", rule: "invalid_format" }],
      });
    }

    const lockId = readField(body, "lockId");
    const note = readField(body, "note");
    const ownerContactConfirmed = readField(body, "ownerContactConfirmed");

    if (typeof lockId !== "string" || typeof note !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [
          ...(typeof lockId === "string" ? [] : [{ field: "lockId", rule: "invalid_format" }]),
          ...(typeof note === "string" ? [] : [{ field: "note", rule: "invalid_format" }]),
        ],
      });
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
    });

    const unlock = await unlockAccountLock(
      {
        actor,
        lockId,
        note,
        ownerContactConfirmed: ownerContactConfirmed === true,
      },
      { rest: runtime.rest, audit: runtime.audit, logger },
    );

    logger.info("account lock unlocked by the office", {
      lockId: unlock.lockId,
      actorUserId: actor.userId,
      subjectAccountId: unlock.userId,
      companyId: unlock.companyId,
    });

    return NextResponse.json(
      {
        status: unlock.status,
        userId: unlock.userId,
        unlockedAt: unlock.unlockedAt,
      } satisfies UnlockResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
