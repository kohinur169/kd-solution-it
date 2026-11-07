// path: app/api/payments/disputes/[id]/evidence/route.ts
import { NextResponse } from "next/server";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeEvidenceView } from "@/services/disputes/dispute-evidence";
import { assembleEvidencePack } from "@/services/disputes/dispute-evidence";
import { getDisputeEvidenceRuntime } from "@/services/disputes/dispute-runtime";
import { evidenceDisputeId, evidenceAuthReader } from "./request";

export const dynamic = "force-dynamic";

/**
 * Assemble the pack of one dispute, at `/api/payments/disputes/[id]/evidence`.
 *
 * Section 19's "a structured chargeback evidence pack is assembled" is this request. It is a `POST` and not a
 * `GET` because it writes: the first call opens the draft and copies every record the platform holds, and a
 * later call copies whatever appeared since. `0126`'s unique key makes the second call add nothing rather than
 * fail, so the button is safe to press twice and a merchant whose page went stale loses no work.
 *
 * The route carries no body: the dispute id is the whole request. Everything that decides whether the pack may
 * be assembled - the `owner` role, the merchant's own dispute, a decided dispute or one already sent - lives in
 * `assembleEvidencePack`, so a second caller cannot reach the table another way and accept what this refused.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeEvidenceView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const disputeId = await evidenceDisputeId(context);
    const actor = await readRequestActor(request.headers.get("cookie"), evidenceAuthReader());
    const view = await assembleEvidencePack({ actor, disputeId }, getDisputeEvidenceRuntime());

    logger.info("dispute evidence assembled", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      itemCount: view.pack?.itemCount ?? 0,
      documentCount: view.pack?.documentCount ?? 0,
      available: view.candidates.length,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
