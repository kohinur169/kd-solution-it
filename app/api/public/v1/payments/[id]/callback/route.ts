// path: app/api/public/v1/payments/[id]/callback/route.ts
import { NextResponse } from "next/server";
import { readClientAddress } from "@/lib/auth/client-address";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { API_STORE_CALLBACK_ROUTE } from "@/lib/api/store-callback-fields";
import { getStoreCallbackRuntime } from "@/lib/api/store-callback-runtime";
import { deliverStoreCallback } from "@/lib/api/store-callbacks";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = API_STORE_CALLBACK_ROUTE;

/**
 * `POST /api/public/v1/payments/{id}/callback` - tell the merchant's connected WooCommerce shop what this payment is.
 *
 * ## Why a route, and why this verb
 *
 * A callback has to start somewhere, and this range owns no queue: STEP 205's deliveries are driven by a job that
 * addresses a *stored endpoint*, while a connection has a **domain** and a URL derived from it. The trigger is
 * therefore the store's own request - "call my shop about this payment" - which is also the only recovery a merchant has
 * when a shop missed a notification. `POST` because it makes a request to a third party; a `GET` that causes an outbound
 * call is a URL a browser preloader or a link scanner can fire.
 *
 * ## What the store does not choose
 *
 * Nothing but the payment. The address comes from `0035`'s row through STEP 208's connection, the token from the box its
 * handshake sealed, the state from STEP 204's read, and the id from a hash of the three - so a merchant cannot make the
 * platform call a host, or announce a state, that the platform did not already know.
 *
 * ## What this answers
 *
 * `200` with the callback's id, its type, the shop's **host**, whether it was delivered, STEP 205's rule for a failure
 * and the status the shop answered. A shop that answers `500`, redirects or times out is a reported outcome, never an
 * error of this platform; only a box that will not open or a body past its ceiling is a `500`.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse> => {
    const runtime = getPublicApiRuntime();
    const callbacks = getStoreCallbackRuntime();
    const { id } = await context.params;

    const answer = await handlePublicApiCall(
      {
        request,
        route,
        handler: async (call) => {
          const outcome = await deliverStoreCallback(
            {
              paymentId: id,
              principal: call.principal,
              clientAddress: readClientAddress(call.request.headers),
            },
            callbacks,
          );

          return { status: 200, body: outcome };
        },
      },
      runtime,
    );

    return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
  },
);
