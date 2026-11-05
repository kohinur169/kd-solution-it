// path: app/(dashboard)/settlements/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { SettlementStatementPanel } from "./settlement-statement-panel";

export const metadata: Metadata = {
  title: getMessage("settlements.pageTitle"),
  description: getMessage("settlements.pageDescription"),
};

/** Read per request: the statement the download answers is never cached with a token. */
export const dynamic = "force-dynamic";

/** Section 17: the merchant's own settlement balance, one line per movement, for the period picked. */
export default function SettlementsPage(): ReactNode {
  return <SettlementStatementPanel />;
}
