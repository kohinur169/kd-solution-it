// path: app/api/office/disputes/[id]/submit/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeSubmissionResult } from "@/services/disputes/dispute-submission";
import { DISPUTE_SUBMISSION_MAXIMUM_BODY_BYTES } from "@/services/disputes/dispute-submission-fields";
import { parseSubmissionBody, submitDisputePack } from "@/services/disputes/dispute-submission";
import { getDisputeSubmissionRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/**
 * Send one approved evidence pack to the processor, at `/api/office/disputes/[id]/submit`.
 *
 * Section 19's last clause: "compliance_kyc reviews the evidence pack and sends it to the processor." The review
 * is the route above this one; this is the sending, and `0127` decides whether it happened, because the dispute
 * only reaches `evidence_submitted` while a *sent* submission row carries it.
 *
 * ## The two channels, and why both are this route
 *
 * `provider` asks the platform to call the processor's dispute API. This build has no documented API for any of
 * its five providers, so that channel answers `dispute_submission_unsupported` before anything is claimed - the
 * port, the registry and the whole call path exist and are proven by the gate against an injected adapter, and
 * the honest refusal is what a deployment reads until an adapter is written from the provider's own docs.
 *
 * `recorded` is the act most facilitators perform: the desk sends the pack from the processor's portal and types
 * the case number here. The row still carries the officer's name, the pack's digest, the counts and the audit
 * entry, and the dispute still moves to `evidence_submitted`, so nothing downstream - STEP 199's monitoring
 * included - needs to know which channel was used beyond the `channel` column itself.
 *
 * The body is `{ "channel": "provider" | "recorded", "processor_reference": "<case number>", "note": "...",
 * "version": <the dispute version the page read> }`. The reference is required exactly when the channel is
 * `recorded`, and a reference sent with the `provider` channel is a refusal: the platform is told that answer by
 * the processor, not by a person.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeSubmissionResult>> => {
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

    // The browser signs these exact bytes before the body is parsed, so an altered case number is a proof
    // failure rather than a submission of somebody else's reference.
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
    const parsed = parseSubmissionBody(body);
    const result = await submitDisputePack({ actor, disputeId, body }, getDisputeSubmissionRuntime());

    logger.info("dispute evidence submitted", {
      disputeId: result.view.dispute.id,
      companyId: result.view.dispute.companyId,
      packId: result.view.pack?.id ?? null,
      channel: result.view.submission?.channel ?? parsed.channel,
      outcome: result.outcome,
      // The processor's own case number is a reference, not a secret: it is on the merchant's screen too. What
      // is never logged is the officer's note, because a note is what somebody typed about a merchant.
      referenceLength: result.processorReference?.length ?? 0,
      actorUserId: actor.userId,
    });

    return NextResponse.json(result);
  },
);
