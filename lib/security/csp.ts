// path: lib/security/csp.ts

/**
 * The Content Security Policy of this platform, and the nonce it is built around.
 *
 * ## Why a nonce and not a list of hosts
 *
 * A policy made of host names says "any script from this origin may run", which is true of a
 * compromised dependency, an injected `<script src="/cdn/x.js">` and the platform's own bundles alike.
 * A nonce says "only the scripts this response was rendered with may run": the proxy mints 128 random
 * bits per response, the framework stamps them on the script tags it emits, and a tag that arrives
 * without one - from a stored XSS, from a proxy that rewrote the document - does not execute.
 *
 * ## The three things that make this file correct rather than decorative
 *
 *   1. **The nonce reaches the framework.** Next reads `content-security-policy` from the *request*
 *      headers and lifts the nonce out of `script-src` (`next/dist/server/render.js`), so the policy is
 *      set on the request as well as on the response. A response header alone looks right in a browser
 *      and leaves every framework script without a nonce - a broken page, or a policy relaxed until it
 *      works again.
 *   2. **Every route is rendered per request.** A prerendered page is served from the build, and its
 *      inline `self.__next_f` bootstrap scripts were written before any nonce existed: a nonce policy
 *      would block them, and a build-time hash cannot cover them because they change with every build.
 *      `app/layout.tsx` therefore declares `force-dynamic`, which is the documented price of a
 *      nonce-based policy and the reason this STEP changes the rendering mode of the seven routes that
 *      were static. The alternative - staying static and dropping the nonce - is a policy that allows
 *      `'unsafe-inline'`, which is no policy at all.
 *   3. **`'strict-dynamic'` is what carries the nonce onward.** Every framework chunk is loaded by a
 *      nonced bootstrap script rather than by a tag in the document, and under CSP3 `'strict-dynamic'`
 *      lets a trusted script load further scripts while host sources are ignored. `'self'` stays as the
 *      fallback for a browser that predates it.
 *
 * ## What is deliberately permissive, and why
 *
 * `style-src` keeps `'unsafe-inline'`: the framework injects style blocks for critical CSS, and an
 * inline *style* cannot execute script. It is the one allowance in this policy that a later reader may
 * find and should not "fix" without reading this paragraph: removing it breaks rendering, and the
 * thing it defends against (CSS exfiltration of an `input`, through a `background-image` URL) is
 * `img-src`'s job.
 *
 * `connect-src 'self'` is enough because every browser request in this platform is same-origin: the
 * forms post to `/api/...`, and the providers that are called on the server sit behind those routes. A
 * later STEP that adds a third-party call from the browser must add its host here *and* say why in its
 * handoff, which is the point of keeping one file.
 *
 * ## The development exception
 *
 * A development server needs `'unsafe-eval'` for React Refresh and a websocket for hot reload, and it
 * is embedded in a preview frame, so `frame-ancestors` is not sent there: a policy that blocks the frame
 * the platform is being reviewed in is a policy that gets switched off. Production sends `'none'` and
 * `upgrade-insecure-requests`.
 */

/** The header the policy travels in. Next reads it from the request as well as the response. */
export const CSP_HEADER_NAME = "content-security-policy";

/** The header that carries the nonce to a server component, when one asks for it. */
export const CSP_NONCE_HEADER_NAME = "x-nonce";

/** 128 bits of randomness, which is what a nonce needs and all it needs. */
export const CSP_NONCE_BYTES = 16;

/** A nonce as this platform writes it: base64url, unpadded, 22 characters. */
export const CSP_NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

/** One directive of the policy: a name and the sources it allows. */
export interface CspDirective {
  readonly name: string;
  readonly values: readonly string[];
}

export interface CspPolicyInput {
  /** The per-response nonce, from `createCspNonce()`. */
  readonly nonce: string;
  /** True for a development server, which needs React Refresh and hot reload. */
  readonly development: boolean;
}

/**
 * A base64url string with no padding.
 *
 * `btoa` and `crypto` are globals in every runtime this file is loaded in - the proxy, a route handler,
 * the gate - which is why this module imports nothing at all. `node:crypto` here would tie the policy
 * to one runtime and `Buffer` would tie it to another.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** A fresh nonce for one response. */
export function createCspNonce(): string {
  const bytes = new Uint8Array(CSP_NONCE_BYTES);

  crypto.getRandomValues(bytes);

  return toBase64Url(bytes);
}

/** True when a value has the shape this platform writes. A caller compares, it does not repair. */
export function isCspNonce(value: string): boolean {
  return CSP_NONCE_PATTERN.test(value);
}

/** The `script-src` sources, in one place because three of them have to agree about `'strict-dynamic'`. */
function scriptSources(nonce: string, development: boolean): readonly string[] {
  return [
    // The fallback for a browser that does not understand `'strict-dynamic'`: same-origin files only.
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development ? ["'unsafe-eval'"] : []),
  ];
}

function connectSources(development: boolean): readonly string[] {
  // Hot reload speaks websocket to the development server itself; a browser matches `'self'` for that,
  // but an explicit entry keeps the failure mode of a strict browser from being a silent one.
  return development ? ["'self'", "ws:", "wss:"] : ["'self'"];
}

/**
 * The directives, in the order they are serialised.
 *
 * The order is not cosmetic: a reader scanning a policy header finds `script-src` first because it is
 * the directive that decides whether an injected script runs, and `default-src` last because it is the
 * fallback for everything already stated.
 */
export function buildCspDirectives(input: CspPolicyInput): readonly CspDirective[] {
  if (!isCspNonce(input.nonce)) {
    throw new Error("a Content Security Policy nonce must be 22 base64url characters");
  }

  const directives: CspDirective[] = [
    { name: "script-src", values: scriptSources(input.nonce, input.development) },
    { name: "style-src", values: ["'self'", "'unsafe-inline'"] },
    { name: "img-src", values: ["'self'", "data:", "blob:"] },
    { name: "font-src", values: ["'self'"] },
    { name: "connect-src", values: connectSources(input.development) },
    { name: "form-action", values: ["'self'"] },
    { name: "base-uri", values: ["'none'"] },
    { name: "object-src", values: ["'none'"] },
    { name: "frame-src", values: ["'none'"] },
    { name: "worker-src", values: ["'none'"] },
    { name: "media-src", values: ["'none'"] },
    { name: "manifest-src", values: ["'self'"] },
    ...(input.development
      ? []
      : [
          // A production deployment is never framed, and never serves a plain http subresource.
          { name: "frame-ancestors", values: ["'none'"] },
          { name: "upgrade-insecure-requests", values: [] },
        ]),
    { name: "default-src", values: ["'self'"] },
  ];

  return Object.freeze(directives);
}

/** The header value: directives separated by `; `, sources by a space, in the order above. */
export function buildContentSecurityPolicy(input: CspPolicyInput): string {
  return buildCspDirectives(input)
    .map((directive) =>
      directive.values.length === 0 ? directive.name : `${directive.name} ${directive.values.join(" ")}`,
    )
    .join("; ");
}
