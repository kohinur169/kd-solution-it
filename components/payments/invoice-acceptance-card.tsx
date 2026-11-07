// path: components/payments/invoice-acceptance-card.tsx
import type { ReactNode } from "react";
import { formatMessage, getMessage } from "../../lib/i18n/messages.ts";
import {
  portalAcceptanceStatementFor,
  type PortalAcceptanceStatement,
} from "../../app/(client-portal)/portal-invoice-fields.ts";
import type { PortalInvoiceView } from "../../app/(client-portal)/portal-invoice.ts";
import { InvoiceAcceptanceForm } from "./invoice-acceptance-form.tsx";

/**
 * The buyer's side of the evidence: what the merchant recorded, and what the buyer may confirm.
 *
 * Section 16 and 18 together make this the last step of an invoice: the merchant records the delivery,
 * the buyer confirms it, and only then may a settlement be released. The card therefore shows four
 * states, in the order a buyer meets them:
 *
 *   1. nothing recorded yet - the sentence says the business has not recorded the delivery, and there is
 *      no form, because a confirmation with nothing to confirm is not evidence;
 *   2. nothing paid yet - the form is withheld and the sentence says why, which the database also refuses
 *      in `invoice_acceptances_guard_evidence`;
 *   3. paid with a record - the record, the consent wording and the form;
 *   4. confirmed - the confirmation as a record, with who and when, and no way to change it.
 *
 * The statement the form sends is computed from the recorded evidence rather than chosen by the buyer, so
 * a buyer never has to understand the difference between goods and work to give a confirmation that
 * matches what the merchant recorded.
 */

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

const bodyClasses = "text-sm text-muted-foreground";

const noteClasses = "text-xs text-muted-foreground";

const summaryClasses = "flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-sm";

const confirmedClasses = "flex flex-col gap-1 rounded-lg border border-success p-4";

const confirmedTitleClasses = "text-base font-semibold text-success";

/** One instant, UTC, seconds cut: the same print every other record on the page uses. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace("T", " ").slice(0, 16) : iso;
}

export interface InvoiceAcceptanceCardProps {
  readonly view: PortalInvoiceView;
  readonly token: string;
}

export function InvoiceAcceptanceCard({ view, token }: InvoiceAcceptanceCardProps): ReactNode {
  const paidMinor = BigInt(view.totals.paidMinor);
  const statement: PortalAcceptanceStatement | null =
    view.fulfilment === null ? null : portalAcceptanceStatementFor(view.fulfilment.kind);

  return (
    <section aria-labelledby="portal-acceptance-heading" className={cardClasses}>
      <h2 id="portal-acceptance-heading" className={headingClasses}>
        {getMessage("portal.confirmationSection")}
      </h2>

      {view.fulfilment === null ? (
        <p className={bodyClasses}>{getMessage("portal.deliveryMissing")}</p>
      ) : (
        <div className={summaryClasses}>
          <p>
            {view.fulfilment.kind === "delivery"
              ? formatMessage("portal.deliveryRecordedDelivery", {
                  date: instantOf(view.fulfilment.occurredAt),
                })
              : formatMessage("portal.deliveryRecordedService", {
                  date: instantOf(view.fulfilment.occurredAt),
                })}
          </p>
          {view.fulfilment.reference === null ? null : (
            <p className={noteClasses}>
              {formatMessage("portal.deliveryReference", { reference: view.fulfilment.reference })}
            </p>
          )}
        </div>
      )}

      {view.acceptance !== null ? (
        <div className={confirmedClasses}>
          <p className={confirmedTitleClasses}>{getMessage("portal.confirmedTitle")}</p>
          <p className={bodyClasses}>
            {formatMessage("portal.confirmedBody", {
              name: view.acceptance.signerName,
              date: instantOf(view.acceptance.acceptedAt),
            })}
          </p>
        </div>
      ) : paidMinor <= 0n ? (
        <p className={bodyClasses}>{getMessage("portal.ruleNotPaidYet")}</p>
      ) : view.fulfilment === null || statement === null ? null : (
        <InvoiceAcceptanceForm
          token={token}
          statement={statement}
          fulfilmentEvidenceId={view.fulfilment.id}
        />
      )}
    </section>
  );
}
