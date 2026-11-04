// path: services/invoices/invoice-line-order.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { INVOICE_CREATED_STATUS, INVOICE_ITEMS_TABLE } from "./invoice-fields.ts";
import { INVOICE_LINE_COLUMNS, invoiceLineRowSchema, lineOf, type InvoiceLine } from "./invoice-lines.ts";

/**
 * Section 16's line ordering: "Line items can be added, edited and **ordered** correctly."
 *
 * ## Why this is a module of its own
 *
 * Moving a line is the one line operation that cannot be written as a single scoped update, and the
 * reason is a schema fact rather than a preference: `0023` declares
 *
 *     create unique index invoice_items_position_key
 *       on public.invoice_items (invoice_id, position) where deleted_at is null;
 *
 * That index is **not** deferrable, so it is checked after every statement. Swapping two lines with two
 * writes - "A takes B's position, then B takes A's" - fails on the first one with a duplicate key, because
 * at that moment both rows hold the same position. A database with a deferrable constraint, or one with
 * a transaction that could `SET CONSTRAINTS ALL DEFERRED`, would make this trivial; `0023` has neither and
 * this STEP may not edit a committed migration.
 *
 * ## The three-write swap
 *
 * So a swap is three statements, and each one leaves the index satisfied:
 *
 *   1. the moving line is parked at a position no live row holds;
 *   2. the displaced line takes the position the moving line just vacated;
 *   3. the moving line takes the position the displaced line just vacated.
 *
 * Every step moves onto a position the previous step freed, so the index is satisfied after each one and
 * no statement ever sees a transient duplicate. Three writes, no loop, no migration, and the two rows
 * end up exactly exchanged.
 *
 * ## Why the parking position is computed rather than constant
 *
 * A constant such as `-1` would violate `invoice_items_position_check`, which requires `position >= 1`.
 * A large constant would work until an invoice reached it. So the parking position is
 * `max(live positions) + 1`, which by definition nothing holds - and it is the same value
 * `addInvoiceLine` appends at, which is why that function's note and this one describe one rule.
 *
 * ## Only an adjacent swap, deliberately
 *
 * "Move up" and "move down" are the two operations an editor needs, and each exchanges a line with its
 * neighbour. A drag-to-reorder UI would need a general renumber, which is the case where a deferrable
 * constraint or a temporary offset pass over every row is required; that is a larger change than this
 * STEP claims, so the API offers exactly the two moves the screen has buttons for and refuses anything
 * else rather than pretending to support it.
 */

/** The audit action of a move. */
export const INVOICE_LINE_MOVED_AUDIT_ACTION = "invoice.line_moved";

/** The two directions the editor offers, named for the button that sends them. */
export const INVOICE_LINE_MOVE_DIRECTIONS = ["up", "down"] as const;

export type InvoiceLineMoveDirection = (typeof INVOICE_LINE_MOVE_DIRECTIONS)[number];

export interface InvoiceLineOrderDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The role and the company, read from the session and never from the body. */
function requireOrderActor(actor: RequestActor): string {
  requireAnyRole(actor, Object.freeze(["owner"] as const));

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** The parent's status, or a refusal. Mirrors `requireDraftParent` in `invoice-lines.ts`. */
async function requireDraftStatus(
  dependencies: InvoiceLineOrderDependencies,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<void> {
  const rows = await dependencies.rest.select(
    "invoices",
    `select=id,status&id=eq.${input.invoiceId}&company_id=eq.${input.companyId}&deleted_at=is.null`,
    z.object({ id: z.string().uuid(), status: z.string().min(1) }),
  );

  if (rows[0] === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice", reason: "not_found" } });
  }

  if (rows[0].status !== INVOICE_CREATED_STATUS) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_changed" }] });
  }
}

/** The live lines of one invoice in print order. */
async function readOrderedLines(
  rest: RestClient,
  companyId: string,
  invoiceId: string,
): Promise<readonly { readonly id: string; readonly position: number }[]> {
  return rest.select(
    INVOICE_ITEMS_TABLE,
    `select=id,position&invoice_id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    z.object({ id: z.string().uuid(), position: z.number().int() }),
  );
}

/** One scoped position write. */
async function writePosition(
  rest: RestClient,
  input: { readonly companyId: string; readonly invoiceId: string; readonly lineId: string; readonly position: number },
): Promise<void> {
  await rest.update(
    INVOICE_ITEMS_TABLE,
    `id=eq.${input.lineId}&company_id=eq.${input.companyId}&invoice_id=eq.${input.invoiceId}&deleted_at=is.null`,
    { position: input.position },
  );
}

/**
 * Move one line of a draft one place up or down.
 *
 * Returns the whole list in its new order, because a swap changes two rows and the editor needs both
 * positions - returning one line would leave the screen guessing what happened to the other.
 *
 * A move at the end of the list is **not** an error: "move up" on the first line is a button the screen
 * disables, and a request that arrives anyway is answered with the list unchanged rather than a refusal.
 * That is a deliberate difference from a bad id, which is a 404: a move that cannot happen is a no-op the
 * caller can ignore, while an id that does not exist is a mistake worth naming.
 */
export async function moveInvoiceLine(
  input: {
    readonly actor: RequestActor;
    readonly invoiceId: string;
    readonly lineId: string;
    readonly direction: InvoiceLineMoveDirection;
  },
  dependencies: InvoiceLineOrderDependencies,
): Promise<{ readonly movedLineId: string; readonly lines: readonly InvoiceLine[] }> {
  const companyId = requireOrderActor(input.actor);

  await requireDraftStatus(dependencies, { companyId, invoiceId: input.invoiceId });

  const ordered = await readOrderedLines(dependencies.rest, companyId, input.invoiceId);
  const index = ordered.findIndex((line) => line.id === input.lineId);

  if (index === -1) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice_line", reason: "not_found" } });
  }

  const neighbourIndex = input.direction === "up" ? index - 1 : index + 1;

  // A move past either end is a no-op, and answers with the list as it stands.
  if (neighbourIndex < 0 || neighbourIndex >= ordered.length) {
    const unchanged = await dependencies.rest.select(
      INVOICE_ITEMS_TABLE,
      `${INVOICE_LINE_COLUMNS}&invoice_id=eq.${input.invoiceId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
      invoiceLineRowSchema,
    );

    return { movedLineId: input.lineId, lines: unchanged.map((line) => lineOf(line)) };
  }

  const moving = ordered[index];
  const displaced = ordered[neighbourIndex];

  if (moving === undefined || displaced === undefined) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "invoice_line", reason: "order_changed" } });
  }

  // The parking position: one past the highest live position, which by definition no row holds.
  const parked = ordered.reduce((highest, line) => Math.max(highest, line.position), 0) + 1;

  // 1. park the moving line, freeing the position it held.
  await writePosition(dependencies.rest, {
    companyId,
    invoiceId: input.invoiceId,
    lineId: moving.id,
    position: parked,
  });

  // 2. the displaced line takes the moving line's old position, which is now free.
  await writePosition(dependencies.rest, {
    companyId,
    invoiceId: input.invoiceId,
    lineId: displaced.id,
    position: moving.position,
  });

  // 3. the moving line takes the displaced line's old position, which step 2 just freed.
  await writePosition(dependencies.rest, {
    companyId,
    invoiceId: input.invoiceId,
    lineId: moving.id,
    position: displaced.position,
  });

  await appendTolerated(dependencies.audit, {
    action: INVOICE_LINE_MOVED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "invoice_line",
    entityId: moving.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      invoice_id: input.invoiceId,
      direction: input.direction,
      from_position: moving.position,
      to_position: displaced.position,
    },
  });

  const reordered = await dependencies.rest.select(
    INVOICE_ITEMS_TABLE,
    `${INVOICE_LINE_COLUMNS}&invoice_id=eq.${input.invoiceId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    invoiceLineRowSchema,
  );

  return { movedLineId: moving.id, lines: reordered.map((line) => lineOf(line)) };
}
