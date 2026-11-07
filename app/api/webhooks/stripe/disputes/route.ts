// path: app/api/webhooks/stripe/disputes/route.ts
import { NextResponse } from "next/server";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import {
  STRIPE_CONNECT_PROVIDER_KEY,
  STRIPE_DISPUTE_WEBHOOK_PATH,
  disputeEventSourceOf,
} from "@/services/disputes/dispute-events";
import {
  receiveDisputeWebhook,
  type DisputeWebhookAccepted,
  type DisputeWebhookRefused,
} from "@/services/disputes/dispute-webhook";
import { getDisputeWebhookRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/** The headers a delivery arrives with, lower cased once, so the reader asks for one spelling. */
function headersOf(request: Request): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();

  for (const [name, value] of request.headers) {
    headers.set(name.toLowerCase(), value);
  }

  return headers;
}

/**
 * Stripe's dispute callbacks, at `/api/webhooks/stripe/disputes`.
 *
 * ## Why this route has no session and no CSRF token
 *
 * The caller is a processor, not a browser: it holds no cookie, so there is no ambient credential to forge,
 * and it identifies itself with an HMAC signature over the exact bytes of the body. That is why this file
 * lives under `app/api/webhooks/` - the one prefix `scripts/verify-audit.mjs` names as
 * machine-to-machine - and why `lib/auth/verify.ts` excludes it from the list of routes that must carry a
 * token. The identity decision is `receiveDisputeWebhook`: it opens the endpoint's secret from the settings
 * store, verifies the signature before it reads a single field, and refuses with `401` when it does not
 * match. A route that answered a verified-only body without that check would be a public way to move a
 * merchant's dispute status.
 *
 * ## Why the body is read as text and never as JSON
 *
 * The signature covers the bytes Stripe sent. `request.json()` would parse and re-encode them, and the
 * verification would then be over a body nobody signed. So the raw text is read once, with the ceiling
 * checked inside the receiver, and the parse happens after the signature has been accepted.
 *
 * ## Why a refusal is not always an error status
 *
 * `200` for a delivery that reached a verdict - including a duplicate, a stale status and an event this
 * build does not act on - because a non-2xx answer makes the processor redeliver a body the platform has
 * already understood. `401`, `400`, `404` and `503` are the four answers that mean "this will never work",
 * and `500` is the one retryable case: a verified dispute naming a payment this database does not have yet.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<DisputeWebhookAccepted | DisputeWebhookRefused>> => {
    const source = disputeEventSourceOf(STRIPE_CONNECT_PROVIDER_KEY);
    const rawBody = await request.text();

    // Read once, before anything else looks at the body: the endpoint a delivery arrives at names the
    // provider, and a provider this build does not receive disputes from is answered without a signature
    // check rather than after one, because there is nothing to verify it against.
    const result = await receiveDisputeWebhook(
      {
        providerKey: source?.providerKey ?? STRIPE_CONNECT_PROVIDER_KEY,
        rawBody,
        headers: headersOf(request),
      },
      getDisputeWebhookRuntime(),
    );

    if (result.status === 200) {
      logger.info("dispute webhook received", {
        route: STRIPE_DISPUTE_WEBHOOK_PATH,
        providerKey: STRIPE_CONNECT_PROVIDER_KEY,
        outcome: result.body.outcome,
        eventId: result.body.eventId,
        disputeId: result.body.disputeId,
        disputeStatus: result.body.disputeStatus,
        rule: result.body.rule,
        bodyBytes: Buffer.byteLength(rawBody, "utf8"),
      });
    } else {
      // The provider body, the signature header and the signing secret are never logged. A rule name and the
      // size of the delivery are what an operator needs to tell a misconfigured endpoint from an attack.
      logger.warn("dispute webhook refused", {
        route: STRIPE_DISPUTE_WEBHOOK_PATH,
        providerKey: STRIPE_CONNECT_PROVIDER_KEY,
        status: result.status,
        rule: result.body.rule,
        bodyBytes: Buffer.byteLength(rawBody, "utf8"),
      });
    }

    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
