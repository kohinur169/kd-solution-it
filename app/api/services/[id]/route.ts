// path: app/api/services/[id]/route.ts
import { createCatalogueEntryRoute } from "../../products/[id]/route";
import type { CatalogueKind } from "@/services/products/catalogue-fields";

export const dynamic = "force-dynamic";

/**
 * One service over HTTP: the product's read and edit handlers, built for this catalogue.
 *
 * See `app/api/products/[id]/route.ts` for the order of the checks; it is the same here because it is
 * the same function, and the two catalogues differ only in the table the service reads.
 */
const KIND: CatalogueKind = "service";

const handlers = createCatalogueEntryRoute(KIND);

export const GET = handlers.GET;
export const POST = handlers.POST;
