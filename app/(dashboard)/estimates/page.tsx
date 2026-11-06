// path: app/(dashboard)/estimates/page.tsx
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The quotes route opens on the form, because a quote is written rather than listed until it is sent.
 *
 * Sending, numbering and the history of what a client accepted are STEPs 120 and 121's: this build has no
 * estimate list service to read, so there is nothing honest to render at this address. A merchant who
 * types it is taken to the form, and the routes that own the document keep their own addresses.
 */
export default function EstimatesPage(): never {
  redirect("/estimates/new");
}
