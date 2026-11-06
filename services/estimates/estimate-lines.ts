// path: services/estimates/estimate-lines.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import {
  assertDiscountFits,
  basisPointsToColumn,
  DISCOUNT_DEFAULT_BASIS,
  discountStateOf,
  isDiscountBasis,
  percentToBasisPoints,
  resolveDiscount,
  type DiscountBasis,
} from "../invoices/invoice-discount.ts";
import { INVOICE_MAXIMUM_LINES } from "../invoices/invoice-fields.ts";
import {
  moveDocumentLine,
  type DocumentLineMoveDirection,
  type DocumentLineOrder,
  type DocumentLineOrderDependencies,
} from "../invoices/invoice-line-order.ts";
import { parsedLineTotalMinor } from "../invoices/invoice-lines.ts";
import { thousandthsToQuantity } from "../invoices/invoice-totals.ts";
import {
  INVOICE_LINE_FIELDS,
  orderDocumentDetails,
  parseDocumentLineBody,
  type ParsedLine,
} from "../invoices/invoices.ts";
import { priceColumnSchema, priceProblemOf, priceToMinor } from "../products/price.ts";
import {
  ESTIMATE_CREATED_STATUS,
  ESTIMATE_ITEMS_TABLE,
  ESTIMATE_ITEM_COLUMNS,
  ESTIMATE_TABLE,
} from "./estimate-fields.ts";
import {
  ESTIMATE_MANAGE_ROLES,
  estimateItemRowSchema,
  estimateLineSnapshotOf,
  estimateTotalsOf,
  type EstimateItemRow,
  type EstimateLineSnapshot,
  type EstimateSnapshot,
} from "./estimates.ts";

/**
 * Section 16's quote lines after the quote exists: added, edited, ordered and removed.
 *
 * ## The one rule that makes this module an estimate module
 *
 * `0026`'s `estimate_items_sync_totals` raises `lines of an issued estimate are locked` unless the parent
 * is a draft. So a quote's lines are editable for exactly as long as nobody has been asked to decide on
 * them, and the moment it is sent - which is STEP 120's write - every function here becomes a refusal. That
 * is not a preference about editing, it is what makes a signature mean something: a client who signs a
 * quote signs the lines that were in front of them, and a merchant who could add a line afterwards could
 * change what was agreed without the client knowing. `estimates_guard_terminal` freezes the parent for the
 * same reason, and this module answers before either trigger has to.
 *
 * ## What is shared with an invoice and what is not
 *
 * A line is the same seven values with the same ceilings in both documents, so the parser
 * (`parseDocumentLineBody`), the money (`thousandthsToQuantity`, `parsedLineTotalMinor`), the discount
 * (`resolveDiscount`, `assertDiscountFits`) and the three-write swap (`moveDocumentLine`) are the invoice's,
 * imported. What is the estimate's own is the vocabulary: the two tables, the `estimate_id` column, the
 * audit actions, and the rule names a refusal carries. A duplicated parser here would be a second, weaker
 * definition of what a line is, and the two would drift the first time one document's ceiling moved.
 *
 * ## The shape of every write
 *
 * Each mutator does the same five things in the same order: the role and the company come from the session
 * and never from the body; the parent is read and has to be a live draft of that company; the line is read
 * and has to belong to that parent; the write is scoped to the row, the company and `deleted_at is null`;
 * and the row is read back afterwards, because a REST update that matched nothing still reports success.
 * Only then is the audit entry written, inside the same flow as the change it records.
 */

/** The audit actions of the four line operations and of a totals change. */
export const ESTIMATE_LINE_ADDED_AUDIT_ACTION = "estimate.line_added";
export const ESTIMATE_LINE_UPDATED_AUDIT_ACTION = "estimate.line_updated";
export const ESTIMATE_LINE_REMOVED_AUDIT_ACTION = "estimate.line_removed";
export const ESTIMATE_LINE_MOVED_AUDIT_ACTION = "estimate.line_moved";
export const ESTIMATE_DISCOUNT_UPDATED_AUDIT_ACTION = "estimate.discount_updated";

/** A line is its own entity in the trail, so an investigation can follow one line of one quote. */
export const ESTIMATE_LINE_AUDIT_ENTITY = "estimate_line";

export interface EstimateLineDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The parent a line write is allowed against: one live draft of the actor's own company. */
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

/** The role and the company, read from the session and never from the body. */
function requireEstimateLineActor(actor: RequestActor): string {
  requireAnyRole(actor, ESTIMATE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/**
 * The quote a line write is against, or a refusal.
 *
 * Three answers, and the difference between the first two matters:
 *   - not a live quote of this company: `RESOURCE_NOT_FOUND`, so a crafted id cannot be used to probe what
 *     exists in another merchant's book;
 *   - a quote that is no longer a draft: `CONFLICT`, because it exists and is simply no longer editable. A
 *     404 would tell a merchant their quote had vanished, and a 500 from `0026`'s trigger would tell them
 *     nothing at all;
 *   - a draft: the parent, so the caller has the company without reading it again.
 */
async function requireDraftParent(
  dependencies: EstimateLineDependencies,
  input: { readonly companyId: string; readonly estimateId: string },
): Promise<DraftParent> {
  if (!z.string().uuid().safeParse(input.estimateId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "estimateId", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `select=id,company_id,status&id=eq.${input.estimateId}&company_id=eq.${input.companyId}&deleted_at=is.null`,
    parentSchema,
  );
  const parent = rows[0];

  if (parent === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  if (parent.status !== ESTIMATE_CREATED_STATUS) {
    // `estimate_items_sync_totals` would raise on the write anyway. Answering first turns a database
    // exception into a sentence the screen can print, and leaves the trigger as the authority.
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_changed" }] });
  }

  return { id: parent.id, companyId: parent.company_id, status: parent.status };
}

/** The live lines of one quote, in print order. */
async function readLiveLines(
  rest: RestClient,
  companyId: string,
  estimateId: string,
): Promise<readonly EstimateItemRow[]> {
  return rest.select(
    ESTIMATE_ITEMS_TABLE,
    `${ESTIMATE_ITEM_COLUMNS}&estimate_id=eq.${estimateId}&company_id=eq.${companyId}&deleted_at=is.null&order=position.asc`,
    estimateItemRowSchema,
  );
}

/** One live line of the actor's company, or a 404. */
async function readOneLine(
  rest: RestClient,
  companyId: string,
  lineId: string,
): Promise<EstimateItemRow> {
  if (!z.string().uuid().safeParse(lineId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lineId", rule: "invalid_format" }] });
  }

  const rows = await rest.select(
    ESTIMATE_ITEMS_TABLE,
    `${ESTIMATE_ITEM_COLUMNS}&id=eq.${lineId}&company_id=eq.${companyId}&deleted_at=is.null`,
    estimateItemRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate_line", reason: "not_found" } });
  }

  return row;
}

/** The row a parsed line is written with. The position is the caller's decision, not this helper's. */
function rowOfLine(
  estimateId: string,
  companyId: string,
  position: number,
  line: ParsedLine,
): Record<string, unknown> {
  return {
    company_id: companyId,
    estimate_id: estimateId,
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

/** The highest live position in a quote, or zero when it has no lines. */
function highestPosition(lines: readonly EstimateItemRow[]): number {
  return lines.reduce((highest, line) => Math.max(highest, line.position), 0);
}

/** Parse one line of an editor's body, with the field names the editor's own boxes carry. */
export function parseEstimateLine(body: unknown): ParsedLine {
  return parseDocumentLineBody(body);
}

/**
 * Add one line to a draft quote, at the end of the list.
 *
 * ## Why the end
 *
 * A merchant adding a line while editing is adding it to the bottom of what they are writing; inserting at
 * the cursor is a richer behaviour this STEP does not claim, and `moveEstimateLine` moves a line afterwards.
 * Appending also means the position is `max + 1`, the one value no live row already holds, so the partial
 * unique index `0026` declares can never be hit by an insert.
 *
 * ## Why the count is checked before the write
 *
 * `INVOICE_MAXIMUM_LINES` bounds a document so one request can build it inside one body, and the create
 * route enforces the same ceiling. An editor that could add past it would let a quote grow beyond what the
 * create path could ever have produced, which is a document nobody has validated.
 */
export async function addEstimateLine(
  input: {
    readonly actor: RequestActor;
    readonly estimateId: string;
    readonly line: ParsedLine;
  },
  dependencies: EstimateLineDependencies,
): Promise<EstimateLineSnapshot> {
  const companyId = requireEstimateLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, estimateId: input.estimateId });
  const lines = await readLiveLines(dependencies.rest, companyId, parent.id);

  if (lines.length >= INVOICE_MAXIMUM_LINES) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lines", rule: "too_many" }] });
  }

  const position = highestPosition(lines) + 1;

  const [inserted] = await dependencies.rest.insertReturning(
    ESTIMATE_ITEMS_TABLE,
    [rowOfLine(parent.id, companyId, position, input.line)],
    estimateItemRowSchema,
  );

  if (inserted === undefined) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "estimate_line", reason: "insert_returned_no_row" } });
  }

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_LINE_ADDED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: ESTIMATE_LINE_AUDIT_ENTITY,
    entityId: inserted.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      estimate_id: parent.id,
      position,
      // The description is free text a merchant may have pasted anything into; the trail records the shape
      // of the change, never its content.
      line_total_minor: inserted.line_total_minor.toString(),
    },
  });

  return estimateLineSnapshotOf(inserted);
}

/**
 * Edit one line of a draft quote.
 *
 * Every field of the line is replaced, not merged. A line is a snapshot of seven values that only make
 * sense together - a quantity without its unit is not an amount - so the editor sends all seven and this
 * write judges all seven with the same parser a created line is judged by. The position is deliberately
 * absent: `moveEstimateLine` owns that, and an edit that could also move a line would be two operations
 * behind one request, each able to fail on its own.
 *
 * ## The guard an edit needs and looks like it does not
 *
 * An edit can lower a line just as a removal can remove one, and `estimates_discount_check` compares a
 * stored flat discount with the subtotal the trigger is about to write. So the projected subtotal - every
 * other live line plus this line's new total - is checked against the stored discount before the write, and
 * the refusal names `discount` rather than arriving as a constraint violation after the line has moved.
 */
export async function updateEstimateLine(
  input: {
    readonly actor: RequestActor;
    readonly estimateId: string;
    readonly lineId: string;
    readonly line: ParsedLine;
  },
  dependencies: EstimateLineDependencies,
): Promise<EstimateLineSnapshot> {
  const companyId = requireEstimateLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, estimateId: input.estimateId });
  const stored = await readOneLine(dependencies.rest, companyId, input.lineId);

  if (stored.estimate_id !== parent.id) {
    // The line exists and belongs to this merchant, but not to the quote the path names. Answering 404
    // rather than editing it is what keeps the two halves of the path meaning one document.
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate_line", reason: "wrong_estimate" } });
  }

  const values = rowOfLine(stored.estimate_id, companyId, stored.position, input.line);
  const others = await readLiveLines(dependencies.rest, companyId, stored.estimate_id);
  const projectedSubtotal =
    others.reduce((total, line) => (line.id === stored.id ? total : total + line.line_total_minor), 0n) +
    parsedLineTotalMinor(input.line);

  await assertStoredDiscountFits(dependencies.rest, {
    companyId,
    estimateId: stored.estimate_id,
    projectedSubtotalMinor: projectedSubtotal,
  });

  await dependencies.rest.update(
    ESTIMATE_ITEMS_TABLE,
    `id=eq.${stored.id}&company_id=eq.${companyId}&estimate_id=eq.${stored.estimate_id}&deleted_at=is.null`,
    values,
  );

  const updated = await readOneLine(dependencies.rest, companyId, stored.id);

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_LINE_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: ESTIMATE_LINE_AUDIT_ENTITY,
    entityId: updated.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      estimate_id: stored.estimate_id,
      position: updated.position,
      fields: ["description", "unit", "quantity", "unit_price", "discount", "product_id", "service_id"],
      line_total_minor: updated.line_total_minor.toString(),
    },
  });

  return estimateLineSnapshotOf(updated);
}

/**
 * Remove one line from a draft quote, and close the gap it leaves.
 *
 * ## Why the positions after it move
 *
 * `estimate_items_position_key` is unique per `(estimate_id, position)` over the live rows, and a soft
 * delete releases the position. Releasing it is not enough for an editor: the list it prints is dense,
 * "move up" addresses the row above, and a gap would make the printed order disagree with the positions. So
 * the rows after the removed one are shifted down by one, in one update per row, lowest first - each target
 * having just been freed by the row ahead of it, which is why the pass cannot collide with the index.
 *
 * ## Why the last line cannot be removed
 *
 * A quote with no lines is not a document `0025` can total, and the create path refuses one. Refusing here
 * too keeps the two paths agreeing about what a draft is, instead of letting an editor reach a state a
 * create never could.
 */
export async function removeEstimateLine(
  input: { readonly actor: RequestActor; readonly estimateId: string; readonly lineId: string },
  dependencies: EstimateLineDependencies,
): Promise<{ readonly removedLineId: string; readonly lines: readonly EstimateLineSnapshot[] }> {
  const companyId = requireEstimateLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, estimateId: input.estimateId });
  const stored = await readOneLine(dependencies.rest, companyId, input.lineId);

  if (stored.estimate_id !== parent.id) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate_line", reason: "wrong_estimate" } });
  }

  const lines = await readLiveLines(dependencies.rest, companyId, parent.id);

  if (lines.length === 1) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lines", rule: "empty" }] });
  }

  // The subtotal this removal is about to produce, summed from the rows already in hand: every live line
  // except the one being removed. No extra read, and no dependence on what the trigger will write.
  const projectedSubtotal = lines.reduce(
    (total, line) => (line.id === stored.id ? total : total + line.line_total_minor),
    0n,
  );

  await assertStoredDiscountFits(dependencies.rest, {
    companyId,
    estimateId: parent.id,
    projectedSubtotalMinor: projectedSubtotal,
  });

  await dependencies.rest.update(
    ESTIMATE_ITEMS_TABLE,
    `id=eq.${stored.id}&company_id=eq.${companyId}&estimate_id=eq.${stored.estimate_id}&deleted_at=is.null`,
    { deleted_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() },
  );

  // Close the gap the removal left, lowest first, so each target has already been freed.
  const orphans = lines.filter((line) => line.position > stored.position);

  for (const orphan of orphans) {
    await dependencies.rest.update(
      ESTIMATE_ITEMS_TABLE,
      `id=eq.${orphan.id}&company_id=eq.${companyId}&estimate_id=eq.${stored.estimate_id}&deleted_at=is.null`,
      { position: orphan.position - 1 },
    );
  }

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_LINE_REMOVED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: ESTIMATE_LINE_AUDIT_ENTITY,
    entityId: stored.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      estimate_id: stored.estimate_id,
      position: stored.position,
      // How many rows moved up to close the gap, which is the fact an investigation needs - never what the
      // removed line said.
      shifted: orphans.length,
    },
  });

  const remaining = await readLiveLines(dependencies.rest, companyId, parent.id);

  return { removedLineId: stored.id, lines: remaining.map((line) => estimateLineSnapshotOf(line)) };
}

/** The quote's own line order: `0026`'s table and column names, and the shared three-write swap. */
const ESTIMATE_LINE_ORDER: DocumentLineOrder<EstimateItemRow, EstimateLineSnapshot> = {
  parentTable: ESTIMATE_TABLE,
  itemsTable: ESTIMATE_ITEMS_TABLE,
  parentColumn: "estimate_id",
  lineColumns: ESTIMATE_ITEM_COLUMNS,
  draftStatus: ESTIMATE_CREATED_STATUS,
  movedAction: ESTIMATE_LINE_MOVED_AUDIT_ACTION,
  lineEntity: ESTIMATE_LINE_AUDIT_ENTITY,
  parentRule: "estimate",
  lineRule: "estimate_line",
  rowSchema: estimateItemRowSchema,
  lineOf: estimateLineSnapshotOf,
};

/**
 * Move one line of a draft quote one place up or down.
 *
 * The swap is the invoice's, imported: `0023` and `0026` declare the same non-deferrable partial unique
 * key, so the three-write sequence that satisfies it after every statement is one argument and not two.
 * `invoice-line-order.ts` explains why a two-write swap cannot work and why the parking position is
 * computed rather than constant.
 */
export async function moveEstimateLine(
  input: {
    readonly actor: RequestActor;
    readonly estimateId: string;
    readonly lineId: string;
    readonly direction: DocumentLineMoveDirection;
  },
  dependencies: DocumentLineOrderDependencies,
): Promise<{ readonly movedLineId: string; readonly lines: readonly EstimateLineSnapshot[] }> {
  return moveDocumentLine(
    ESTIMATE_LINE_ORDER,
    { actor: input.actor, parentId: input.estimateId, lineId: input.lineId, direction: input.direction },
    dependencies,
  );
}

/**
 * The order a totals screen reads its three boxes.
 *
 * The basis comes first because it is the field that decides how the discount beside it is read: a
 * percentage and an amount are different numbers with the same shape.
 */
const TOTALS_FIELD_ORDER = ["discount_basis", "discount", "tax"] as const;

/** The three fields a totals body carries, and nothing else. */
const estimateTotalsBodySchema = z
  .object({
    discount: z.string().nullish(),
    discount_basis: z.string().nullish(),
    tax: z.string().nullish(),
  })
  .strict();

/**
 * Parse a totals body into the values `updateEstimateTotals` writes with.
 *
 * ## Why this is in the service and not in the route
 *
 * Rule 11 asks for every input to be validated on the server, and the server is here: a route that parsed
 * the body itself would make the second caller of `updateEstimateTotals` - a job, a conversion, a gate -
 * write its own parser, and two parsers of one body drift. So the route decides only that the body is JSON,
 * and this decides what the three fields mean.
 *
 * ## What the three fields mean
 *
 * `discount_basis` chooses which rule reads `discount`: a percentage is basis points and a flat amount is
 * money, and the basis decides before either is parsed, because "12.5" is a valid percentage and an invalid
 * amount of dollars. A blank field is zero, which is how a merchant takes a discount back off. `tax` is
 * always money. Every refusal names the box it came from and is ordered by the shared document ordering, so
 * a screen marks them top to bottom.
 */
export function parseEstimateTotalsBody(body: unknown): EstimateTotalsUpdate {
  const attempt = estimateTotalsBodySchema.safeParse(body);

  if (!attempt.success) {
    const problems: ErrorDetail[] = [];

    for (const issue of attempt.error.issues) {
      const field = String(issue.path[0] ?? "discount");

      if (!problems.some((problem) => problem.field === field)) {
        problems.push({ field, rule: "invalid_format" });
      }
    }

    throw new AppError("VALIDATION_FAILED", { details: orderDocumentDetails(problems, TOTALS_FIELD_ORDER, INVOICE_LINE_FIELDS) });
  }

  const basisText = (attempt.data.discount_basis ?? "").trim();
  const basis = basisText.length === 0 ? DISCOUNT_DEFAULT_BASIS : basisText;
  const knownBasis = isDiscountBasis(basis) ? basis : null;
  const problems: ErrorDetail[] = [];

  if (knownBasis === null) {
    problems.push({ field: "discount_basis", rule: "invalid_format" });
  }

  const percent = knownBasis === "percent";
  const discountText = (attempt.data.discount ?? "").trim();
  const taxText = (attempt.data.tax ?? "").trim();

  const discountValue =
    discountText.length === 0 ? 0n : percent ? percentToBasisPoints(discountText) : priceToMinor(discountText);

  if (discountValue === null) {
    problems.push({
      field: "discount",
      rule:
        percent || priceProblemOf(discountText) !== "too_large" ? "invalid_format" : "too_large",
    });
  }

  const taxMinor = taxText.length === 0 ? 0n : priceToMinor(taxText);

  if (taxMinor === null) {
    problems.push({ field: "tax", rule: priceProblemOf(taxText) === "too_large" ? "too_large" : "invalid_format" });
  }

  if (problems.length > 0 || knownBasis === null || discountValue === null || taxMinor === null) {
    throw new AppError("VALIDATION_FAILED", { details: orderDocumentDetails(problems, TOTALS_FIELD_ORDER, INVOICE_LINE_FIELDS) });
  }

  return {
    basis: knownBasis,
    basisPoints: knownBasis === "percent" ? discountValue : 0n,
    amountMinor: knownBasis === "percent" ? 0n : discountValue,
    taxMinor,
  };
}

/**
 * Refuse a line change that would leave a stored flat discount larger than the lines add up to.
 *
 * `projectedSubtotalMinor` is the subtotal the write is about to produce, computed by the caller from the
 * lines it already read. The guard compares the **stored** discount, because that is what the trigger's
 * update of the parent will be checked against. A percentage needs no guard here: `0117` re-resolves it in
 * the same statement that writes the subtotal, so it follows the lines down by construction.
 */
async function assertStoredDiscountFits(
  rest: RestClient,
  input: { readonly companyId: string; readonly estimateId: string; readonly projectedSubtotalMinor: bigint },
): Promise<void> {
  const rows = await rest.select(
    ESTIMATE_TABLE,
    `select=id,discount_minor,discount_basis,discount_percent_bp&id=eq.${input.estimateId}&company_id=eq.${input.companyId}&deleted_at=is.null`,
    parentDiscountSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  assertDiscountFits({
    basis: discountStateOf(row).basis,
    discountMinor: row.discount_minor,
    subtotalMinor: input.projectedSubtotalMinor,
  });
}

const parentDiscountSchema = z.object({
  id: z.string().uuid(),
  discount_minor: priceColumnSchema,
  discount_basis: z.string(),
  discount_percent_bp: z.number().int(),
});

const parentSubtotalSchema = z.object({
  id: z.string().uuid(),
  subtotal_minor: priceColumnSchema,
});

const parentRowSchema = z.object({
  id: z.string().uuid(),
  subtotal_minor: priceColumnSchema,
  discount_minor: priceColumnSchema,
  tax_minor: priceColumnSchema,
  total_minor: priceColumnSchema,
  discount_basis: z.string(),
  discount_percent_bp: z.number().int(),
});

/** The discount and tax of a draft quote, which the create path sets and nothing else could change. */
export interface EstimateTotalsUpdate {
  readonly basis: DiscountBasis;
  /** Basis points; zero unless the basis is `percent`. */
  readonly basisPoints: bigint;
  /** The flat amount, already parsed. Ignored when the basis is `percent`. */
  readonly amountMinor: bigint;
  readonly taxMinor: bigint;
}

/**
 * Change the quote-level discount and the tax line of a draft.
 *
 * ## Why a percentage is resolved here and not by the caller
 *
 * A percentage of the subtotal is not a number the merchant typed, it is a function of how many lines the
 * quote currently holds. The subtotal is therefore read back from the parent - the value
 * `estimate_items_sync_totals` wrote - and the money is resolved against it. A caller that sent money it had
 * computed itself would be a second opinion about the same fact, and the two would drift the first time a
 * line changed.
 *
 * ## Why the returned totals are read and not computed
 *
 * `total_minor` is `estimates_derive_total`'s, written by a trigger this module does not run. Answering with
 * this module's own arithmetic would be a second answer that no gate could distinguish from the database's,
 * so the row is read back and the four amounts are printed from what is stored.
 */
export async function updateEstimateTotals(
  input: {
    readonly actor: RequestActor;
    readonly estimateId: string;
    readonly totals: EstimateTotalsUpdate;
  },
  dependencies: EstimateLineDependencies,
): Promise<EstimateSnapshot["totals"]> {
  const companyId = requireEstimateLineActor(input.actor);
  const parent = await requireDraftParent(dependencies, { companyId, estimateId: input.estimateId });

  const subtotalRows = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `select=id,subtotal_minor&id=eq.${parent.id}&company_id=eq.${companyId}&deleted_at=is.null`,
    parentSubtotalSchema,
  );
  const subtotalRow = subtotalRows[0];

  if (subtotalRow === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  const discountMinor = resolveDiscount({
    basis: input.totals.basis,
    basisPoints: input.totals.basisPoints,
    amountMinor: input.totals.amountMinor,
    subtotalMinor: subtotalRow.subtotal_minor,
  });

  // A flat amount larger than the lines add up to is refused here with a field the screen can mark, instead
  // of by `estimates_discount_check` after an UPDATE that would have already half-happened.
  assertDiscountFits({ basis: input.totals.basis, discountMinor, subtotalMinor: subtotalRow.subtotal_minor });

  await dependencies.rest.update(
    ESTIMATE_TABLE,
    `id=eq.${parent.id}&company_id=eq.${companyId}&status=eq.${ESTIMATE_CREATED_STATUS}&deleted_at=is.null`,
    {
      discount_minor: discountMinor,
      discount_basis: input.totals.basis,
      discount_percent_bp: basisPointsToColumn(input.totals.basisPoints),
      tax_minor: input.totals.taxMinor,
    },
  );

  const rows = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `select=id,subtotal_minor,discount_minor,tax_minor,total_minor,discount_basis,discount_percent_bp&id=eq.${parent.id}&company_id=eq.${companyId}&deleted_at=is.null`,
    parentRowSchema,
  );
  const stored = rows[0];

  if (stored === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  const totals = estimateTotalsOf(stored);

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_DISCOUNT_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "estimate",
    entityId: parent.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      basis: input.totals.basis,
      // The percentage is recorded because it is the instruction; the money because it is what the totals
      // became. Neither is free text, so both are safe to keep.
      basis_points: input.totals.basisPoints.toString(),
      discount_minor: totals.discountMinor,
      tax_minor: totals.taxMinor,
      subtotal_minor: totals.subtotalMinor,
      total_minor: totals.totalMinor,
    },
  });

  return totals;
}
