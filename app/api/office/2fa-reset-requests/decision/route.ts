// path: app/api/office/2fa-reset-requests/decision/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { decideTwoFactorReset } from "@/lib/auth/two-factor-reset";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

/** A request id, an action and two optional notes. */
const maximumBodyBytes = 4_096;

const actions = ["contacted", "approve", "reject"] as const;

type ResetAction = (typeof actions)[number];

interface DecisionResponseBody {
  readonly status: "contacted" | "approved" | "rejected";
  readonly userId: string;
}

function isAction(value: unknown): value is ResetAction {
  return typeof value === "string" && actions.some((action) => action === value);
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

function readOptionalText(body: unknown, key: string): string | null {
  const value = readField(body, key);

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The office side of a reset: record the contact, approve the reset, or reject the request.
 *
 * Three actions on one route because they are three transitions of one state machine, and splitting
 * them into three endpoints would have meant three copies of the same permission check. The role
 * check lives in the service, so a second caller of the service cannot forget it.
 *
 * An approval clears the account's second factor and is audited as `user.two_factor_reset`; the
 * merchant then signs in with the password alone and enrols again through STEP 041.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<DecisionResponseBody>> => {
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
        details: [{ field: "action", rule: "invalid_format" }],
      });
    }

    const action = readField(body, "action");
    const requestId = readField(body, "requestId");

    if (!isAction(action) || typeof requestId !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [
          { field: "action", rule: "invalid_format" },
          { field: "requestId", rule: "invalid_format" },
        ],
      });
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
    });

    const decision = await decideTwoFactorReset(
      {
        actor,
        requestId,
        action,
        documentReference: readOptionalText(body, "documentReference"),
        note: readOptionalText(body, "note"),
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("two factor reset decided", {
      requestId,
      action,
      actorUserId: actor.userId,
      outcome: decision.status,
    });

    return NextResponse.json(
      { status: decision.status, userId: decision.userId } satisfies DecisionResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
