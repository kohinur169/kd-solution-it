// path: app/api/services/route.ts
import { createCatalogueRoute } from "../products/route";
import type { CatalogueKind } from "@/services/products/catalogue-fields";

export const dynamic = "force-dynamic";

/**
 * The create route of the second catalogue.
 *
 * Section 15 pairs products and services, and `0021` gives a service the same money rules as `0020`
 * gives a product; only the table, the code column and the audit action differ. The handler is
 * therefore the product one, built for this kind - see `app/api/products/route.ts` for the order of the
 * checks, which is the same here by construction rather than by a second copy.
 */
const KIND: CatalogueKind = "service";

export const POST = createCatalogueRoute(KIND);
