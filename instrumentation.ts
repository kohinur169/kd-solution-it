// path: instrumentation.ts

/**
 * Next.js server start hook.
 *
 * This is the boot gate of the platform: the validated environment is read once when a
 * server instance starts, and the process refuses to start when a required variable is
 * missing or malformed. Two conditions keep the hook safe:
 *
 * - the Edge runtime is skipped, because the environment contract is a server concern and
 *   the process APIs used by the gate do not exist there;
 * - the production build phase is skipped, because a build machine must not need runtime
 *   secrets to compile the application.
 *
 * All Node specific work lives in lib/env/boot.ts, imported only inside the nodejs branch.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") {
    return;
  }

  if (process.env["NEXT_PHASE"] === "phase-production-build") {
    return;
  }

  const { enforceServerEnvironmentOrExit } = await import("./lib/env/boot");
  await enforceServerEnvironmentOrExit();
}
