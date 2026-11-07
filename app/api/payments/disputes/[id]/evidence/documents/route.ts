// path: app/api/payments/disputes/[id]/evidence/documents/route.ts
import { NextResponse } from "next/server";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { DisputeEvidenceView } from "@/services/disputes/dispute-evidence";
import { attachEvidenceDocument, removeEvidenceDocument, DISPUTE_EVIDENCE_FIELD } from "@/services/disputes/dispute-evidence";
import {
  DISPUTE_EVIDENCE_MAXIMUM_BYTES,
  DISPUTE_EVIDENCE_MAXIMUM_UPLOAD_BYTES,
} from "@/services/disputes/dispute-evidence-fields";
import { getDisputeEvidenceRuntime } from "@/services/disputes/dispute-runtime";
import { evidenceDisputeId, evidenceAuthReader, evidenceJsonBody } from "../request";

export const dynamic = "force-dynamic";

/**
 * The documents a merchant supplies, at `/api/payments/disputes/[id]/evidence/documents`.
 *
 * Section 19 asks for two things this route answers: "the dispute interface: list, status and document
 * upload" and "the merchant ... supplies the required documents". The bytes arrive as a multipart body; the
 * type is decided from their signature by the shared upload validator, sealed before they leave the process by
 * the storage layer, and recorded with a digest - never trusted from the `Content-Type` the browser sent.
 *
 * ## The ceiling, twice
 *
 * `content-length` is checked first and the file's own length second, because a chunked request declares
 * nothing. The body ceiling is the file ceiling plus one megabyte of multipart envelope, so the check refuses
 * a body that could not hold a file the policy allows rather than a file the policy refuses.
 *
 * ## What a refusal means
 *
 * A file the upload policy refuses is a `422`; a file the storage layer has no binding for is the honest
 * "this deployment has no document storage" rather than a row pointing at bytes nobody stored. A quarantined
 * file - bytes that do not match the type they claim - is refused here, and `attachEvidenceDocument` is where
 * that rule lives, because a pack is the one place a mislabelled file must never become evidence.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DisputeEvidenceView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declared = request.headers.get("content-length");

    if (declared !== null) {
      const parsed = Number.parseInt(declared, 10);

      if (Number.isFinite(parsed) && parsed > DISPUTE_EVIDENCE_MAXIMUM_UPLOAD_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const disputeId = await evidenceDisputeId(context);
    let form: FormData;

    try {
      form = await request.formData();
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
    }

    const file = form.get("file");
    const section = form.get("section");
    const caption = form.get("caption");

    if (!(file instanceof File) || typeof section !== "string") {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
    }

    if (file.size <= 0 || file.size > DISPUTE_EVIDENCE_MAXIMUM_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const actor = await readRequestActor(request.headers.get("cookie"), evidenceAuthReader());
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (bytes.length > DISPUTE_EVIDENCE_MAXIMUM_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const view = await attachEvidenceDocument(
      {
        actor,
        disputeId,
        upload: {
          fileName: file.name,
          declaredType: file.type,
          bytes,
          section,
          ...(typeof caption === "string" ? { caption } : {}),
        },
      },
      getDisputeEvidenceRuntime(),
    );

    logger.info("dispute evidence document attached", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      section,
      contentType: file.type,
      byteSize: bytes.length,
      documentCount: view.pack?.documentCount ?? 0,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view, { status: 200, headers: { "cache-control": "no-store" } });
  },
);

/** The one shape a removal carries: the document's id. */
function documentIdOf(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
  }

  const value = (body as { readonly document_id?: unknown }).document_id;

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
    const documentId = documentIdOf(await evidenceJsonBody(request));
    const actor = await readRequestActor(request.headers.get("cookie"), evidenceAuthReader());
    const view = await removeEvidenceDocument({ actor, disputeId, documentId }, getDisputeEvidenceRuntime());

    logger.info("dispute evidence document removed", {
      disputeId: view.dispute.id,
      companyId: view.dispute.companyId,
      packId: view.pack?.id ?? null,
      documentCount: view.pack?.documentCount ?? 0,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
