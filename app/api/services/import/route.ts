// path: app/api/services/import/route.ts
import { createCatalogueImportRoute } from "../../products/import/route";

export const dynamic = "force-dynamic";

/**
 * Section 15's service CSV import: the product import's handler, built for this catalogue.
 *
 * See `app/api/products/import/route.ts`; it is the same function because the two catalogues differ only
 * in the table the service reads and the default unit a blank cell takes.
 */
export const POST = createCatalogueImportRoute("service");
