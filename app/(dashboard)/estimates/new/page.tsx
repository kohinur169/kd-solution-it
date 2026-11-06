// path: app/(dashboard)/estimates/new/page.tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { estimateMetadata, EstimateCreateScreen } from "../estimate-screens";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return estimateMetadata();
}

/** Section 16's estimate create form. */
export default function NewEstimatePage(): ReactNode {
  return <EstimateCreateScreen />;
}
