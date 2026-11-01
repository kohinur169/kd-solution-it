// path: app/api/office/2fa-reset-requests/decision/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
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

    // One read, as text: the signature covers these bytes, so the parser below must be given the
    // same document the device signed.
    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // A proof before a parse: an altered body fails here rather than as a schema problem.
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
