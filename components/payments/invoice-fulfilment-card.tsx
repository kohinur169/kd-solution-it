// path: components/payments/invoice-fulfilment-card.tsx
import type { ReactNode } from "react";
import { getMessage } from "../../lib/i18n/messages.ts";
import type { PortalInvoiceView } from "../../app/(client-portal)/portal-invoice.ts";
import { InvoiceFulfilmentForm } from "./invoice-fulfilment-form.tsx";

/**
 * The merchant's panel on the client's own link.
 *
 * It is rendered only for a session that resolves to the invoice's own company with the `owner` role -
 * the page decides that, and the route behind the form decides it again, because a panel is a courtesy
 * and a permission check is not. A buyer never sees this card, and no part of it is reachable without the
 * CSRF token the ordinary merchant forms use.
 *
 * The card is absent, rather than disabled, for an invoice that is already confirmed: there is nothing to
 * record once the buyer has confirmed, and a form that could only fail would teach a merchant that the
 * platform is unreliable rather than that the record is closed.
 */

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-primary bg-surface p-4 text-foreground shadow-card sm:p-6";

const headingClasses = "text-sm font-semibold tracking-tight text-foreground";

export interface InvoiceFulfilmentCardProps {
  readonly view: PortalInvoiceView;
  readonly token: string;
}

export function InvoiceFulfilmentCard({ view, token }: InvoiceFulfilmentCardProps): ReactNode {
  if (view.acceptance !== null || view.state === "void" || view.state === "not_issued") {
    return null;
  }

  return (
    <section aria-labelledby="portal-fulfilment-heading" className={cardClasses}>
      <h2 id="portal-fulfilment-heading" className={headingClasses}>
        {getMessage("portal.merchantSection")}
      </h2>

      <InvoiceFulfilmentForm
        token={token}
        existing={
          view.fulfilment === null
            ? null
            : {
                kind: view.fulfilment.kind,
                method: view.fulfilment.method,
                occurredAt: view.fulfilment.occurredAt,
                reference: view.fulfilment.reference,
                description: view.fulfilment.description,
              }
        }
      />
    </section>
  );
}
