// path: app/(dashboard)/products/new/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueCreateScreen, catalogueMetadata } from "../catalogue-screens";

export const metadata: Metadata = catalogueMetadata("product", "new");

/** Read per request: the form posts to the API and the page is never cached with a token. */
export const dynamic = "force-dynamic";

/** Section 15's product create form. */
export default function NewProductPage(): ReactNode {
  return <CatalogueCreateScreen kind="product" />;
}
