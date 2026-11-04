// path: app/(dashboard)/invoices/page.tsx
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

/** Read per request: the create form posts to the API and is never cached with a token. */
export const dynamic = "force-dynamic";

/**
 * `/invoices` for now sends the merchant to the create form.
 *
 * The invoice list is a later STEP's screen; this STEP owns the create form, and a hub with one link
 * would be a page that exists to be clicked through. A redirect is honest about that: the only thing at
 * this address today is the way to make one.
 */
export default function InvoicesPage(): ReactNode {
  redirect("/invoices/new");
}
