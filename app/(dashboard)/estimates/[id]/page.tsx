// path: app/(dashboard)/estimates/[id]/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { EstimateEditorScreen } from "../estimate-screens";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return {
    title: getMessage("estimates.editTitle"),
    description: getMessage("estimates.editDescription"),
  };
}

export default async function EstimateEditorPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const context = await params;

  // The segment arrives percent-encoded, and an id is a UUID: decoding it is what makes a route that was
  // linked with an encoded character read the same document as one that was not.
  return <EstimateEditorScreen estimateId={decodeURIComponent(context.id)} />;
}
