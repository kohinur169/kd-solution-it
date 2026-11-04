// path: app/(dashboard)/services/new/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueCreateScreen, catalogueMetadata } from "../../products/catalogue-screens";

export const metadata: Metadata = catalogueMetadata("service", "new");

/** Read per request: the form posts to the API and the page is never cached with a token. */
export const dynamic = "force-dynamic";

/** Section 15's service create form. */
export default function NewServicePage(): ReactNode {
  return <CatalogueCreateScreen kind="service" />;
}
