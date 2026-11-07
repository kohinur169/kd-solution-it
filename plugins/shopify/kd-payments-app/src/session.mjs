// path: plugins/shopify/kd-payments-app/src/session.mjs
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The app's own session: an opaque identifier in a signed cookie, and a record held in this process's memory.
 *
 * ## Why a cookie and a map, and nothing else
 *
 * The app has three pieces of state to carry between the install and the credential login: which shop consented, the
 * state value that matches Shopify's callback, and - for a few minutes - the access token Shopify minted. The first
 * two are not secrets and could live in a cookie; **the third cannot**. A Shopify access token in a cookie is a token in
 * a browser, so it stays on the server, in a record keyed by an identifier the browser holds but cannot forge, and the
 * record is bounded by a lifetime and by a count.
 *
 * The cookie is signed rather than encrypted, because there is nothing in it worth hiding - only the identifier - and a
 * signature is what stops a stranger naming somebody else's session.
 *
 * ## What happens when the process restarts
 *
 * Every session is lost. A merchant in the middle of the login sees "install again", which is the honest answer: the
 * token was never written to disk, because writing it to disk is the mistake this module exists to avoid.
 */

/** The cookie's name, and the longest value this app will read from it. */
export const SESSION_COOKIE_NAME = "kd_shopify_session";
const MAXIMUM_COOKIE_VALUE_LENGTH = 256;

/** The largest number of sessions one process will keep; past it the oldest is dropped rather than growing forever. */
const MAXIMUM_SESSIONS = 5_000;

/**
 * A record of one install in progress.
 *
 * `accessToken` is present only between the callback and the credential login, and is removed the moment the platform
 * has accepted it. `connection` is what the platform last answered, which carries no secret: its `store_token_last_four`
 * is the only four characters of the token any screen may show.
 */
export function createSessionStore({ ttlMs, now = () => Date.now() }) {
  const records = new Map();

  function prune() {
    const at = now();

    for (const [id, record] of records) {
      if (record.expiresAt <= at) {
        records.delete(id);
      }
    }

    while (records.size > MAXIMUM_SESSIONS) {
      const oldest = records.keys().next().value;

      if (oldest === undefined) {
        return;
      }

      records.delete(oldest);
    }
  }

  return {
    create(values) {
      prune();

      const id = randomBytes(32).toString("base64url");
      const at = now();

      records.set(id, { ...values, createdAt: at, expiresAt: at + ttlMs });

      return id;
    },

    read(id) {
      prune();

      const record = records.get(id);

      if (record === undefined || record.expiresAt <= now()) {
        return undefined;
      }

      return record;
    },

    update(id, values) {
      const record = records.get(id);

      if (record === undefined) {
        return undefined;
      }

      const updated = { ...record, ...values, expiresAt: now() + ttlMs };

      records.set(id, updated);

      return updated;
    },

    destroy(id) {
      records.delete(id);
    },

    size() {
      prune();

      return records.size;
    },
  };
}

/** A value and its signature, joined by a dot: what the browser may hold without being able to invent one. */
export function signSessionId(id, secret) {
  const signature = createHmac("sha256", secret).update(id, "utf8").digest("base64url");

  return `${id}.${signature}`;
}

/** The identifier inside a signed value, or undefined for a forged, truncated or edited one. */
export function readSignedSessionId(value, secret) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_COOKIE_VALUE_LENGTH) {
    return undefined;
  }

  const separator = value.lastIndexOf(".");

  if (separator <= 0) {
    return undefined;
  }

  const id = value.slice(0, separator);
  const presented = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(id, "utf8").digest("base64url");

  if (presented.length !== expected.length) {
    return undefined;
  }

  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");

  if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
    return undefined;
  }

  return id;
}

/** One `Set-Cookie` header for the session identifier. `Secure`, `HttpOnly`, `SameSite=Lax`, no domain. */
export function sessionCookie({ value, maxAgeSeconds }) {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${String(maxAgeSeconds)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** The session cookie the request carried, or undefined. The cookie is read by name and never by position. */
export function readSessionCookie(header) {
  if (typeof header !== "string" || header.length === 0) {
    return undefined;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator < 0) {
      continue;
    }

    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }

  return undefined;
}

/** The CSRF token of one session: minted with the session, compared before any form is believed. */
export function createCsrfToken() {
  return randomBytes(24).toString("base64url");
}
