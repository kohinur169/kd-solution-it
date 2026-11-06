// path: app/api/estimates/[id]/signature/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  readEstimateSignature,
  type EstimateSignatureSnapshot,
} from "@/services/estimates/estimate-signature";

export const dynamic = "force-dynamic";

interface SignatureBody {
  readonly status: "read";
  readonly signature: EstimateSignatureSnapshot | null;
}

/**
 * The evidence of one decision on one of this merchant's quotes, as JSON.
 *
 * ## Why `signature: null` rather than a 404 when nobody has decided
 *
 * An undecided quote is the normal state of a quote, not a missing resource. A caller that had to tell
 * "no signature yet" apart from "no such quote" would otherwise read two refusals to answer one question,
 * and the second of them - the 404 - is exactly what a screen words as "this estimate does not exist". So
 * the service reads the quote first: a quote that is not there, or that belongs to another merchant, is a
 * 404 about the quote, and only a quote that exists and carries no decision answers `null`.
 *
 * ## Why a read carries no CSRF token and earns no audit entry
 *
 * There is nothing to forge in a request that changes nothing, and the session cookie still decides who is
 * asking: the company comes from the session and never from the path, the query or a header. Rule 9 is
 * about writes, so a merchant reading their own client's decision adds no link to the chain - a chain of
 * reads would bury the writes that matter in a chargeback.
 *
 * ## What this route cannot do
 *
 * It cannot record a decision, and no route in this build can yet. Recording one means storing the
 * signer's own address and agent, and those arrive with a tokenized link (STEP 181/182). A
 * merchant-authenticated capture would store the merchant's address as the signer's, which is not weaker
 * evidence but false evidence, so the write waits for the workflow that can carry the truth. `no-store`,
 * because a client's name, address and device are personal data and a proxy has no business keeping them.
 */
export const GET = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<SignatureBody>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // The segment arrives percent-encoded and an id is a UUID, so it is decoded exactly as the page that
    // links to it decodes it: two spellings of one id have to read one document.
    const estimateId = decodeURIComponent((await context.params).id);
    const signature = await readEstimateSignature(
      { actor, estimateId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(
      { status: "read", signature },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
