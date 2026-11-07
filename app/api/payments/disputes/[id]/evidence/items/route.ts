// path: app/api/payments/disputes/[id]/evidence/items/route.ts
import { NextResponse } from "next/server";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeEvidenceView } from "@/services/disputes/dispute-evidence";
import { addEvidenceItem, removeEvidenceItem } from "@/services/disputes/dispute-evidence";
import { DISPUTE_EVIDENCE_FIELD } from "@/services/disputes/dispute-evidence";
import { getDisputeEvidenceRuntime } from "@/services/disputes/dispute-runtime";
import { evidenceDisputeId, evidenceAuthReader, evidenceJsonBody } from "../request";

export const dynamic = "force-dynamic";

/**
 * The two acts on one item of a draft pack: add and remove.
 *
 * ## `POST` - add
 *
 * Two shapes, both of them section 19's: a `record` names a row the platform holds (an invoice, a message, an
 * acceptance) and is re-read from its source before it is copied, and a `note` is the merchant's own sentence
 * filed under one of the four parts. A record the platform no longer holds is refused rather than copied from
 * a stale page.
 *
 * ## `DELETE` - remove
 *
 * Removal is a soft delete and only while the pack is a draft; `0126`'s trigger refuses it afterwards, and the
 * service refuses it first so the merchant reads "the pack is frozen" rather than a missing row. The id is in
 * the body because a route segment would make two ways to say the same thing, and the body ceiling is the same
 * on both verbs.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeEvidenceView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const disputeId = await evidenceDisputeId(context);
    const body = await evidenceJsonBody(request);
    const actor = await readRequestActor(request.headers.get("cookie"), evidenceAuthReader());
    const view = await addEvidenceItem({ actor, disputeId, body }, getDisputeEvidenceRuntime());

    logger.info("dispute evidence item added", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      itemCount: view.pack?.itemCount ?? 0,
      kind: typeof body === "object" && body !== null ? (body as { readonly kind?: unknown }).kind : null,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view, { status: 200, headers: { "cache-control": "no-store" } });
  },
);

/** The one shape a removal carries: the item's id and nothing else. */
function itemIdOf(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
  }

  const value = (body as { readonly item_id?: unknown }).item_id;

  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
  }

  return value;
}

export const DELETE = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeEvidenceView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const disputeId = await evidenceDisputeId(context);
    const itemId = itemIdOf(await evidenceJsonBody(request));
    const actor = await readRequestActor(request.headers.get("cookie"), evidenceAuthReader());
    const view = await removeEvidenceItem({ actor, disputeId, itemId }, getDisputeEvidenceRuntime());

    logger.info("dispute evidence item removed", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      itemCount: view.pack?.itemCount ?? 0,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
