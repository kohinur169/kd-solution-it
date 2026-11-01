// path: proxy.ts
import { NextResponse, type NextRequest } from "next/server";
import { getServerConfig } from "@/config/server";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_HEADER_NAME,
  CSP_NONCE_HEADER_NAME,
  isFrameworkAssetPath,
} from "@/lib/security/csp";
import { headersFor } from "@/lib/security/headers";

/**
 * The one place a response gets its security headers.
 *
 * Next 16 replaced `middleware.ts` with `proxy.ts`, and this file is that convention: it runs before
 * every page, every route handler and every framework asset the matcher admits, and writes two things.
 *
 *   1. **The Content Security Policy**, for a response that is rendered rather than served
 *      (`lib/security/csp.ts`). A nonce is minted per rendered response and travels on the request as
 *      well as the response, because the framework reads it from the request to stamp its own script
 *      tags. A static asset gets no policy: a nonce on a `.css` file is a header written for nobody.
 *   2. **The security headers** (`lib/security/headers.ts`), on every response without exception -
 *      `nosniff` and `cross-origin-resource-policy` on build output, and the full document set on
 *      anything a browser renders or treats as data.
 *
 * Both halves are data in `lib/security/`; this file only decides which response gets which, which is
 * the one thing a proxy should be trusted to decide. It reads no body, writes no cookie and never asks
 * who the caller is: identity is the routes' work, and a proxy that starts deciding it becomes a second
 * authorisation system that nothing else knows about.
 */

export function proxy(request: NextRequest): NextResponse {
  const asset = isFrameworkAssetPath(request.nextUrl.pathname);

  // No header in the asset scope is production only, so the environment cannot change that answer and
  // a static file does not pay for reading the configuration.
  const development = asset ? false : getServerConfig().isDevelopment;

  const requestHeaders = new Headers(request.headers);
  let nonce: string | null = null;
  let policy: string | null = null;

  if (!asset) {
    nonce = createCspNonce();
    policy = buildContentSecurityPolicy({ nonce, development });

    requestHeaders.set(CSP_HEADER_NAME, policy);
    requestHeaders.set(CSP_NONCE_HEADER_NAME, nonce);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  for (const header of headersFor({ development, scope: asset ? "asset" : "document" })) {
    response.headers.set(header.name, header.value);
  }

  if (policy !== null && nonce !== null) {
    // The response carries the same policy the request did: the request header is what the framework
    // reads, the response header is what the browser enforces, and they must not drift apart.
    response.headers.set(CSP_HEADER_NAME, policy);
    response.headers.set(CSP_NONCE_HEADER_NAME, nonce);
  }

  return response;
}

/**
 * Which requests run through the proxy.
 *
 * Everything but the development hot reload socket, which is a websocket upgrade rather than a
 * response: STEP 060's contract is that *every* response carries the security headers, and a static
 * chunk is a response. The cost is one function call per asset, and it buys a header set that cannot be
 * bypassed by asking for a file instead of a page.
 */
export const config = {
  matcher: ["/((?!_next/webpack-hmr).*)"],
};
