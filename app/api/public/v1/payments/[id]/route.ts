// path: app/api/public/v1/payments/[id]/route.ts
import { NextResponse } from "next/server";
import { readClientAddress } from "@/lib/auth/client-address";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { API_PAYMENT_STATUS_ROUTE, readStorePaymentStatus } from "@/lib/api/store-payment-status";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

/**
 * `GET /api/public/v1/payments/{id}` - the status of one payment the store created, read by that store.
 *
 * ## Why the path carries the id and the body carries nothing
 *
 * A read has no body: the resource is named by the URL, so there is no second place to disagree with it. That also
 * makes the call cacheable by an intermediary in principle and therefore worth the explicit `no-store` the pipeline
 * sets - a payment status is the one answer in this API that is never allowed to be stale.
 *
 * ## Why there is no idempotency key here
 *
 * STEP 203's header exists because a `POST` that is delivered twice creates money twice. A `GET` delivered twice
 * reads the same row twice, and the second read is not a mistake, it is a poll. So this route does not read the
 * header, does not require it and does not mention it in a refusal: a store that sends one is not wrong, it is just
 * early. The pipeline counts and records the call; the chain entry for a *refused* read is written by the service.
 *
 * ## Why the pipeline is given a template rather than the path that arrived
 *
 * `API_PAYMENT_STATUS_ROUTE` is `/api/public/v1/payments/{id}`. The limiter keys its route bucket on the route, so a
 * concrete path would give every payment its own sixty-a-minute allowance and one merchant could multiply their
 * budget by polling a thousand ids. The template keeps the endpoint's ceiling the endpoint's, and the chain entry
 * records the route rather than the resource - which is why a refused read names its id separately.
 *
 * ## What this route never answers
 *
 * Every verb but `GET` is a `405` from the framework, and no failure of this handler can be a `200`: the id is
 * validated before a query, the row is narrowed by tenant, mode and the schema's own definition of a store payment,
 * and five different reasons for "not yours" collapse into one `404` so that the answer cannot be used to map
 * another merchant's ids.
 */
export const GET = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse> => {
    const runtime = getPublicApiRuntime();
    const { id } = await context.params;

    const answer = await handlePublicApiCall(
      {
        request,
        route: API_PAYMENT_STATUS_ROUTE,
        handler: async (call) => {
          const payment = await readStorePaymentStatus(
            {
              paymentId: id,
              principal: call.principal,
              clientAddress: readClientAddress(call.request.headers),
            },
            runtime,
          );

          return { status: 200, body: payment };
        },
      },
      runtime,
    );

    return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
  },
);
