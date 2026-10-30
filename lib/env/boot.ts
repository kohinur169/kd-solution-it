// path: lib/env/boot.ts
import process from "node:process";
import { clientEnvSource } from "./client.ts";
import {
  parseClientEnvironment,
  parseServerEnvironment,
  resolveEnvironment,
} from "./schema.ts";

/**
 * Node.js only boot gate.
 *
 * Kept out of instrumentation.ts because that file is also compiled for the Edge runtime,
 * where the process APIs used here do not exist. It is imported dynamically, and only, from
 * the NEXT_RUNTIME=nodejs branch of the server start hook.
 *
 * Both scopes are validated here: the server variables from the process, and the public
 * variables from the same static map the browser reads. Next.js inlines public variables at
 * build time, so that map already holds the build time values when the server starts.
 *
 * On failure the process ends with a non zero exit code. Next.js would otherwise keep a half
 * prepared server listening and answer health checks while every real request fails, which
 * is the opposite of the "refuse to start" rule in FEATURE_LIST section 29.
 */
export async function enforceServerEnvironmentOrExit(): Promise<void> {
  try {
    const environment = resolveEnvironment(process.env);
    parseServerEnvironment(process.env, environment);
    parseClientEnvironment(clientEnvSource, environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown environment failure";

    // Names and rules only: the validation errors never carry a value.
    const line = `level=fatal event=boot.environment_rejected message="${message.replaceAll(
      '"',
      "'",
    )}"\n`;

    await new Promise<void>((resolve) => {
      process.stderr.write(line, () => {
        resolve();
        process.exit(1);
      });
    });
  }
}
