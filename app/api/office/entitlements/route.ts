// path: app/api/office/entitlements/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { readOfficeEntitlements, type MerchantEntitlementAnswer } from "../../../../services/billing/entitlements.ts";
import { getEntitlementDependencies } from "../../../../services/billing/entitlements-runtime.ts";

export const dynamic = "force-dynamic";

/**
 * One merchant's entitlements, for the office: what plan they are on and which of the six services it grants.
 *
 * ## Read only, and why that is not a shortcut
 *
 * STEP 213 checks entitlements; it does not grant, sell or change them. The plan a merchant is on is STEP
 * 214's write and the plan's services are STEP 212's, so this route answers the question those two make
 * possible and nothing else. A `GET` therefore needs no CSRF token - it changes nothing - and the answer is
 * marked `no-store` because it is a live fact about a paying merchant rather than a page.
 *
 * ## The order
 *
 * The session, then the role, then the merchant's id, then the three reads. The role check lives in
 * `readOfficeEntitlements` beside the read it guards, so a second caller cannot reach a weaker path than
 * this route; the route's own work is to find the actor and read one query parameter.
 *
 * ## Why the company id is a parameter and not a body
 *
 * It identifies what is being read, and it is the one value in this route a caller controls. It is validated
 * as a uuid by the service before it reaches a query, and it is never interpreted as a filter expression.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<MerchantEntitlementAnswer>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const companyId = new URL(request.url).searchParams.get("companyId") ?? "";
    const answer = await readOfficeEntitlements({ actor, companyId }, getEntitlementDependencies());

    return NextResponse.json(answer, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
