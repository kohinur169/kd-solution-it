// path: app/api/onboarding/processor-profile/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  readProcessorProfile,
  type ProcessorProfileSnapshot,
} from "@/services/submerchant/processor-profile";

export const dynamic = "force-dynamic";

/**
 * The one-time business profile of section 5, assembled for the processors, over HTTP.
 *
 * ## Why this is a GET and reads from the query string
 *
 * A read has no body to protect, so no CSRF token applies; the account still comes from the cookie
 * and never from the request. The `companyId` parameter exists for the office roles
 * (`super_admin`, `ceo`, `compliance_kyc`), which read any one merchant's profile and leave an
 * audit entry; the `owner` role passes no parameter and gets their own company's profile, which is
 * what the review step of the wizard shows. A parameter the owner sends that is not their own
 * company is refused by the service rather than ignored.
 *
 * ## The order of the checks
 *
 * Session first, then the service, which applies the reader roles, validates the parameter as a
 * UUID before any query, and reads the one `business_profiles` row. The answer is `no-store`: a
 * profile can change between two reads and a cached answer would lie about what a processor is
 * sent.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<ProcessorProfileSnapshot>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const companyId = new URL(request.url).searchParams.get("companyId") ?? undefined;
    const snapshot = await readProcessorProfile(
      { actor, companyId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
