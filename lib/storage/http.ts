// path: lib/storage/http.ts
import {
  checkOutboundUrl,
  isLoopbackHost,
  outboundPolicy,
  type OutboundPolicy,
} from "../security/ssrf.ts";
import { isStorageError, MAX_OBJECT_BYTES, StorageError } from "./types.ts";

/**
 * The one place in this block that speaks HTTP to a storage provider.
 *
 * Both adapters send their requests through `storageFetch`, which makes four guarantees true for
 * every object operation at once, on the same terms as the auth module's transport:
 *
 *   1. a call cannot hang: every request carries a timeout;
 *   2. a redirect is an error, not a hop, so a `Location` header can never carry the service role
 *      key or the S3 signing key to another origin (`redirect: "error"`);
 *   3. the destination is a decided one: every URL is checked against the outbound policy before
 *      any socket is opened, so a poisoned `SUPABASE_URL` or a bucket name that resolves somewhere
 *      else is refused with `unavailable` and no request is sent;
 *   4. a failure is typed: the network error, the refused destination and each upstream status map
 *      to one `StorageError` code, and no URL, header or body of the provider answer is ever logged
 *      or put into a message - the signature and the keys live in headers, and this file keeps them
 *      out of every string it produces.
 */

/** A `fetch` shape, injectable so the gate can answer without a network. */
export type StorageFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Timeout for one storage request. Long enough for a 50 MB upload on a slow link, short enough to fail a route. */
export const STORAGE_REQUEST_TIMEOUT_MS = 30_000;

/** Ceiling for one provider error body read while classifying a failure. */
const ERROR_BODY_LIMIT_BYTES = 8_192;

/** The default transport: the global fetch. */
export const defaultStorageFetch: StorageFetch = (url, init) => fetch(url, init);

export interface StorageHttpDependencies {
  readonly fetch?: StorageFetch;
  readonly policy?: OutboundPolicy;
  readonly now?: () => number;
}

/**
 * The outbound policy of one provider endpoint: the project origin's host plus the extra hosts a
 * deployment adds on purpose (the S3 adapter adds its virtual-hosted bucket host beside the regional
 * service host). The loopback exception is the same narrow one the auth config makes: a non
 * production deployment whose endpoint is a container on loopback.
 */
export function storageOutboundPolicy(
  projectUrl: string,
  extraHosts: readonly string[] = [],
  allowLoopback = false,
): OutboundPolicy {
  return outboundPolicy({ projectUrl, extraHosts, allowLoopback });
}

/** True when the endpoint is a loopback host in a non-production environment - the one dev exception. */
export function isLoopbackDevelopment(projectUrl: string, nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production" && isLoopbackHost(new URL(projectUrl).hostname);
}

/**
 * Send one request to a storage provider. The URL is checked against the policy first; a refused
 * destination or a network failure answers `unavailable` / `provider_error` without a request.
 */
export async function storageFetch(
  policy: OutboundPolicy,
  fetchImpl: StorageFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const decision = checkOutboundUrl(url, policy);

  if (!decision.ok) {
    throw new StorageError("unavailable", `the storage destination was refused: ${decision.reason}`);
  }

  try {
    return await fetchImpl(decision.target.url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isStorageError(error)) {
      throw error;
    }

    throw new StorageError("provider_error", "the storage provider could not be reached");
  }
}

/** Map one upstream status to the storage error vocabulary. Never includes the response body. */
export function storageErrorForStatus(status: number): StorageError {
  if (status === 404) {
    return new StorageError("not_found", "the object does not exist at the provider");
  }

  if (status === 409) {
    return new StorageError("conflict", "the object already exists at the provider");
  }

  if (status === 400 || status === 422) {
    return new StorageError("invalid_input", "the provider refused the request");
  }

  return new StorageError("provider_error", `the storage provider answered status ${status}`);
}

/**
 * Read a response body as bytes, bounded by the 50 MB object ceiling: the declared length is refused
 * before the body is read and the actual length is checked after, so a broken or hostile endpoint
 * cannot exhaust memory.
 */
export async function readBoundedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > MAX_OBJECT_BYTES) {
    throw new StorageError("provider_error", "the provider answered with an oversized object");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length > MAX_OBJECT_BYTES) {
    throw new StorageError("provider_error", "the provider answered with an oversized object");
  }

  return bytes;
}

/** Read a small provider error body so an XML error code can be classified. Bounded, never logged. */
export async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const text = await response.text();

    if (text.length > ERROR_BODY_LIMIT_BYTES) {
      return null;
    }

    const match = /<Code>([^<]+)<\/Code>/u.exec(text);

    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Encode an object key as a URL path, keeping the `/` separators the storage APIs expect. */
export function encodeStoragePath(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/** Encode a bucket name for a URL path. */
export function encodeStorageBucket(bucket: string): string {
  return encodeURIComponent(bucket);
}
