// path: app/api/office/disputes/warnings/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { runDisputeWarningsNow, type DisputeWarningSweepResult } from "@/services/disputes/dispute-warnings";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/** The largest body this route reads: one uuid and two braces. */
const DISPUTE_WARNINGS_MAXIMUM_BODY_BYTES = 512;

/** The body, with the ceiling checked before and after it is held. */
async function readBodyText(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsed) && parsed > DISPUTE_WARNINGS_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > DISPUTE_WARNINGS_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  return text;
}

/** One company's uuid, when the caller asks for one merchant rather than the platform. */
const companySchema = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Section 19's two warnings, sent by hand when the deployment's clock has not.
 *
 * The office already has the button this route backs - the queue screen's "send the warnings that are due now"
 * - for the same reason the compliance calendar has one: a deployment with a scheduler gets its warnings from
 * `dispute.deadline_warnings`, and a deployment without one still has to be able to tell a merchant that their
 * window is closing. The service refuses a duplicate whatever the button does, so it is safe to press twice.
 *
 * Three guards on the route (CSRF, the device proof over these exact bytes, the session) and two in the service
 * (`ceo`/compliance/`super_admin`, and a satisfied second factor), because this act mails the platform's
 * merchants: it is correspondence at platform scale, not a read.
 *
 * An empty body means every merchant; `{ "company_id": "<uuid>" }` means one. An unknown key or a malformed id
 * is a refusal rather than a default, so a caller cannot believe they swept one merchant while sweeping all.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<DisputeWarningSweepResult>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const bodyText = await readBodyText(request);
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // The browser signs these exact bytes before the body is parsed, so an altered company id is a proof
    // failure rather than a sweep of somebody else's merchant.
    requireTrustedDevice(
      await verifySensitiveRequest({ request, bodyText, actor }, { rest: runtime.rest, audit: runtime.audit }),
    );

    const trimmed = bodyText.trim();
    let companyId: string | null = null;

    if (trimmed.length > 0) {
      let body: unknown;

      try {
        body = JSON.parse(trimmed) as unknown;
      } catch {
        throw new AppError("VALIDATION_FAILED", { details: [{ field: "company_id", rule: "invalid_format" }] });
      }

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError("VALIDATION_FAILED", { details: [{ field: "company_id", rule: "invalid_format" }] });
      }

      const keys = Object.keys(body);

      if (keys.some((key) => key !== "company_id")) {
        throw new AppError("VALIDATION_FAILED", { details: [{ field: "company_id", rule: "invalid_format" }] });
      }

      const requested = (body as { readonly company_id?: unknown }).company_id;

      if (requested !== undefined) {
        if (typeof requested !== "string" || !companySchema.test(requested)) {
          throw new AppError("VALIDATION_FAILED", { details: [{ field: "company_id", rule: "invalid_format" }] });
        }

        companyId = requested.toLowerCase();
      }
    }

    const result = await runDisputeWarningsNow({ actor, companyId }, getDisputeRuntime());

    logger.info("dispute warnings swept", {
      companyId,
      considered: result.considered,
      due: result.due,
      sent: result.sent,
      alreadySent: result.skipped.already_sent,
      superseded: result.skipped.superseded,
      senderNotConfigured: result.skipped.sender_not_configured,
      noOwner: result.skipped.no_owner,
      failed: result.skipped.failed,
      actorUserId: actor.userId,
    });

    return NextResponse.json(result, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
