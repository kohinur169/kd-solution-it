// path: app/api/payments/disputes/[id]/evidence/freeze/route.ts
import { NextResponse } from "next/server";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeEvidenceView } from "@/services/disputes/dispute-evidence";
import { DISPUTE_EVIDENCE_FIELD, freezeEvidencePack } from "@/services/disputes/dispute-evidence";
import { getDisputeEvidenceRuntime } from "@/services/disputes/dispute-runtime";
import { evidenceDisputeId, evidenceAuthReader, evidenceJsonBody } from "../request";

export const dynamic = "force-dynamic";

/**
 * Freeze the pack, at `/api/payments/disputes/[id]/evidence/freeze`.
 *
 * This is the one act of the STEP that changes what the row means: `0039`'s `evidence_ready` becomes true, and
 * only a frozen pack may raise it - `0126`'s trigger on `disputes` refuses the flag otherwise. After it, the
 * compliance desk reviews what was frozen and sends it (STEP 198), and `0126` refuses every write to the pack.
 *
 * The body carries the version the page read, so a merchant who removed a record in another tab while this one
 * was pressing the button is told the pack moved rather than freezing a pack they no longer see. The service
 * treats a missing version as "freeze whatever is there", which is what the gate and the job want; the panel
 * always sends one.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeEvidenceView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const disputeId = await evidenceDisputeId(context);
    const body = await evidenceJsonBody(request);
    const version = versionOf(body);
    const actor = await readRequestActor(request.headers.get("cookie"), evidenceAuthReader());
    const view = await freezeEvidencePack(
      version === null ? { actor, disputeId } : { actor, disputeId, version },
      getDisputeEvidenceRuntime(),
    );

    logger.info("dispute evidence frozen", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      itemCount: view.pack?.itemCount ?? 0,
      documentCount: view.pack?.documentCount ?? 0,
      // The fingerprint of what was frozen. It says a pack exists and which one; it says nothing about what is
      // in it, and the row is where the content lives.
      digest: view.pack?.digest ?? null,
      evidenceReady: view.dispute.evidenceReady,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view, { status: 200, headers: { "cache-control": "no-store" } });
  },
);

/** The optimistic-locking version, when the caller sent one. */
function versionOf(body: unknown): number | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const value = (body as { readonly version?: unknown }).version;

  if (value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
  }

  return value;
}
