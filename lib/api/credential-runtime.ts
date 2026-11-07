// path: lib/api/credential-runtime.ts
import { randomBytes } from "node:crypto";
import { getAuthRuntime } from "../auth/runtime.ts";
import { sealSecret } from "../auth/secrets.ts";
import { serverEnv } from "../env/server.ts";
import type { CredentialDependencies } from "./credentials.ts";

/**
 * The production wiring of section 20's credentials: the service role client, the signed chain, the clock,
 * the environment's encryption key and the platform's randomness.
 *
 * A projection of `getAuthRuntime()` rather than a second factory - the same shape `dispute-runtime.ts` uses
 * - so a caller cannot reach the table without a chain entry, and cannot seal a signing secret under a key
 * the boot validator never checked.
 *
 * The randomness is injected rather than imported by the service so the gate can know the key it issued and
 * assert that it reached no column, no view and no chain entry.
 */
export function getCredentialRuntime(): CredentialDependencies {
  const runtime = getAuthRuntime();

  return {
    rest: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
    seal: (plaintext: string, context: string): ReturnType<typeof sealSecret> =>
      sealSecret(serverEnv().ENCRYPTION_MASTER_KEY, plaintext, context),
    randomHex: (bytes: number): string => randomBytes(bytes).toString("hex"),
  };
}
