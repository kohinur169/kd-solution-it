// path: docs/handoffs/STEP_057_COMPLETED.md
# STEP 057 completed - CSRF double-submit protection for mutations

Branch `arena/1dc51ec3-kd-solution-it`, base `9bd9578` (STEP 056).
Source: `docs/final/STEP_PLAN_250.md` line 752; `docs/final/FEATURE_LIST.md` line 12 ("Sanitization for
every input: XSS, SQL injection, CSRF, SSRF, header injection, null byte, path traversal, Unicode
normalization") and `docs/final/MASTER_PROMPT.md` rule 11.

## What the STEP asks for

The session cookie has been `SameSite=Strict` and `HttpOnly` since STEP 036, and that has been the
whole of the CSRF answer: a cross-site form post does not carry a strict cookie, so a cross-site form
post arrives with no session and is refused as anonymous. The argument has three holes. A sibling or
compromised subdomain is same-site, so a strict cookie *does* travel with its requests. A browser or a
proxy that mishandles the attribute removes the defence silently. And "there was no session" is not a
refusal - several mutations are anonymous on purpose, and an attacker who wants a side effect from a
signed-in person's browser does not need to read the response.

The double submit token is the half that survives all three: another origin can make a browser send a
cookie, and cannot read a value to put in a header.

## Sub-steps, in order

1. **Read the contract** - `STEP_PLAN_250.md` line 752, feature list line 12, master prompt rules 4 and
   11, the 056 handoff, `lib/auth/README.md` rules 1-89, `lib/auth/cookies.ts` (the policy interface
   this STEP has to agree with), and every `method: "POST"` site under `app/` and `lib/`.
2. **Owned paths** - three new files, seven edited library files, fifteen routes, eleven browser files;
   listed in `docs/planning/STEP_057_SUBSTEP_BREAKDOWN.md`.
3. **Database** - none; see below.
4. **Core logic** - `lib/security/csrf.ts` and `lib/security/csrf-client.ts`.
5. **Routes** - `GET /api/auth/csrf` issues the token; the 15 mutation routes call `requireCsrfToken`.
6. **UI** - no screen changes; the eleven browser files that mutate now carry the header.
7. **Security proof** - `checkCsrfProtection()`, 152 checks, and six mutation controls.
8. **Gates, commit, push** - recorded below.

## Database - none

A token is 32 random bytes that live in the browser for at most twelve hours and are compared on the
way in. Nothing persists, nothing is audited per issue (the endpoint is a rate-limited counter, and
`auth.rate_limited` is the existing record of an abuse), nothing needs a rollback. The `csrf` rate
limit scope reuses `rate_limit_windows` from `0092`, so no migration is added and the existing
function accepts the new scope unchanged.

## The guard

`lib/security/csrf.ts` (231 lines):

| Export | What it decides |
| --- | --- |
| `CSRF_COOKIE_NAME` / `_INSECURE` | `__Host-kd_csrf` in production, `kd_csrf` when the deployment is not secure |
| `CSRF_HEADER_NAME` | `x-csrf-token` |
| `CSRF_TOKEN_PATTERN` | `^[A-Za-z0-9_-]{43}$` - 32 bytes of base64url, nothing else |
| `csrfPolicy({ secure })` | the cookie name and attributes, from the auth runtime's cookie policy |
| `createCsrfToken()` | `randomBytes(32)` in base64url |
| `csrfCookie(token, policy)` | `Path=/; Max-Age=43200; SameSite=Strict[; Secure]` - **no** `HttpOnly`, **no** `Domain` |
| `readCsrfCookie(cookieHeader, policy)` | the one name the policy uses, or `null` |
| `csrfTokensMatch(a, b)` | `timingSafeEqual`; `false` on a length mismatch, never a throw |
| `verifyCsrfRequest(request, ...)` | `{ ok: true, token }` or `{ ok: false, reason }` with `missing_cookie`, `missing_header`, `malformed_token`, `mismatch` |
| `requireCsrfToken(request, ...)` | the above, or `VALIDATION_FAILED` with field `csrf` and rule `csrf_token_invalid` |

`lib/security/csrf-client.ts` (96 lines) imports nothing at all: `readCsrfCookieFromDocument()`,
`readCsrfTokenFromCookie()` (the secure name first, then the bare one), `isCsrfToken()` and
`csrfHeaders()`. `csrfHeaders()` answers `{}` when it cannot get a token, so a form still reaches the
route and is refused there rather than failing in the browser with no explanation.

## Routes

`app/api/auth/csrf/route.ts`: `enforceRateLimit({ request, scope: "csrf" }, getAuthRuntime())` first,
then `csrfPolicy` from the same runtime, then `set-cookie` and `{ token }` with `cache-control:
no-store`. Anonymous, and classified as such in `lib/auth/disclosure.ts` with `TRANSPORT_CODES` only -
it never answers a statement about a record.

The 15 protected paths, in `CSRF_PROTECTED_PATHS`:

```
/api/auth/signin                  /api/auth/signup
/api/auth/2fa/reset               /api/auth/2fa/enroll
/api/auth/2fa/confirm             /api/auth/2fa/verify
/api/auth/2fa/backup-codes        /api/auth/devices
/api/auth/devices/confirm         /api/auth/session/rotate
/api/auth/session/reauth          /api/auth/sessions/revoke
/api/office/2fa-reset-requests/decision
/api/office/account-locks/unlock  /api/office/sessions/revoke
```

Each calls `requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure })`. In an auth
route the call is the first statement **after** `enforceRateLimit`; in an office route it is the first
statement of the handler, before `readRequestActor`. So an attacker spends a counter slot whether the
token is right or wrong, and no body is parsed and no session is looked up for a request that has not
proved it came from this origin.

## Browser wiring

Ten files, twelve call sites: `signin-form` (2), `two-factor-form` (2), `signup-form`,
`reset-request-form`, `reauth-form`, `backup-codes-form`, `device-confirm-form`, `session-list`,
`office-reset-queue`, `office-session-list`, plus both fetches in `lib/auth/device-proof-store.ts`
(rotation and enrolment). Each does `const csrf = await csrfHeaders();` before the fetch and spreads
`...csrf` - or `...proof, ...csrf` where a device proof header is already present - into `headers`.

## Security proof - `checkCsrfProtection()`, 152 checks

Behaviour: the token matches its pattern and is 43 characters; two minted tokens differ; the seven
cookie attributes (prefix, value, `Path=/`, `Secure`, `SameSite=Strict`, no `HttpOnly`, no `Domain`)
and the insecure variant's missing `Secure`; the cookie is read back from a header with other cookies
around it and is *not* read under the other name; matching is reflexive and refuses another token and
another length; the four refusal reasons each answer in order; `requireCsrfToken` throws
`VALIDATION_FAILED` with field `csrf` and rule `csrf_token_invalid`, and the sign-in surface is allowed
to answer that code and **not** `PERMISSION_DENIED`.

Tree: the set of route files that export a `POST` equals `CSRF_PROTECTED_PATHS` (15, in both
directions); each protected route calls the guard exactly once, before any `request.text()` and before
any `readRequestActor`, and after `enforceRateLimit` where there is one; ten browser files send twelve
mutations and spread exactly one token into each; the token endpoint installs its cookie, is
`no-store`, is rate limited with scope `csrf` through `rateLimitScopeForPath`, is in `classifiedPaths()`
and does not allow `VALIDATION_FAILED`; `csrf.ts` imports `node:crypto` and uses `timingSafeEqual`,
`csrf-client.ts` imports nothing and mentions neither, and `device-proof-store.ts` carries the header.

Six mutation controls, each restored and re-run afterwards:

| Mutation | Failed on |
| --- | --- |
| `requireCsrfToken` removed from signin | "checks the token exactly once" (0) |
| `...csrf` removed from one signin form call | "one spread per call" |
| `VALIDATION_FAILED` changed to `PERMISSION_DENIED` | "with the catalogue's validation code" |
| token route removed from the disclosure table | "is classified as anonymous or as session scoped" |
| `HttpOnly` added to the cookie | "and it is readable, because the page must send it back" |
| `node:crypto` imported by `csrf-client.ts` | "the browser half imports no Node builtin" |

## A defect found and fixed in the gate itself

`verify.ts` asserted that a session token with its last character replaced by `A` hashes differently.
When the minted token already ended in `A` - one run in sixty-four - the "changed" token was the
token, and the gate failed with "a changed token hashes differently" on a platform that was correct.
The replacement character now depends on the original (`ended in A` ? `B` : `A`), so the assertion is
deterministic. This was a flake in the certificate, not in the code, and it would have failed a
release.

## Gates

`npm run verify` exit **0**: structure **17 directories** / 13 root files / **167 source files** (three
new), config 10 sections/28 values, i18n 294 messages/14 placeholders/1 locale, logger 117, errors
202/15 codes, lint 77, shell 237, jobs 110, migrations 2746/92/75, `tsc --noEmit` clean, `next lint`
clean, `next build` clean - with `/api/auth/csrf` in the route list as a dynamic function.

`node lib/auth/verify.ts` passes **2355 checks** (2203 before this STEP; +152 for the new function, and
the flake fix above is the difference between 2354 and 2355).
`node lib/security/verify.ts` passes **174 checks**, unchanged: it owns the four sanitisers, and the
token is verified from the auth gate, where the route inventory is.

## Package requests (unchanged, still not applied)

1. `"check:auth": "node lib/auth/verify.ts"` and `"check:security": "node lib/security/verify.ts"`
   inside `verify`, after `check:errors`. Both gates run only when a person runs them today.
2. `dompurify` for the client-side rich text preview the CMS STEP will own.

## Deliberately not done

- **No `HttpOnly` on the CSRF cookie.** It is the one cookie that must be readable: the page has to
  put its value in a header. The session cookie stays `HttpOnly`, and that is the line between the two.
- **No per-form token.** One token per origin, refreshed when issued. A token per form means per-form
  state on the server or a token that dies with a tab, and neither buys anything against the attack
  this defends against.
- **No token in the session record.** The token is not a secret that authorises anything by itself; it
  proves the request came from a page on this origin. Storing it beside the session would make it a
  second password.
- **No `SameSite` on the CSRF cookie as the defence.** It is `Strict` as a second line, but the
  defence is the comparison. If the token is right, the cookie travelled; if the cookie did not
  travel, there was nothing to compare.
- **No signed token.** A signature would need a key, a rotation and a clock; the value is compared with
  a value in the caller's own cookie jar, so a forger would have to write a cookie on this origin,
  which is the attack it cannot mount.

## Next

STEP 058 - SSRF guard with URL allowlist and private range blocking (`STEP_PLAN_250.md` line 762). The
seam: `lib/security/host.ts` and `url.ts` already answer the half that is decidable from the string,
and `lib/security/README.md` states the second half - resolve the host, then check the resolved
address, then do not follow a redirect to a host that has not been checked. 058 is where the outbound
call sites get that second check.
