// path: lib/auth/device-context.ts
import { createHash } from "node:crypto";

/**
 * The device a request came from, as far as this platform may claim to know it.
 *
 * Section 22 asks for a per-device proof key and a new device alert, and `0009`/`0011` store what
 * those two features need. Neither is this file's job. What a sign in can honestly record today is
 * the pair of facts the request carries - an agent and an address - and a label a human can read in
 * an audit entry and, later, in a device list.
 *
 * ## Why the label is derived, not trusted
 *
 * A user agent is attacker controlled text. It is never rendered, never used for a decision and
 * never stored raw in a place that promises a fact: the attempt table stores it bounded by its own
 * check, and the audit payload carries this derived label, which is one of the families below or
 * "an unknown browser". A person who sends a fabricated agent gets "an unknown browser on an
 * unknown platform" rather than a lie the platform repeats.
 *
 * ## Why an address is hashed
 *
 * `login_attempts` cannot store an address it does not know an account for, because that would
 * build a table of strangers' email addresses. `emailHash` is the alternative the schema provides:
 * the same address produces the same hash, so repeated probing is countable, and nothing can be
 * recovered from the hash itself.
 */

/** One device, described by the families this module can name. */
export interface DeviceContext {
  /** A sentence fragment such as "Chrome on macOS", at most 80 characters. */
  readonly label: string;
  readonly browser: string;
  readonly platform: string;
}

const unknownBrowser = "an unknown browser";
const unknownPlatform = "an unknown platform";

/** Longest label `device_proof_keys_label_check` accepts, so a device list can reuse it later. */
const maximumLabelLength = 80;

const browserFamilies: readonly (readonly [string, string])[] = [
  ["EdgA/", "Edge"],
  ["EdgiOS/", "Edge"],
  ["Edg/", "Edge"],
  ["OPR/", "Opera"],
  ["SamsungBrowser/", "Samsung Internet"],
  ["FxiOS/", "Firefox"],
  ["Firefox/", "Firefox"],
  ["CriOS/", "Chrome"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
];

const platformFamilies: readonly (readonly [string, string])[] = [
  ["iPhone", "iOS"],
  ["iPad", "iPadOS"],
  ["Android", "Android"],
  ["Windows", "Windows"],
  ["Macintosh", "macOS"],
  ["CrOS", "ChromeOS"],
  ["Linux", "Linux"],
];

function firstMatch(
  haystack: string,
  families: readonly (readonly [string, string])[],
  fallback: string,
): string {
  for (const [marker, name] of families) {
    if (haystack.includes(marker)) {
      return name;
    }
  }

  return fallback;
}

/**
 * The device context of an agent.
 *
 * The order of the two tables matters and is the reason they are written out rather than matched by
 * a regular expression: Edge and Opera both claim to be Chrome, and Chrome on iOS claims to be
 * Safari, so the first table asks the more specific marker first.
 */
export function readDeviceContext(userAgent: string | null): DeviceContext {
  const agent = userAgent?.trim() ?? "";

  if (agent.length === 0) {
    return { label: unknownBrowser, browser: unknownBrowser, platform: unknownPlatform };
  }

  const browser = firstMatch(agent, browserFamilies, unknownBrowser);
  const platform = firstMatch(agent, platformFamilies, unknownPlatform);
  const label = `${browser} on ${platform}`.slice(0, maximumLabelLength);

  return { label, browser, platform };
}

/** The SHA-256 of an address, in the lowercase hex `login_attempts_email_hash_check` requires. */
export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}
