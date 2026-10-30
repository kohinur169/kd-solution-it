// path: lib/logger/redact.ts
import type { JsonValue } from "./serialize.ts";

/**
 * Redaction for structured log records.
 *
 * MASTER_PROMPT rule 94 and FEATURE_LIST section 29 are absolute: no secret, key, token or
 * credential may appear in a log. The only way to keep that true as the codebase grows is to
 * make redaction the logger's job rather than the caller's, so every record is walked once
 * after it is assembled and before it is written.
 *
 * Two independent rules run, because either alone leaves a gap:
 *
 *   1. A key rule. The field name decides. `password`, `authorization`, `apiKey`,
 *      `service_role_key` and friends are replaced whatever their value looks like. This
 *      catches the common case even when the value is an opaque string.
 *   2. A value rule. Every string is scanned for the shapes secrets take in practice: a bearer
 *      token, a JWT, a provider secret key, an AWS access key id, a private key block, and a
 *      password embedded in a URL or in a `key=value` pair. This catches a secret pasted into
 *      a field whose name says nothing, such as `message` or `url`.
 */

/** The single marker written in place of a redacted value. */
export const REDACTED_MARKER = "[REDACTED]";

/**
 * Field names whose value is never written, compared after normalizing to lowercase letters
 * and digits. So `apiKey`, `api_key`, `API-KEY` and `apikey` are one entry.
 */
const sensitiveFieldNames: ReadonlySet<string> = new Set([
  "password",
  "passwordhash",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "secrets",
  "clientsecret",
  "apisecret",
  "webhooksecret",
  "secretkey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "masterkey",
  "servicerolekey",
  "serviceaccountkey",
  "anonkey",
  "apikey",
  "accesskey",
  "accesskeyid",
  "key",
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "csrftoken",
  "xsrf",
  "csrf",
  "authorization",
  "bearer",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "cardnumber",
  "cardno",
  "pan",
  "cvv",
  "cvv2",
  "cvc",
  "ssn",
  "taxid",
  "otp",
  "totp",
  "backupcode",
  "backupcodes",
  "recoverycode",
  "dsn",
  "connectionstring",
  "databaseurl",
]);

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** True when a field name is one the platform never writes a value for. */
export function isSensitiveFieldName(name: string): boolean {
  return sensitiveFieldNames.has(normalizeFieldName(name));
}

interface TextPattern {
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/**
 * Value patterns. Each one is anchored to a shape that only a credential produces, so ordinary
 * prose, ids and amounts pass through untouched.
 */
const textPatterns: readonly TextPattern[] = [
  // A private key block, including its body.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replace: () => REDACTED_MARKER,
  },
  // A password inside a URL with credentials: postgresql://user:secret@host
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s/]+)(@)/giu,
    replace: (_match, prefix, _secret, suffix) => `${prefix}${REDACTED_MARKER}${suffix}`,
  },
  // Bearer tokens in an authorization value.
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gu,
    replace: () => `Bearer ${REDACTED_MARKER}`,
  },
  // JSON Web Tokens, which is also the shape of the Supabase anon and service role keys.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu,
    replace: () => REDACTED_MARKER,
  },
  // Provider secret keys and webhook signing secrets.
  {
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gu,
    replace: () => REDACTED_MARKER,
  },
  {
    pattern: /\bwhsec_[A-Za-z0-9]{8,}\b/gu,
    replace: () => REDACTED_MARKER,
  },
  // AWS access key ids.
  {
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replace: () => REDACTED_MARKER,
  },
  // A secret written in key=value or key: value form inside free text.
  {
    pattern:
      /\b(password|passwd|secret|token|api[_-]?key|apikey|authorization|signature)\s*[=:]\s*[^\s,;&"']{4,}/giu,
    replace: (_match, name) => `${name}=${REDACTED_MARKER}`,
  },
];

/** Replaces every secret shaped fragment inside one string. */
export function redactText(text: string): string {
  let result = text;

  for (const { pattern, replace } of textPatterns) {
    result = result.replace(pattern, (...args: unknown[]): string => {
      const groups = args.filter((argument): argument is string => typeof argument === "string");

      return replace(groups[0] ?? "", ...groups.slice(1));
    });
  }

  return result;
}

/**
 * Returns a redacted copy of JSON safe log data.
 *
 * A sensitive field name loses its whole value, whatever its type, so `cvv: 123` and
 * `token: {…}` cannot slip through as a number or an object. Every other string is scrubbed by
 * the value patterns.
 */
export function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  const record = value as { readonly [key: string]: JsonValue };
  const result: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(record)) {
    result[key] = isSensitiveFieldName(key) ? REDACTED_MARKER : redactValue(child);
  }

  return result;
}
