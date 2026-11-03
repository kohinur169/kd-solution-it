// path: lib/storage/registry.ts
import { getServerConfig, type StorageProvider } from "../../config/server.ts";
import {
  STORAGE_ADAPTER_NAMES,
  StorageError,
  type StorageAdapter,
  type StorageAdapterName,
} from "./types.ts";

/**
 * The adapter registry: the one place that knows which adapters exist and which one is active.
 *
 * FEATURE_LIST section 21: "The active adapter is selected by environment configuration, so the
 * same build runs with the application hosted on Netlify, Vercel or Amazon without rewriting the
 * core." The environment carries `STORAGE_PROVIDER` (`supabase` by default, `s3` when the files
 * live in Amazon S3), `config/server.ts` validates it into `getServerConfig().storageProvider`, and
 * `activeAdapter()` resolves it here. The adapters themselves are registered by STEP 101, one per
 * provider name; until an adapter for the active provider is registered, every operation answers
 * `StorageError("unavailable")` - a build that boots without its storage wired fails loudly at the
 * first file operation instead of silently writing to disk.
 *
 * ## The rules
 *
 * 1. One adapter per provider name: registering twice throws, exactly like the job registry.
 * 2. Feature code never picks an adapter by name; it calls `activeAdapter()`. Only tests and the
 *    adapter modules themselves name a provider.
 * 3. The registry is server only, like the config it reads.
 */

/** Thrown when a provider name is registered twice. */
export class StorageAdapterAlreadyRegisteredError extends Error {
  constructor(name: string) {
    super(`a storage adapter for "${name}" is already registered`);
    this.name = "StorageAdapterAlreadyRegisteredError";
  }
}

/** Thrown when no adapter serves the asked provider. */
export class StorageAdapterNotRegisteredError extends Error {
  constructor(name: string) {
    super(`no storage adapter is registered for "${name}"`);
    this.name = "StorageAdapterNotRegisteredError";
  }
}

export class StorageAdapterRegistry {
  private readonly adapters = new Map<StorageAdapterName, StorageAdapter>();

  /** Register one adapter. Throws when the provider name is already taken. */
  register(adapter: StorageAdapter): void {
    if (!STORAGE_ADAPTER_NAMES.includes(adapter.name)) {
      throw new StorageError("invalid_input", `unknown storage adapter name "${adapter.name}"`);
    }

    if (this.adapters.has(adapter.name)) {
      throw new StorageAdapterAlreadyRegisteredError(adapter.name);
    }

    this.adapters.set(adapter.name, adapter);
  }

  /** True when an adapter serves the provider. */
  has(name: StorageAdapterName): boolean {
    return this.adapters.has(name);
  }

  /** The adapter of one provider, or a `StorageAdapterNotRegisteredError`. */
  get(name: StorageAdapterName): StorageAdapter {
    const adapter = this.adapters.get(name);

    if (adapter === undefined) {
      throw new StorageAdapterNotRegisteredError(name);
    }

    return adapter;
  }

  /** The registered provider names. */
  names(): readonly StorageAdapterName[] {
    return [...this.adapters.keys()];
  }

  get size(): number {
    return this.adapters.size;
  }
}

/**
 * The adapter of an explicit provider, or `StorageError("unavailable")` when none is registered.
 * Feature code prefers `activeAdapter()`; this is for tests and the adapter modules themselves.
 */
export function adapterFor(registry: StorageAdapterRegistry, provider: StorageProvider): StorageAdapter {
  if (!STORAGE_ADAPTER_NAMES.includes(provider as StorageAdapterName)) {
    throw new StorageError("invalid_input", `unknown storage provider "${String(provider)}"`);
  }

  try {
    return registry.get(provider as StorageAdapterName);
  } catch {
    throw new StorageError("unavailable", `no storage adapter is registered for "${provider}"`);
  }
}

/**
 * The active adapter: the one the environment's `STORAGE_PROVIDER` names. Reads
 * `getServerConfig().storageProvider` once per call site is avoided by memoising the provider name,
 * not the adapter - an adapter registered after the first call still becomes active, which the
 * gate relies on.
 */
export function activeAdapter(registry: StorageAdapterRegistry): StorageAdapter {
  return adapterFor(registry, getServerConfig().storageProvider);
}
