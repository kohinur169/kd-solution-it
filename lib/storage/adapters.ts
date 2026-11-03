// path: lib/storage/adapters.ts
import { serverEnv } from "../env/server.ts";
import type { StorageFetch } from "./http.ts";
import { adapterFor, type StorageAdapterRegistry } from "./registry.ts";
import { createS3StorageAdapter, type S3StorageEnvironment } from "./s3-adapter.ts";
import { createSupabaseStorageAdapter, type SupabaseStorageEnvironment } from "./supabase-adapter.ts";
import type { StorageAdapter, StorageAdapterName } from "./types.ts";

/**
 * The wiring of section 21: "The active adapter is selected by environment configuration, so the
 * same build runs with the application hosted on Netlify, Vercel or Amazon without rewriting the
 * core."
 *
 * `registerConfiguredAdapters` builds the adapter of each provider from the validated environment
 * and registers both into the registry, so `activeAdapter(registry)` - which reads
 * `getServerConfig().storageProvider`, the validated `STORAGE_PROVIDER` - resolves the one the
 * deployment asked for. Nothing else in the application names a provider: feature code calls the
 * service layer with the active adapter, and a deployment that sets `STORAGE_PROVIDER=s3` changes
 * nothing but its environment.
 *
 * The Supabase adapter is always built, because `SUPABASE_URL` and the service role key are required
 * in every environment - the platform's database is Supabase either way. The S3 adapter is built
 * when the `S3_*` fields are present, and is required when `STORAGE_PROVIDER=s3`: asking for S3
 * without configuring it is a configuration error thrown at registration, not an `unavailable` at
 * the first upload, so a broken deployment fails at boot-time wiring and not in a user's face.
 */

/** The environment fields the wiring reads. `ServerEnvironment` satisfies it; the gate builds a fixture. */
export interface StorageAdaptersEnvironment extends SupabaseStorageEnvironment {
  readonly NODE_ENV?: string;
  readonly STORAGE_PROVIDER?: string;
  readonly S3_BUCKET?: string;
  readonly S3_REGION?: string;
  readonly S3_ACCESS_KEY_ID?: string;
  readonly S3_SECRET_ACCESS_KEY?: string;
}

export interface StorageAdaptersDependencies {
  readonly fetch?: StorageFetch;
  readonly now?: () => number;
}

/**
 * Build and register the configured adapters. Returns the adapters so a caller can inspect what was
 * wired; feature code uses `activeAdapter(registry)` instead.
 */
export function registerConfiguredAdapters(
  registry: StorageAdapterRegistry,
  environment: StorageAdaptersEnvironment,
  dependencies: StorageAdaptersDependencies = {},
): readonly StorageAdapter[] {
  const adapters: StorageAdapter[] = [
    createSupabaseStorageAdapter(environment, dependencies),
  ];

  const wantsS3 = (environment.STORAGE_PROVIDER ?? "supabase") === "s3";
  const s3Fields = [
    environment.S3_BUCKET,
    environment.S3_REGION,
    environment.S3_ACCESS_KEY_ID,
    environment.S3_SECRET_ACCESS_KEY,
  ];
  const s3Configured = s3Fields.every((field) => field !== undefined);
  const s3Partial = s3Fields.some((field) => field !== undefined);

  if (s3Partial && !s3Configured) {
    throw new Error("the S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY fields must be set together");
  }

  if (!s3Configured && wantsS3) {
    throw new Error("STORAGE_PROVIDER is s3 but the S3_BUCKET, S3_REGION and S3 credential fields are missing");
  }

  if (s3Configured) {
    const s3Environment: S3StorageEnvironment = {
      S3_BUCKET: environment.S3_BUCKET ?? "",
      S3_REGION: environment.S3_REGION ?? "",
      S3_ACCESS_KEY_ID: environment.S3_ACCESS_KEY_ID ?? "",
      S3_SECRET_ACCESS_KEY: environment.S3_SECRET_ACCESS_KEY ?? "",
    };

    adapters.push(createS3StorageAdapter(s3Environment, dependencies));
  }

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return adapters;
}

/** Register the adapters of the real validated environment. Server only: it reads secrets. */
export function registerDefaultStorageAdapters(registry: StorageAdapterRegistry): readonly StorageAdapter[] {
  return registerConfiguredAdapters(registry, serverEnv());
}

/** The adapter of one provider from a registry the wiring filled, typed for callers. */
export function configuredAdapterFor(registry: StorageAdapterRegistry, provider: StorageAdapterName): StorageAdapter {
  return adapterFor(registry, provider);
}
