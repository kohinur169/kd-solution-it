// path: app/api/public/v1/payments/[id]/simulate/route.ts
import { NextResponse } from "next/server";
import { readClientAddress } from "@/lib/auth/client-address";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { API_SANDBOX_ROUTE } from "@/lib/api/sandbox-fields";
import {
  guardTestCredential,
  parseSandboxSimulationRequest,
  readSandboxBody,
  simulateTestPayment,
} from "@/lib/api/sandbox-payment";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = API_SANDBOX_ROUTE;

/**
 * `POST /api/public/v1/payments/{id}/simulate` - section 8's sandbox, for a store's own test checkout.
 *
 * ## What a store sends and what it gets back
 *
 * One field: the scenario its test checkout should have produced - `captured`, `declined` or `review`. The answer is
 * the payment, shaped exactly as STEP 204 serves it, with the state the simulation wrote. No idempotency header is
 * read or required: a simulation is not a charge, and a second call for a payment that already has an outcome is a
 * `409` rather than a duplicate of anything.
 *
 * ## The order inside the handler
 *
 * **The credential, then the body, then the payment.** A live key is refused before a byte of the body is read, so
 * the sandbox cannot be used to probe what a production key would be allowed to do. A test key's body is bounded and
 * parsed before a query, and only a request that names a real scenario reaches the service.
 *
 * ## What happens before this function runs
 *
 * STEP 202's pipeline has authenticated the bearer key, counted the call against the `public_api` class and recorded
 * it, so the company and the mode arrive as a principal the platform has already proved. That is why the mode, and
 * not a body field, decides whether this endpoint exists for this caller.
 *
 * ## Why there is no `GET` and no other verb here
 *
 * Reading a payment is STEP 204's endpoint, and this path names an action rather than a resource. The framework
 * answers `405` for every verb but `POST`.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse> => {
    const runtime = getPublicApiRuntime();
    const { id } = await context.params;

    const answer = await handlePublicApiCall(
      {
        request,
        route,
        handler: async (call) => {
          // Before the body: a live credential is refused by the fence, and the refusal is in the chain.
          await guardTestCredential(call.principal, {
            audit: runtime.audit,
            clientAddress: readClientAddress(call.request.headers),
          });

          const body = await readSandboxBody(call.request);
          const simulation = parseSandboxSimulationRequest(body);

          const outcome = await simulateTestPayment(
            {
              paymentId: id,
              principal: call.principal,
              clientAddress: readClientAddress(call.request.headers),
              request: simulation,
            },
            runtime,
          );

          return { status: outcome.status, body: outcome.body };
        },
      },
      runtime,
    );

    return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
  },
);
