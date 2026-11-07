// path: app/api/office/disputes/[id]/review/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeReviewPageView } from "@/services/disputes/dispute-submission";
import { DISPUTE_SUBMISSION_MAXIMUM_BODY_BYTES } from "@/services/disputes/dispute-submission-fields";
import { parseReviewBody, reviewDisputePack } from "@/services/disputes/dispute-submission";
import { getDisputeSubmissionRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/**
 * The compliance desk's decision on one frozen evidence pack, at
 * `/api/office/disputes/[id]/review`.
 *
 * Section 19's sentence is "compliance_kyc reviews the evidence pack and sends it to the processor", and this is
 * the review: one decision, one reason, one named officer. It is a `POST` because it writes a row that is never
 * edited - `0127` refuses every update and every delete on `dispute_reviews` - and it answers with the whole
 * screen's worth of state, so the page a reviewer sees after pressing is the page the server just read rather
 * than one the browser assembled.
 *
 * Three guards on the route and two in the service: CSRF first, then the device proof over these exact bytes,
 * then the session; the service asks for the role and for a satisfied second factor. The device proof matters
 * here for the same reason it matters on the deadline extension: this decision is about a merchant's money and
 * a compromised cookie should not be enough to make it.
 *
 * The body is `{ "decision": "approved" | "declined", "note": "<reason>" }` and nothing else - an unknown key is
 * a refusal rather than a default, and the note is trimmed and bounded by `0127`'s check as well as by the parse.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeReviewPageView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declared = request.headers.get("content-length");

    if (declared !== null) {
      const parsed = Number.parseInt(declared, 10);

      if (Number.isFinite(parsed) && parsed > DISPUTE_SUBMISSION_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > DISPUTE_SUBMISSION_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    requireTrustedDevice(
      await verifySensitiveRequest({ request, bodyText, actor }, { rest: runtime.rest, audit: runtime.audit }),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "submission", rule: "invalid_format" }],
      });
    }

    const parameters = await context.params;
    const disputeId = decodeURIComponent(parameters.id);

    // The parse runs here as well as in the service so the route logs a decision it has already proved is one of
    // two words, rather than whatever the caller sent.
    const parsed = parseReviewBody(body);
    const view = await reviewDisputePack({ actor, disputeId, body }, getDisputeSubmissionRuntime());

    logger.info("dispute evidence reviewed", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      decision: parsed.decision,
      noteLength: parsed.note.length,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view);
  },
);
