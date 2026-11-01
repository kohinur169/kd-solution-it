// path: app/api/office/delegations/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getPermissionRuntime } from "@/lib/permissions/runtime";
import { grantPermission, revokePermission, type DelegationView } from "@/lib/permissions/service";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Delegating one permission, and taking one back.
 *
 * ## Two actions, one route
 *
 * Both acts are the same permission on the same table, and both need the same five checks before the
 * body is read, so they share a route the way the gateway console's five actions do: one place where the
 * order of the guards is written, instead of two that can drift.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes, then the
 * parse, then the service - which applies the delegation role and the freshness of the second factor
 * beside the writes they guard. A refusal names a field and a rule; the address of a colleague is the
 * only personal data in the body and it is never echoed back.
 */

/** A key, an address, a window and a reason. 4 KiB is generous and bounded. */
const maximumBodyBytes = 4_096;

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

function readText(body: unknown, key: string): string {
  const value = readField(body, key);

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "invalid_format" }] });
  }

  return value;
}

/** The window is a whole number of days; the service refuses anything the form could not offer. */
function readDays(body: unknown): number {
  const value = readField(body, "days");

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "days", rule: "invalid_range" }],
    });
  }

  return value;
}

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<DelegationView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // A proof before a parse: the signature covers these bytes, and an altered body fails here rather
    // than as a schema problem the operator would have to read.
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

    if (action === "grant") {
      const delegation = await grantPermission(
        {
          actor,
          permission: readText(body, "permission"),
          email: readText(body, "email"),
          days: readDays(body),
          reason: readText(body, "reason"),
        },
        getPermissionRuntime(),
      );

      logger.info("permission delegated", {
        delegationId: delegation.id,
        permission: delegation.permission,
        holderId: delegation.holderId,
        actorUserId: actor.userId,
      });

      return NextResponse.json(delegation, {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    }

    if (action === "revoke") {
      const delegation = await revokePermission(
        { actor, delegationId: readText(body, "delegationId") },
        getPermissionRuntime(),
      );

      logger.info("permission withdrawn", {
        delegationId: delegation.id,
        permission: delegation.permission,
        holderId: delegation.holderId,
        actorUserId: actor.userId,
      });

      return NextResponse.json(delegation, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }

    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "action", rule: "invalid_format" }],
    });
  },
);
