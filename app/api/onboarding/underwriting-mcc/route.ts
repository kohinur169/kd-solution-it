// path: app/api/onboarding/underwriting-mcc/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  readUnderwritingMccOverview,
  type UnderwritingMccOverview,
} from "@/services/kyc/underwriting";

export const dynamic = "force-dynamic";

/**
 * The MCC overview of the underwriting screen: every active merchant category code with its title,
 * the risk tier the compliance team set on it, and how many live business profiles carry it.
 *
 * ## Why this is a GET and takes no parameter
 *
 * The list is platform scoped - the codes belong to the card networks and the profiles are counted
 * across companies on purpose, which the `business_profiles_underwriting_read` policy of `0106`
 * allows - so no company comes from the query string. The service applies
 * `UNDERWRITING_READ_ROLES` and refuses any other actor before a single query runs.
 *
 * ## The order of the checks
 *
 * Session first, then the service. The answer is `no-store`: a merchant's code changes between two
 * reads, and a cached overview would miscount.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<UnderwritingMccOverview>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const overview = await readUnderwritingMccOverview(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(overview, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
