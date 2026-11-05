// path: app/api/estimates/catalogue/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  listInvoiceCatalogueOptions,
  type InvoiceCatalogueOptions,
} from "@/services/invoices/invoices";

export const dynamic = "force-dynamic";

/** The two catalogues a line may quote from, which is `0026`'s `num_nonnulls(product_id, service_id) <= 1`. */
const KINDS = ["product", "service"] as const;

/**
 * The catalogue entries a quote line may be filled from, as JSON.
 *
 * ## Why a quote reads the same picker an invoice reads
 *
 * A line of either document quotes a product or a service and carries its id so reporting can follow the
 * link; the printed description, unit and price are the merchant's to change, which is why the answer is a
 * suggestion rather than a stored reference. That is one fact about the merchant's catalogue, so the reader
 * is the catalogue's one definition rather than a second copy here - same cap, same column list, same
 * company scope as the catalogue screens themselves.
 *
 * A read, so no CSRF token: it changes nothing, and the session and the company come from the cookie as they
 * do on every other route here. `no-store`, because a merchant's prices are commercial information.
 *
 * ## Why an unknown `kind` falls back rather than refusing
 *
 * The query names which catalogue to list, and a value outside the two is a stale bookmark or a hand-edited
 * URL rather than an attack: there is nothing to gain by answering with the products. Refusing would make a
 * picker fail closed on a harmless typo, and the fallback is one of the two legal answers.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<InvoiceCatalogueOptions>> => {
    const requested = new URL(request.url).searchParams.get("kind") ?? "product";
    const kind = (KINDS as readonly string[]).includes(requested)
      ? (requested as (typeof KINDS)[number])
      : "product";
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const options = await listInvoiceCatalogueOptions({ rest: runtime.rest }, { actor, kind });

    return NextResponse.json(options, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
