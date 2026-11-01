// path: lib/env/client.ts
import type { ClientEnvName } from "./manifest.ts";

/**
 * Public environment values that reach the browser.
 *
 * This module is deliberately dependency free. It imports types only, so it can never pull
 * the server schema, the manifest descriptions or the zod validator into a client bundle.
 * The server validates these values at boot through lib/env/boot.ts instead.
 *
 * Next.js inlines a public variable only when it is read as a static literal, so the map is
 * written out by hand. The `satisfies` clause below is the parity guarantee: adding a client
 * variable to the manifest without adding it here is a type error at build time.
 */
export const clientEnvSource = {
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env["NEXT_PUBLIC_TURNSTILE_SITE_KEY"],
} as const satisfies Record<ClientEnvName, string | undefined>;

function normalize(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The values a component may read. The key always exists and the value is possibly
 * undefined, which forces the caller to handle a missing public variable instead of
 * rendering an empty string that looks configured.
 */
export const clientEnv: Readonly<Record<ClientEnvName, string | undefined>> = {
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: normalize(clientEnvSource.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
};
