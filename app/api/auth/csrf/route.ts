// path: app/api/auth/csrf/route.ts
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { createCsrfToken, csrfCookie, csrfPolicy } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

interface CsrfResponseBody {
  readonly token: string;
}

/**
 * Mint a cross site request forgery token, and install it in the readable cookie of the same name.
 *
 * The one authentication route that needs no session, because the forms that most need a token are the
 * ones before a session exists: a sign in and a sign up are state changes, and a platform that only
 * protected the routes behind a cookie would leave the two that decide who gets one open to a form
 * post from another site.
 *
 * The answer carries the token as well as setting it, so a page that has just asked does not have to
 * parse `document.cookie` itself - although `csrf-client.ts` reads the cookie anyway, because that is
 * the value the server will compare against. `cache-control: no-store` is part of the feature: a token
 * served from a cache is one token for every visitor of that cache.
 *
 * It is rate limited like every other auth route (STEP 055) and classified as an anonymous surface
 * (STEP 039), so nothing about it is a second kind of endpoint.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<CsrfResponseBody>> => {
  // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
  // never reaches the body, the session or the work behind them.
  await enforceRateLimit({ request, scope: "csrf" }, getAuthRuntime());

  const policy = csrfPolicy({ secure: getAuthRuntime().cookiePolicy.secure });
  const token = createCsrfToken();

  return NextResponse.json(
    { token } satisfies CsrfResponseBody,
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "set-cookie": csrfCookie(token, policy),
      },
    },
  );
});
