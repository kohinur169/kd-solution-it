// path: app/api/office/approvals/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  decideApproval,
  normalizeCurrency,
  requestApproval,
  type ApprovalRequestView,
} from "@/lib/approvals/service";
import { getApprovalRuntime } from "@/lib/approvals/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Raising a request into the section 2 chain.
 *
 * ## Two actions, one chain
 *
 * STEP 070 built the queue and the act of raising a request; STEP 072 adds the decision, on the same
 * route and behind the same five guards, so that both names on the chain are written once rather than
 * four times. `request` answers `201` because it creates a row; `decide` answers `200` because it
 * settles one.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes, then
 * the parse, then the service - which applies the requester matrix and the freshness of the second
 * factor beside the insert they guard. A refusal names a field and a rule; the note the operator
 * wrote is never echoed back, because a note about money is as private as the money.
 */

/** One action, one subject, a label, a note and an optional amount. 4 KiB is generous and bounded. */
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

/** An amount is optional; when it is there it must be a whole number of minor units. */
function readAmount(body: unknown): number | null {
  const value = readField(body, "amountMinor");

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "amountMinor", rule: "invalid_format" }],
    });
  }

  return value;
}

/** A decision's note is optional on the wire; whether it is required is the service's rule. */
function readNote(body: unknown): string | null {
  const value = readField(body, "note");

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "note", rule: "invalid_format" }],
    });
  }

  return value;
}

/** A currency is optional too, and it is normalized here rather than in four callers. */
function readCurrency(body: unknown): string | null {
  const value = readField(body, "currency");

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "currency", rule: "invalid_format" }],
    });
  }

  return normalizeCurrency(value);
}

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ApprovalRequestView>> => {
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

    if (action === "request") {
      const approval = await requestApproval(
        {
          actor,
          actionType: readText(body, "actionType"),
          subjectId: readText(body, "subjectId"),
          subjectLabel: readText(body, "subjectLabel"),
          amountMinor: readAmount(body),
          currency: readCurrency(body),
          note: readText(body, "note"),
        },
        getApprovalRuntime(),
      );

      logger.info("approval requested", {
        approvalId: approval.id,
        actionType: approval.actionType,
        subjectType: approval.subjectType,
        actorUserId: actor.userId,
        requesterRole: approval.requesterRole,
      });

      return NextResponse.json(approval, { status: 201, headers: { "cache-control": "no-store" } });
    }

    if (action === "decide") {
      const approval = await decideApproval(
        {
          actor,
          approvalId: readText(body, "approvalId"),
          decision: readText(body, "decision"),
          note: readNote(body),
        },
        getApprovalRuntime(),
      );

      logger.info("approval decided", {
        approvalId: approval.id,
        actionType: approval.actionType,
        status: approval.status,
        stage: approval.stage,
        actorUserId: actor.userId,
      });

      return NextResponse.json(approval, { status: 200, headers: { "cache-control": "no-store" } });
    }

    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "action", rule: "invalid_format" }],
    });
  },
);
