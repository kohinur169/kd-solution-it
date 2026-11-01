// path: docs/handoffs/STEP_058_COMPLETED.md
# STEP 058 completed - SSRF guard with URL allowlist and private range blocking

Branch `arena/1dc51ec3-kd-solution-it`, base `7a09d6f` (STEP 057).
Source: `docs/final/STEP_PLAN_250.md` line 762; `docs/final/FEATURE_LIST.md` line 12 ("Sanitization for
every input: XSS, SQL injection, CSRF, SSRF, header injection, null byte, path traversal, Unicode
normalization") and `docs/final/MASTER_PROMPT.md` rule 11.

## What the STEP asks for

STEP 056 left the SSRF rule half finished and said so in its own README: `host.ts` can refuse
`169.254.169.254` as a string, and cannot refuse `payments.example.com`, which is a perfectly ordinary
name until you know what it resolves to. That sentence is the whole of this STEP's brief.

The platform also had no allowlist at all. It has exactly three outbound destinations - the Supabase
project origin from the environment, `challenges.cloudflare.com` (Turnstile, STEP 041) and
`api.pwnedpasswords.com` (breach check, STEP 040) - and "a public address" is not the same claim as
"a destination we chose". `SUPABASE_URL` is an environment variable, and an environment variable is
input.

## Sub-steps, in order

1. **Read the contract** - STEP 057's handoff, line 12 of the feature list, rule 11, the two-halves
   paragraph of `lib/security/README.md`, `lib/auth/http.ts` (the one outbound door) and
   `lib/auth/config.ts` (where the project origin is validated).
2. **Owned paths** - one new module, eight edited library files, two READMEs; listed in
   `docs/planning/STEP_058_SUBSTEP_BREAKDOWN.md`.
3. **Database** - none; the guard stores nothing.
4. **Core logic** - `lib/security/ssrf.ts`.
5. **Routes and jobs** - none added; the guard is wired into the existing transport, which every
   outbound call already uses.
6. **UI** - none; a refusal arrives as `DEPENDENCY_FAILED`, which every screen already renders.
7. **Security proof** - 112 new checks in the security gate, 30 in the auth gate, seven mutation
   controls.
8. **Gates, commit, push** - recorded below.

## Database - none

Nothing persists. A destination is judged, not stored, and no table gains a column. There is no
migration and therefore no rollback to prove; `migrations/verify.ts` still passes its 2 746 checks
against the 92 existing files.

## The module

`lib/security/ssrf.ts` (428 lines, server only):

| Export | What it decides |
| --- | --- |
| `OUTBOUND_PROVIDER_HOSTS` | `challenge: challenges.cloudflare.com`, `breach: api.pwnedpasswords.com` - hostnames, because a URL is the caller's to build and a destination is this file's to decide |
| `outboundPolicy({ projectUrl, extraHosts, allowLoopback })` | the allowlist of one process; refuses a wildcard, a CIDR, a bare address, a private suffix, a single label and a loopback origin without the development flag |
| `policyAllowsHost(policy, host)` | the host itself or a name under it **on a dot boundary**, so `challenges.cloudflare.com.evil.gate` and `evilcloudflare.com` both fail |
| `checkOutboundUrl(value, policy)` | the string half: STEP 056's `sanitizeHttpUrl` (called, never re-implemented), the allowlist, and the loopback branch |
| `createOutboundResolver({ lookup, ttlMs, now, limit })` | a bounded, expiring address cache that stores addresses and never verdicts |
| `assertOutboundUrl(value, policy, resolver)` | the whole rule, including "every address must be public" |
| `outboundRefusal(reason, field)` / `requireOutboundUrl(...)` | `422 VALIDATION_FAILED`, field `url`, rule `outbound_host_not_allowed`, reason kept in `cause` |

Three checks, in this order, and all must pass:

1. **the string** - scheme, credentials, port, host shape, private literals: STEP 056's decisions,
   unchanged, so there is one answer to "is this a URL" and not two;
2. **the allowlist** - the project origin from the environment plus the two provider hosts plus
   whatever a deployment adds;
3. **the addresses** - the host is resolved, and *every* address in the answer must be public.

A host that is not on the allowlist is refused **before** the lookup, so a hostile name cannot even
make this process perform a query.

## The wiring

`lib/auth/http.ts` is the one door: timeout, response ceiling, `redirect: "error"`,
`credentials: "omit"`. It now calls `assertOutboundUrl` **first**, before it builds headers or a body:

```ts
const destination = await assertOutboundUrl(request.url, outboundPolicy, resolver);

if (!destination.ok) {
  return { ok: false, failure: failureOf("blocked", null, destination.reason) };
}
```

and dials `destination.target.url` - the canonical form the guard decided on, not the string it was
given. `AuthHttpOptions.outbound` has **no default**: a transport that reaches anything because nobody
configured it is exactly the failure this STEP removes, and a required parameter is the one version of
that a compiler can enforce. `createAuthHttpForConfig` takes its options without `outbound` and always
uses `config.outbound`, so no caller can widen the policy of the process that built it.

`AuthConfig.outbound` is built in `buildAuthConfig` from the validated project origin - which is where
the one exception lives: `allowLoopback` is true only when `NODE_ENV` is not production **and** the
configured origin is loopback, the same condition that already permits plain http there.

`AuthFailureKind` gains `blocked`, distinct from `network` because the two facts differ (a provider
having a bad day versus our own allowlist saying the URL was never legitimate), and it maps to
`DEPENDENCY_FAILED` in `failures.ts`, `signin.ts`, `registration.ts` and `email-verification.ts`. The
reason travels in `failure.code`, which is where an upstream code has always travelled, so the log
keeps the rule and the response keeps its one sentence.

The two provider constants of earlier STEPs are on the same allowlist, which is the check that keeps a
guard from becoming an outage: `TURNSTILE_SITEVERIFY_URL` and `BREACH_RANGE_ENDPOINT` are asserted to
pass `config.outbound`.

## Security proof - `checkOutboundStrings()` + `checkOutboundAddresses()`, 112 checks

The string corpus, 24 refusals with the reason named for each: metadata IP, `10.0.0.5`, `192.168.1.1`,
`172.16.0.1`, `[::1]`, `[::ffff:127.0.0.1]`, `169.254.169.254/latest/meta-data/iam/security-credentials/`,
`redis.internal`, `metadata.google.internal`, `localhost`, `ref.supabase.co.` (trailing dot), plain
http, `javascript:`, `file:`, `gopher:`, embedded credentials, port 8080, an off-list host, a
lookalike that merely ends with an allowed name, a punycode host, a backslash URL, a protocol-relative
URL and a string that is not a URL at all. Seven allowed destinations, including a subdomain of the
project host and the two provider endpoints. Plus the policy boundaries (`*.supabase.co`, `.supabase.co`,
`localhost`, `redis.internal`, `payments`, `ref.supabase.co:443` and `10.0.0.5` all refused as *entries*),
the dot-boundary rule in both directions, and the loopback recognition.

The address corpus: a public answer allowed; `169.254.169.254` refused; `10.0.0.5` refused; a **mixed**
answer refused; an empty answer refused; a lookup that throws refused; a host off the list refused with
the resolver never called; one host looked up once inside the cache window; a **rebinding** zone whose
first answer is public and whose second (after expiry) is private refused for being private; and a
bounded cache that evicts rather than grows.

## Security proof - `checkOutboundGuard()`, 30 checks

The configuration builds the policy (project host, both provider hosts, and not `evil.gate`, and
`allowLoopback` false in this deployment); the two provider constants pass it; a metadata URL through
the real transport is a `blocked` failure naming `private_host` with **`fetch` never called**; an
off-list host is `host_not_allowed` with no request; plain http is `unsupported_scheme` with no request;
a name that resolves to `10.0.0.5` is `private_address` with no request; the canonical URL is what is
dialled (`HTTPS://PROJECT-REF.SUPABASE.CO/rest/v1/users` arrives as
`https://project-ref.supabase.co/rest/v1/users`); a development transport reaches
`http://127.0.0.1:54321/auth/v1/token`; `toAuthAppError` turns a block into `DEPENDENCY_FAILED`.

Then the source: `assertOutboundUrl` appears before `doFetch` in `http.ts`, `redirect: "error"` and
`credentials: "omit"` survive, `outbound: config.outbound` is what the transport uses, `config.ts`
builds the policy and states the loopback exception once - and only three modules under `lib/` call
`fetch` at all: the server door, the browser proof store and the browser CSRF helper.

## Mutation controls

| Mutation | Failed on |
| --- | --- |
| the transport skips the guard | "a metadata URL is a blocked failure" |
| the allowlist compares by prefix instead of a dot boundary | "a name under it, on a dot boundary" |
| only the first resolved address is checked | "one private address beside a public one" |
| the loopback branch allows any private host | "and is refused as `private_host`" |
| every allowlist entry validation removed | the allowlist refuses `"10.0.0.5"` as an entry |
| `redirect: "follow"` | "a redirect is an error, never a hop" |
| the loopback exception dropped from the config | the configuration refuses its own development origin |

Two further mutations were absorbed rather than caught, and that is worth recording because both are
redundancy rather than coverage:

- removing the `addresses.length === 0` guard in `assertOutboundUrl` changes nothing, because the
  resolver itself returns `null` for an empty answer;
- removing the `policy.allowLoopback` test inside the loopback branch changes nothing, because
  `sanitizeHttpUrl` has already refused a loopback host for a policy that does not allow private hosts.

Each pair is only dangerous together, and the composed behaviour is asserted directly.

## Gates

`npm run verify` exit **0**: structure **17 directories** / 13 root files / **168 source files** (one
new), config 10 sections/28 values, i18n 294 messages/14 placeholders/1 locale, logger 117, errors
202/15 codes, lint 77, shell 237, jobs 110, migrations 2 746/92/75, `tsc --noEmit` clean, `next lint`
clean, `next build` clean.

`node lib/security/verify.ts` passes **286 checks** (174 before this STEP).
`node lib/auth/verify.ts` passes **2 385 checks** (2 355 before this STEP).

`next build` compiles with `node:dns/promises` imported by `ssrf.ts` and reports nothing: the module is
reached only from `lib/auth/config.ts` and `lib/auth/http.ts`, both server only, and the gate asserts
that no client module imports either.

## Package request (open, not applied)

1. **A dispatcher such as `undici` with a custom `lookup`**, so the socket is pinned to the address the
   guard checked. Without it there is a window between the lookup and the connection in which a
   rebinding zone can answer publicly and connect privately. The window is narrowed here - a one-minute
   cache, no redirects anywhere in the transport - and narrowed is not closed. This is the honest
   remainder of the SSRF rule, and it needs a package, which `package.json` is not a STEP's to edit.
2. `"check:auth": "node lib/auth/verify.ts"` and `"check:security": "node lib/security/verify.ts"`
   inside `verify`, after `check:errors`, remain open from 056 and 057.
3. `dompurify` for the client-side rich text preview the CMS STEP will own.

## Deliberately not done

- **No endpoint that accepts a URL to fetch.** The guard is complete without one, and an endpoint that
  fetches what it is given is the vulnerability this STEP is about.
- **No allowlist from an environment variable.** The hosts are the project origin plus two constants in
  this repository. A deployment can add one through `extraHosts` in code, which means it is reviewed;
  an environment variable that widens an SSRF allowlist is a second `SUPABASE_URL` waiting to happen.
- **No wildcard, no CIDR, no regex entry.** Every entry is one name, compared on a dot boundary, and the
  gate proves both directions of that comparison.
- **No retry on a block.** A blocked destination is a configuration fault, and retrying a fault is a
  way to make it look like an outage.
- **No audit row.** A blocked destination is not a person's action: there is no user-supplied URL in the
  platform yet, so the entry would have no subject. The webhook STEP that introduces the first one owns
  the audit entry, and `outboundRefusal` already carries the rule and the reason for it.
- **No change to `lib/security/host.ts`.** Its ranges are the rule; a second copy in `ssrf.ts` is the
  thing the gate asserts against.

## Next

STEP 059 - Nonce based Content Security Policy builder (`STEP_PLAN_250.md` line 772). The seam: the app
already renders one static theme script in `app/layout.tsx` and one `dangerouslySetInnerHTML`, both
asserted by `lib/security/verify.ts`, which is exactly what a nonce has to be threaded through.
