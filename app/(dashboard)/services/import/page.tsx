// path: app/(dashboard)/services/import/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueImportScreen, catalogueImportMetadata } from "../../products/catalogue-import-screen";

export const metadata: Metadata = catalogueImportMetadata("service");

/** Read per request: the page asks who is signed in, and never caches a session. */
export const dynamic = "force-dynamic";

/** Section 15's service CSV import. */
export default function ImportServicesPage(): ReactNode {
  return <CatalogueImportScreen kind="service" />;
}
