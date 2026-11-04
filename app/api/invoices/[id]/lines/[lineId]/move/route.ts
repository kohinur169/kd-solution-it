// path: app/api/invoices/[id]/lines/[lineId]/move/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  INVOICE_LINE_MOVE_DIRECTIONS,
  moveInvoiceLine,
  type InvoiceLineMoveDirection,
} from "@/services/invoices/invoice-line-order";
import type { InvoiceLine } from "@/services/invoices/invoice-lines";

export const dynamic = "force-dynamic";

/** A direction and nothing else; 1 KiB is generous. */
const maximumBodyBytes = 1_024;

interface MoveBody {
  readonly status: "moved";
  readonly movedLineId: string;
  readonly lines: readonly InvoiceLine[];
}

/**
 * Move one line of a draft one place up or down.
 *
 * ## Why the direction is in the body and the ids are in the path
 *
 * The path names **what** moves - an invoice and one of its lines - and the body names **how far**, which
 * is a value rather than an address. A `?direction=up` query would put a mutation's parameter somewhere
 * logs and proxies copy freely; a body is the right place for it.
 *
 * ## Why only two directions
 *
 * `up` and `down` are the two buttons the editor has, and each is an adjacent swap. A general reorder
 * (`position: 7`) would need every line between the two ends renumbered, which cannot be done against
 * `invoice_items_position_key` without either a deferrable constraint or a temporary offset pass over all
 * rows - a change this STEP does not claim. Offering only what the schema can do honestly is better than
 * offering a move that fails at scale.
 *
 * ## The order of the checks
 *
 * CSRF first - a cross-origin post cannot read the token this compares - then the declared length, then
 * the session, then the body's shape, then the service, which applies the `owner` role, refuses a document
 * that has left `draft`, and performs the three-write swap described in `invoice-line-order.ts`.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string; readonly lineId: string }> },
  ): Promise<NextResponse<MoveBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > maximumBodyBytes) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "direction", rule: "invalid_format" }] });
    }

    const direction = (body as { readonly direction?: unknown } | null)?.direction;

    if (
      typeof direction !== "string" ||
      !(INVOICE_LINE_MOVE_DIRECTIONS as readonly string[]).includes(direction)
    ) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "direction", rule: "invalid_format" }] });
    }

    const params = await context.params;
    const invoiceId = decodeURIComponent(params.id);
    const lineId = decodeURIComponent(params.lineId);
    const result = await moveInvoiceLine(
      { actor, invoiceId, lineId, direction: direction as InvoiceLineMoveDirection },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice line moved", {
      userId: actor.userId,
      invoiceId,
      lineId: result.movedLineId,
      direction,
    });

    return NextResponse.json(
      { status: "moved", movedLineId: result.movedLineId, lines: result.lines },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
