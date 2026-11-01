// path: lib/security/csrf-client.ts
/**
 * The browser's half of the double submit token.
 *
 * ## Why the header always comes from the cookie
 *
 * A double submit check compares two values, and the failure it can produce by accident is a page that
 * holds a *newer* token than the cookie the browser sent. That happens when two calls race - two tabs,
 * or a page that asks twice - and the fix is not a retry but an order: read the cookie that is on the
 * wire **now**, put exactly that value in the header, and only ask for a new token when there is no
 * cookie at all. The header and the cookie cannot disagree, because one was copied from the other.
 *
 * ## Why it is a separate module from `csrf.ts`
 *
 * `csrf.ts` mints tokens with `node:crypto` and is imported by routes. This file runs in the browser
 * and imports nothing at all: its only tools are `document.cookie` and `fetch`. Keeping them apart is
 * what stops a Node builtin from being pulled into a client bundle, which is the mistake
 * `lib/security/README.md` records as a rule.
 */

/** The names to look for: the secure one first, then the name a development deployment uses. */
const cookieNames: readonly string[] = Object.freeze(["__Host-kd_csrf", "kd_csrf"]);

/** The header the server reads. Kept literal here so no server module is imported. */
const headerName = "x-csrf-token";

/** The endpoint that issues a token. Literal for the same reason. */
const tokenPath = "/api/auth/csrf";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

/** One value from `document.cookie`, or null. */
export function readCsrfCookieFromDocument(cookieName: string): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");

    if (separator <= 0 || pair.slice(0, separator).trim() !== cookieName) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();

    return tokenPattern.test(value) ? value : null;
  }

  return null;
}

/** The token currently readable on this origin, or null. */
export function readCsrfTokenFromCookie(): string | null {
  for (const name of cookieNames) {
    const value = readCsrfCookieFromDocument(name);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

/**
 * The headers for one mutation.
 *
 * A cookie is read first, because a cookie is what the server will compare against. When there is
 * none, the token endpoint is asked once: it sets the cookie and answers the same token, and the
 * caller gets the value that is now on the wire. An empty object means the platform could not issue a
 * token, which the caller's refusal path already handles - a request without the header is a request
 * the server refuses, and that is the correct outcome.
 */
export async function csrfHeaders(): Promise<Readonly<Record<string, string>>> {
  const existing = readCsrfTokenFromCookie();

  if (existing !== null) {
    return { [headerName]: existing };
  }

  try {
    await fetch(tokenPath, { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    return {};
  }

  const issued = readCsrfTokenFromCookie();

  return issued === null ? {} : { [headerName]: issued };
}

/** True when a value has the shape of a token, for a caller that wants to know before it asks. */
export function isCsrfToken(value: string): boolean {
  return tokenPattern.test(value);
}
