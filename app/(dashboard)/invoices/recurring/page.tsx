// path: app/(dashboard)/invoices/recurring/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { InvoiceRecurringScreen } from "../invoice-screens";

export const metadata: Metadata = {
  title: getMessage("invoices.recurringTitle"),
  description: getMessage("invoices.recurringDescription"),
};

/** Read per request: a schedule's next run moves as the section 27 job runs. */
export const dynamic = "force-dynamic";

/** Section 16's recurring invoice schedules, as a merchant configures them. */
export default function InvoiceRecurringPage(): ReactNode {
  return <InvoiceRecurringScreen />;
}
