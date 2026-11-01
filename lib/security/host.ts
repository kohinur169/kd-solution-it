// path: lib/security/host.ts
import { isIP } from "node:net";

/**
 * Which hosts a server-side request may reach.
 *
 * ## Why this is the SSRF rule and not a nicety
 *
 * This platform calls payment and KYC providers with values a merchant can influence: a webhook
 * endpoint, a return URL, a document link. A URL is not just a string in that context - it is the
 * platform's own network position being spent. `http://169.254.169.254/latest/meta-data/` is the
 * metadata service of whichever host runs the aV, `http://127.0.0.1:5432` is a port nobody meant to
 * expose, and `http://redis.internal` is the cache. The rule below is the list of addresses that are
 * *never* legitimate destinations for this platform, whatever DNS says.
 *
 * ## What this cannot decide
 *
 * DNS. A public name can resolve to a private address, and only the moment of connection knows that.
 * This module therefore answers the half that is decidable from the string - the literal ranges and
 * the names that must never be asked for - and the caller that actually connects is expected to
 * re-check the resolved address with `isPublicAddress` before it dials. That two-step rule is stated
 * in `lib/security/README.md` because it is the part a later STEP can get wrong.
 */

/** IPv4 ranges that are never a legitimate outbound destination, with what each one is. */
const blockedIpv4Ranges: readonly { readonly network: readonly [number, number, number, number]; readonly prefix: number; readonly reason: string }[] = [
  { network: [0, 0, 0, 0], prefix: 8, reason: "this network" },
  { network: [10, 0, 0, 0], prefix: 8, reason: "private" },
  { network: [100, 64, 0, 0], prefix: 10, reason: "carrier grade NAT" },
  { network: [127, 0, 0, 0], prefix: 8, reason: "loopback" },
  { network: [169, 254, 0, 0], prefix: 16, reason: "link local, including the metadata service" },
  { network: [172, 16, 0, 0], prefix: 12, reason: "private" },
  { network: [192, 0, 0, 0], prefix: 24, reason: "IETF protocol assignments" },
  { network: [192, 0, 2, 0], prefix: 24, reason: "documentation" },
  { network: [192, 168, 0, 0], prefix: 16, reason: "private" },
  { network: [198, 18, 0, 0], prefix: 15, reason: "benchmarking" },
  { network: [198, 51, 100, 0], prefix: 24, reason: "documentation" },
  { network: [203, 0, 113, 0], prefix: 24, reason: "documentation" },
  { network: [224, 0, 0, 0], prefix: 4, reason: "multicast" },
  { network: [240, 0, 0, 0], prefix: 4, reason: "reserved" },
];

/** Names that resolve to something private by convention, so they are refused as strings. */
export const BLOCKED_HOST_SUFFIXES: readonly string[] = Object.freeze([
  "localhost",
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".test",
  ".example",
  ".invalid",
  ".onion",
]);

/** True when a value is an IP address literal rather than a name. */
export function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0;
}

function ipv4ToNumber(address: string): number {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));

  return ((parts[0] ?? 0) * 2 ** 24 + (parts[1] ?? 0) * 2 ** 16 + (parts[2] ?? 0) * 2 ** 8 + (parts[3] ?? 0)) >>> 0;
}

/** True when an IPv4 literal is outside every range this platform may reach. */
export function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) {
    return false;
  }

  const value = ipv4ToNumber(address);

  for (const range of blockedIpv4Ranges) {
    const mask = range.prefix === 0 ? 0 : (0xffffffff << (32 - range.prefix)) >>> 0;

    if ((value & mask) >>> 0 === (ipv4ToNumber(range.network.join(".")) & mask) >>> 0) {
      return false;
    }
  }

  return true;
}

/** The IPv6 prefixes that are never a legitimate destination, with the bits that define each one. */
const blockedIpv6Prefixes: readonly { readonly prefix: string; readonly bits: number }[] = Object.freeze([
  { prefix: "::", bits: 128 },
  { prefix: "::1", bits: 128 },
  { prefix: "64:ff9b::", bits: 96 },
  { prefix: "100::", bits: 64 },
  { prefix: "2001:db8::", bits: 32 },
  { prefix: "2002::", bits: 16 },
  { prefix: "fc00::", bits: 7 },
  { prefix: "fe80::", bits: 10 },
  { prefix: "ff00::", bits: 8 },
]);

/** The 16 bytes of an IPv6 literal, or null for anything that is not one. */
function ipv6Bytes(address: string): readonly number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }

  const zone = address.split("%", 1)[0] ?? "";
  const halves = zone.split("::");

  if (halves.length > 2) {
    return null;
  }

  function groupsOf(part: string): number[] {
    if (part === "") {
      return [];
    }

    return part.split(":").flatMap((group) => {
      if (group.includes(".")) {
        const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map((value) => Number.parseInt(value, 10));

        return [(a << 8) + b, (c << 8) + d];
      }

      return [Number.parseInt(group, 16)];
    });
  }

  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  const groups =
    halves.length === 2
      ? [...head, ...new Array<number>(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail]
      : head;

  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null;
  }

  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

/**
 * True when the first `bits` bits of an address are the prefix's.
 *
 * Whole bytes are compared as bytes and the last, partial byte through a mask, because a prefix such
 * as `fc00::/7` is seven bits: comparing sixteen bytes would only ever match `fc00::` exactly, which
 * is the bug that lets `fd00::1` through.
 */
function bytesStartWith(bytes: readonly number[], prefix: string, bits: number): boolean {
  const wanted = ipv6Bytes(prefix);

  if (wanted === null) {
    return false;
  }

  const wholeBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;

  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== wanted[index]) {
      return false;
    }
  }

  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xff << (8 - remainingBits)) & 0xff;

  return ((bytes[wholeBytes] ?? 0) & mask) === ((wanted[wholeBytes] ?? 0) & mask);
}

/** The IPv4 address carried by an IPv4-mapped IPv6 literal, or null. */
function mappedIpv4(address: string): string | null {
  const bytes = ipv6Bytes(address);

  if (bytes === null) {
    return null;
  }

  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);

  if (!firstTenZero || bytes[10] !== 0xff || bytes[11] !== 0xff) {
    return null;
  }

  return `${bytes[12] ?? 0}.${bytes[13] ?? 0}.${bytes[14] ?? 0}.${bytes[15] ?? 0}`;
}

/** True when an IPv6 literal is outside every range this platform may reach. */
export function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);

  if (bytes === null) {
    return false;
  }

  const mapped = mappedIpv4(address);

  if (mapped !== null) {
    return isPublicIpv4(mapped);
  }

  for (const blocked of blockedIpv6Prefixes) {
    if (bytesStartWith(bytes, blocked.prefix, blocked.bits)) {
      return false;
    }
  }

  return true;
}

/** True when an address literal may be dialled: IPv4 outside the private ranges, IPv6 likewise. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    return isPublicIpv4(address);
  }

  if (family === 6) {
    return isPublicIpv6(address);
  }

  return false;
}

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/**
 * True when a *name* is a legitimate destination: at least two labels, ASCII letters, digits and
 * hyphens, no leading or trailing hyphen, and none of the private conventions above.
 *
 * A single-label host is refused even when it is not in the suffix list, because on the machine that
 * runs the platform `payments` is a service name rather than a host on the internet - which is exactly
 * the shape of an SSRF payload.
 */
export function isPublicHostname(host: string): boolean {
  const lower = host.toLowerCase();

  if (isIP(lower) !== 0) {
    return isPublicAddress(lower);
  }

  if (!hostnamePattern.test(lower)) {
    return false;
  }

  return !BLOCKED_HOST_SUFFIXES.some((suffix) => lower === suffix.replace(/^\./u, "") || lower.endsWith(suffix));
}

/** True when a literal or a name is a destination this platform may reach. */
export function isPublicHost(host: string): boolean {
  return isIpLiteral(host) ? isPublicAddress(host) : isPublicHostname(host);
}
