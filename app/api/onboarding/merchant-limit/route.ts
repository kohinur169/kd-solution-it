// path: app/api/onboarding/merchant-limit/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { readMerchantLimit, type MerchantLimitSnapshot } from "@/services/kyc/merchant-limit";

export const dynamic = "force-dynamic";

/**
 * The merchant's own starting transaction limit, over HTTP: the monthly limit, the usage counted in
 * the current calendar month, and what is left. The first read creates the row from the `0106`
 * underwriting criteria (audited as `merchant_limit.assigned`); every later read is the row as it
 * stands.
 *
 * ## Why this is a GET that may write once
 *
 * A read has no body to protect, so no CSRF token applies; the account still comes from the cookie.
 * The one write is the lazy creation of the merchant's limit row, which is idempotent - the partial
 * unique index on `company_id` turns a lost race into a re-read - and audited. The company is never in
 * the query string: the service takes it from the session and refuses any other actor before a query.
 *
 * ## The order of the checks
 *
 * Session first, then the service, which applies the `owner` role and the company scope. The answer
 * is `no-store`: usage moves between two reads, and a cached limit would lie about what is left.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<MerchantLimitSnapshot>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const limit = await readMerchantLimit(
      { actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(limit, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
