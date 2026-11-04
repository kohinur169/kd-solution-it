// path: app/(dashboard)/invoices/new/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { InvoiceCreateScreen, invoiceMetadata } from "../invoice-screens";

export const metadata: Metadata = invoiceMetadata();

/** Read per request: the form posts to the API and the page is never cached with a token. */
export const dynamic = "force-dynamic";

/** Section 16's invoice create form. */
export default function NewInvoicePage(): ReactNode {
  return <InvoiceCreateScreen />;
}
