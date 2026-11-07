// path: app/api/public/v1/stores/shopify/connection/route.ts
import { NextResponse } from "next/server";
import { readClientAddress } from "@/lib/auth/client-address";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { getShopifyConnectionRuntime } from "@/lib/api/shopify-connection-runtime";
import {
  connectShopifyStore,
  disconnectShopifyStore,
  parseShopifyConnectionRequest,
  readShopifyConnection,
  readShopifyConnectionBody,
} from "@/lib/api/shopify-connections";
import {
  API_SHOPIFY_CONNECTION_ROUTE,
  SHOPIFY_CONNECTION_RULES,
  SHOPIFY_SHOP_DOMAIN_FIELD,
} from "@/lib/api/shopify-connection-fields";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = API_SHOPIFY_CONNECTION_ROUTE;

/**
 * `POST | GET | DELETE /api/public/v1/stores/shopify/connection` - section 20's Shopify app handshake.
 *
 * ## One resource, three verbs
 *
 *   - **`POST`** - the app logs the merchant in after the install: it sends the shop Shopify named and the access
 *     token Shopify minted, and the connection becomes active. A second call answers the same connection and says so
 *     (`reused`), because installing twice is not connecting twice.
 *   - **`GET`** - the app asks whether this shop is connected. The shop travels in the query string, because a merchant
 *     may run two shops and a status check about *this* shop must name it.
 *   - **`DELETE`** - the app's Disconnect. The row is kept and marked revoked, which `0035` makes final.
 *
 * ## What authenticates the call
 *
 * The merchant's public API key, in the same `Authorization: Bearer` header as every other public call: STEP 202 has
 * already authenticated it, counted it against the `public_api` class and recorded it. That key is also the answer to
 * the question Shopify cannot: a shop with an installed app is not yet a merchant, and only the key says which company
 * the shop belongs to. The key's mode travels with the principal and into the chain, because the connection row itself
 * has no mode - the payments that flow through it do.
 *
 * ## What this route never answers
 *
 * The access token, in any form but its last four characters, and nothing about another merchant: every query of the
 * service is scoped by the company the key proved.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse> => {
  const runtime = getPublicApiRuntime();
  const connections = getShopifyConnectionRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (call) => {
        const body = await readShopifyConnectionBody(call.request);
        const outcome = await connectShopifyStore(
          {
            principal: call.principal,
            clientAddress: readClientAddress(call.request.headers),
            request: parseShopifyConnectionRequest(body),
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
  const connections = getShopifyConnectionRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (call) => {
        const connection = await readShopifyConnection(
          {
            principal: call.principal,
            shopDomain: readShopQuery(call.request),
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
  const connections = getShopifyConnectionRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (call) => {
        const connection = await disconnectShopifyStore(
          {
            principal: call.principal,
            shopDomain: readShopQuery(call.request),
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
 * The shop a status call or a disconnect names.
 *
 * The query string is the only place a `GET` or a `DELETE` can carry it, and the service validates it exactly as it
 * validates the body's copy - because a query string is caller controlled in the same way a body is. A missing value is
 * refused here rather than in the service, so the refusal names the same field the body would.
 */
function readShopQuery(request: Request): string {
  const shopDomain = new URL(request.url).searchParams.get(SHOPIFY_SHOP_DOMAIN_FIELD);

  if (shopDomain === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: SHOPIFY_SHOP_DOMAIN_FIELD, rule: SHOPIFY_CONNECTION_RULES.shopDomainMissing }],
    });
  }

  return shopDomain;
}
