// path: app/api/public/v1/stores/woocommerce/connection/route.ts
import { NextResponse } from "next/server";
import { readClientAddress } from "@/lib/auth/client-address";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { getStoreConnectionRuntime } from "@/lib/api/store-connection-runtime";
import {
  connectWooCommerceStore,
  disconnectWooCommerceStore,
  parseConnectionRequest,
  readConnectionBody,
  readWooCommerceConnection,
} from "@/lib/api/store-connections";
import {
  API_WOOCOMMERCE_CONNECTION_ROUTE,
  STORE_CONNECTION_DOMAIN_FIELD,
  STORE_CONNECTION_RULES,
} from "@/lib/api/store-connection-fields";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = API_WOOCOMMERCE_CONNECTION_ROUTE;

/**
 * `POST | GET | DELETE /api/public/v1/stores/woocommerce/connection` - section 20's plugin handshake.
 *
 * ## One resource, three verbs
 *
 *   - **`POST`** - the plugin logs in: it sends its own store domain and the token it minted, and the connection
 *     becomes active. A second call answers the same connection and says so (`reused`), because installing twice is
 *     not connecting twice.
 *   - **`GET`** - the plugin asks whether this store is connected. The domain travels in the query string, because a
 *     merchant may run two shops and a status check about *this* store must name it.
 *   - **`DELETE`** - the plugin's Disconnect. The row is kept and marked revoked, which `0035` makes final.
 *
 * ## What authenticates the call
 *
 * The merchant's public API key, in the same `Authorization: Bearer` header as every other public call: STEP 202 has
 * already authenticated it, counted it against the `public_api` class and recorded it. The key's mode travels with the
 * principal and into the chain, because the connection row itself has no mode - the payments that flow through it do.
 *
 * ## What this route never answers
 *
 * The store's token, in any form but its last four characters, and nothing about another merchant: every query of the
 * service is scoped by the company the key proved.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse> => {
  const runtime = getPublicApiRuntime();
  const connections = getStoreConnectionRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (call) => {
        const body = await readConnectionBody(call.request);
        const outcome = await connectWooCommerceStore(
          {
            principal: call.principal,
            clientAddress: readClientAddress(call.request.headers),
            request: parseConnectionRequest(body),
          },
          connections,
        );

        return { status: outcome.status, body: outcome.body };
      },
    },
    runtime,
  );

  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
});

export const GET = withErrorResponse(async (request: Request): Promise<NextResponse> => {
  const runtime = getPublicApiRuntime();
  const connections = getStoreConnectionRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (call) => {
        const connection = await readWooCommerceConnection(
          {
            principal: call.principal,
            storeDomain: readConnectionQuery(call.request),
            clientAddress: readClientAddress(call.request.headers),
          },
          connections,
        );

        return { status: 200, body: connection };
      },
    },
    runtime,
  );

  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
});

export const DELETE = withErrorResponse(async (request: Request): Promise<NextResponse> => {
  const runtime = getPublicApiRuntime();
  const connections = getStoreConnectionRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (call) => {
        const connection = await disconnectWooCommerceStore(
          {
            principal: call.principal,
            storeDomain: readConnectionQuery(call.request),
            clientAddress: readClientAddress(call.request.headers),
          },
          connections,
        );

        return { status: 200, body: connection };
      },
    },
    runtime,
  );

  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
});

/**
 * The domain a status call or a disconnect names.
 *
 * The query string is the only place a `GET` or a `DELETE` can carry it, and the service validates it exactly as it
 * validates the body's copy - because a query string is caller controlled in the same way a body is.
 */
function readConnectionQuery(request: Request): string {
  const storeDomain = new URL(request.url).searchParams.get("store_domain");

  if (storeDomain === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainMissing }],
    });
  }

  return storeDomain;
}
