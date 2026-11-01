// path: lib/auth/http.ts
import { PLATFORM_SERVICE_SLUG } from "../constants/platform.ts";
import {
  AUTH_MAXIMUM_RESPONSE_BYTES,
  AUTH_REQUEST_TIMEOUT_MS,
  type AuthConfig,
} from "./config.ts";
import type { AuthFailure, AuthOutcome } from "./types.ts";

/**
 * The one place in this module that speaks HTTP.
 *
 * The client, the admin client and the actor directory all send their request through this
 * function, which is what makes four guarantees true for every call at once:
 *
 *   1. a call cannot hang. It carries a timeout, combined with the caller's own signal so a job
 *      that is shutting down aborts the request instead of waiting for the socket;
 *   2. a redirect is an error, not a hop. `redirect: "error"` keeps the `apikey` header from
 *      following a `Location` to another origin, which is the whole reason a proxy in front of
 *      the project cannot quietly become the recipient of a key;
 *   3. a response is bounded. The declared length is refused before the body is read and the
 *      actual length is checked after, so a hostile or broken endpoint cannot exhaust memory;
 *   4. a body that is not JSON is a typed failure, never an exception in a request handler.
 *
 * The result carries the status and the parsed body, and nothing else. Deciding what a status
 * means is `failures.ts`, and the split matters: this file cannot accidentally decide that a
 * `401` should say something about an account.
 *
 * The token of a request is never logged, never placed in a URL and never put in a failure. A
 * failure carries a kind, a status and an upstream code, which is all a log line or a retry
 * decision needs.
 */

/** A `fetch` shape, injectable so the gate can answer without a network. */
export type AuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AuthRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  /** The key presented as the `apikey` header: anonymous for a user call, service role for admin. */
  readonly apiKey: string;
  /** The user's access token, when the call acts as that user. Never the service role key. */
  readonly bearerToken?: string;
  readonly body?: unknown;
  /**
   * A form encoded body, for the one endpoint that expects one (Cloudflare Turnstile siteverify).
   * Mutually exclusive with `body`: a request sends JSON or a form, never both.
   */
  readonly form?: Readonly<Record<string, string>>;
  /** Extra request headers. A reserved header is never overridden by this field. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface AuthAnswer {
  readonly status: number;
  /** The parsed JSON body, or null when the answer had no body. */
  readonly body: unknown;
  /** Seconds the upstream answer asked the caller to wait, taken from `retry-after`. */
  readonly retryAfterSeconds: number | null;
}

export interface AuthHttp {
  send(request: AuthRequest): Promise<AuthOutcome<AuthAnswer>>;
}

export interface AuthHttpOptions {
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly fetch?: AuthFetch;
  /**
   * Value of the `x-client-info` header. Supabase uses it to attribute traffic; the platform
   * name keeps the platform's calls distinguishable from a browser's in the project log.
   */
  readonly clientInfo?: string;
}

/** An HTTP date is a legal `retry-after` value; a delay in seconds is what this module returns. */
function parseRetryAfter(value: string | null, nowEpochMs: number): number | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  if (/^[0-9]{1,6}$/u.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);

    return seconds > 0 ? seconds : null;
  }

  const dateEpochMs = Date.parse(trimmed);

  if (Number.isNaN(dateEpochMs)) {
    return null;
  }

  const seconds = Math.ceil((dateEpochMs - nowEpochMs) / 1000);

  return seconds > 0 ? seconds : null;
}

function isTimeout(error: unknown, callerSignal: AbortSignal | undefined): boolean {
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return callerSignal === undefined || !callerSignal.aborted;
  }

  return false;
}

function failureOf(
  kind: AuthFailure["kind"],
  status: number | null,
  code: string | null = null,
): AuthFailure {
  return { kind, status, code, retryAfterSeconds: null };
}

/** Headers a caller may not set: they carry the key, the identity and the body contract. */
const reservedHeaderNames: ReadonlySet<string> = new Set([
  "apikey",
  "authorization",
  "accept",
  "content-type",
  "content-length",
  "x-client-info",
]);

function buildHeaders(request: AuthRequest, clientInfo: string): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!reservedHeaderNames.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  headers.set("accept", "application/json");
  headers.set("apikey", request.apiKey);
  headers.set("x-client-info", clientInfo);

  if (request.bearerToken !== undefined) {
    headers.set("authorization", `Bearer ${request.bearerToken}`);
  }

  if (request.form !== undefined) {
    headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (request.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function buildBody(request: AuthRequest): string | undefined {
  if (request.form !== undefined) {
    return new URLSearchParams(request.form).toString();
  }

  return request.body === undefined ? undefined : JSON.stringify(request.body);
}

async function readBoundedText(
  response: Response,
  maximumResponseBytes: number,
): Promise<AuthOutcome<string>> {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);

    if (Number.isFinite(parsedLength) && parsedLength > maximumResponseBytes) {
      return { ok: false, failure: failureOf("malformed-response", response.status) };
    }
  }

  let text: string;

  try {
    text = await response.text();
  } catch {
    return { ok: false, failure: failureOf("network", response.status) };
  }

  if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
    return { ok: false, failure: failureOf("malformed-response", response.status) };
  }

  return { ok: true, value: text };
}

/**
 * Build the transport.
 *
 * The timeout and the ceiling default to the configured values, and both are injectable so the
 * gate can prove the behaviour without waiting ten seconds or building a megabyte body.
 */
export function createAuthHttp(options: AuthHttpOptions = {}): AuthHttp {
  const timeoutMs = options.timeoutMs ?? AUTH_REQUEST_TIMEOUT_MS;
  const maximumResponseBytes = options.maximumResponseBytes ?? AUTH_MAXIMUM_RESPONSE_BYTES;
  const clientInfo = options.clientInfo ?? PLATFORM_SERVICE_SLUG;
  const doFetch: AuthFetch = options.fetch ?? ((url, init) => fetch(url, init));

  return {
    async send(request: AuthRequest): Promise<AuthOutcome<AuthAnswer>> {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        request.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([request.signal, timeoutSignal]);

      const requestBody = buildBody(request);
      let response: Response;

      try {
        response = await doFetch(request.url, {
          method: request.method,
          headers: buildHeaders(request, clientInfo),
          // A redirect is a configuration error, and following one would send the key onward.
          redirect: "error",
          // No cookie jar of the process is ever attached to an identity provider call.
          credentials: "omit",
          ...(requestBody === undefined ? {} : { body: requestBody }),
          signal,
        });
      } catch (error) {
        return {
          ok: false,
          failure: failureOf(isTimeout(error, request.signal) ? "timeout" : "network", null),
        };
      }

      const read = await readBoundedText(response, maximumResponseBytes);

      if (!read.ok) {
        return read;
      }

      const text = read.value;

      if (text.trim() === "") {
        return {
          ok: true,
          value: {
            status: response.status,
            body: null,
            retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), Date.now()),
          },
        };
      }

      let body: unknown;

      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, failure: failureOf("malformed-response", response.status) };
      }

      return {
        ok: true,
        value: {
          status: response.status,
          body,
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after"), Date.now()),
        },
      };
    },
  };
}

/** The transport of a configured project. */
export function createAuthHttpForConfig(config: AuthConfig, options: AuthHttpOptions = {}): AuthHttp {
  return createAuthHttp({
    timeoutMs: options.timeoutMs ?? config.requestTimeoutMs,
    maximumResponseBytes: options.maximumResponseBytes ?? config.maximumResponseBytes,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo }),
  });
}
