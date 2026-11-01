// path: proxy.ts
import { NextResponse, type NextRequest } from "next/server";
import { getServerConfig } from "@/config/server";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_HEADER_NAME,
  CSP_NONCE_HEADER_NAME,
} from "@/lib/security/csp";

/**
 * The one place a request gets its Content Security Policy.
 *
 * Next 16 replaced `middleware.ts` with `proxy.ts`, and this file is that convention: it runs before
 * every page and every route handler the matcher lets through, mints one nonce, and attaches the policy
 * to the request as well as the response. Both halves are load bearing:
 *
 *   - the **request** header is what the framework reads to stamp its own script tags, so without it the
 *     nonce in the response header would protect nothing (see the header comment of
 *     `lib/security/csp.ts`);
 *   - the **response** header is what the browser enforces.
 *
 * It also sets `x-nonce`, which is how `app/layout.tsx` gets the same value for the one script tag this
 * repository writes itself - the pre-paint theme script, which would otherwise be a blocked inline
 * script and a light flash before a dark page.
 *
 * Two rules for anything added here later: it must not read or write a body, and it must not decide
 * anything about identity. A proxy runs on every request including the ones that must stay cheap, and a
 * security header is the whole of its job.
 */

export function proxy(request: NextRequest): NextResponse {
  const nonce = createCspNonce();
  // The environment is read through the validated accessor of STEP 004, never from the raw environment
  // directly (the lint gate refuses the raw read anywhere but `lib/env/`), and the value is memoised
  // after the first call, so a policy costs one nonce and one string on every path after boot.
  const policy = buildContentSecurityPolicy({ nonce, development: getServerConfig().isDevelopment });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_HEADER_NAME, policy);
  requestHeaders.set(CSP_NONCE_HEADER_NAME, nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER_NAME, policy);
  response.headers.set(CSP_NONCE_HEADER_NAME, nonce);

  return response;
}

/**
 * Which requests get a policy.
 *
 * Everything a browser renders or fetches as data, and nothing that is already a file: the framework's
 * build output is immutable and content addressed, an image or a font cannot execute, and rewriting the
 * policy on each of them would be a header on every asset for no gain. The exclusion list is the
 * framework's own static prefixes plus one extension pattern, and it is asserted by
 * `lib/security/verify.ts` so that a later edit cannot quietly drop a page from the policy.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|txt|xml|woff|woff2)$).*)",
  ],
};
