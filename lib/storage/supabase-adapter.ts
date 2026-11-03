// path: lib/storage/supabase-adapter.ts
import {
  defaultStorageFetch,
  encodeStorageBucket,
  encodeStoragePath,
  isLoopbackDevelopment,
  readBoundedBytes,
  storageErrorForStatus,
  storageFetch,
  storageOutboundPolicy,
  type StorageFetch,
  type StorageHttpDependencies,
} from "./http.ts";
import {
  StorageError,
  type SignedUrl,
  type StorageAdapter,
  type StorageObjectRef,
  type StorageUploadInput,
  type StoredObject,
} from "./types.ts";

/**
 * The Supabase Storage adapter: the default provider (`STORAGE_PROVIDER=supabase`).
 *
 * The platform has no Supabase SDK in its dependency tree and `package.json` is owned by the
 * integrator, so this adapter speaks the Storage REST API of the project directly, with the same
 * guarantees as the auth module's REST client: the service role key is presented only from the
 * server, as both the `apikey` header and the bearer, every request goes through `storageFetch`
 * (timeout, no redirects, outbound policy), and every answer maps to a typed `StorageError`.
 *
 * ## The four endpoints
 *
 *   - upload:   `POST   {project}/storage/v1/object/{bucket}/{key}`        (409 when the key exists)
 *   - download: `GET    {project}/storage/v1/object/{bucket}/{key}`        (404 when missing)
 *   - delete:   `DELETE {project}/storage/v1/object/{bucket}/{key}`
 *   - sign:     `POST   {project}/storage/v1/object/sign/{bucket}/{key}`   body `{"expiresIn": seconds}`
 *
 * The signed answer is a path relative to `/storage/v1`, and this adapter resolves it against the
 * project URL only when it starts with `/object/sign/` - the provider's answer is never trusted as
 * an absolute URL, because a signed URL must point back at the provider that signed it.
 *
 * The bucket is taken per call (the `0057` record stores it); Supabase Storage serves several
 * buckets from one project and its own policies govern which one a key belongs to.
 */

/** The environment fields this adapter reads. `serverEnv()` satisfies it; the gate builds a fixture. */
export interface SupabaseStorageEnvironment {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly NODE_ENV?: string;
}

export interface SupabaseStorageAdapterDependencies extends StorageHttpDependencies {
  readonly fetch?: StorageFetch;
}

/** The path prefix every signed URL this adapter answers with must start with. */
export const SUPABASE_SIGNED_PATH_PREFIX = "/object/sign/";

/** Strip the trailing slash of a configured project URL, or refuse a non-URL value. */
function normalizeProjectUrl(value: string): string {
  const url = new URL(value);

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("SUPABASE_URL must be the project origin without a path");
  }

  return url.origin;
}

export function createSupabaseStorageAdapter(
  environment: SupabaseStorageEnvironment,
  dependencies: SupabaseStorageAdapterDependencies = {},
): StorageAdapter {
  const projectUrl = normalizeProjectUrl(environment.SUPABASE_URL);
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  const base = `${projectUrl}/storage/v1`;
  const policy = storageOutboundPolicy(
    projectUrl,
    [],
    isLoopbackDevelopment(projectUrl, environment.NODE_ENV),
  );
  const fetchImpl = dependencies.fetch ?? defaultStorageFetch;
  const now = dependencies.now ?? (() => Date.now());

  const objectUrl = (ref: StorageObjectRef): string =>
    `${base}/object/${encodeStorageBucket(ref.bucket)}/${encodeStoragePath(ref.key)}`;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  });

  return {
    name: "supabase",

    async upload(input: StorageUploadInput): Promise<StoredObject> {
      const response = await storageFetch(
        policy,
        fetchImpl,
        objectUrl(input),
        {
          method: "POST",
          headers: headers({ "content-type": input.contentType }),
          body: input.bytes as BodyInit,
        },
      );

      if (!response.ok) {
        throw storageErrorForStatus(response.status);
      }

      return { provider: "supabase", bucket: input.bucket, key: input.key, byteSize: input.bytes.length };
    },

    async download(ref: StorageObjectRef): Promise<Uint8Array> {
      const response = await storageFetch(policy, fetchImpl, objectUrl(ref), {
        method: "GET",
        headers: headers(),
      });

      if (!response.ok) {
        throw storageErrorForStatus(response.status);
      }

      return readBoundedBytes(response);
    },

    async remove(ref: StorageObjectRef): Promise<void> {
      const response = await storageFetch(policy, fetchImpl, objectUrl(ref), {
        method: "DELETE",
        headers: headers(),
      });

      if (!response.ok) {
        throw storageErrorForStatus(response.status);
      }
    },

    async createSignedUrl(input: {
      readonly bucket: string;
      readonly key: string;
      readonly expiresInSeconds: number;
    }): Promise<SignedUrl> {
      const signUrl = `${base}/object/sign/${encodeStorageBucket(input.bucket)}/${encodeStoragePath(input.key)}`;
      const response = await storageFetch(policy, fetchImpl, signUrl, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ expiresIn: input.expiresInSeconds }),
      });

      if (!response.ok) {
        throw storageErrorForStatus(response.status);
      }

      const body: unknown = await response.json();
      const signedPath =
        typeof body === "object" && body !== null && "signedURL" in body
          ? (body as { readonly signedURL: unknown }).signedURL
          : null;

      if (typeof signedPath !== "string" || !signedPath.startsWith(SUPABASE_SIGNED_PATH_PREFIX)) {
        throw new StorageError("provider_error", "the provider answered with an unexpected signed URL");
      }

      return {
        url: `${base}${signedPath}`,
        expiresAt: new Date(now() + input.expiresInSeconds * 1000).toISOString(),
      };
    },
  };
}
