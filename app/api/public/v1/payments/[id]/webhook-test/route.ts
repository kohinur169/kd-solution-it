// path: app/api/public/v1/payments/[id]/webhook-test/route.ts
import { NextResponse } from "next/server";
import { readClientAddress } from "@/lib/auth/client-address";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { API_SANDBOX_WEBHOOK_ROUTE } from "@/lib/api/sandbox-webhook-fields";
import {
  guardSimulatedCredential,
  parseSandboxWebhookRequest,
  readSandboxWebhookBody,
  sendSimulatedWebhook,
} from "@/lib/api/sandbox-webhook";
import { getStoreWebhookRuntime } from "@/lib/api/store-webhook-runtime";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = API_SANDBOX_WEBHOOK_ROUTE;

/**
 * `POST /api/public/v1/payments/{id}/webhook-test` - section 8's simulated delivery.
 *
 * ## What a store sends and what it gets back
 *
 * One field, the endpoint to send to, and the answer is what that endpoint did: the event id and type the platform
 * sent, the store's own HTTP status, and STEP 205's rule for it. `200` with `delivered: false` is the normal answer
 * to a store whose server refused the event - the platform did its job, and the answer says what happened rather
 * than pretending the call failed.
 *
 * ## What it actually sends
 *
 * The platform's real webhook, not a rehearsal of one: the same envelope over the payment's current state, the same
 * four headers, and an `x-kd-signature` computed with this credential's own signing secret. A store that verifies
 * this delivery has verified its production path.
 *
 * ## What happens before this function runs
 *
 * STEP 202's pipeline has authenticated the bearer key, counted the call against the `public_api` class and recorded
 * it. The credential is fenced, then the body is read, and the payment is read by the service rather than taken from
 * the request: a caller names the payment and the endpoint, never the event.
 *
 * ## Why there is no `GET` and no other verb here
 *
 * This path names an action, and the framework answers `405` for every verb but `POST`. Reading a payment is STEP
 * 204's endpoint; simulating one is STEP 206's.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse> => {
    const runtime = getPublicApiRuntime();
    const webhooks = getStoreWebhookRuntime();
    const { id } = await context.params;

    const answer = await handlePublicApiCall(
      {
        request,
        route,
        handler: async (call) => {
          // Before the body: a live credential is refused by the fence, and the refusal is in the chain.
          await guardSimulatedCredential(call.principal, {
            audit: webhooks.audit,
            clientAddress: readClientAddress(call.request.headers),
          });

          const body = await readSandboxWebhookBody(call.request);
          const simulation = parseSandboxWebhookRequest(body);

          const outcome = await sendSimulatedWebhook(
            {
              paymentId: id,
              principal: call.principal,
              clientAddress: readClientAddress(call.request.headers),
              request: simulation,
            },
            webhooks,
          );

          return { status: outcome.status, body: outcome.body };
        },
      },
      runtime,
    );

    return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
  },
);
