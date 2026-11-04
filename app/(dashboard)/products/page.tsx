// path: app/(dashboard)/products/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueHub, catalogueMetadata } from "./catalogue-screens";

export const metadata: Metadata = catalogueMetadata("product", "hub");

/** Read per request, so the entry a merchant saved in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/** Section 15's product catalogue: the hub the create screen hangs from. */
export default function ProductsPage(): ReactNode {
  return <CatalogueHub kind="product" />;
}
