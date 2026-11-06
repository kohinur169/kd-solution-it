// path: lib/tax/taxcloud-tax-line.ts
import { AppError } from "../errors/app-error.ts";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import type { RequestActor } from "../auth/types.ts";
import { deepFreeze } from "../utils/freeze.ts";
import type { RestClient } from "../auth/rest.ts";
import { z as zod } from "zod";
import { TAXCLOUD_PROVIDER_KEY } from "./taxcloud.ts";
import { isTaxCloudCompanyId } from "./taxcloud-connect.ts";
import type { TaxCloudInvoiceTax, TaxCloudLineTax } from "./taxcloud-invoice-tax.ts";

/**
 * Storing the tax line of FEATURE_LIST section 7: "the tax amount ... is stored on invoice and payment
 * records".
 *
 * ## Three records, one answer
 *
 * STEP 179 answers what a set of lines was taxed. This file puts that answer where section 7 says it
 * lives, in three places that must agree:
 *
 *   - `invoices.tax_minor`, the invoice's own number. It already exists in `0022`, its total trigger
 *     recomputes `subtotal - discount + tax`, and the comment in `0036` says the collector writes it -
 *     so this file writes one column and lets the database do the arithmetic it already owns.
 *   - `invoice_tax_lines`, one row per line, from `0121`. It explains the invoice's number: which line,
 *     how much was taxable, what the rate was and which provider said so.
 *   - `payments.tax_minor`, the part of that tax a payment actually collected, from `0121` as well.
 *
 * ## Why the sum is checked here and not only in a screen
 *
 * The invoice says one number and the table says several. If they disagree, one of two wrong things is
 * true: a client is charged tax the invoice does not show, or a return claims tax that was never
 * charged. So `taxCloudTaxLineRowsOf` refuses an answer whose lines do not add up to the invoice's tax,
 * and refuses an invoice whose own `subtotal - discount + tax` is not its total. The database bounds
 * each row (`tax_minor <= taxable_minor`); this file bounds the set.
 *
 * ## What may be recalculated, and what may not
 *
 * A draft's tax is a calculation and may be calculated again - a merchant adds a line, the destination
 * changes, the rate changes. An invoice that has left `draft` has been sent and filed, so its tax is a
 * fact: this file refuses to write it, and `0121`'s `invoice_tax_lines_guard_issued` refuses the same
 * write at the table. Two guards, because one of them is a service and the other is a database.
 *
 * ## The payment's share, exactly
 *
 * An invoice can be paid in parts. The tax a payment collected is therefore its share of the invoice's
 * tax, in proportion to the money it moved, and the payment that completes the invoice takes the
 * remainder rather than its rounded share. That is what makes the parts add up to the whole without a
 * one minor unit drifting into the ether, and it is why the rule needs `paidBeforeMinor` and
 * `collectedTaxBeforeMinor` rather than the payment alone.
 *
 * ## What is never written here
 *
 * No credential, no connection reference and no TaxCloud identifier beyond the provider's name. The tax
 * line is a money fact; which connection answered is in the audit trail, and the invoice's client, its
 * address and its profile are the invoice's own rows, not copies in this table.
 */

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** The table `0121` creates, and the two shipped tables this file writes one column of each. */
export const TAXCLOUD_TAX_LINE_TABLE = "invoice_tax_lines";
export const TAXCLOUD_INVOICE_TAX_TABLE = "invoices";
export const TAXCLOUD_PAYMENT_TAX_TABLE = "payments";

/** The only provider that answers a tax calculation at launch. */
export const TAXCLOUD_TAX_LINE_PROVIDER_KEY = TAXCLOUD_PROVIDER_KEY;

/** The one invoice status whose tax may be calculated or recalculated. */
export const TAXCLOUD_STORABLE_INVOICE_STATUS = "draft" as const;

/** A rate in basis points: one hundred percent is the ceiling, because more is not a tax. */
export const TAXCLOUD_RATE_MAXIMUM_BP = 10_000;

/** The currency section 7 collects in, and the one the invoice writer uses for it. */
export const TAXCLOUD_TAX_LINE_CURRENCY = "USD" as const;

/** The five answers storing a tax line can have. */
export const TAXCLOUD_TAX_LINE_STATUSES = deepFreeze([
  "stored",
  "cleared",
  "unchanged",
  "refused",
  "conflict",
] as const);

export type TaxCloudTaxLineStatus = (typeof TAXCLOUD_TAX_LINE_STATUSES)[number];

/** The audit actions of a tax write, one per fact. */
export const TAXCLOUD_TAX_LINE_AUDIT_ACTIONS = deepFreeze([
  "taxcloud.tax_line_stored",
  "taxcloud.tax_line_cleared",
  "taxcloud.payment_tax_stored",
] as const);

export type TaxCloudTaxLineAuditAction = (typeof TAXCLOUD_TAX_LINE_AUDIT_ACTIONS)[number];

/** The payment statuses whose tax is already collected money, which `0121`'s guard freezes. */
export const TAXCLOUD_SETTLED_PAYMENT_STATUSES: readonly string[] = deepFreeze([
  "settled",
  "partially_refunded",
  "refunded",
] as const);

/* -------------------------------------------------------------------------------------------------
 * The rate
 * ---------------------------------------------------------------------------------------------- */

/**
 * A documented rate as basis points, exactly, without a float multiplication.
 *
 * TaxCloud's `rate` is a decimal such as `0.08125`. Multiplying by ten thousand in binary floating
 * point gives `812.4999999999999` often enough to matter, so the decimal's own digits are read instead,
 * and the rounding - half away from zero, the rule this platform uses for money everywhere - happens on
 * the integer those digits produce. A rate outside zero to one is refused rather than clamped: it is a
 * number no tax has.
 */
export function taxCloudRateBpOf(rate: number | null): number {
  if (rate === null) return 0;

  if (Number.isFinite(rate) === false || rate < 0 || rate > 1) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "rate", rule: "a rate is a decimal fraction between zero and one" }],
    });
  }

  const text = String(rate);
  const [whole = "0", fraction = ""] = text.split(".");
  // Basis points are four decimals of the fraction: `0.08125` is `812.5` of them, which rounds to 813.
  const padded = `${fraction}00000`.slice(0, 5);
  const scaled = BigInt(whole) * 100_000n + BigInt(padded);
  // One hundred thousandth of a unit is a tenth of a basis point, so the last digit decides the round.
  const tenths = scaled % 10n;
  const wholeBasisPoints = scaled / 10n;
  const basisPoints = tenths >= 5n ? wholeBasisPoints + 1n : wholeBasisPoints;

  // A rate at most one can never scale past ten thousand basis points, so the ceiling is a property of
  // the range check above rather than a second refusal here. The gate proves both ends of it.
  return Number(basisPoints);
}

/* -------------------------------------------------------------------------------------------------
 * The rows
 * ---------------------------------------------------------------------------------------------- */

/** One invoice line as the invoice stores it: its net, in minor units, and the TIC if any. */
export interface TaxCloudInvoiceLineMoney {
  /** `invoice_items.id`, which is the `itemId` STEP 179 sent and got back. */
  readonly invoiceItemId: string;
  /** The line's position, which with the id identifies one cart line. */
  readonly index: number;
  /** The line's net after its own discount and its share of the invoice discount, in minor units. */
  readonly netMinor: bigint;
  /** The TIC the merchant assigned, when one is known. */
  readonly tic?: number;
}

/** One row as `0121` stores it. */
export interface TaxCloudTaxLineRow {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly invoiceItemId: string;
  readonly lineIndex: number;
  readonly tic: number | null;
  readonly taxableMinor: bigint;
  readonly taxMinor: bigint;
  readonly rateBp: number;
  readonly currency: string;
  readonly providerKey: string;
  readonly calculatedAtEpochMs: number;
}

/** The invoice the tax belongs to, as its own writer read it. */
export interface TaxCloudInvoiceTaxMoney {
  readonly invoiceId: string;
  readonly status: string;
  readonly version: number;
  readonly currency: string;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
}

/** What storing a tax line is asked to do. */
export interface TaxCloudInvoiceTaxStoreInput {
  readonly actor: RequestActor;
  readonly invoice: TaxCloudInvoiceTaxMoney;
  readonly lines: readonly TaxCloudInvoiceLineMoney[];
  /** STEP 179's answer, or null when collection is off and the invoice carries no tax. */
  readonly tax: TaxCloudInvoiceTax | null;
  readonly nowEpochMs: number;
}

export const TAXCLOUD_TAX_LINE_REQUIRED_COLUMNS: readonly string[] = deepFreeze([
  "id",
  "company_id",
  "invoice_id",
  "invoice_item_id",
  "line_index",
  "tic",
  "taxable_minor",
  "tax_minor",
  "rate_bp",
  "currency",
  "provider_key",
  "calculated_at",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
] as const);

function invoiceProblemOf(money: TaxCloudInvoiceTaxMoney): string | null {
  if (money.subtotalMinor < 0n) return "an invoice subtotal is not negative";
  if (money.discountMinor < 0n) return "an invoice discount is not negative";
  if (money.taxMinor < 0n) return "an invoice tax is not negative";
  if (money.discountMinor > money.subtotalMinor) return "an invoice discount is at most its subtotal";
  if (money.totalMinor !== money.subtotalMinor - money.discountMinor + money.taxMinor) {
    return "the invoice total is not its subtotal less its discount plus its tax";
  }
  if (money.currency !== TAXCLOUD_TAX_LINE_CURRENCY) return "sales tax is collected in United States dollars";

  return null;
}

/**
 * The rows `0121` stores for one calculation, or the reason they cannot be stored.
 *
 * The order is deliberate: the invoice's own arithmetic first, because a wrong invoice is not made right
 * by a tax line; then the lines; then the answer, matched to those lines by the two things TaxCloud
 * echoes - the item id and the index it was asked about. A line the answer does not mention, a line it
 * mentions twice, or an answer for another cart is refused rather than repaired.
 */
export function taxCloudTaxLineRowsOf(
  input: TaxCloudInvoiceTaxStoreInput,
): { readonly rows: readonly TaxCloudTaxLineRow[] } | { readonly reason: string } {
  const problem = invoiceProblemOf(input.invoice);

  if (problem !== null) return { reason: problem };

  const companyId = input.actor.companyId;

  // A platform account has no merchant books, so a tax line it asked to store belongs to nobody.
  if (companyId === null) return { reason: "a tax line belongs to a merchant, and this account has none" };

  if (input.invoice.status !== TAXCLOUD_STORABLE_INVOICE_STATUS) {
    return { reason: "the tax of an invoice that has left draft is a fact and is not recalculated" };
  }

  if (Number.isSafeInteger(input.invoice.version) === false || input.invoice.version < 1) {
    return { reason: "an invoice version is a whole number of at least one" };
  }

  if (Number.isSafeInteger(input.nowEpochMs) === false || input.nowEpochMs <= 0) {
    return { reason: "a calculation instant is a positive whole number of milliseconds" };
  }

  const seen = new Set<string>();

  for (const line of input.lines) {
    if (isTaxCloudCompanyId(line.invoiceItemId) === false) return { reason: "a line id is not one this platform issues" };
    if (Number.isSafeInteger(line.index) === false || line.index < 0 || line.index > 999) {
      return { reason: "a line index is a whole number between zero and 999" };
    }
    if (line.netMinor < 0n) return { reason: "a line's taxable amount is not negative" };
    if (line.tic !== undefined && (Number.isSafeInteger(line.tic) === false || line.tic < 0 || line.tic > 99_999)) {
      return { reason: "a TIC is a whole number between zero and 99999" };
    }

    const key = `${line.invoiceItemId}#${String(line.index)}`;

    if (seen.has(key)) return { reason: "two lines share an id and an index" };
    seen.add(key);
  }

  if (input.tax === null) {
    if (input.invoice.taxMinor !== 0n) return { reason: "a cleared tax line needs an invoice tax of zero" };

    return { rows: [] };
  }

  if (input.tax.currency !== TAXCLOUD_TAX_LINE_CURRENCY) return { reason: "the answer is not a United States dollar answer" };
  if (input.tax.cartId !== input.invoice.invoiceId) return { reason: "the answer was calculated for another invoice" };
  if (input.tax.totalTaxMinor !== input.invoice.taxMinor) return { reason: "the answer's total is not the invoice's tax" };
  if (input.tax.lines.length !== input.lines.length) return { reason: "the answer does not carry one tax per invoice line" };

  const byKey = new Map<string, TaxCloudLineTax>();

  for (const line of input.tax.lines) {
    const key = `${line.itemId}#${String(line.index)}`;

    if (byKey.has(key)) return { reason: "the answer carries two taxes for one line" };
    byKey.set(key, line);
  }

  const rows: TaxCloudTaxLineRow[] = [];
  let summedMinor = 0n;

  for (const line of input.lines) {
    const answered = byKey.get(`${line.invoiceItemId}#${String(line.index)}`);

    if (answered === undefined) return { reason: "the answer has no tax for one of the invoice's lines" };
    if (answered.taxMinor > line.netMinor) return { reason: "a line's tax is above the amount it was calculated on" };

    rows.push({
      companyId,
      invoiceId: input.invoice.invoiceId,
      invoiceItemId: line.invoiceItemId,
      lineIndex: line.index,
      tic: line.tic ?? null,
      taxableMinor: line.netMinor,
      taxMinor: answered.taxMinor,
      rateBp: taxCloudRateBpOf(answered.rate),
      currency: TAXCLOUD_TAX_LINE_CURRENCY,
      providerKey: TAXCLOUD_TAX_LINE_PROVIDER_KEY,
      calculatedAtEpochMs: input.nowEpochMs,
    });
    summedMinor += answered.taxMinor;
  }

  if (summedMinor !== input.invoice.taxMinor) return { reason: "the line amounts do not add up to the invoice's tax" };

  return { rows };
}

/* -------------------------------------------------------------------------------------------------
 * The store
 * ---------------------------------------------------------------------------------------------- */

/** What an invoice currently stores: its tax and its live lines. */
export interface TaxCloudStoredTax {
  readonly taxMinor: bigint;
  readonly lines: readonly TaxCloudTaxLineRow[];
}

/** A payment, as far as the tax is concerned. */
export interface TaxCloudPaymentTaxRow {
  readonly companyId: string;
  readonly paymentId: string;
  readonly invoiceId: string | null;
  readonly amountMinor: bigint;
  readonly taxMinor: bigint;
  readonly status: string;
  readonly version: number;
}

/**
 * The store: one read of what is there, one write of the whole answer.
 *
 * `replaceTax` is declared as one call because it is one fact. The production adapter issues three
 * statements - soft-delete the live lines, insert the new ones, write the invoice's tax under its
 * version - and compensates the first two if the third loses its race; the gate proves that sequence,
 * including the compensation. An adapter that left the lines behind after a lost version would leave an
 * invoice explaining a tax it does not carry.
 */
export interface TaxCloudTaxLineStore {
  readTax(companyId: string, invoiceId: string): Promise<TaxCloudStoredTax>;
  replaceTax(input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly expectedVersion: number;
    readonly taxMinor: bigint;
    readonly rows: readonly TaxCloudTaxLineRow[];
    readonly nowEpochMs: number;
  }): Promise<{ readonly status: "written"; readonly version: number } | { readonly status: "conflict" }>;
  readPayment(companyId: string, paymentId: string): Promise<TaxCloudPaymentTaxRow | null>;
  writePaymentTax(input: {
    readonly companyId: string;
    readonly paymentId: string;
    readonly taxMinor: bigint;
    readonly expectedVersion: number;
    readonly nowEpochMs: number;
  }): Promise<boolean>;
}

function sameRow(left: TaxCloudTaxLineRow, right: TaxCloudTaxLineRow): boolean {
  return (
    left.invoiceItemId === right.invoiceItemId &&
    left.lineIndex === right.lineIndex &&
    left.tic === right.tic &&
    left.taxableMinor === right.taxableMinor &&
    left.taxMinor === right.taxMinor &&
    left.rateBp === right.rateBp &&
    left.currency === right.currency &&
    left.providerKey === right.providerKey
  );
}

/**
 * The in-memory store: `0121`'s invariants as code.
 *
 * One live row per line, a version that moves by one, a tax that only moves with a matched version, and
 * a row that a recalculation replaces rather than stacks. The gate drives every branch of the writer
 * through it, so the rules are tested rather than described.
 */
export class InMemoryTaxCloudTaxLineStore implements TaxCloudTaxLineStore {
  private readonly rows = new Map<string, TaxCloudTaxLineRow & { readonly deletedAtEpochMs: number | null }>();
  private readonly invoiceTax = new Map<string, { taxMinor: bigint; version: number }>();
  private readonly payments = new Map<string, { row: TaxCloudPaymentTaxRow }>();
  /** How many rows have been written, so a replacement appends rather than overwrites. */
  private replacement = 0;

  /** Seed an invoice as its own writer would have stored it. */
  seedInvoice(invoiceId: string, taxMinor: bigint, version: number): void {
    this.invoiceTax.set(invoiceId, { taxMinor, version });
  }

  /** Seed a payment, so the attribution's bounds can be proven against a stored row. */
  seedPayment(row: TaxCloudPaymentTaxRow): void {
    this.payments.set(row.paymentId, { row });
  }

  async readTax(companyId: string, invoiceId: string): Promise<TaxCloudStoredTax> {
    const stored = this.invoiceTax.get(invoiceId);
    const lines = [...this.rows.values()].filter(
      (row) => row.companyId === companyId && row.invoiceId === invoiceId && row.deletedAtEpochMs === null,
    );

    return {
      taxMinor: stored?.taxMinor ?? 0n,
      lines: lines.map(({ deletedAtEpochMs: _deleted, ...row }) => row),
    };
  }

  async replaceTax(input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly expectedVersion: number;
    readonly taxMinor: bigint;
    readonly rows: readonly TaxCloudTaxLineRow[];
    readonly nowEpochMs: number;
  }): Promise<{ readonly status: "written"; readonly version: number } | { readonly status: "conflict" }> {
    const stored = this.invoiceTax.get(input.invoiceId) ?? { taxMinor: 0n, version: 1 };

    if (stored.version !== input.expectedVersion) return { status: "conflict" };

    for (const [id, row] of this.rows) {
      if (row.companyId !== input.companyId || row.invoiceId !== input.invoiceId) continue;
      if (row.deletedAtEpochMs !== null) continue;

      this.rows.set(id, { ...row, deletedAtEpochMs: input.nowEpochMs });
    }

    for (const row of input.rows) {
      // A row of its own, not an overwrite: the table keeps the calculation a recalculation replaced, so
      // the reference store does too, and a gate can prove the history is there.
      this.replacement += 1;
      this.rows.set(`${row.invoiceId}#${String(row.lineIndex)}#${String(this.replacement)}`, {
        ...row,
        deletedAtEpochMs: null,
      });
    }

    this.invoiceTax.set(input.invoiceId, { taxMinor: input.taxMinor, version: input.expectedVersion + 1 });

    return { status: "written", version: input.expectedVersion + 1 };
  }

  async readPayment(companyId: string, paymentId: string): Promise<TaxCloudPaymentTaxRow | null> {
    const stored = this.payments.get(paymentId);

    if (stored === undefined || stored.row.companyId !== companyId) return null;

    return stored.row;
  }

  async writePaymentTax(input: {
    readonly companyId: string;
    readonly paymentId: string;
    readonly taxMinor: bigint;
    readonly expectedVersion: number;
    readonly nowEpochMs: number;
  }): Promise<boolean> {
    const stored = this.payments.get(input.paymentId);

    if (stored === undefined || stored.row.companyId !== input.companyId) return false;
    if (stored.row.version !== input.expectedVersion) return false;
    if (TAXCLOUD_SETTLED_PAYMENT_STATUSES.includes(stored.row.status)) return false;

    this.payments.set(input.paymentId, {
      row: { ...stored.row, taxMinor: input.taxMinor, version: input.expectedVersion + 1 },
    });

    return true;
  }

  /** Every stored row, deleted ones included, so the gate can prove a replacement soft-deleted the old. */
  allRows(): readonly (TaxCloudTaxLineRow & { readonly deletedAtEpochMs: number | null })[] {
    return [...this.rows.values()];
  }
}

/* -------------------------------------------------------------------------------------------------
 * The write
 * ---------------------------------------------------------------------------------------------- */

/** What a caller learns from storing a tax line. */
export type RecordInvoiceTaxResult =
  | { readonly status: "stored"; readonly taxMinor: bigint; readonly lineCount: number; readonly totalMinor: bigint }
  | { readonly status: "cleared"; readonly totalMinor: bigint }
  | { readonly status: "unchanged"; readonly taxMinor: bigint; readonly totalMinor: bigint }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "conflict" };

export interface RecordInvoiceTaxOptions {
  readonly store: TaxCloudTaxLineStore;
  readonly audit: AuditTrail;
}

function taxLineAuditEntryOf(input: {
  readonly action: TaxCloudTaxLineAuditAction;
  readonly actor: RequestActor;
  readonly companyId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): AuditEntry {
  return {
    action: input.action,
    actorUserId: input.actor.userId,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: { ...input.payload },
    companyId: input.companyId,
    sessionId: input.actor.sessionId,
  };
}

/**
 * Store the tax of one draft invoice.
 *
 * The order is the same order STEP 178's switch uses, because the reasons are the same: the caller
 * first (a refused caller learns nothing), then the invoice's own arithmetic, then the answer matched to
 * the lines, then what is already stored - a calculation that changes nothing writes nothing and audits
 * nothing - and only then the write, which is version guarded, with the audit entry after the row it
 * describes.
 */
export async function recordInvoiceTax(
  input: TaxCloudInvoiceTaxStoreInput,
  options: RecordInvoiceTaxOptions,
): Promise<RecordInvoiceTaxResult> {
  const built = taxCloudTaxLineRowsOf(input);

  if ("reason" in built) return { status: "refused", reason: built.reason };

  const companyId = input.actor.companyId as string;

  const stored = await options.store.readTax(companyId, input.invoice.invoiceId);
  const sameLines =
    stored.lines.length === built.rows.length &&
    stored.lines.every((row, index) => sameRow(row, built.rows[index] as TaxCloudTaxLineRow));

  if (stored.taxMinor === input.invoice.taxMinor && sameLines) {
    return { status: "unchanged", taxMinor: stored.taxMinor, totalMinor: input.invoice.totalMinor };
  }

  const written = await options.store.replaceTax({
    companyId,
    invoiceId: input.invoice.invoiceId,
    expectedVersion: input.invoice.version,
    taxMinor: input.invoice.taxMinor,
    rows: built.rows,
    nowEpochMs: input.nowEpochMs,
  });

  if (written.status === "conflict") return { status: "conflict" };

  const cleared = built.rows.length === 0;

  await options.audit.append(
    taxLineAuditEntryOf({
      action: cleared ? "taxcloud.tax_line_cleared" : "taxcloud.tax_line_stored",
      actor: input.actor,
      companyId,
      entityType: "invoice",
      entityId: input.invoice.invoiceId,
      payload: {
        provider_key: TAXCLOUD_TAX_LINE_PROVIDER_KEY,
        currency: input.invoice.currency,
        tax_minor: input.invoice.taxMinor.toString(),
        subtotal_minor: input.invoice.subtotalMinor.toString(),
        discount_minor: input.invoice.discountMinor.toString(),
        total_minor: input.invoice.totalMinor.toString(),
        line_count: built.rows.length,
        invoice_version: written.version,
        outcome: cleared ? "cleared" : "stored",
      },
    }),
  );

  return cleared
    ? { status: "cleared", totalMinor: input.invoice.totalMinor }
    : {
        status: "stored",
        taxMinor: input.invoice.taxMinor,
        lineCount: built.rows.length,
        totalMinor: input.invoice.totalMinor,
      };
}

/* -------------------------------------------------------------------------------------------------
 * The payment's share
 * ---------------------------------------------------------------------------------------------- */

/** What a payment collects of its invoice's tax. */
export interface TaxCloudPaymentTaxInput {
  readonly paymentMinor: bigint;
  readonly invoiceTotalMinor: bigint;
  readonly invoiceTaxMinor: bigint;
  /** The invoice's total already paid by the payments before this one, in minor units. */
  readonly paidBeforeMinor: bigint;
  /** The tax those payments already collected. */
  readonly collectedTaxBeforeMinor: bigint;
}

/**
 * The tax a payment collected: its share of the invoice's tax, with the last payment taking the
 * remainder.
 *
 * The alternative - rounding each payment's share on its own - leaves a penny of tax uncollected on an
 * invoice paid in three parts, and a return that is short by that penny every month. Taking the
 * remainder on the payment that completes the invoice makes the parts add up to the whole by
 * construction, which is the only version of this arithmetic that reconciles.
 */
export function taxCloudPaymentTaxOf(
  input: TaxCloudPaymentTaxInput,
): { readonly taxMinor: bigint } | { readonly reason: string } {
  if (input.invoiceTotalMinor <= 0n) return { reason: "an invoice with no total collects no tax" };
  if (input.invoiceTaxMinor < 0n) return { reason: "an invoice tax is not negative" };
  if (input.invoiceTaxMinor > input.invoiceTotalMinor) return { reason: "an invoice tax is at most its total" };
  if (input.paymentMinor <= 0n) return { reason: "a payment collects nothing when it moves no money" };
  if (input.paidBeforeMinor < 0n) return { reason: "the amount already paid is not negative" };
  if (input.paidBeforeMinor > input.invoiceTotalMinor) return { reason: "the amount already paid is at most the invoice total" };
  if (input.collectedTaxBeforeMinor < 0n) return { reason: "the tax already collected is not negative" };
  if (input.collectedTaxBeforeMinor > input.invoiceTaxMinor) {
    return { reason: "the tax already collected is at most the invoice tax" };
  }
  if (input.paymentMinor > input.invoiceTotalMinor - input.paidBeforeMinor) {
    return { reason: "a payment is at most what the invoice still owes" };
  }

  const remainingTax = input.invoiceTaxMinor - input.collectedTaxBeforeMinor;

  if (remainingTax === 0n) return { taxMinor: 0n };

  // The payment that clears the invoice takes the rest, so the parts equal the whole exactly.
  if (input.paidBeforeMinor + input.paymentMinor === input.invoiceTotalMinor) return { taxMinor: remainingTax };

  const share = (input.invoiceTaxMinor * input.paymentMinor * 2n + input.invoiceTotalMinor) / (input.invoiceTotalMinor * 2n);

  return { taxMinor: share < remainingTax ? share : remainingTax };
}

/** What a caller asks the payment writer to do. */
export interface RecordPaymentTaxInput {
  readonly actor: RequestActor | null;
  readonly companyId: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly paymentMinor: bigint;
  readonly paymentStatus: string;
  readonly paymentVersion: number;
  readonly invoiceTotalMinor: bigint;
  readonly invoiceTaxMinor: bigint;
  readonly paidBeforeMinor: bigint;
  readonly collectedTaxBeforeMinor: bigint;
  readonly nowEpochMs: number;
}

export type RecordPaymentTaxResult =
  | { readonly status: "stored"; readonly taxMinor: bigint }
  | { readonly status: "unchanged"; readonly taxMinor: bigint }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "conflict" };

/**
 * Record the tax a payment collected on its invoice.
 *
 * The write is version guarded like the invoice's, and it refuses a payment whose tax is already
 * collected money: `0121`'s `payments_guard_tax_state` refuses the same write at the table, and this
 * refusal exists so the caller reads a sentence rather than a constraint violation.
 */
export async function recordPaymentTax(
  input: RecordPaymentTaxInput,
  options: RecordInvoiceTaxOptions,
): Promise<RecordPaymentTaxResult> {
  if (isTaxCloudCompanyId(input.companyId) === false) return { status: "refused", reason: "a payment belongs to a company" };
  if (isTaxCloudCompanyId(input.paymentId) === false) return { status: "refused", reason: "a payment id is not one this platform issues" };
  if (isTaxCloudCompanyId(input.invoiceId) === false) return { status: "refused", reason: "an invoice id is not one this platform issues" };
  if (TAXCLOUD_SETTLED_PAYMENT_STATUSES.includes(input.paymentStatus)) {
    return { status: "refused", reason: "the tax of a settled payment is collected money and is not rewritten" };
  }

  const share = taxCloudPaymentTaxOf(input);

  if ("reason" in share) return { status: "refused", reason: share.reason };

  const current = await options.store.readPayment(input.companyId, input.paymentId);

  if (current === null) return { status: "refused", reason: "no payment of this merchant has that id" };
  if (current.invoiceId !== input.invoiceId) return { status: "refused", reason: "the payment belongs to another invoice" };
  if (current.amountMinor !== input.paymentMinor) return { status: "refused", reason: "the payment's amount is not the one recorded" };
  if (current.taxMinor === share.taxMinor) return { status: "unchanged", taxMinor: share.taxMinor };

  const written = await options.store.writePaymentTax({
    companyId: input.companyId,
    paymentId: input.paymentId,
    taxMinor: share.taxMinor,
    expectedVersion: input.paymentVersion,
    nowEpochMs: input.nowEpochMs,
  });

  if (written === false) return { status: "conflict" };

  await options.audit.append({
    action: "taxcloud.payment_tax_stored",
    actorUserId: input.actor === null ? null : input.actor.userId,
    entityType: "payment",
    entityId: input.paymentId,
    payload: {
      provider_key: TAXCLOUD_TAX_LINE_PROVIDER_KEY,
      invoice_id: input.invoiceId,
      payment_id: input.paymentId,
      tax_minor: share.taxMinor.toString(),
      invoice_tax_minor: input.invoiceTaxMinor.toString(),
      invoice_total_minor: input.invoiceTotalMinor.toString(),
      paid_before_minor: input.paidBeforeMinor.toString(),
      collected_tax_before_minor: input.collectedTaxBeforeMinor.toString(),
      outcome: "stored",
    },
    companyId: input.companyId,
    sessionId: input.actor === null ? null : input.actor.sessionId,
  });

  return { status: "stored", taxMinor: share.taxMinor };
}

/* -------------------------------------------------------------------------------------------------
 * The rest adapter
 * ---------------------------------------------------------------------------------------------- */

const taxLineRowSchema = zod.object({
  id: zod.string().trim().min(1),
  company_id: zod.string().trim().min(1),
  invoice_id: zod.string().trim().min(1),
  invoice_item_id: zod.string().trim().min(1),
  line_index: zod.number().int(),
  tic: zod.number().int().nullable(),
  taxable_minor: zod.string(),
  tax_minor: zod.string(),
  rate_bp: zod.number().int(),
  currency: zod.string(),
  provider_key: zod.string(),
  calculated_at: zod.string(),
  version: zod.number().int(),
});

const invoiceRowSchema = zod.object({
  id: zod.string().trim().min(1),
  company_id: zod.string().trim().min(1).optional(),
  tax_minor: zod.string(),
  version: zod.number().int(),
});

const paymentRowSchema = zod.object({
  id: zod.string().trim().min(1),
  company_id: zod.string().trim().min(1),
  invoice_id: zod.string().nullable(),
  amount_minor: zod.string(),
  tax_minor: zod.string(),
  status: zod.string(),
  version: zod.number().int(),
});

const TAXCLOUD_TAX_LINE_SELECT = [
  "id",
  "company_id",
  "invoice_id",
  "invoice_item_id",
  "line_index",
  "tic",
  "taxable_minor",
  "tax_minor",
  "rate_bp",
  "currency",
  "provider_key",
  "calculated_at",
  "created_at",
  "updated_at",
  "deleted_at",
  "version",
].join(",");

interface TaxLineRestRow {
  readonly id: string;
  readonly company_id: string;
  readonly invoice_id: string;
  readonly invoice_item_id: string;
  readonly line_index: number;
  readonly tic: number | null;
  readonly taxable_minor: string;
  readonly tax_minor: string;
  readonly rate_bp: number;
  readonly currency: string;
  readonly provider_key: string;
  readonly calculated_at: string;
  readonly version: number;
}

interface InvoiceRestRow {
  readonly id: string;
  readonly tax_minor: string;
  readonly version: number;
}

interface PaymentRestRow {
  readonly id: string;
  readonly company_id: string;
  readonly invoice_id: string | null;
  readonly amount_minor: string;
  readonly tax_minor: string;
  readonly status: string;
  readonly version: number;
}

function restRowsOf(rows: readonly TaxLineRestRow[], companyId: string, invoiceId: string): readonly TaxCloudTaxLineRow[] {
  return rows.map((row) => ({
    companyId: row.company_id === (companyId as string) ? row.company_id : companyId,
    invoiceId,
    invoiceItemId: row.invoice_item_id,
    lineIndex: row.line_index,
    tic: row.tic,
    taxableMinor: BigInt(row.taxable_minor),
    taxMinor: BigInt(row.tax_minor),
    rateBp: row.rate_bp,
    currency: row.currency,
    providerKey: row.provider_key,
    calculatedAtEpochMs: Date.parse(row.calculated_at),
  }));
}

/**
 * The rest adapter: the one place that knows `0121`'s column names.
 *
 * `replaceTax` is three statements, and the third is the version guarded write of the invoice's tax. If
 * the version has moved, the rows just written are soft-deleted again, because a breakdown that outlives
 * its tax is worse than no breakdown: a screen would show a tax the invoice does not carry. The gate
 * proves the order and the compensation against a recording client.
 */
export function createTaxCloudTaxLineRestStore(rest: RestClient): TaxCloudTaxLineStore {
  const selectLines = async (companyId: string, invoiceId: string): Promise<readonly TaxLineRestRow[]> =>
    rest.select<TaxLineRestRow>(
      TAXCLOUD_TAX_LINE_TABLE,
      `${TAXCLOUD_TAX_LINE_SELECT}&company_id=eq.${encodeURIComponent(companyId)}&invoice_id=eq.${encodeURIComponent(invoiceId)}&deleted_at=is.null&order=line_index.asc`,
      taxLineRowSchema,
    );

  return {
    async readTax(companyId: string, invoiceId: string): Promise<TaxCloudStoredTax> {
      const invoices = await rest.select<InvoiceRestRow>(
        TAXCLOUD_INVOICE_TAX_TABLE,
        `id,tax_minor,version&company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(invoiceId)}&deleted_at=is.null&limit=1`,
        invoiceRowSchema,
      );
      const rows = await selectLines(companyId, invoiceId);

      return {
        taxMinor: invoices[0] === undefined ? 0n : BigInt(invoices[0].tax_minor),
        lines: restRowsOf(rows, companyId, invoiceId),
      };
    },

    async replaceTax(input: {
      readonly companyId: string;
      readonly invoiceId: string;
      readonly expectedVersion: number;
      readonly taxMinor: bigint;
      readonly rows: readonly TaxCloudTaxLineRow[];
      readonly nowEpochMs: number;
    }): Promise<{ readonly status: "written"; readonly version: number } | { readonly status: "conflict" }> {
      const now = new Date(input.nowEpochMs).toISOString();
      const scope = `company_id=eq.${encodeURIComponent(input.companyId)}&invoice_id=eq.${encodeURIComponent(input.invoiceId)}&deleted_at=is.null`;

      await rest.update(TAXCLOUD_TAX_LINE_TABLE, scope, { deleted_at: now });

      if (input.rows.length > 0) {
        await rest.insert(
          TAXCLOUD_TAX_LINE_TABLE,
          input.rows.map((row) => ({
            company_id: row.companyId,
            invoice_id: row.invoiceId,
            invoice_item_id: row.invoiceItemId,
            line_index: row.lineIndex,
            tic: row.tic,
            taxable_minor: row.taxableMinor.toString(),
            tax_minor: row.taxMinor.toString(),
            rate_bp: row.rateBp,
            currency: row.currency,
            provider_key: row.providerKey,
            calculated_at: new Date(row.calculatedAtEpochMs).toISOString(),
          })),
        );
      }

      await rest.update(
        TAXCLOUD_INVOICE_TAX_TABLE,
        `id=eq.${encodeURIComponent(input.invoiceId)}&company_id=eq.${encodeURIComponent(input.companyId)}&version=eq.${input.expectedVersion}&deleted_at=is.null`,
        { tax_minor: input.taxMinor.toString() },
      );

      const written = await rest.select<InvoiceRestRow>(
        TAXCLOUD_INVOICE_TAX_TABLE,
        `id,tax_minor,version&company_id=eq.${encodeURIComponent(input.companyId)}&id=eq.${encodeURIComponent(input.invoiceId)}&limit=1`,
        invoiceRowSchema,
      );
      const row = written[0];

      if (row === undefined || row.version !== input.expectedVersion + 1) {
        // The tax did not move, so the breakdown must not either: undo the two statements above.
        await rest.update(TAXCLOUD_TAX_LINE_TABLE, `${scope}&calculated_at=eq.${encodeURIComponent(now)}`, {
          deleted_at: now,
        });

        return { status: "conflict" };
      }

      return { status: "written", version: row.version };
    },

    async readPayment(companyId: string, paymentId: string): Promise<TaxCloudPaymentTaxRow | null> {
      const rows = await rest.select<PaymentRestRow>(
        TAXCLOUD_PAYMENT_TAX_TABLE,
        `id,company_id,invoice_id,amount_minor,tax_minor,status,version&company_id=eq.${encodeURIComponent(companyId)}&id=eq.${encodeURIComponent(paymentId)}&deleted_at=is.null&limit=1`,
        paymentRowSchema,
      );
      const row = rows[0];

      if (row === undefined) return null;

      return {
        companyId: row.company_id,
        paymentId: row.id,
        invoiceId: row.invoice_id,
        amountMinor: BigInt(row.amount_minor),
        taxMinor: BigInt(row.tax_minor),
        status: row.status,
        version: row.version,
      };
    },

    async writePaymentTax(input: {
      readonly companyId: string;
      readonly paymentId: string;
      readonly taxMinor: bigint;
      readonly expectedVersion: number;
      readonly nowEpochMs: number;
    }): Promise<boolean> {
      await rest.update(
        TAXCLOUD_PAYMENT_TAX_TABLE,
        `id=eq.${encodeURIComponent(input.paymentId)}&company_id=eq.${encodeURIComponent(input.companyId)}&version=eq.${input.expectedVersion}&deleted_at=is.null`,
        { tax_minor: input.taxMinor.toString() },
      );

      const rows = await rest.select<PaymentRestRow>(
        TAXCLOUD_PAYMENT_TAX_TABLE,
        `id,company_id,invoice_id,amount_minor,tax_minor,status,version&id=eq.${encodeURIComponent(input.paymentId)}&limit=1`,
        paymentRowSchema,
      );

      return rows[0] !== undefined && rows[0].version === input.expectedVersion + 1;
    },
  };
}

/** The tables this module writes, for a caller that records them in a handoff or a test. */
export const TAXCLOUD_TAX_LINE_TABLES: readonly string[] = deepFreeze([
  TAXCLOUD_TAX_LINE_TABLE,
  TAXCLOUD_INVOICE_TAX_TABLE,
  TAXCLOUD_PAYMENT_TAX_TABLE,
] as const);
