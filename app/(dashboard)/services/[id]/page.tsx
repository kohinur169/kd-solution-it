// path: app/(dashboard)/services/[id]/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CatalogueEditScreen, catalogueMetadata } from "../../products/catalogue-screens";

export const metadata: Metadata = catalogueMetadata("service", "edit");

/** The row is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/** Section 15's service edit form. */
export default async function EditServicePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  return <CatalogueEditScreen entryId={decodeURIComponent(id)} kind="service" />;
}
