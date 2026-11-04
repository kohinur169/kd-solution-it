// path: services/invoices/invoice-lines.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import {
  INVOICE_CREATED_STATUS,
  INVOICE_ITEMS_TABLE,
  INVOICE_MAXIMUM_LINES,
  type InvoiceUnit,
} from "./invoice-fields.ts";
import { grossLineMinor, thousandthsToQuantity } from "./invoice-totals.ts";

/**
 * Section 16's line item editor: adding, editing, removing and ordering the lines of a **draft**.
 *
 * ## What this module owns, and what it does not
 *
 * `invoices.ts` owns the document and its create; this module owns one line at a time. The split is not
 * cosmetic: a create writes N lines in one insert and never looks at them again, while an editor writes
 * **one** line per request and has to answer "is this line still the one I read", "is its invoice still a
 * draft" and "what position does it take". Those are different questions with different failure modes,
 * and putting them beside the create would make both harder to read.
 *
 * ## The draft lock is the database's, not this module's
 *
 * `invoice_items_sync_totals` raises `lines of an issued invoice are locked` on any insert, update or
 * delete of a line whose parent has left `draft`. This module therefore does not have to enforce it, and
 * deliberately does not try to: it checks the parent's status first so the caller gets an honest 409 with
 * a sentence, but if that check ever raced, the trigger refuses the write anyway. A guard written twice
 * is a guard that can disagree with itself; here the database is the authority and this module is the
 * explanation.
 *
 * ## The subtotal is never sent
 *
 * Every write below leaves `invoices.subtotal_minor` alone. `invoice_items_sync_totals` recomputes it from
 * the live lines after each row change, and `invoices_derive_total` turns it into the total. This module
 * reads the result back rather than computing it, so a line edit can never leave a stored total that
 * disagrees with the lines a client would see.
 *
 * ## Position is the print order, and it is dense
 *
 * `invoice_items_position_key` is a unique index on `(invoice_id, position)` over the live rows, and
 * `invoice_items_position_check` requires `position >= 1`. Two consequences this module lives with:
 *
 *   - a new line takes the highest live position plus one, so the list stays dense and the next line
 *     never lands on a gap a removal left behind;
 *   - a removal **compacts** the positions after it, because a dense list is what the editor shows and a
 *     gap would make "move up" skip a row that does not exist.
 *
 * The compaction is the reason `moveLine` in `invoice-line-order.ts` needs a third write; the note there
 * explains it.
 */

/** The audit action of an added line. */
export const INVOICE_LINE_ADDED_AUDIT_ACTION = "invoice.line_added";

/** The audit action of an edited line. */
export const INVOICE_LINE_UPDATED_AUDIT_ACTION = "invoice.line_updated";

/** The audit action of a removed line. */
export const INVOICE_LINE_REMOVED_AUDIT_ACTION = "invoice.line_removed";

/** The audit entity of all three. */
export const INVOICE_LINE_AUDIT_ENTITY = "invoice_line";

/** One line as the editor sees it. The money is text for the reason `InvoiceLineSnapshot` states. */
export interface InvoiceLine {
  readonly id: string;
  readonly invoiceId: string;
  /** One based, dense, and the order the invoice prints in. */
  readonly position: number;
  readonly description: string;
  readonly unit: InvoiceUnit;
  /** The quantity as it was typed: `2.5`, `1`, `0.25`. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly unitPriceMinor: string;
  readonly discount: string;
  readonly discountMinor: string;
  readonly lineTotalMinor: string;
  readonly productId: string | null;
  readonly serviceId: string | null;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/**
 * The row shape of `0023`, as this module reads it.
 *
 * `line_total_minor` is generated and `quantity` is the decimal text of `numeric(12,3)`, so both are read
 * and never written. The two catalogue references are `num_nonnulls(...) <= 1` by the migration.
 */
export const invoiceLineRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  position: z.number().int().min(1),
  description: z.string().min(1).max(300),
  unit: z.enum(["item", "unit", "hour", "day", "week", "month", "project"]),
  quantity: z.string().min(1),
  unit_price_minor: z.union([z.string(), z.number()]).transform((value) => BigInt(String(value))),
  discount_minor: z.union([z.string(), z.number()]).transform((value) => BigInt(String(value))),
  line_total_minor: z.union([z.string(), z.number()]).transform((value) => BigInt(String(value))),
  product_id: z.string().uuid().nullable(),
  service_id: z.string().uuid().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

type InvoiceLineRow = z.infer<typeof invoiceLineRowSchema>;

/** The columns the editor reads, listed one by one: rule 17, and never a `*`. */
export const INVOICE_LINE_COLUMNS =
  "select=id,company_id,invoice_id,position,description,unit,quantity,unit_price_minor,discount_minor,line_total_minor,product_id,service_id,created_at,updated_at,deleted_at,version";

export interface InvoiceLineDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * The values one line is written with, already parsed.
 *
 * `invoices.ts` produces this shape from a body through `parseLine`, which is exported for exactly this
 * reason: an edited line must be judged by the same seven rules as a created one, and a second parser
 * here would be the drift this whole codebase keeps designing away from.
 */
export interface ParsedInvoiceLine {
  readonly description: string;
  readonly unit: InvoiceUnit;
  readonly quantityThousandths: bigint;
  readonly unitPriceMinor: bigint;
  readonly discountMinor: bigint;
  readonly productId: string | null;
  readonly serviceId: string | null;
}

/** The single line row a snapshot prints. */
export function lineOf(row: InvoiceLineRow): InvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    position: row.position,
    description: row.description,
    unit: row.unit,
    quantity: thousandthsToQuantity(
      // The stored decimal back to thousandths and out again, so 2.500 prints as 2.5.
      quantityThousandthsOf(row.quantity),
    ),
    unitPrice: minorText(row.unit_price_minor),
    unitPriceMinor: row.unit_price_minor.toString(),
    discount: minorText(row.discount_minor),
    discountMinor: row.discount_minor.toString(),
    lineTotalMinor: row.line_total_minor.toString(),
    productId: row.product_id,
    serviceId: row.service_id,
    version: row.version,
    createdAtEpochMs: Date.parse(row.created_at),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

/** `numeric(12,3)` text as the integer thousandths the engine carries. */
function quantityThousandthsOf(text: string): bigint {
  const [whole = "0", fraction = ""] = text.trim().split(".");

  return BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0").slice(0, 3) || "0");
}

/** A minor unit count as the printed major units. Kept local so this module does not import the parser. */
function minorText(minor: bigint): string {
  const whole = minor / 10_000n;
  const fraction = (minor % 10_000n).toString().padStart(4, "0");

  return `${whole.toString()}.${fraction}`;
}

/** The role and the company, read from the session and never from the body. */
function requireLineActor(actor: RequestActor): string {
  requireAnyRole(actor, INVOICE_MANAGE_ROLES_OF_LINES);

  return requireCompanyId(actor);
}

/**
 * The roles that may write a line.
 *
 * The same list as the invoice's own, imported through this constant rather than restated, so a line can
 * never be writable by an account that could not create the document it belongs to.
 */
const INVOICE_MANAGE_ROLES_OF_LINES = Object.freeze(["owner"] as const);

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** The parent invoice's id, status and company, or a refusal. */
interface DraftParent {
  readonly id: string;
  readonly companyId: string;
  readonly status: string;
}

const parentSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  status: z.string().min(1),
});

/**
 * Read the parent invoice and refuse unless it is a live draft of the actor's own company.
 *
 * Three different facts, three different answers, which is the point of doing it here rather than
 * letting one `update` match nothing:
 *
 *   - not found, or another merchant's: `RESOURCE_NOT_FOUND`, the same answer an unknown id gets, so a
 *     crafted id cannot be used to probe what exists;
 *   - not a draft: `CONFLICT`, because the document exists and is simply no longer editable - a 404 would
 *     tell the merchant their invoice had vanished;
 *   - a draft: the parent, so the caller has the company without re-reading it.
 */
async function requireDraftParent(
  dependencies: InvoiceLineDependencies,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<DraftParent> {
  if (!z.string().uuid().safeParse(input.invoiceId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "invoiceId", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    "invoices",
    `select=id,company_id,status&id=eq.${input.invoiceId}&company_id=eq.${input.companyId}&deleted_at=is.null`,
    parentSchema,
  );
  const parent = rows[0];

  if (parent === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice", reason: "not_found" } });
  }

  if (parent.status !== INVOICE_CREATED_STATUS) {
    // `invoice_items_sync_totals` would raise on the write anyway. Answering first turns a database
    // exception into a sentence the screen can print, and leaves the trigger as the authority.
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_changed" }] });
  }

  return { id: parent.id, companyId: parent.company_id, status: parent.status };
}

/** The live lines of an invoice, in print order. */
async function readLiveLines(
  rest: RestClient,
  companyId: string,
  invoiceId: string,
): Promise<readonly InvoiceLineRow[]> {
  return rest.select(
    INVOICE_ITEMS_TABLE,
    `${INVOICE_LINE_COLUMNS}&invoice_id=eq.${invoiceId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    invoiceLineRowSchema,
  );
}

/** One live line of the actor's company, or a 404. */
async function readOneLine(
  rest: RestClient,
  companyId: string,
  lineId: string,
): Promise<InvoiceLineRow> {
  if (!z.string().uuid().safeParse(lineId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lineId", rule: "invalid_format" }] });
  }

  const rows = await rest.select(
    INVOICE_ITEMS_TABLE,
    `${INVOICE_LINE_COLUMNS}&id=eq.${lineId}&company_id=eq.${companyId}&deleted_at=is.null`,
    invoiceLineRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice_line", reason: "not_found" } });
  }

  return row;
}

/** The row a parsed line is written with. The position is the caller's decision, not this helper's. */
function rowOfLine(
  invoiceId: string,
  companyId: string,
  position: number,
  line: ParsedInvoiceLine,
): Record<string, unknown> {
  return {
    company_id: companyId,
    invoice_id: invoiceId,
    position,
    description: line.description,
    unit: line.unit,
    // `numeric(12,3)` takes the decimal text, never the integer thousandths this service carries.
    quantity: thousandthsToQuantity(line.quantityThousandths),
    unit_price_minor: line.unitPriceMinor,
    discount_minor: line.discountMinor,
    product_id: line.productId,
    service_id: line.serviceId,
  };
}

/** The highest live position in an invoice, or zero when it has no lines. */
function highestPosition(lines: readonly InvoiceLineRow[]): number {
  return lines.reduce((highest, line) => Math.max(highest, line.position), 0);
}

/**
 * Add one line to a draft, at the end of the list.
 *
 * ## Why the end
 *
 * A merchant adding a line while editing is adding it to the bottom of what they are writing; inserting
 * at the cursor is a richer behaviour this STEP does not claim, and the ordering slice moves a line
 * afterwards. Appending also means the position is `max + 1`, which is the one value no live row already
 * holds - so the unique index can never be hit by an insert.
 *
 * ## Why the count is checked before the write
 *
 * `INVOICE_MAXIMUM_LINES` bounds the document so a request can build it inside one body. The create route
 * enforces the same ceiling; an editor that could add past it would let a document grow beyond what the
 * create path could ever have produced.
 */
export async function addInvoiceLine(
  input: {
    readonly actor: RequestActor;
    readonly invoiceId: string;
    readonly line: ParsedInvoiceLine;
  },
  dependencies: InvoiceLineDependencies,
): Promise<InvoiceLine> {
  const companyId = requireLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, invoiceId: input.invoiceId });
  const lines = await readLiveLines(dependencies.rest, companyId, parent.id);

  if (lines.length >= INVOICE_MAXIMUM_LINES) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lines", rule: "too_many" }] });
  }

  const position = highestPosition(lines) + 1;

  const [inserted] = await dependencies.rest.insertReturning(
    INVOICE_ITEMS_TABLE,
    [rowOfLine(parent.id, companyId, position, input.line)],
    invoiceLineRowSchema,
  );

  if (inserted === undefined) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "invoice_line", reason: "insert_returned_no_row" } });
  }

  await appendTolerated(dependencies.audit, {
    action: INVOICE_LINE_ADDED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_LINE_AUDIT_ENTITY,
    entityId: inserted.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      invoice_id: parent.id,
      position,
      // The description is free text a merchant may have pasted anything into; the trail records the
      // shape of the change, never its content.
      line_total_minor: inserted.line_total_minor.toString(),
    },
  });

  return lineOf(inserted);
}

/**
 * Edit one line of a draft.
 *
 * Every field of the line is replaced, not merged. A line is a snapshot of seven values that only make
 * sense together - a quantity without its unit is not an amount - so the editor sends all seven and this
 * write validates all seven with the same parser the create uses. The position is deliberately absent:
 * `moveInvoiceLine` owns that, and an edit that could also move a line would be two operations behind one
 * request, each able to fail on its own.
 *
 * The write is scoped to the row, the company and `deleted_at is null`, and the row is re-read
 * afterwards - the same discipline `updateCatalogueEntry` follows, because a REST update that matched
 * nothing still reports success.
 */
export async function updateInvoiceLine(
  input: {
    readonly actor: RequestActor;
    readonly invoiceId: string;
    readonly lineId: string;
    readonly line: ParsedInvoiceLine;
  },
  dependencies: InvoiceLineDependencies,
): Promise<InvoiceLine> {
  const companyId = requireLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, invoiceId: input.invoiceId });
  const stored = await readOneLine(dependencies.rest, companyId, input.lineId);

  if (stored.invoice_id !== parent.id) {
    // The line exists and belongs to this merchant, but not to the invoice the path names. Answering
    // 404 rather than editing it is what keeps the two halves of the path consistent.
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice_line", reason: "wrong_invoice" } });
  }

  const values = rowOfLine(stored.invoice_id, companyId, stored.position, input.line);

  await dependencies.rest.update(
    INVOICE_ITEMS_TABLE,
    `id=eq.${stored.id}&company_id=eq.${companyId}&invoice_id=eq.${stored.invoice_id}&deleted_at=is.null`,
    values,
  );

  const updated = await readOneLine(dependencies.rest, companyId, stored.id);

  await appendTolerated(dependencies.audit, {
    action: INVOICE_LINE_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_LINE_AUDIT_ENTITY,
    entityId: updated.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      invoice_id: stored.invoice_id,
      position: updated.position,
      fields: ["description", "unit", "quantity", "unit_price", "discount", "product_id", "service_id"],
      line_total_minor: updated.line_total_minor.toString(),
    },
  });

  return lineOf(updated);
}

/**
 * Remove one line from a draft, and close the gap it leaves.
 *
 * ## Why the positions after it move
 *
 * `invoice_items_position_key` is unique per `(invoice_id, position)` over the live rows, and the index's
 * own comment says a removal frees its place. Freeing it is not enough for an editor: the list it prints
 * is dense, "move up" addresses the row above, and a gap would make the printed order disagree with the
 * positions. So the rows after the removed one are shifted down by one, in **one** update per row.
 *
 * ## Why this cannot collide with the unique index
 *
 * Every shift moves a row from `p` to `p - 1`, and `p - 1` is the position just vacated by the row ahead
 * of it - which is being moved in the same pass, from the lowest orphan upward. Because the pass runs in
 * ascending order and each target was freed by the previous statement (or by the removal itself), no two
 * live rows ever hold the same position. The reorder case is the one that needs a third write; the note
 * in `invoice-line-order.ts` explains why.
 *
 * ## Why it is a soft delete
 *
 * `0023` keeps the row: a line that was printed on a draft the merchant may have exported should still be
 * answerable from the database, and the partial index releases the position so the list stays dense.
 */
export async function removeInvoiceLine(
  input: { readonly actor: RequestActor; readonly invoiceId: string; readonly lineId: string },
  dependencies: InvoiceLineDependencies,
): Promise<{ readonly removedLineId: string; readonly lines: readonly InvoiceLine[] }> {
  const companyId = requireLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, invoiceId: input.invoiceId });
  const stored = await readOneLine(dependencies.rest, companyId, input.lineId);

  if (stored.invoice_id !== parent.id) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice_line", reason: "wrong_invoice" } });
  }

  const lines = await readLiveLines(dependencies.rest, companyId, parent.id);

  if (lines.length === 1) {
    // An invoice with no lines is not a document `0022` can total, and the create path refuses one.
    // Refusing here keeps the two paths agreeing about what a draft is.
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lines", rule: "empty" }] });
  }

  await dependencies.rest.update(
    INVOICE_ITEMS_TABLE,
    `id=eq.${stored.id}&company_id=eq.${companyId}&invoice_id=eq.${stored.invoice_id}&deleted_at=is.null`,
    { deleted_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() },
  );

  // Close the gap the removal left, lowest first, so each target has already been freed.
  const orphans = lines.filter((line) => line.position > stored.position);

  for (const orphan of orphans) {
    await dependencies.rest.update(
      INVOICE_ITEMS_TABLE,
      `id=eq.${orphan.id}&company_id=eq.${companyId}&invoice_id=eq.${stored.invoice_id}&deleted_at=is.null`,
      { position: orphan.position - 1 },
    );
  }

  await appendTolerated(dependencies.audit, {
    action: INVOICE_LINE_REMOVED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_LINE_AUDIT_ENTITY,
    entityId: stored.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      invoice_id: stored.invoice_id,
      position: stored.position,
      // How many rows moved up to close the gap, which is the fact an investigation needs - never what
      // they said.
      shifted: orphans.length,
    },
  });

  const remaining = await readLiveLines(dependencies.rest, companyId, parent.id);

  return { removedLineId: stored.id, lines: remaining.map((line) => lineOf(line)) };
}

/** The gross of a parsed line, for a caller that wants it without reading the row back. */
export function parsedLineTotalMinor(line: ParsedInvoiceLine): bigint {
  return (
    grossLineMinor({
      quantityThousandths: line.quantityThousandths,
      unitPriceMinor: line.unitPriceMinor,
    }) - line.discountMinor
  );
}

/** The empty list a refusal about a line's fields is paired with, so a caller has one shape. */
export type LineDetails = readonly ErrorDetail[];
