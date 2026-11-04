// path: app/(dashboard)/invoices/[id]/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { InvoiceEditorScreen } from "../invoice-screens";

export const metadata: Metadata = {
  title: getMessage("invoices.editTitle"),
  description: getMessage("invoices.editDescription"),
};

/** Read per request: the editor writes per line and the page is never cached with a token. */
export const dynamic = "force-dynamic";

/** Section 16's line item editor for one draft. */
export default async function InvoiceDraftPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const resolved = await params;

  return <InvoiceEditorScreen invoiceId={decodeURIComponent(resolved.id)} />;
}
