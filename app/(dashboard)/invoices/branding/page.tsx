// path: app/(dashboard)/invoices/branding/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { InvoiceBrandingScreen } from "../invoice-screens";

export const metadata: Metadata = {
  title: getMessage("invoices.brandingTitle"),
  description: getMessage("invoices.brandingDescription"),
};

/** Read per request: the branding, the profile behind it and a signed URL for the logo all change. */
export const dynamic = "force-dynamic";

/** Section 16's own logo and invoice branding, as a merchant sets them. */
export default function InvoiceBrandingPage(): ReactNode {
  return <InvoiceBrandingScreen />;
}
