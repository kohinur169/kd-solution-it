// path: app/(dashboard)/payments/refunds/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { RefundConsole } from "./refund-console";

export const metadata: Metadata = {
  title: getMessage("refunds.title"),
  description: getMessage("refunds.description"),
};

/** Read per request: the desk lists live money and posts with a CSRF token, so it is never cached. */
export const dynamic = "force-dynamic";

/**
 * Section 19's refund desk, at `/payments/refunds`.
 *
 * The page is the session's shell and nothing more: which merchant this is, which payments can still be
 * refunded and what each refund became are all answered by the API and the service behind it. The client
 * component therefore starts from `loading` rather than from a server-rendered list, which also means a
 * merchant whose session expired reads the sign-in refusal instead of an empty table that looks like "no
 * refunds".
 *
 * ## Where the decision lives
 *
 * Somewhere else, on purpose. A merchant asks; the finance desk decides at `/office/refunds`. The two screens
 * never share a form, because the two acts have different roles, different guards and different audit
 * actions, and a single component serving both is how one of them ends up with the weaker guard.
 */
export default function RefundsPage(): ReactNode {
  return <RefundConsole />;
}
