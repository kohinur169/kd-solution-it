// path: lib/security/ssrf.ts
import { lookup } from "node:dns/promises";
import { AppError } from "../errors/app-error.ts";
import { isIpLiteral, isPublicAddress, isPublicHostname } from "./host.ts";
import { sanitizeHttpUrl, type UrlRejectionReason } from "./url.ts";

/**
 * The destination rule for a server-side request.
 *
 * ## Why a string check is not the rule
 *
 * `host.ts` answers what a host string says about itself, and `url.ts` answers what a URL string says
 * about itself. Neither can answer the question that actually matters - *which address will this
 * request reach* - because `payments.example.com` is a perfectly ordinary name that a hostile or
 * compromised DNS zone can point at `10.0.0.5`. A guard that stops at the string is the guard that
 * SSRF walks past, and it is worse than no guard when someone reads the code and believes it.
 *
 * So the rule here has three parts, in this order, and all three must hold:
 *
 *   1. **The string** - scheme, credentials, port, host shape and the private literal ranges, which is
 *      `sanitizeHttpUrl` and `host.ts` doing the work they already own. Nothing in this file repeats
 *      those lists.
 *   2. **The allowlist** - the host must be one this process was configured to reach: the project
 *      origin, the two provider endpoints, and whatever a deployment adds. A name that resolves to a
 *      public address is not thereby a legitimate destination; `attacker.example` resolves publicly.
 *   3. **The addresses** - the host is resolved and **every** address it answers with must be public.
 *      Every one, because the runtime picks one of them, and "the first result was public" is not a
 *      property of the second.
 *
 * ## What this still cannot decide
 *
 * The window between the lookup and the connection: a DNS answer may change in between (rebinding).
 * Closing it needs the socket to be pinned to the address that was checked, which `fetch` does not
 * expose without a dispatcher package; `package.json` is not a STEP's to edit, so it is a package
 * request in the STEP 058 handoff. The window is narrowed here, not ignored: the answer is cached for
 * one minute, so a rebinding zone has to survive a cache expiry unnoticed, and every hop of a redirect
 * would still be checked by the caller - a caller that follows redirects at all. `lib/auth/http.ts`
 * does not: `redirect: "error"` is its contract, and the auth gate asserts it.
 *
 * ## The one exception, and how narrow it is
 *
 * A local deployment speaks to a Supabase container on `127.0.0.1`. `allowLoopback` is true only when
 * the configured project origin is loopback **and** the environment is not production, which is the
 * same condition `lib/auth/config.ts` already uses to permit plain http. The exception is a loopback
 * host and nothing else: it does not widen the allowlist, it does not admit a private name, and it
 * never applies in production.
 */

/** The rule name a form or an audit entry shows for a refused destination. */
export const OUTBOUND_RULE = "outbound_host_not_allowed";

/** The field name a refused user supplied URL is reported under. */
export const OUTBOUND_FIELD = "url";

/** How long one DNS answer is reused. Short: a rebinding zone has to outlive it, silently. */
export const OUTBOUND_DNS_TTL_MS = 60_000;

/** How many host answers are kept. A deployment reaches a handful of hosts, not the internet. */
export const OUTBOUND_CACHE_LIMIT = 64;

/**
 * The provider endpoints this platform calls, by what they are for.
 *
 * They are hostnames, not URLs, because the URL is the caller's to build and the destination is this
 * file's to decide. A caller may override the endpoint - the gate does, so no proof reaches the
 * network - and the override still has to pass the policy it is called with.
 */
export const OUTBOUND_PROVIDER_HOSTS: Readonly<Record<"challenge" | "breach", readonly string[]>> =
  Object.freeze({
    challenge: Object.freeze(["challenges.cloudflare.com"]),
    breach: Object.freeze(["api.pwnedpasswords.com"]),
  });

/** The identity provider host is not listed here: it comes from the environment, per deployment. */
export const OUTBOUND_STATIC_HOSTS: readonly string[] = Object.freeze([
  ...OUTBOUND_PROVIDER_HOSTS.challenge,
  ...OUTBOUND_PROVIDER_HOSTS.breach,
]);

/** Why a destination was refused. The URL reasons are `url.ts`'s, unchanged. */
export type OutboundRejectionReason =
  | UrlRejectionReason
  | "host_not_allowed"
  | "unresolvable"
  | "private_address";

/** The hosts one process may reach, and whether a loopback development container counts. */
export interface OutboundPolicy {
  /** Lower case host names. A name matches itself or any name under it, on a dot boundary. */
  readonly allowedHosts: readonly string[];
  /** Ports allowed beside the scheme default. Empty means the default port only. */
  readonly allowedPorts: readonly string[];
  /** True only for a non-production deployment whose identity provider is on loopback. */
  readonly allowLoopback: boolean;
}

/** A destination that passed the string checks: the canonical URL and the host to resolve. */
export interface OutboundTarget {
  readonly url: string;
  readonly host: string;
}

/** The answer of every check in this file. */
export type OutboundDecision =
  | { readonly ok: true; readonly target: OutboundTarget }
  | { readonly ok: false; readonly reason: OutboundRejectionReason };

export interface OutboundPolicyInput {
  /** The configured project origin. Its host joins the allowlist unless it is the loopback case. */
  readonly projectUrl: string;
  /** Hosts a deployment adds on purpose. Each one is validated like a listed host. */
  readonly extraHosts?: readonly string[];
  /** True only when a non-production deployment talks to a container on loopback. */
  readonly allowLoopback?: boolean;
}

const hostnameEntryPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** True when a host is loopback: the one destination a development container may use. */
export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/u, "");

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }

  if (lower === "::1" || lower === "[::1]" || lower === "0:0:0:0:0:0:0:1") {
    return true;
  }

  return /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u.test(lower);
}

function requireHostEntry(host: string, source: string): string {
  const lower = host.trim().toLowerCase();

  if (lower.length === 0) {
    throw new Error(`${source} must not contain an empty host`);
  }

  if (isIpLiteral(lower) || lower.startsWith("[") || /[0-9]+$/u.test(lower.split(".").pop() ?? "")) {
    // An allowlisted IP literal would defeat the range rule for that address and for every name that
    // resolves to it, so a literal is refused at the door rather than compared at the call.
    throw new Error(`${source} must name a host, not an address`);
  }

  if (lower.includes("*") || lower.startsWith(".") || lower.includes("/") || lower.includes(":")) {
    throw new Error(`${source} must be a bare host name`);
  }

  if (!hostnameEntryPattern.test(lower)) {
    throw new Error(`${source} contains a host that is not a public name`);
  }

  if (!isPublicHostname(lower)) {
    throw new Error(`${source} contains a host this platform may never reach`);
  }

  return lower;
}

/**
 * Build the allowlist of one process.
 *
 * A policy is code, so a bad entry throws here rather than quietly widening the rule: a wildcard, a
 * CIDR, a bare address, a private suffix or a typo with a trailing dot are all refused at build time,
 * which is the only time anyone is watching.
 */
export function outboundPolicy(input: OutboundPolicyInput): OutboundPolicy {
  const project = new URL(input.projectUrl);
  const projectHost = project.hostname.toLowerCase();
  const allowLoopback = input.allowLoopback === true;
  const hosts: string[] = [];
  const seen = new Set<string>();

  const add = (host: string): void => {
    if (seen.has(host)) {
      return;
    }

    seen.add(host);
    hosts.push(host);
  };

  if (isLoopbackHost(projectHost)) {
    if (!allowLoopback) {
      throw new Error("the project host is loopback, which the policy does not allow");
    }
  } else {
    add(requireHostEntry(projectHost, "the project host"));
  }

  for (const host of OUTBOUND_STATIC_HOSTS) {
    add(requireHostEntry(host, "the provider table"));
  }

  for (const host of input.extraHosts ?? []) {
    add(requireHostEntry(host, "an extra host"));
  }

  return Object.freeze({
    allowedHosts: Object.freeze(hosts),
    allowedPorts: Object.freeze(
      project.port === "" ? [] : [`${project.port}`],
    ),
    allowLoopback,
  });
}

/** True when a host is the allowlist's own name or a name under it, on a dot boundary. */
export function policyAllowsHost(policy: OutboundPolicy, host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/u, "");

  return policy.allowedHosts.some(
    (allowed) => lower === allowed || lower.endsWith(`.${allowed}`),
  );
}

/**
 * The string half of the rule. Synchronous, no network, and the only half a unit of code needs when it
 * is deciding whether to *offer* a URL as a destination.
 *
 * The sanitiser of STEP 056 does the work: scheme, credentials, port, host shape and the private
 * literal ranges are all its decisions, and a second list here would be a second answer to one
 * question. What this function adds is the two things a sanitiser cannot know - which hosts this
 * process was configured to reach, and that a development container on loopback is a destination while
 * a production one never is.
 */
export function checkOutboundUrl(value: string, policy: OutboundPolicy): OutboundDecision {
  const sanitized = sanitizeHttpUrl(value, {
    // Plain http exists for exactly one deployment: a container on the loopback of a machine that is
    // not production. It is not a general allowance, because the loopback branch below is the only
    // branch that can reach it.
    allowedProtocols: policy.allowLoopback ? ["http:", "https:"] : ["https:"],
    allowedPorts: policy.allowedPorts,
    allowPrivateHosts: policy.allowLoopback,
  });

  if (!sanitized.ok || sanitized.value === undefined) {
    return { ok: false, reason: sanitized.reason ?? "invalid_format" };
  }

  const host = new URL(sanitized.value).hostname.toLowerCase();

  // The sanitiser has already refused a loopback host for a production policy (`allowPrivateHosts`
  // is false there), so this branch is the development case and nothing else. It still states the
  // condition rather than assuming it: the day a policy allows a private host for another reason,
  // loopback must not become reachable by that accident.
  if (isLoopbackHost(host)) {
    return policy.allowLoopback
      ? { ok: true, target: { url: sanitized.value, host } }
      : { ok: false, reason: "private_host" };
  }

  if (!policyAllowsHost(policy, host)) {
    return { ok: false, reason: "host_not_allowed" };
  }

  return { ok: true, target: { url: sanitized.value, host } };
}

/** A resolver, in the one shape this file needs, so the gate can answer without a network. */
export type HostLookup = (host: string) => Promise<readonly string[]>;

/** The real lookup. `all: true` matters: every address is checked, not the first one. */
export const lookupWithDns: HostLookup = async (host) => {
  const answers = await lookup(host, { all: true, verbatim: true });

  return answers.map((answer) => answer.address);
};

export interface OutboundResolver {
  resolve(host: string): Promise<readonly string[] | null>;
  /** How many lookups this resolver performed. The gate reads it; production never asks. */
  lookups(): number;
  clear(): void;
}

export interface OutboundResolverOptions {
  readonly lookup?: HostLookup;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly limit?: number;
}

/**
 * A resolver with a bounded, expiring cache.
 *
 * The cache holds the *addresses*, never the verdict: every use re-checks `isPublicAddress`, so an
 * answer that was public when it was read is still refused if the rule says it is private now. What
 * the cache buys is one lookup per host per minute instead of one per identity call, which is the
 * difference between a guard and a latency regression.
 */
export function createOutboundResolver(options: OutboundResolverOptions = {}): OutboundResolver {
  const doLookup = options.lookup ?? lookupWithDns;
  const ttlMs = options.ttlMs ?? OUTBOUND_DNS_TTL_MS;
  const now = options.now ?? Date.now;
  const limit = options.limit ?? OUTBOUND_CACHE_LIMIT;
  const cache = new Map<string, { readonly addresses: readonly string[]; readonly expiresAt: number }>();
  let lookups = 0;

  return {
    async resolve(host: string): Promise<readonly string[] | null> {
      const key = host.toLowerCase();
      const hit = cache.get(key);
      const at = now();

      if (hit !== undefined && hit.expiresAt > at) {
        return hit.addresses;
      }

      lookups += 1;

      let addresses: readonly string[];

      try {
        addresses = await doLookup(key);
      } catch {
        cache.delete(key);

        return null;
      }

      if (addresses.length === 0) {
        return null;
      }

      if (cache.size >= limit) {
        const oldest = cache.keys().next();

        if (!oldest.done) {
          cache.delete(oldest.value);
        }
      }

      cache.set(key, { addresses, expiresAt: at + ttlMs });

      return addresses;
    },
    lookups(): number {
      return lookups;
    },
    clear(): void {
      cache.clear();
      lookups = 0;
    },
  };
}

/** The resolver of this process: one cache, shared by every transport built from it. */
export const defaultOutboundResolver: OutboundResolver = createOutboundResolver();

/**
 * The whole rule: the string, the allowlist and the addresses.
 *
 * A name that is not on the allowlist is refused before it is resolved, so a hostile name cannot even
 * be used to make this process perform a lookup - the query is itself a small information leak and,
 * against a rebinding zone, a small time window.
 */
export async function assertOutboundUrl(
  value: string,
  policy: OutboundPolicy,
  resolver: OutboundResolver = defaultOutboundResolver,
): Promise<OutboundDecision> {
  const decision = checkOutboundUrl(value, policy);

  if (!decision.ok) {
    return decision;
  }

  if (isLoopbackHost(decision.target.host)) {
    // The policy only allows this in a development deployment, and the destination is the machine
    // the process already runs on: there is nothing for a lookup to add.
    return decision;
  }

  if (isIpLiteral(decision.target.host)) {
    return isPublicAddress(decision.target.host)
      ? decision
      : { ok: false, reason: "private_address" };
  }

  const addresses = await resolver.resolve(decision.target.host);

  if (addresses === null || addresses.length === 0) {
    return { ok: false, reason: "unresolvable" };
  }

  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      return { ok: false, reason: "private_address" };
    }
  }

  return decision;
}

/**
 * The `AppError` a refused destination answers with.
 *
 * `422 VALIDATION_FAILED` with the field and the rule, which is what a form needs when the URL came
 * from a person. A destination that came from configuration is not a person's input: the transport
 * maps that refusal to a failure kind instead of throwing, and `DEPENDENCY_FAILED` is what it becomes.
 */
export function outboundRefusal(reason: OutboundRejectionReason, field: string = OUTBOUND_FIELD): AppError {
  return new AppError("VALIDATION_FAILED", {
    details: [{ field, rule: OUTBOUND_RULE }],
    // Which rule the address broke is evidence for the log, and `cause` is the one field the response
    // builder never serialises. A form learns the rule name and nothing about the address.
    cause: { rule: OUTBOUND_RULE, reason },
  });
}

/** The throwing wrapper for a URL a person supplied. */
export async function requireOutboundUrl(
  value: string,
  policy: OutboundPolicy,
  resolver: OutboundResolver = defaultOutboundResolver,
  field: string = OUTBOUND_FIELD,
): Promise<string> {
  const decision = await assertOutboundUrl(value, policy, resolver);

  if (!decision.ok) {
    throw outboundRefusal(decision.reason, field);
  }

  return decision.target.url;
}
