// path: app/(dashboard)/products/import/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueImportScreen, catalogueImportMetadata } from "../catalogue-import-screen";

export const metadata: Metadata = catalogueImportMetadata("product");

/** Read per request: the page asks who is signed in, and never caches a session. */
export const dynamic = "force-dynamic";

/** Section 15's product CSV import. */
export default function ImportProductsPage(): ReactNode {
  return <CatalogueImportScreen kind="product" />;
}
