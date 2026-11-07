// path: components/payments/invoice-paid-state.tsx
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "../../lib/i18n/messages.ts";
import type { PortalInvoiceView } from "../../app/(client-portal)/portal-invoice.ts";
import { portalMoneyTextOf } from "../../app/(client-portal)/portal-invoice-money.ts";

/**
 * The paid state and the receipt of a tokenized invoice, as section 16 asks for them.
 *
 * "Once an invoice is fully paid through its tokenized link, that link no longer accepts payment. Opening
 * it shows the paid state and the receipt." So this is two things in one card: the sentence that says the
 * link is finished, and the record of what was taken. The receipt is printed whether or not the invoice
 * is settled, because a partly paid invoice has a receipt too - a shorter one - and printing nothing
 * until the last penny arrives would leave a client who has paid half with no record of it.
 *
 * ## What a receipt is allowed to print
 *
 * The amount, the day, the method and the card's brand with its last four digits: all of it something the
 * payer already knows, and four digits is what a receipt has printed since receipts existed. Never a
 * token, never a processor transaction id, never a card number and never the address the payment came
 * from. A receipt is a document a client keeps, forwards and hands to an accountant.
 *
 * ## The width
 *
 * One card per entry at 360px, because a money table with five columns is five columns of clipped text on
 * a phone; from `sm` up the same rows become a real table, where the amounts line up to the right and a
 * client can compare them. The totals are a description list in both widths, so each figure keeps its
 * label beside it rather than in a header row a screen reader has already left behind.
 */

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const paidBannerClasses = "flex flex-col gap-1 rounded-lg border border-success p-4";

const paidTitleClasses = "text-base font-semibold text-success";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const tableClasses = "hidden w-full border-collapse text-sm sm:table";

const headCellClasses =
  "border-b border-border pb-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground";

const headAmountClasses =
  "border-b border-border pb-2 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground";

const cellClasses = "border-b border-border py-2 text-left align-top";

const amountCellClasses = "border-b border-border py-2 text-right align-top tabular-nums";

const entryClasses = "flex flex-col gap-1 rounded-md border border-border p-3 sm:hidden";

const totalsClasses = "grid grid-cols-1 gap-2 text-sm sm:grid-cols-3";

const totalRowClasses = "flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2";

const totalLabelClasses = "text-muted-foreground";

const totalValueClasses = "font-medium tabular-nums";

/**
 * One instant, printed the way every client facing document prints one: UTC, seconds cut.
 *
 * A receipt is a record, so it prints one zone rather than the reader's: two people reading the same
 * receipt from two countries must see the same instant.
 */
function instantOf(iso: string | null): string {
  if (iso === null) {
    return "";
  }

  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

/** The method of a payment in the catalog's words, with the card's own tail when there is one. */
function methodTextOf(method: string, brand: string | null, lastFour: string | null): string {
  if (brand !== null && lastFour !== null) {
    return formatMessage("portal.receiptCardLine", { brand, lastFour });
  }

  switch (method) {
    case "bank_transfer":
      return getMessage("portal.receiptMethodBankTransfer");
    case "e_wallet":
      return getMessage("portal.receiptMethodEWallet");
    default:
      return getMessage("portal.receiptMethodCard");
  }
}

export interface InvoicePaidStateProps {
  readonly view: PortalInvoiceView;
}

/** The receipt card: entries, totals and, for a settled invoice, the sentence that ends the link. */
export function InvoicePaidState({ view }: InvoicePaidStateProps): ReactNode {
  const settled = view.state === "paid";
  const entries = view.receipt.entries;
  const testMode = entries.some((entry) => entry.mode === "test");

  return (
    <section aria-labelledby="portal-receipt-heading" className={cardClasses}>
      <h2 id="portal-receipt-heading" className={headingClasses}>
        {getMessage("portal.receiptSection")}
      </h2>

      {settled ? (
        <div className={paidBannerClasses}>
          <p className={paidTitleClasses}>{getMessage("portal.paidTitle")}</p>
          <p className={bodyClasses}>
            {view.paidAt === null
              ? getMessage("portal.paidBodyUndated")
              : formatMessage("portal.paidBody", { date: instantOf(view.paidAt) })}
          </p>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className={bodyClasses}>{getMessage("portal.receiptEmpty")}</p>
      ) : (
        <>
          <table className={tableClasses}>
            <thead>
              <tr>
                <th scope="col" className={headCellClasses}>
                  {getMessage("portal.receiptPaidOnLabel")}
                </th>
                <th scope="col" className={headCellClasses}>
                  {getMessage("portal.receiptMethodLabel")}
                </th>
                <th scope="col" className={headAmountClasses}>
                  {getMessage("portal.amountLabel")}
                </th>
                <th scope="col" className={headAmountClasses}>
                  {getMessage("portal.receiptRefundedLabel")}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.paymentId}>
                  <td className={cellClasses}>
                    <span className="block">{instantOf(entry.capturedAt ?? entry.settledAt)}</span>
                    {entry.mode === "test" ? (
                      <span className={noteClasses}>{getMessage("portal.receiptModeTest")}</span>
                    ) : null}
                  </td>
                  <td className={cellClasses}>
                    {methodTextOf(entry.method, entry.cardBrand, entry.cardLastFour)}
                  </td>
                  <td className={amountCellClasses}>
                    {portalMoneyTextOf(view.currency, entry.amountMinor)}
                  </td>
                  <td className={amountCellClasses}>
                    {portalMoneyTextOf(view.currency, entry.refundedMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="flex flex-col gap-2 sm:hidden">
            {entries.map((entry) => (
              <li key={entry.paymentId} className={entryClasses}>
                <span className="text-sm font-medium tabular-nums">
                  {portalMoneyTextOf(view.currency, entry.amountMinor)}
                </span>
                <span className={noteClasses}>
                  {methodTextOf(entry.method, entry.cardBrand, entry.cardLastFour)}
                </span>
                <span className={noteClasses}>{instantOf(entry.capturedAt ?? entry.settledAt)}</span>
                {entry.refundedMinor !== "0" ? (
                  <span className={noteClasses}>
                    {getMessage("portal.receiptRefundedLabel")}:{" "}
                    {portalMoneyTextOf(view.currency, entry.refundedMinor)}
                  </span>
                ) : null}
                {entry.mode === "test" ? (
                  <span className={noteClasses}>{getMessage("portal.receiptModeTest")}</span>
                ) : null}
              </li>
            ))}
          </ul>

          <dl className={totalsClasses}>
            <div className={totalRowClasses}>
              <dt className={totalLabelClasses}>{getMessage("portal.receiptReceivedLabel")}</dt>
              <dd className={totalValueClasses}>
                {portalMoneyTextOf(view.currency, view.receipt.receivedMinor)}
              </dd>
            </div>
            {view.receipt.refundedMinor === null || view.receipt.netMinor === null ? null : (
              <>
                <div className={totalRowClasses}>
                  <dt className={totalLabelClasses}>{getMessage("portal.receiptRefundedLabel")}</dt>
                  <dd className={totalValueClasses}>
                    {portalMoneyTextOf(view.currency, view.receipt.refundedMinor)}
                  </dd>
                </div>
                <div className={totalRowClasses}>
                  <dt className={totalLabelClasses}>{getMessage("portal.receiptNetLabel")}</dt>
                  <dd className={totalValueClasses}>
                    {portalMoneyTextOf(view.currency, view.receipt.netMinor)}
                  </dd>
                </div>
              </>
            )}
          </dl>

          {view.receipt.truncated ? (
            <p className={noteClasses}>
              {formatMessage("portal.receiptTruncated", {
                shown: entries.length,
                omitted: view.receipt.omitted,
              })}
            </p>
          ) : null}

          {testMode ? <p className={noteClasses}>{getMessage("portal.receiptTestNote")}</p> : null}
        </>
      )}
    </section>
  );
}
