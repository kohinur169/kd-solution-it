// path: app/(dashboard)/services/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueHub, catalogueMetadata } from "../products/catalogue-screens";

export const metadata: Metadata = catalogueMetadata("service", "hub");

/** Read per request, so the entry a merchant saved in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/** Section 15's service catalogue: the paginated list with search, over the same screens. */
export default async function ServicesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}): Promise<ReactNode> {
  return <CatalogueHub kind="service" searchParams={await searchParams} />;
}
