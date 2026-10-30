// path: lib/env/server.ts
import type { ServerEnvironment } from "./manifest.ts";
import { parseServerEnvironment, resolveEnvironment } from "./schema.ts";

let validatedEnvironment: ServerEnvironment | undefined;

/**
 * The validated server environment.
 *
 * Validation runs once per process and the result is memoised. A failure throws on the first
 * call and keeps throwing on every later call, so a process that boots with a broken
 * environment can never quietly serve a request with a partially valid one.
 *
 * This module reads secrets. It must never be imported from a client component, and the
 * values it returns must never be logged, serialized into a response or sent to the browser.
 */
export function serverEnv(): ServerEnvironment {
  if (validatedEnvironment === undefined) {
    validatedEnvironment = parseServerEnvironment(process.env, resolveEnvironment(process.env));
  }

  return validatedEnvironment;
}

/**
 * Boot gate used by instrumentation.ts. Called once when the server starts; the application
 * refuses to start when the environment is incomplete or malformed.
 */
export function assertServerEnvironmentReady(): ServerEnvironment {
  return serverEnv();
}
