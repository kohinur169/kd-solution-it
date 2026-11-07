// path: app/api/public/v1/payments/route.ts
import { NextResponse } from "next/server";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { API_PAYMENTS_PATH, API_REPLAY_HEADER } from "@/lib/api/payment-fields";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import {
  createStorePayment,
  parseStorePaymentRequest,
  readIdempotencyKey,
  readPaymentBody,
} from "@/lib/api/store-payments";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = API_PAYMENTS_PATH;

/**
 * `POST /api/public/v1/payments` - the one call an online store makes at its checkout.
 *
 * ## What a store sends and what it gets back
 *
 * An idempotency key in a header, and a body of three fields: the amount in minor units, the currency (USD, and
 * saying so is allowed), and how the payer will pay. The answer is the payment's identity and what it is -
 * `pending`, the amount, the mode the credential was issued in and the method - with `201` on the first call and
 * the same bytes with `idempotency-replayed: true` on every retry of that call.
 *
 * ## What happens before this function runs
 *
 * STEP 202's pipeline has already authenticated the bearer key, counted the call against the `public_api` class
 * and recorded it. A refused key never reaches this handler, which is why nothing here reads the authorization
 * header: the company and the mode arrive as a principal the platform has already proved.
 *
 * ## The order inside the handler
 *
 * The idempotency key first, then the body, then the payment. A call without a key cannot be made safely at all,
 * so it is refused before a byte of the body is read; a body that is too large or not JSON is refused before a
 * single query; and only a request that could become a payment reaches the service.
 *
 * ## Why there is no `GET` here
 *
 * Reading a payment is STEP 204's endpoint. This file answers one verb, and the framework answers `405` for the
 * others - a creation endpoint that also listed payments would be a list endpoint nobody designed.
 */
export const POST = withErrorResponse(async (request: Request): Promise<NextResponse> => {
  const runtime = getPublicApiRuntime();

  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (context) => {
        const idempotencyKey = readIdempotencyKey(context.request);
        const body = await readPaymentBody(context.request);
        const paymentRequest = parseStorePaymentRequest(body);

        const outcome = await createStorePayment(
          { principal: context.principal, idempotencyKey, request: paymentRequest },
          runtime,
        );

        return {
          status: outcome.status,
          body: outcome.body,
          headers: outcome.replayed ? { [API_REPLAY_HEADER]: "true" } : {},
        };
      },
    },
    runtime,
  );

  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
});
