// path: plugins/shopify/kd-payments-app/src/config.mjs
import { readFile } from "node:fs/promises";

/**
 * The app's configuration, read from one JSON file and validated once at boot.
 *
 * A Shopify app runs on somebody else's infrastructure, so its configuration is a deployment artifact rather than a
 * platform module: the file is read here, every field is checked, and a value that is missing or wrong stops the app
 * with a message that names the field and never repeats the value. The repository carries
 * `config.example.json` and nothing else - no key, no secret and no session seed is committed.
 */

/** The largest configuration file this app will read. */
const MAXIMUM_CONFIGURATION_BYTES = 16_384;

/** The bounds a session's lifetime may take: long enough to type a key, short enough that a token does not linger. */
const MINIMUM_SESSION_TTL_SECONDS = 60;
const MAXIMUM_SESSION_TTL_SECONDS = 3_600;

/** The scopes a Shopify app may request, as Shopify spells them: a verb and a resource. */
const SCOPE_PATTERN = /^(?:read|write)_[a-z][a-z0-9_]*$/u;

/** A host that is not the platform, refused before a byte leaves: no scheme, no path, no credentials. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::[1-9][0-9]{0,4})?$/u;

/** A configuration the app cannot start with. The message names the field; it never carries the value. */
export class ConfigError extends Error {
  constructor(field, rule) {
    super(`${field}: ${rule}`);

    this.name = "ConfigError";
    this.field = field;
    this.rule = rule;
  }
}

/** One `https` origin, validated as an origin rather than as a URL a caller could steer. */
function httpsOrigin(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(field, "missing");
  }

  const trimmed = value.trim();

  if (!trimmed.startsWith("https://")) {
    throw new ConfigError(field, "not_https");
  }

  let parsed;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(field, "malformed");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/" ||
    !HOST_PATTERN.test(parsed.host)
  ) {
    throw new ConfigError(field, "not_an_origin");
  }

  return parsed.origin;
}

/** A Shopify credential: an opaque identifier, bounded and never printed. */
function secret(value, field, minimumLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(field, "missing");
  }

  const trimmed = value.trim();

  if (trimmed.length < minimumLength || trimmed.length > 256 || /\s/u.test(trimmed)) {
    throw new ConfigError(field, "invalid");
  }

  return trimmed;
}

function integer(value, field, minimum, maximum) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(field, `outside_${String(minimum)}_${String(maximum)}`);
  }

  return value;
}

/**
 * Validate one configuration document.
 *
 * The two URLs are reduced to origins because the app appends its own paths and its own query strings: a base URL that
 * carried a path would silently move every platform call, which is the kind of misconfiguration that looks like a
 * broken platform instead of a broken deployment.
 */
export function parseConfiguration(document) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ConfigError("configuration", "not_an_object");
  }

  const scopes = document.scopes;

  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 24) {
    throw new ConfigError("scopes", "invalid");
  }

  for (const scope of scopes) {
    if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
      throw new ConfigError("scopes", "invalid");
    }
  }

  const uniqueScopes = [...new Set(scopes)];

  if (uniqueScopes.length !== scopes.length) {
    throw new ConfigError("scopes", "duplicated");
  }

  const sessionTtlSeconds = integer(
    document.sessionTtlSeconds,
    "sessionTtlSeconds",
    MINIMUM_SESSION_TTL_SECONDS,
    MAXIMUM_SESSION_TTL_SECONDS,
  );

  return Object.freeze({
    platformBaseUrl: httpsOrigin(document.platformBaseUrl, "platformBaseUrl"),
    appUrl: httpsOrigin(document.appUrl, "appUrl"),
    shopifyApiKey: secret(document.shopifyApiKey, "shopifyApiKey", 16),
    shopifyApiSecret: secret(document.shopifyApiSecret, "shopifyApiSecret", 16),
    sessionSecret: secret(document.sessionSecret, "sessionSecret", 32),
    scopes: Object.freeze(uniqueScopes),
    sessionTtlSeconds,
    sessionTtlMs: sessionTtlSeconds * 1_000,
    port: integer(document.port, "port", 1, 65_535),
    listenHost: typeof document.listenHost === "string" && document.listenHost.length > 0
      ? document.listenHost
      : "0.0.0.0",
  });
}

/** Read and validate the file named on the command line, or `./config.json`. */
export async function loadConfiguration(path) {
  const text = await readFile(path, "utf8");

  if (new TextEncoder().encode(text).length > MAXIMUM_CONFIGURATION_BYTES) {
    throw new ConfigError("configuration", "too_large");
  }

  let document;

  try {
    document = JSON.parse(text);
  } catch {
    throw new ConfigError("configuration", "not_json");
  }

  return parseConfiguration(document);
}
