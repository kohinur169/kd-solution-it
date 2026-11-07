// path: app/(dashboard)/payments/links/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { PaymentLinksConsole } from "./payment-links-console";

export const metadata: Metadata = {
  title: getMessage("paymentLinks.title"),
  description: getMessage("paymentLinks.description"),
};

/** Read per request: the console lists live links and posts with a CSRF token, so it is never cached. */
export const dynamic = "force-dynamic";

/**
 * Section 16's payment link console.
 *
 * The page is the session's shell and nothing more: which merchant it is, whether the plan includes payment
 * links and what the links are, are all answered by the API and the service behind it. The client component
 * therefore starts from `loading` rather than from a server-rendered list - which also means a merchant whose
 * session expired sees the sign-in refusal rather than an empty table that looks like "no links".
 */
export default function PaymentLinksPage(): ReactNode {
  return <PaymentLinksConsole />;
}
