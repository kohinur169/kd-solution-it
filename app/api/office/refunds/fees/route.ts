// path: app/api/office/refunds/fees/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { requireAnyRole } from "@/lib/auth/session";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  REFUND_FEE_SCREEN_ROLES,
  readRefundFeeBacklog,
  readRefundFeeRule,
  saveRefundFeeRule,
  type RefundFeeRuleView,
} from "@/services/payments/refund-fee";
import { REFUND_FEE_MAXIMUM_BODY_BYTES } from "@/services/payments/refund-fee-fields";
import { getRefundFeeRuntime } from "@/services/payments/refund-fee-runtime";

export const dynamic = "force-dynamic";

/**
 * Section 18's one sentence about refunds, over HTTP: whether the platform fee is returned on a refund.
 *
 * ## Two verbs, two audiences
 *
 * `GET` answers the question for the desk and counts the succeeded refunds the rule has not been applied to
 * yet, so the screen can say what a pass would do. It is `finance_ops` and `super_admin` - the desk that works
 * refunds - and it carries no cache.
 *
 * `POST` is the answer itself: `{ action: "save", returned, savedAt }`. It is the super administrator's alone,
 * which the service enforces with section 18's role and a fresh second factor on top of the route's CSRF token
 * and device proof. `savedAt` is the `updated_at` the form rendered, so two officers who both flip the switch
 * produce a conflict rather than an overwrite.
 *
 * ## Why the body is 512 bytes
 *
 * A boolean and an instant. A body larger than that is not this route's, and the refusal is `PAYLOAD_TOO_LARGE`
 * before the session is read - the same order every mutating office route uses.
 */

/** What the screen reads: the switch, its state, and the backlog a pass would work through. */
interface FeeRuleResponseBody {
  readonly rule: RefundFeeRuleView;
  readonly pending: number;
  readonly pendingCapped: boolean;
  readonly readAtEpochMs: number;
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<FeeRuleResponseBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  requireAnyRole(actor, REFUND_FEE_SCREEN_ROLES);

  const dependencies = getRefundFeeRuntime();
  const rule = await readRefundFeeRule({ actor }, dependencies);
  const backlog = await readRefundFeeBacklog(dependencies);

  return NextResponse.json(
    {
      rule,
      pending: backlog.pending,
      pendingCapped: backlog.capped,
      readAtEpochMs: Date.now(),
    } satisfies FeeRuleResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});

export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<FeeRuleResponseBody>> => {
  requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > REFUND_FEE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const bodyText = await request.text();

  if (bodyText.length > REFUND_FEE_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  // The signature covers these bytes, so an altered body fails here rather than as a schema problem.
  requireTrustedDevice(
    await verifySensitiveRequest({ request, bodyText, actor }, { rest: runtime.rest, audit: runtime.audit }),
  );

  let body: unknown;

  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "action", rule: "invalid_format" }] });
  }

  if (readField(body, "action") !== "save") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "action", rule: "invalid_format" }] });
  }

  const returned = readField(body, "returned");

  if (typeof returned !== "boolean") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "returned", rule: "invalid_format" }] });
  }

  const savedAt = readField(body, "savedAt");

  if (savedAt !== undefined && savedAt !== null && typeof savedAt !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "savedAt", rule: "invalid_format" }] });
  }

  const dependencies = getRefundFeeRuntime();
  const rule = await saveRefundFeeRule(
    { actor, returned, expectedUpdatedAt: typeof savedAt === "string" ? savedAt : null },
    dependencies,
  );
  const backlog = await readRefundFeeBacklog(dependencies);

  logger.info("refund fee rule saved", { returned: rule.returned, actorUserId: actor.userId });

  return NextResponse.json(
    {
      rule,
      pending: backlog.pending,
      pendingCapped: backlog.capped,
      readAtEpochMs: Date.now(),
    } satisfies FeeRuleResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
