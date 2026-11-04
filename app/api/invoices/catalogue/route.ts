// path: app/api/invoices/catalogue/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  listInvoiceCatalogueOptions,
  type InvoiceCatalogueOptions,
} from "@/services/invoices/invoices";

export const dynamic = "force-dynamic";

/** The two catalogues a line may quote; anything else is ignored and the product list is read. */
const KINDS = ["product", "service"] as const;

/**
 * The catalogue entries a line may fill itself from, per kind, as JSON.
 *
 * A line may quote a product or a service, and the merchant wants its name, unit and price without
 * retyping them. This reads one capped page of the merchant's own catalogue through the catalogue's own
 * table, so the same company scope applies as on the catalogue screens themselves.
 *
 * A read, so no CSRF token: it changes nothing, and the session and the company come from the cookie as
 * they do on every other route here. `no-store`, because a merchant's prices are commercial information.
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
