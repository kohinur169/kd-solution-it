// path: docs/planning/STEP_058_SUBSTEP_BREAKDOWN.md
# STEP 058 - Sub-step breakdown

STEP 058: **SSRF guard with URL allowlist and private range blocking** (`docs/final/STEP_PLAN_250.md`
line 762), from `docs/final/FEATURE_LIST.md` line 12 ("Sanitization for every input: XSS, SQL
injection, CSRF, SSRF, header injection, null byte, path traversal, Unicode normalization") and
`docs/final/MASTER_PROMPT.md` rule 11.

## What already exists, and what is missing

STEP 056 built the half of the SSRF rule that is decidable from a string: `host.ts` lists the fourteen
IPv4 ranges and nine IPv6 prefixes that are never a destination (including `169.254.0.0/16`, the
metadata service), and `url.ts` refuses a URL whose host is a private literal, a private suffix or a
single label. Its README closes with the honest sentence that the other half belongs to a later STEP:
a public name can resolve to `10.0.0.5`, and only the moment of connection knows that.

STEP 058 is that half, and it needs three things the platform does not have:

1. **An allowlist.** The platform has exactly three outbound destinations - the Supabase project
   origin from the environment, `challenges.cloudflare.com` for the Turnstile check of STEP 041 and
   `api.pwnedpasswords.com` for the breach check of STEP 040 - and nothing enforces that. A name that
   resolves publicly is not thereby legitimate: an attacker who controls any URL the platform fetches
   wants *any* public host it can read from, not a private one.
2. **The address check.** Nothing resolves a host before dialling it, so `payments.example.com` is
   trusted on the strength of its spelling.
3. **A place to put it.** `lib/auth/http.ts` is already the one door every identity and provider call
   goes through - it owns the timeout, the response ceiling, `redirect: "error"` and
   `credentials: "omit"` - so the guard belongs in front of that door rather than in front of each
   caller.

## The decisions this STEP makes

1. **Three checks, in order, and all of them must pass:** the string (STEP 056's sanitiser, unchanged,
   called rather than reimplemented), the allowlist (which hosts this process may reach), and the
   addresses (every address the name answers with must be public). The order matters for the answer,
   not just the result: an attack is named as the attack it is - `private_host`, `credentials`,
   `unsupported_scheme` - rather than as a generic "not allowed".
2. **The allowlist is a policy object with no default.** `createAuthHttp` now *requires* an `outbound`
   policy. A transport that reaches anything because nobody configured it is the failure mode this
   STEP exists to make unrepresentable, and a required parameter is the only version of that a compiler
   can enforce.
3. **A policy refuses to be built badly.** An allowlist entry that is an IP literal, a CIDR, a
   wildcard, a private suffix or a single label throws at build time. An allowlisted literal would
   defeat the range rule for that address and for every name that resolves to it.
4. **A host off the list is refused before it is resolved.** A lookup is itself a small leak and, for
   a rebinding zone, a small window; the gate asserts that the resolver is never called for a name the
   policy does not allow.
5. **Every address, not the first.** The runtime picks one of an answer set, so "the first was public"
   is not a property of the second. A mixed answer is refused.
6. **The cache holds addresses, never verdicts.** One lookup per host per minute instead of one per
   identity call, and every use re-judges the cached addresses, so a cached answer cannot go stale into
   permission. The cache is bounded, and an expired entry is re-resolved - which is what makes a
   rebinding zone test possible and what makes its second answer get refused.
7. **The refusal is `DEPENDENCY_FAILED`, with the reason in the log.** The URL came from the
   deployment, not from a person, so it is not a form error. `AuthFailureKind` gains `blocked` rather
   than reusing `network`, because the two facts differ: one is a provider having a bad day, the other
   is this platform's own allowlist saying the URL was never legitimate.
8. **The redirect rule is stated, not assumed.** `redirect: "error"` was already the transport's
   contract; the gate now asserts it, because following a `Location` to a host the guard has not
   checked is the classic way a correct string check becomes an SSRF.
9. **The DNS window is documented and narrowed, not hidden.** Pinning a socket to the checked address
   needs a dispatcher package, and `package.json` is not a STEP's to edit, so the package request is in
   the handoff. What this STEP does instead: no redirects, a one-minute cache, and a README paragraph
   that says plainly what is still open.

## Owned paths

New: `lib/security/ssrf.ts`, `docs/planning/STEP_058_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_058_COMPLETED.md`.

Edited: `lib/auth/config.ts` (the policy on `AuthConfig`), `lib/auth/http.ts` (the guard and the
`blocked` failure), `lib/auth/types.ts` (the failure kind), `lib/auth/failures.ts` (its mapping),
`lib/auth/registration.ts`, `lib/auth/signin.ts`, `lib/auth/email-verification.ts` (each states the new
kind beside `network`), `lib/auth/verify.ts` (one check function and the transport fixtures),
`lib/security/verify.ts` (the corpus and the tree assertions), `lib/auth/README.md`,
`lib/security/README.md`.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_057_COMPLETED.md` (committed `7a09d6f`), `STEP_PLAN_250.md` line 762, `FEATURE_LIST.md` line 12,
`MASTER_PROMPT.md` rule 11, `lib/security/README.md` (the two-halves paragraph), `lib/auth/README.md`
rules 1-95, `lib/auth/http.ts` and `lib/auth/config.ts`.

## Sub-step 2 - Owned paths

Listed above. Nothing outside them is touched; `package.json` is not edited.

## Sub-step 3 - Database

None. The guard decides about a destination; it stores nothing, and the only table any outbound call
touches is the one its caller was already using. No migration, so no rollback to prove.

## Sub-step 4 - The core logic

`lib/security/ssrf.ts`:

- `OUTBOUND_PROVIDER_HOSTS` (`challenge`, `breach`) and `OUTBOUND_STATIC_HOSTS`;
- `outboundPolicy({ projectUrl, extraHosts, allowLoopback })` - validates every entry, refuses a
  loopback project origin unless the deployment says it is a development one;
- `policyAllowsHost(policy, host)` - the host itself or a name under it, on a dot boundary;
- `checkOutboundUrl(value, policy)` - the synchronous half: loopback exception, then STEP 056's
  sanitiser, then the allowlist;
- `createOutboundResolver({ lookup, ttlMs, now, limit })` - the bounded, expiring address cache;
- `assertOutboundUrl(value, policy, resolver)` - the whole rule, including the address check;
- `outboundRefusal(reason, field)` and `requireOutboundUrl(...)` - `VALIDATION_FAILED` with field `url`
  and rule `outbound_host_not_allowed`, the reason kept in `cause` for the log.

## Sub-step 5 - Routes and jobs

No route is added: the platform has no endpoint that accepts a URL to fetch, and adding one to
demonstrate the guard would be an SSRF endpoint. The connection this STEP makes is to the one outbound
door that already exists - `lib/auth/http.ts` - so all three real destinations (project origin,
Turnstile, breach corpus), and every identity call built on them, pass the guard.

## Sub-step 6 - UI

Not applicable: the refusal reaches the existing form errors through `DEPENDENCY_FAILED`, which every
screen already renders, and no screen gains a field or a state. The one visible behaviour is the one
intended - a misconfigured deployment fails loudly instead of fetching something it should not.

## Sub-step 7 - Security proof

`checkOutboundStrings()` and `checkOutboundAddresses()` in `lib/security/verify.ts` (the corpus: 24
refusals, 7 allowed destinations, the policy boundaries, the resolver, the rebinding case, the bounded
cache) and `checkOutboundGuard()` in `lib/auth/verify.ts` (the wiring: the configuration builds the
policy, the transport consults it before it dials, a refused URL never reaches `fetch`, the canonical
URL is what is dialled, the two provider constants pass, and only three modules in `lib/` dial at all).
Seven mutation controls, plus two that are absorbed by a second check and are recorded as such.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib`, `node lib/security/verify.ts`, `node lib/auth/verify.ts`,
`npm run verify`, one commit `STEP 058: SSRF guard with URL allowlist and private range blocking` on
`arena/1dc51ec3-kd-solution-it`, pushed, with `docs/handoffs/STEP_058_COMPLETED.md`.
