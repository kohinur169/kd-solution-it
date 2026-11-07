// path: app/api/public/v1/credential/route.ts
import { NextResponse } from "next/server";
import { getPublicApiRuntime } from "@/lib/api/public-runtime";
import { handlePublicApiCall } from "@/lib/api/public-api";
import { API_PUBLISHED_LIMITS, PUBLIC_API_BASE } from "@/lib/api/public-fields";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

const route = `${PUBLIC_API_BASE}/credential`;

/**
 * `GET /api/public/v1/credential` - the call that says whether a key works.
 *
 * ## Why this exists before any payment does
 *
 * Section 20 gives a merchant one thing to do with a key before they can take a payment: find out whether the
 * key they pasted into their store is the right one, in the right mode, and still alive. Without an endpoint
 * that answers that, the first thing every integration does is create a payment to see if it errors - which is
 * the one test that costs money. The answer is the credential's own identity: its label, its mode, its handle
 * and its last four characters. It is the same masking section 20 requires everywhere else, so this route
 * cannot become the reveal that the settings screen refuses to be.
 *
 * ## What it does not say
 *
 * Not the key, not its hash, not the signing secret, and not another merchant's id. The company's own id is
 * included because a store already knows which merchant it belongs to, and a mismatch is the fastest way for an
 * integrator to notice they pasted the wrong key.
 *
 * ## The pipeline
 *
 * `handlePublicApiCall` has already authenticated the bearer key, counted the call against the `public_api`
 * class and recorded both. A refused call never reaches this function, which is why nothing here reads a
 * header.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse> => {
  const answer = await handlePublicApiCall(
    {
      request,
      route,
      handler: async (context) => ({
        status: 200,
        body: {
          api_version: "v1",
          credential: {
            id: context.principal.credentialId,
            label: context.principal.label,
            mode: context.principal.mode,
            key_prefix: context.principal.keyPrefix,
            key_last_four: context.principal.keyLastFour,
          },
          merchant: {
            id: context.principal.companyId,
            name: context.principal.companyName,
          },
          limits: {
            requests_per_minute: API_PUBLISHED_LIMITS.requestsPerMinute,
            account_requests_per_minute: API_PUBLISHED_LIMITS.accountRequestsPerMinute,
            address_requests_per_minute: API_PUBLISHED_LIMITS.addressRequestsPerMinute,
          },
        },
      }),
    },
    getPublicApiRuntime(),
  );

  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
});
