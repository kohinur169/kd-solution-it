// path: lib/auth/client-address.ts
import { z } from "zod";

/**
 * The address a request came from, or null.
 *
 * `audit_logs.ip_address` and `login_attempts` are `inet` columns, so a value that is not an address
 * is a failed insert rather than a harmless string. A proxy header is also attacker influenced: the
 * first entry of `x-forwarded-for` is whatever the client claimed unless a trusted edge rewrote the
 * header, so this module does not decide trust. It decides shape, and it refuses anything that is
 * not an address, which keeps a claim out of the database while leaving the audit and the rate
 * limiter of STEP 055 to use what the edge passed.
 *
 * Both families are accepted, including the IPv4 mapped form a dual stack edge produces. A zone
 * index, a port and a bracketed host are refused, because `inet` has no place for them and a value
 * that has to be repaired is a value that should not be stored.
 */

const maximumAddressLength = 45;

const ipv4Pattern = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/u;

const ipv6Pattern = /^[0-9a-f:]{2,45}$/iu;

const forwardedForSchema = z.string().max(1_024);

/** True when a value is a plain IPv4 or IPv6 address with no port, zone or brackets. */
export function isAddress(value: string): boolean {
  if (value.length === 0 || value.length > maximumAddressLength) {
    return false;
  }

  if (ipv4Pattern.test(value)) {
    return true;
  }

  return ipv6Pattern.test(value) && value.includes(":");
}

/** The address of a request, from the proxy headers a hosting platform sets. */
export function readClientAddress(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");

  if (forwarded !== null) {
    const parsed = forwardedForSchema.safeParse(forwarded);

    if (parsed.success) {
      const first = parsed.data.split(",", 1)[0]?.trim() ?? "";

      if (isAddress(first)) {
        return first;
      }
    }
  }

  const realIp = headers.get("x-real-ip")?.trim() ?? "";

  return isAddress(realIp) ? realIp : null;
}

/** The user agent, bounded by the column check, or null. */
export function readUserAgent(headers: Headers): string | null {
  const value = headers.get("user-agent")?.trim() ?? "";

  return value.length >= 1 && value.length <= 512 ? value : null;
}
