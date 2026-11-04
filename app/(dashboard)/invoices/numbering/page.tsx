// path: app/(dashboard)/invoices/numbering/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { InvoiceNumberingScreen } from "../invoice-screens";

export const metadata: Metadata = {
  title: getMessage("invoices.numberingTitle"),
  description: getMessage("invoices.numberingDescription"),
};

/** Read per request: the series changes as invoices are issued. */
export const dynamic = "force-dynamic";

/** Section 16's numbering service, as a merchant configures it. */
export default function InvoiceNumberingPage(): ReactNode {
  return <InvoiceNumberingScreen />;
}
