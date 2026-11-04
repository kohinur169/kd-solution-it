// path: app/(dashboard)/products/[id]/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueEditScreen, catalogueMetadata } from "../catalogue-screens";

export const metadata: Metadata = catalogueMetadata("product", "edit");

/** The row is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/** Section 15's product edit form. */
export default async function EditProductPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  return <CatalogueEditScreen entryId={decodeURIComponent(id)} kind="product" />;
}
