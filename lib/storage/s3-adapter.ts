// path: lib/storage/s3-adapter.ts
import { createHash, createHmac } from "node:crypto";
import {
  defaultStorageFetch,
  encodeStoragePath,
  readBoundedBytes,
  readErrorCode,
  storageErrorForStatus,
  storageFetch,
  storageOutboundPolicy,
  type StorageFetch,
  type StorageHttpDependencies,
} from "./http.ts";
import { validateBucket } from "./service.ts";
import {
  StorageError,
  type SignedUrl,
  type StorageAdapter,
  type StorageObjectRef,
  type StorageUploadInput,
  type StoredObject,
} from "./types.ts";

/**
 * The Amazon S3 adapter: the provider for `STORAGE_PROVIDER=s3`, the hosting case of FEATURE_LIST
 * section 21 where the build runs on Amazon beside its bucket.
 *
 * The platform has no AWS SDK in its dependency tree and `package.json` is owned by the integrator,
 * so this adapter signs requests itself with AWS Signature Version 4 (`node:crypto` HMAC-SHA256)
 * and sends them through `storageFetch`, which gives every object operation the same guarantees as
 * the Supabase adapter: timeout, no redirects, outbound policy, typed errors. The credentials never
 * leave the headers of a signed request, never enter a URL (the presigned URL carries only the
 * access key id and a signature), and never appear in a log line or an error message.
 *
 * ## One bucket, the configured one
 *
 * `S3_BUCKET` names the single bucket these credentials may write and read. An operation naming any
 * other bucket is refused with `invalid_input` before a request is built, so the credentials can
 * never be spent on a bucket the deployment did not declare.
 *
 * ## Presigned downloads
 *
 * `createSignedUrl` mints a GET URL with the `X-Amz-*` query parameters and `UNSIGNED-PAYLOAD`: no
 * request is sent, the URL itself is the answer, and it expires after the asked lifetime.
 */

/** The environment fields this adapter reads. `serverEnv()` satisfies it; the gate builds a fixture. */
export interface S3StorageEnvironment {
  readonly S3_BUCKET: string;
  readonly S3_REGION: string;
  readonly S3_ACCESS_KEY_ID: string;
  readonly S3_SECRET_ACCESS_KEY: string;
}

export interface S3StorageAdapterDependencies extends StorageHttpDependencies {
  readonly fetch?: StorageFetch;
}

/** The S3 error codes that mean the object is not there. */
const S3_NOT_FOUND_CODES = new Set(["NoSuchKey", "NotFound", "NoSuchBucket"]);

/** The signature algorithm identifier of SigV4. */
export const S3_ALGORITHM = "AWS4-HMAC-SHA256";

/** The payload hash of a presigned URL, which signs no body. */
export const S3_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u;

/** RFC 3986 percent-encoding, the stricter variant SigV4 requires (`encodeURIComponent` leaves `!'()*`). */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data, "utf8").digest());
}

/** The two date forms of SigV4 from one instant. */
export function amzDates(nowMs: number): { readonly amzDate: string; readonly dateStamp: string } {
  const iso = new Date(nowMs).toISOString();
  const amzDate = iso.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");

  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** The SigV4 signing key derived from the secret, the date, the region and the service. */
export function s3SigningKey(secret: string, dateStamp: string, region: string): Uint8Array {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");

  return hmac(kService, "aws4_request");
}

function canonicalQueryString(parameters: Readonly<Record<string, string>>): string {
  return Object.keys(parameters)
    .sort()
    .map((name) => `${awsUriEncode(name)}=${awsUriEncode(parameters[name] ?? "")}`)
    .join("&");
}

interface SignedRequestInput {
  readonly method: string;
  readonly canonicalUri: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

function sign(input: SignedRequestInput, secret: string, region: string, amzDate: string, dateStamp: string): string {
  const names = Object.keys(input.headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${input.headers[name]?.trim() ?? ""}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    canonicalQueryString(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [S3_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", s3SigningKey(secret, dateStamp, region))
    .update(stringToSign, "utf8")
    .digest("hex");

  return signature;
}

export function createS3StorageAdapter(
  environment: S3StorageEnvironment,
  dependencies: S3StorageAdapterDependencies = {},
): StorageAdapter {
  const bucket = validateBucket(environment.S3_BUCKET);

  if (!REGION_PATTERN.test(environment.S3_REGION)) {
    throw new Error("S3_REGION is not a valid region name");
  }

  if (environment.S3_ACCESS_KEY_ID.length === 0 || environment.S3_SECRET_ACCESS_KEY.length === 0) {
    throw new Error("the S3 credentials are missing");
  }

  const region = environment.S3_REGION;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const endpoint = `https://${host}`;
  const policy = storageOutboundPolicy(`https://s3.${region}.amazonaws.com`, [host]);
  const fetchImpl = dependencies.fetch ?? defaultStorageFetch;
  const now = dependencies.now ?? (() => Date.now());

  /** The one bucket these credentials may touch; anything else is refused before a request exists. */
  function requireConfiguredBucket(ref: StorageObjectRef): void {
    if (ref.bucket !== bucket) {
      throw new StorageError("invalid_input", "the S3 adapter serves only its configured bucket");
    }
  }

  async function signedRequest(
    method: "GET" | "PUT" | "DELETE",
    ref: StorageObjectRef,
    options: { readonly body?: Uint8Array; readonly contentType?: string } = {},
  ): Promise<Response> {
    requireConfiguredBucket(ref);

    const { amzDate, dateStamp } = amzDates(now());
    const path = encodeStoragePath(ref.key);
    const headers: Record<string, string> = {
      host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": options.body === undefined ? sha256Hex("") : sha256Hex(options.body),
    };

    if (options.contentType !== undefined) {
      headers["content-type"] = options.contentType;
    }

    const signature = sign(
      { method, canonicalUri: `/${path}`, query: {}, headers, payloadHash: headers["x-amz-content-sha256"] ?? "" },
      environment.S3_SECRET_ACCESS_KEY,
      region,
      amzDate,
      dateStamp,
    );
    const names = Object.keys(headers).sort();
    const authorization =
      `${S3_ALGORITHM} Credential=${environment.S3_ACCESS_KEY_ID}/${dateStamp}/${region}/s3/aws4_request, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`;

    return storageFetch(policy, fetchImpl, `${endpoint}/${path}`, {
      method,
      headers: { ...headers, authorization },
      ...(options.body === undefined ? {} : { body: options.body as BodyInit }),
    });
  }

  /** Classify a failed S3 answer: the XML error code first, the status as the fallback. */
  async function s3Failure(response: Response): Promise<StorageError> {
    const code = await readErrorCode(response);

    if (code !== null && S3_NOT_FOUND_CODES.has(code)) {
      return new StorageError("not_found", "the object does not exist at the provider");
    }

    return storageErrorForStatus(response.status);
  }

  return {
    name: "s3",

    async upload(input: StorageUploadInput): Promise<StoredObject> {
      const response = await signedRequest("PUT", input, {
        body: input.bytes,
        contentType: input.contentType,
      });

      if (!response.ok) {
        throw await s3Failure(response);
      }

      return { provider: "s3", bucket: input.bucket, key: input.key, byteSize: input.bytes.length };
    },

    async download(ref: StorageObjectRef): Promise<Uint8Array> {
      const response = await signedRequest("GET", ref);

      if (!response.ok) {
        throw await s3Failure(response);
      }

      return readBoundedBytes(response);
    },

    async remove(ref: StorageObjectRef): Promise<void> {
      const response = await signedRequest("DELETE", ref);

      if (!response.ok) {
        throw await s3Failure(response);
      }
    },

    async createSignedUrl(input: {
      readonly bucket: string;
      readonly key: string;
      readonly expiresInSeconds: number;
    }): Promise<SignedUrl> {
      requireConfiguredBucket(input);

      const { amzDate, dateStamp } = amzDates(now());
      const path = encodeStoragePath(input.key);
      const query: Record<string, string> = {
        "X-Amz-Algorithm": S3_ALGORITHM,
        "X-Amz-Credential": `${environment.S3_ACCESS_KEY_ID}/${dateStamp}/${region}/s3/aws4_request`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(input.expiresInSeconds),
        "X-Amz-SignedHeaders": "host",
      };
      const signature = sign(
        {
          method: "GET",
          canonicalUri: `/${path}`,
          query,
          headers: { host },
          payloadHash: S3_UNSIGNED_PAYLOAD,
        },
        environment.S3_SECRET_ACCESS_KEY,
        region,
        amzDate,
        dateStamp,
      );

      return {
        url: `${endpoint}/${path}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`,
        expiresAt: new Date(now() + input.expiresInSeconds * 1000).toISOString(),
      };
    },
  };
}
