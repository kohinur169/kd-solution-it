// path: app/(dashboard)/services/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueHub, catalogueMetadata } from "../products/catalogue-screens";

export const metadata: Metadata = catalogueMetadata("service", "hub");

/** Read per request, so the entry a merchant saved in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/** Section 15's service catalogue: the second catalogue, rendered by the same screens. */
export default function ServicesPage(): ReactNode {
  return <CatalogueHub kind="service" />;
}
