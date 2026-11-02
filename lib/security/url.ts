// path: lib/security/url.ts
import { AppError } from "../errors/app-error.ts";
import { isPublicHost } from "./host.ts";

/**
 * A URL, a path and a redirect destination that cannot be talked into doing something else.
 *
 * ## The four attacks this answers
 *
 *   - **Script URLs.** `javascript:` in an `href` is stored XSS with one click behind it. The scheme is
 *     decided by parsing, never by looking at the start of the string, because `java\nscript:` and
 *     `&#106;avascript:` both begin with something else; the control characters and the entities are
 *     removed before the parse, so what is parsed is what a browser would execute.
 *   - **SSRF.** A URL the server fetches is the server's network position, and `host.ts` is the list of
 *     destinations that are never legitimate. This module calls it and names the refusal.
 *   - **Open redirect.** A `returnUrl` that is an absolute URL to somebody else's host turns a sign in
 *     into a phishing page under the platform's own domain. `isSafeRedirect` allows a rooted path and
 *     a same-origin absolute URL, and nothing else.
 *   - **Path traversal.** A path that carries `..`, an encoded `..`, a backslash or a null byte is a
 *     path that leaves the directory it was meant to name. `sanitizeRelativePath` decodes once, then
 *     refuses, then rebuilds from the segments that remain.
 *
 * ## Why a decision and not an exception, with a wrapper for each
 *
 * The reason is what a form shows and what an audit entry records, so `sanitizeHttpUrl` and
 * `sanitizeRelativePath` answer a discriminated result. The two `require*` wrappers turn a refusal
 * into the catalogue's `VALIDATION_FAILED` with the rule name a screen already knows how to display,
 * which is what a route wants.
 */

/** Why a URL was refused, in the vocabulary a form can show. */
export type UrlRejectionReason =
  | "empty"
  | "too_long"
  | "control_character"
  | "backslash"
  | "markup_character"
  | "invalid_format"
  | "unsupported_scheme"
  | "credentials"
  | "invalid_host"
  | "private_host"
  | "unsupported_port";

/** Why a path was refused. */
export type PathRejectionReason =
  | "empty"
  | "too_long"
  | "not_rooted"
  | "traversal"
  | "encoded_traversal"
  | "backslash"
  | "control_character"
  | "invalid_format"
  | "scheme";

export interface UrlDecision {
  readonly ok: boolean;
  readonly value?: string;
  readonly reason?: UrlRejectionReason;
}

export interface PathDecision {
  readonly ok: boolean;
  readonly value?: string;
  readonly reason?: PathRejectionReason;
}

export interface UrlPolicy {
  /** The schemes allowed. `http:` exists for a local deployment and is refused by default. */
  readonly allowedProtocols?: readonly string[];
  /** The ports allowed besides the two default ones. Empty means "the default port only". */
  readonly allowedPorts?: readonly string[];
  /** True only for a caller that has already decided the host is internal on purpose. */
  readonly allowPrivateHosts?: boolean;
  readonly maximumLength?: number;
}

const defaultProtocols: readonly string[] = Object.freeze(["https:"]);
const defaultMaximumLength = 2_048;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const markupCharacters = /[<>"]/u;

/**
 * Minus one: the input reduced to the characters a URL parser should see.
 *
 * A browser strips leading and trailing C0 controls and the space before it parses a URL, which is why
 * `" javascript:alert(1)"` executes in an `href`. This does the same stripping *before* the decision,
 * so the decision is about the string the browser would act on.
 */
function trimForParsing(input: string): string {
  return input.replace(/^[\u0000-\u0020\u007f-\u009f]+|[\u0000-\u0020\u007f-\u009f]+$/gu, "");
}

/**
 * A URL that is https, public, without credentials and short enough to store.
 *
 * The host is lower cased and the URL is re-serialised by the parser, so what is returned is the
 * canonical form rather than the caller's string: `HTTPS://Example.COM:443/a` comes back as
 * `https://example.com/a`, which means two spellings of one URL are one stored value.
 */
export function sanitizeHttpUrl(input: string, policy: UrlPolicy = {}): UrlDecision {
  const maximumLength = policy.maximumLength ?? defaultMaximumLength;
  const protocols = policy.allowedProtocols ?? defaultProtocols;
  const trimmed = trimForParsing(input);

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if ([...trimmed].length > maximumLength) {
    return { ok: false, reason: "too_long" };
  }

  if (controlCharacters.test(trimmed)) {
    return { ok: false, reason: "control_character" };
  }

  // The scheme is read before the characters are judged, so `data:text/html,<script>` is refused for
  // being a data URL rather than for the bracket in it. A backslash is a path separator to some
  // parsers, and a bracket is the start of markup to an HTML parser that reads the value again, so
  // both are refused before the parse rather than after it.
  const declaredScheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed);

  if (declaredScheme !== null && !protocols.includes(`${(declaredScheme[1] ?? "").toLowerCase()}:`)) {
    return { ok: false, reason: "unsupported_scheme" };
  }

  if (trimmed.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }

  if (markupCharacters.test(trimmed)) {
    return { ok: false, reason: "markup_character" };
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_format" };
  }

  if (!protocols.includes(parsed.protocol)) {
    return { ok: false, reason: "unsupported_scheme" };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "credentials" };
  }

  const host = parsed.hostname;

  if (host.length === 0) {
    return { ok: false, reason: "invalid_host" };
  }

  if (!(policy.allowPrivateHosts ?? false) && !isPublicHost(host)) {
    return { ok: false, reason: "private_host" };
  }

  const allowedPorts = policy.allowedPorts ?? [];

  if (parsed.port !== "" && !allowedPorts.includes(parsed.port)) {
    return { ok: false, reason: "unsupported_port" };
  }

  return { ok: true, value: parsed.toString() };
}

/** The throwing form a route uses: `VALIDATION_FAILED` with the field and the rule. */
export function requireHttpUrl(input: string, field: string, policy: UrlPolicy = {}): string {
  const decision = sanitizeHttpUrl(input, policy);

  if (!decision.ok || decision.value === undefined) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field, rule: decision.reason ?? "invalid_format" }],
    });
  }

  return decision.value;
}

/**
 * A rooted path, decoded once and rebuilt from safe segments.
 *
 * The decode is the important half. `/%2e%2e/etc/passwd` contains no `..` until something decodes it,
 * and the something is usually the framework rather than this function. Decoding here means the check
 * sees what the router will see, and the rebuild means the value that leaves this function contains
 * only segments that were checked. Query and fragment are kept as-is because they are not path
 * segments; a `%00` in either is still refused.
 */
export function sanitizeRelativePath(input: string, maximumLength: number = 2_048): PathDecision {
  const trimmed = trimForParsing(input);

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if ([...trimmed].length > maximumLength) {
    return { ok: false, reason: "too_long" };
  }

  if (controlCharacters.test(trimmed) || trimmed.toLowerCase().includes("%00")) {
    return { ok: false, reason: "control_character" };
  }

  if (trimmed.includes("\\")) {
    return { ok: false, reason: "backslash" };
  }

  if (!trimmed.startsWith("/")) {
    return { ok: false, reason: "not_rooted" };
  }

  if (trimmed.startsWith("//")) {
    return { ok: false, reason: "scheme" };
  }

  // A first segment followed by a colon is a scheme to a parser, not a path segment: `/https://x`
  // and `/javascript:alert(1)` are refused even though they begin with a slash. The platform's own
  // routes are names without colons, so the conservative rule costs nothing.
  const schemeMatch = /^\/[^/]*:/u.exec(trimmed);

  if (schemeMatch !== null) {
    return { ok: false, reason: "scheme" };
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // A broken percent escape is not decodable, and a value this function cannot read is a value it
    // cannot certify.
    return { ok: false, reason: "invalid_format" };
  }

  if (decoded.includes("\u0000")) {
    return { ok: false, reason: "control_character" };
  }

  if (decoded.includes("../") || decoded.endsWith("/..") || decoded === ".." || decoded.includes("/./")) {
    return { ok: false, reason: "traversal" };
  }

  if (trimmed.toLowerCase().includes("%2e%2e") || trimmed.toLowerCase().includes("%2f%2e")) {
    return { ok: false, reason: "encoded_traversal" };
  }

  const [pathPart = "", ...rest] = decoded.split("?");
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "traversal" };
  }

  const rebuilt = `/${segments.join("/")}`;

  return { ok: true, value: rest.length === 0 ? rebuilt : `${rebuilt}?${rest.join("?")}` };
}

/** The throwing form of `sanitizeRelativePath`. */
export function requireRelativePath(input: string, field: string, maximumLength: number = 2_048): string {
  const decision = sanitizeRelativePath(input, maximumLength);

  if (!decision.ok || decision.value === undefined) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field, rule: decision.reason ?? "invalid_format" }],
    });
  }

  return decision.value;
}

/**
 * True when a `returnUrl` may be sent to.
 *
 * A rooted path is always safe because a browser resolves it against the current origin, and an
 * absolute URL is safe exactly when its protocol is allowed and its host is one of `allowedHosts`.
 * Everything else - a protocol-relative `//host`, a scheme-relative path, any other origin - is a
 * redirect to somebody else, which is what a phishing link inside a sign in is made of.
 */
export function isSafeRedirect(
  target: string,
  options: { readonly allowedHosts?: readonly string[]; readonly allowedProtocols?: readonly string[] } = {},
): boolean {
  const pathDecision = sanitizeRelativePath(target);

  if (pathDecision.ok) {
    return true;
  }

  const decision = sanitizeHttpUrl(target, {
    allowedProtocols: options.allowedProtocols ?? defaultProtocols,
  });

  if (!decision.ok || decision.value === undefined) {
    return false;
  }

  return (options.allowedHosts ?? []).some((host) => {
    try {
      return new URL(decision.value ?? "").hostname === host.toLowerCase();
    } catch {
      return false;
    }
  });
}
