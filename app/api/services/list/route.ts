// path: app/api/services/list/route.ts
import { createCatalogueListRoute } from "../../products/list/route";

export const dynamic = "force-dynamic";

/**
 * Section 15's paginated service list: the product list's handler, built for this catalogue.
 *
 * See `app/api/products/list/route.ts`; it is the same function because the two catalogues differ only
 * in the table the service reads.
 */
export const GET = createCatalogueListRoute("service");
