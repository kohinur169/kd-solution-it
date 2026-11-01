// path: lib/security/headers.ts

/**
 * The security headers every response carries, and why each one is there.
 *
 * A header is a sentence a server says to a browser about everything it is about to send. The four
 * rules of `lib/security/README.md` are about the *content* of a response; these are about its
 * handling: what the browser may sniff, frame, refer, open, embed, prefetch or grant. They are cheap
 * (a few hundred bytes), they are the last line that still works when a rendering mistake reaches
 * production, and each one below names the thing it stops.
 *
 * ## Two scopes, because an asset is not a document
 *
 * A document is rendered, scripted and framed; an immutable chunk in `_next/static` is none of those.
 * Sending `Referrer-Policy` on a JavaScript file, or `X-Frame-Options` on a font, is noise that teaches
 * a reader the list is decorative. So the table carries a scope, and `headersFor(scope)` answers the
 * subset that matters for that kind of response:
 *
 *   - **document** - every page, every API answer, every redirect and every 404;
 *   - **asset** - the framework's immutable build output: `nosniff` and `cross-origin-resource-policy`.
 *
 * ## The environment exception, stated once
 *
 * `strict-transport-security` is production only. A development server speaks plain http on loopback,
 * and telling a browser to remember a secure-only policy for a host it just reached over http is at best
 * ignored and at worst poisons `localhost` for every other project on the machine.
 *
 * `x-frame-options` is production only for the same reason `frame-ancestors` is: the platform is
 * embedded in a preview frame while it is being built, and a header that blocks the frame the work is
 * reviewed in is a header someone removes. In production both are sent - `frame-ancestors` for a
 * browser that implements CSP, `X-Frame-Options` for one that does not.
 *
 * ## What is deliberately absent
 *
 * `cross-origin-embedder-policy: require-corp` is not here. It would force every subresource to opt in
 * with CORP, and the one feature it unlocks in this platform - `SharedArrayBuffer` - is not used by
 * anything. A header that breaks a future image or font for a capability nothing needs is a net loss.
 *
 * `origin-agent-cluster: ?1` is not here either: it changes how the browser groups processes across
 * origins, and the isolation it buys duplicates what Site Isolation already does for this deployment.
 */

/** Which kind of response a header belongs on. */
export type HeaderScope = "document" | "asset";

/** One header: its name, its value, and where it belongs. */
export interface SecurityHeader {
  readonly name: string;
  /**
   * The value sent. Header values are constants of this repository, never a value derived from a
   * request: a header built from input is how a response splitting attack starts.
   */
  readonly value: string;
  readonly scopes: readonly HeaderScope[];
  /** True when the header is only correct on a deployment that terminates TLS. */
  readonly productionOnly: boolean;
}

/**
 * The table.
 *
 * The order is the order they are written in, and it is stable so that a test can compare a whole
 * response rather than a set.
 */
export const SECURITY_HEADERS: readonly SecurityHeader[] = Object.freeze([
  {
    // A browser must not decide that this file is a different type than the server said. Without it,
    // a `.txt` that a merchant uploaded is a document, and a document is a script if it says so.
    name: "x-content-type-options",
    value: "nosniff",
    scopes: ["document", "asset"],
    productionOnly: false,
  },
  {
    // The client portal and the estimate links carry a token in the path (`/i/<token>`, `/e/<token>`).
    // A `Referer` header would hand that token to the next origin the document touches - and there is
    // no reason for this platform to send a referrer at all.
    name: "referrer-policy",
    value: "no-referrer",
    scopes: ["document"],
    productionOnly: false,
  },
  {
    // Nothing in this platform uses a device sensor, a camera, a location or the Payment Request API.
    // A browser feature the application never asks for is a browser feature an injected script can.
    name: "permissions-policy",
    value:
      "accelerometer=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), " +
      "hid=(), idle-detection=(), magnetometer=(), microphone=(), payment=(), serial=(), usb=()",
    scopes: ["document"],
    productionOnly: false,
  },
  {
    // A document from this origin opens no cross-origin window and expects no cross-origin opener, so
    // it gets its own browsing context group: the process isolation that stops a hostile page from
    // reaching into this one through a window handle.
    name: "cross-origin-opener-policy",
    value: "same-origin",
    scopes: ["document"],
    productionOnly: false,
  },
  {
    // Nothing on this platform is meant to be embedded by another site - not an image, not a font, not
    // a chunk. `same-origin` says so, and it holds even where CSP is not read.
    name: "cross-origin-resource-policy",
    value: "same-origin",
    scopes: ["document", "asset"],
    productionOnly: false,
  },
  {
    // A prefetch resolves a host name before a click, which leaks the next destination to the network
    // and to anyone watching DNS. The platform gains nothing: its own routes are already resolved.
    name: "x-dns-prefetch-control",
    value: "off",
    scopes: ["document"],
    productionOnly: false,
  },
  {
    // Legacy cross-domain policy files (Flash, PDF readers). A deployment that never serves one still
    // says it will not, which is the whole value of the header.
    name: "x-permitted-cross-domain-policies",
    value: "none",
    scopes: ["document"],
    productionOnly: false,
  },
  {
    // Two years, subdomains included. Not `preload`: preloading is an effectively irreversible,
    // domain-wide commitment that belongs to a deliberate deployment decision (STEPs 244-250 own that),
    // not to a header a security STEP switches on.
    name: "strict-transport-security",
    value: "max-age=63072000; includeSubDomains",
    scopes: ["document"],
    productionOnly: true,
  },
  {
    // The belt for a browser that does not read `frame-ancestors`: a document may not be framed, by
    // anyone, in production.
    name: "x-frame-options",
    value: "DENY",
    scopes: ["document"],
    productionOnly: true,
  },
]);

/** Every name the table can write, in table order. Used by the gate and by a reader. */
export const SECURITY_HEADER_NAMES: readonly string[] = Object.freeze(
  SECURITY_HEADERS.map((header) => header.name),
);

/** The name and value a response carries, with the reason already stripped. */
export interface ResolvedHeader {
  readonly name: string;
  readonly value: string;
}

export interface HeaderOptions {
  /** True for a development server, which speaks plain http and is embedded in a preview frame. */
  readonly development: boolean;
  readonly scope: HeaderScope;
}

/**
 * The headers of one response.
 *
 * Pure and total: no environment read, no request, no clock. The proxy calls it once per response and
 * the gate calls it a hundred times, and they agree because there is nothing to disagree about.
 */
export function headersFor(options: HeaderOptions): readonly ResolvedHeader[] {
  return Object.freeze(
    SECURITY_HEADERS.filter(
      (header) =>
        header.scopes.includes(options.scope) && !(options.development && header.productionOnly),
    ).map((header) => ({ name: header.name, value: header.value })),
  );
}

/** True when a name is one this table writes. A caller compares, it never repairs. */
export function isSecurityHeaderName(name: string): boolean {
  return SECURITY_HEADER_NAMES.includes(name.toLowerCase());
}
