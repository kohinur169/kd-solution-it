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

/** The audit action of an invoice's move. */
export const INVOICE_LINE_MOVED_AUDIT_ACTION = "invoice.line_moved";

/** The two directions an editor offers, named for the button that sends them. */
export const DOCUMENT_LINE_MOVE_DIRECTIONS = ["up", "down"] as const;

export type DocumentLineMoveDirection = (typeof DOCUMENT_LINE_MOVE_DIRECTIONS)[number];

/** The invoice's own names for the same two directions, kept because its gate and its route use them. */
export const INVOICE_LINE_MOVE_DIRECTIONS = DOCUMENT_LINE_MOVE_DIRECTIONS;

export type InvoiceLineMoveDirection = DocumentLineMoveDirection;

export interface DocumentLineOrderDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The invoice's own name for the same dependencies. */
export type InvoiceLineOrderDependencies = DocumentLineOrderDependencies;

/** The role and the company, read from the session and never from the body. */
function requireOrderActor(actor: RequestActor): string {
  requireAnyRole(actor, Object.freeze(["owner"] as const));

  return requireCompanyId(actor);
}

/**
 * What one document family's line order needs to know about itself.
 *
 * ## Why the swap is written once
 *
 * `0023` and `0026` declare the same shape of index - a partial unique key on `(parent, position)` over the
 * live rows, not deferrable - so the three-write argument above is not an invoice argument, it is an
 * argument about that index. A quote's editor needs the identical swap, and a second copy of a
 * concurrency-critical sequence is a second place to get it wrong with nothing to catch the difference:
 * both copies pass their own gate. So the swap lives here once, parameterised by the two table names, the
 * column a line points at its parent with, the columns the editor reads, the status whose lines may move,
 * and the vocabulary the move is reported and audited in.
 *
 * What stays document-specific is the mapping from a row to the printed line, which each family owns.
 */
export interface DocumentLineOrder<TRow, TLine> {
  /** `invoices`, `estimates`. */
  readonly parentTable: string;
  /** `invoice_items`, `estimate_items`. */
  readonly itemsTable: string;
  /** The column a line points at its parent with: `invoice_id`, `estimate_id`. */
  readonly parentColumn: string;
  /** The `select=`-prefixed columns the editor reads one line with: rule 17, never a `*`. */
  readonly lineColumns: string;
  /** The only status whose lines may move; a decided document is frozen by its own trigger. */
  readonly draftStatus: string;
  /** The audit action of a move in this family's vocabulary. */
  readonly movedAction: string;
  /** The audit entity a line is: `invoice_line`, `estimate_line`. */
  readonly lineEntity: string;
  /** The rule name a missing parent is reported under. */
  readonly parentRule: string;
  /** The rule name a missing line is reported under. */
  readonly lineRule: string;
  /** The row schema of the items table, which is also what the returned lines are validated by. */
  readonly rowSchema: z.ZodType<TRow>;
  /** One row as this family prints it. */
  readonly lineOf: (row: TRow) => TLine;
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
  document: { readonly parentTable: string; readonly draftStatus: string; readonly parentRule: string },
  dependencies: InvoiceLineOrderDependencies,
  input: { readonly companyId: string; readonly parentId: string },
): Promise<void> {
  const rows = await dependencies.rest.select(
    document.parentTable,
    `select=id,status&id=eq.${input.parentId}&company_id=eq.${input.companyId}&deleted_at=is.null`,
    z.object({ id: z.string().uuid(), status: z.string().min(1) }),
  );

  if (rows[0] === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      cause: { rule: document.parentRule, reason: "not_found" },
    });
  }

  if (rows[0].status !== document.draftStatus) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_changed" }] });
  }
}

/** The live lines of one document in print order. */
async function readOrderedLines(
  document: { readonly itemsTable: string; readonly parentColumn: string },
  rest: RestClient,
  companyId: string,
  parentId: string,
): Promise<readonly { readonly id: string; readonly position: number }[]> {
  return rest.select(
    document.itemsTable,
    `select=id,position&${document.parentColumn}=eq.${parentId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    z.object({ id: z.string().uuid(), position: z.number().int() }),
  );
}

/** One scoped position write. */
async function writePosition(
  document: { readonly itemsTable: string; readonly parentColumn: string },
  rest: RestClient,
  input: { readonly companyId: string; readonly parentId: string; readonly lineId: string; readonly position: number },
): Promise<void> {
  await rest.update(
    document.itemsTable,
    `id=eq.${input.lineId}&company_id=eq.${input.companyId}&${document.parentColumn}=eq.${input.parentId}&deleted_at=is.null`,
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
 *
 * The sequence is the three-write swap described at the top of this module, and it is the same sequence for
 * every document family that declares a non-deferrable partial unique key on `(parent, position)`.
 */
export async function moveDocumentLine<TRow, TLine>(
  document: DocumentLineOrder<TRow, TLine>,
  input: {
    readonly actor: RequestActor;
    readonly parentId: string;
    readonly lineId: string;
    readonly direction: DocumentLineMoveDirection;
  },
  dependencies: DocumentLineOrderDependencies,
): Promise<{ readonly movedLineId: string; readonly lines: readonly TLine[] }> {
  const companyId = requireOrderActor(input.actor);

  await requireDraftStatus(document, dependencies, { companyId, parentId: input.parentId });

  const ordered = await readOrderedLines(document, dependencies.rest, companyId, input.parentId);
  const index = ordered.findIndex((line) => line.id === input.lineId);

  if (index === -1) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: document.lineRule, reason: "not_found" } });
  }

  const neighbourIndex = input.direction === "up" ? index - 1 : index + 1;

  // A move past either end is a no-op, and answers with the list as it stands.
  if (neighbourIndex < 0 || neighbourIndex >= ordered.length) {
    const unchanged = await dependencies.rest.select(
      document.itemsTable,
      `${document.lineColumns}&${document.parentColumn}=eq.${input.parentId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
      document.rowSchema,
    );

    return { movedLineId: input.lineId, lines: unchanged.map((line) => document.lineOf(line)) };
  }

  const moving = ordered[index];
  const displaced = ordered[neighbourIndex];

  if (moving === undefined || displaced === undefined) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: document.lineRule, reason: "order_changed" } });
  }

  // The parking position: one past the highest live position, which by definition no row holds.
  const parked = ordered.reduce((highest, line) => Math.max(highest, line.position), 0) + 1;

  // 1. park the moving line, freeing the position it held.
  await writePosition(document, dependencies.rest, {
    companyId,
    parentId: input.parentId,
    lineId: moving.id,
    position: parked,
  });

  // 2. the displaced line takes the moving line's old position, which is now free.
  await writePosition(document, dependencies.rest, {
    companyId,
    parentId: input.parentId,
    lineId: displaced.id,
    position: moving.position,
  });

  // 3. the moving line takes the displaced line's old position, which step 2 just freed.
  await writePosition(document, dependencies.rest, {
    companyId,
    parentId: input.parentId,
    lineId: moving.id,
    position: displaced.position,
  });

  await appendTolerated(dependencies.audit, {
    action: document.movedAction,
    actorUserId: input.actor.userId,
    entityType: document.lineEntity,
    entityId: moving.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      [document.parentColumn]: input.parentId,
      direction: input.direction,
      from_position: moving.position,
      to_position: displaced.position,
    },
  });

  const reordered = await dependencies.rest.select(
    document.itemsTable,
    `${document.lineColumns}&${document.parentColumn}=eq.${input.parentId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    document.rowSchema,
  );

  return { movedLineId: moving.id, lines: reordered.map((line) => document.lineOf(line)) };
}

/** The invoice's own line order, which is `0023`'s table and column names and this module's swap. */
const INVOICE_LINE_ORDER: DocumentLineOrder<z.infer<typeof invoiceLineRowSchema>, InvoiceLine> = {
  parentTable: "invoices",
  itemsTable: INVOICE_ITEMS_TABLE,
  parentColumn: "invoice_id",
  lineColumns: INVOICE_LINE_COLUMNS,
  draftStatus: INVOICE_CREATED_STATUS,
  movedAction: INVOICE_LINE_MOVED_AUDIT_ACTION,
  lineEntity: "invoice_line",
  parentRule: "invoice",
  lineRule: "invoice_line",
  rowSchema: invoiceLineRowSchema,
  lineOf,
};

/** Move one line of a draft invoice, which is the invoice's names on the shared swap. */
export async function moveInvoiceLine(
  input: {
    readonly actor: RequestActor;
    readonly invoiceId: string;
    readonly lineId: string;
    readonly direction: InvoiceLineMoveDirection;
  },
  dependencies: InvoiceLineOrderDependencies,
): Promise<{ readonly movedLineId: string; readonly lines: readonly InvoiceLine[] }> {
  return moveDocumentLine(
    INVOICE_LINE_ORDER,
    { actor: input.actor, parentId: input.invoiceId, lineId: input.lineId, direction: input.direction },
    dependencies,
  );
}
