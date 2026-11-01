// path: config/server.ts
import { z } from "zod";
import { ENVIRONMENTS, type AppEnvironment } from "../lib/env/manifest.ts";
import { serverEnv } from "../lib/env/server.ts";
import { deepFreeze } from "../lib/utils/freeze.ts";

/**
 * Server configuration derived from the validated environment.
 *
 * Server only. It reads values through `serverEnv()`, which STEP 004 already validated at
 * boot, so nothing here re-validates or re-reads `process.env`.
 *
 * The value is built lazily and then memoised, on purpose. A module level read would execute
 * during `next build` while Next collects page data, which would make a build machine need
 * the runtime secrets again - exactly the guarantee STEP 004 established. Call
 * `getServerConfig()` from inside a request handler, a server component body or a job.
 *
 * Only a safe subset crosses this boundary: the environment name and flags, the public
 * application URL, the storage adapter name, the log level and whether monitoring is on.
 * Keys, tokens, passwords and connection strings stay in `serverEnv()` at their point of use,
 * so a value printed from this object can never be a credential.
 */

const environmentSchema = z.enum(ENVIRONMENTS);
const storageProviderSchema = z.enum(["supabase", "s3"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export type StorageProvider = z.infer<typeof storageProviderSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export interface ServerConfig {
  readonly environment: AppEnvironment;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly appUrl: string;
  readonly storageProvider: StorageProvider;
  readonly logLevel: LogLevel;
  readonly monitoringEnabled: boolean;
}

function buildServerConfig(): ServerConfig {
  if (typeof window !== "undefined") {
    throw new Error(
      "config/server.ts is server only. Import config/app.ts from a client component.",
    );
  }

  const environment = serverEnv();

  const parsedEnvironment = environmentSchema.safeParse(environment.NODE_ENV);
  if (!parsedEnvironment.success) {
    throw new Error("config/server.ts received an unsupported NODE_ENV value");
  }

  const parsedStorageProvider = storageProviderSchema.safeParse(
    environment.STORAGE_PROVIDER ?? "supabase",
  );
  if (!parsedStorageProvider.success) {
    throw new Error("config/server.ts received an unsupported STORAGE_PROVIDER value");
  }

  const parsedLogLevel = logLevelSchema.safeParse(environment.LOG_LEVEL ?? "info");
  if (!parsedLogLevel.success) {
    throw new Error("config/server.ts received an unsupported LOG_LEVEL value");
  }

  const activeEnvironment = parsedEnvironment.data;

  return {
    environment: activeEnvironment,
    isProduction: activeEnvironment === "production",
    isDevelopment: activeEnvironment === "development",
    isTest: activeEnvironment === "test",
    appUrl: environment.APP_URL,
    storageProvider: parsedStorageProvider.data,
    logLevel: parsedLogLevel.data,
    monitoringEnabled: (environment.SENTRY_DSN ?? "").length > 0,
  };
}

let cachedServerConfig: ServerConfig | undefined;

/**
 * The validated server configuration. Built on first use and reused for the life of the
 * process, so the cost is one object per process and never one per request.
 */
export function getServerConfig(): ServerConfig {
  cachedServerConfig ??= deepFreeze(buildServerConfig());
  return cachedServerConfig;
}
