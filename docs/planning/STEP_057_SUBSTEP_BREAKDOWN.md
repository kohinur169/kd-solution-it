// path: docs/planning/STEP_057_SUBSTEP_BREAKDOWN.md
# STEP 057 - Sub-step breakdown

STEP 057: **CSRF double-submit protection for mutations** (`docs/final/STEP_PLAN_250.md` line 752),
from `docs/final/FEATURE_LIST.md` line 12 ("Sanitization for every input: XSS, SQL injection, CSRF,
SSRF, header injection, null byte, path traversal, Unicode normalization") and
`docs/final/MASTER_PROMPT.md` rule 11.

## What already exists, and what is missing

The session cookie has been `HttpOnly`, `Secure` and `SameSite=Strict` since STEP 036, and that closes
the ordinary cross-site form post: a page on another origin cannot read the cookie and the browser
does not attach it to a request that origin started. Everything else about the mutation surface is
already there too - every route validates its body with zod, counts the request with
`enforceRateLimit` (STEP 055), decides permissions from the session, and writes its audit entry.

What is missing is the second half of the defence, and it is the half that `SameSite` does not cover:

- a compromised or sibling subdomain is **same-site**, so a `Strict` cookie travels with its requests;
- a browser that treats `SameSite=Strict` as `Lax`, or a deployment behind a proxy that rewrites the
  cookie, has the same hole;
- `GET /api/auth/csrf` and the 15 mutation routes answer a request that may carry no session at all,
  so "the session was missing" is not the same refusal as "the caller is a stranger".

The platform therefore has no way to tell a mutation that a person's own page sent from a mutation
that another origin made the browser send. STEP 057 adds the value that only a page on this origin can
read, and makes each mutation prove it has the value.

## The decisions this STEP makes

1. **A second token, not a second cookie for the session.** `__Host-kd_csrf` is a 32-byte random value
   in base64url (43 characters), `HttpOnly` **absent by design**, `Secure`, `Path=/`, `SameSite=Strict`,
   `Max-Age` 43 200 seconds and no `Domain` - the four conditions a browser demands before it accepts a
   `__Host-` name. The session cookie stays `HttpOnly`; making it readable would be the one change that
   turns an XSS into a stolen session. A non-production deployment uses the bare name `kd_csrf`,
   because a browser refuses `__Host-` without `Secure`.
2. **One token for the whole origin, refreshed at issue.** `GET /api/auth/csrf` mints a token, installs
   the cookie and answers `{ token }` with `cache-control: no-store`. A page that has no cookie asks
   once; `csrfHeaders()` reads the cookie first and only calls the endpoint when there is nothing to
   read, so the common path is one `document.cookie` parse and no request.
3. **The refusal is `VALIDATION_FAILED`, not `PERMISSION_DENIED`.** The request has no proven identity:
   it may be an anonymous form post, it may be a stale tab, it may be an attacker. `PERMISSION_DENIED`
   would be a statement about a record, and the disclosure table would have to allow it on an
   anonymous surface. One code, one rule `csrf_token_invalid`, one field `csrf`, whatever the way it
   failed - and the four ways (`missing_cookie`, `missing_header`, `malformed_token`, `mismatch`) are
   distinguishable only in the reason the guard returns internally, never in the response.
4. **The comparison is constant time and needs both halves.** `csrfTokensMatch` uses
   `timingSafeEqual` over equal-length buffers and answers `false` for a length mismatch instead of
   throwing. A comparison that returns early on the first differing byte is a byte-at-a-time oracle.
5. **The guard sits after the counter and before the body.** `requireCsrfToken` is the first thing an
   office route does and the first thing an auth route does after `enforceRateLimit`, so an attacker
   spends a rate-limit slot whether or not the token is right, and no route parses a body or looks a
   session up on the strength of a request that has not proved it came from this origin.
6. **Two modules, because one would be bundled.** `csrf.ts` imports `node:crypto`. A `"use client"`
   module that imported it would drag the Node builtin into the browser bundle and fail the build, so
   `csrf-client.ts` imports **nothing** - not a type, not a constant - and the auth gate asserts that
   it stays that way.

## Owned paths

New: `lib/security/csrf.ts`, `lib/security/csrf-client.ts`, `app/api/auth/csrf/route.ts`,
`docs/planning/STEP_057_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_057_COMPLETED.md`.

Edited: `lib/auth/rate-limit.ts` (one scope, one policy, one path mapping), `lib/auth/disclosure.ts`
(one anonymous surface), `lib/auth/verify.ts` (one check function and one certificate fix),
`lib/auth/device-proof-store.ts`, `lib/auth/README.md`, `lib/security/README.md`, the 12
`app/api/auth/**/route.ts` mutations, the 3 `app/api/office/**/route.ts` mutations, and the 10 browser
files that send a `POST`.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_057_COMPLETED.md` for 056 (committed `9bd9578`), `STEP_PLAN_250.md` line 752,
`FEATURE_LIST.md` line 12, `MASTER_PROMPT.md` rules 4 and 11, `lib/auth/README.md` rules 1-89.

## Sub-step 2 - Owned paths

Listed above. Nothing outside them is touched; `package.json` is not edited.

## Sub-step 3 - Database

None. A CSRF token is 32 random bytes that live in the browser for at most half a day and are
compared on the way in; there is nothing to persist, nothing to audit and nothing to roll back. The
one table this STEP touches is `rate_limit_windows` (STEP 055), through the `csrf` scope it adds to
the existing function - no migration is added, and the existing one already accepts the scope.

## Sub-step 4 - The core logic

`lib/security/csrf.ts`:

- the constants (`CSRF_COOKIE_NAME`, `CSRF_COOKIE_NAME_INSECURE`, `CSRF_HEADER_NAME`, `CSRF_TOKEN_BYTES`,
  `CSRF_TOKEN_PATTERN`, `CSRF_COOKIE_MAX_AGE_SECONDS`, `CSRF_FIELD`, `CSRF_RULE`, `CSRF_TOKEN_PATH`,
  `CSRF_PROTECTED_PATHS`);
- `csrfPolicy({ secure })` - the cookie name and attributes for the deployment;
- `createCsrfToken()`, `csrfCookie()`, `readCsrfCookie()`, `csrfTokensMatch()`;
- `verifyCsrfRequest()`, which answers `{ ok: true, token }` or `{ ok: false, reason }`;
- `csrfRejection()` and `requireCsrfToken()`, which turn a refusal into `VALIDATION_FAILED`.

`lib/security/csrf-client.ts`: `readCsrfCookieFromDocument()`, `readCsrfTokenFromCookie()`,
`isCsrfToken()` and `csrfHeaders()` - which answers `{}` rather than throwing when there is no token
at all, because a form that cannot get a token should still reach the route and be refused there.

## Sub-step 5 - Routes

`app/api/auth/csrf/route.ts` issues the token: `enforceRateLimit` with scope `csrf` (120 per 5
minutes), `csrfPolicy` from the auth runtime, `set-cookie` and `{ token }`, both `no-store`.

The 15 mutation routes call `requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure })`
as `app/office/**`'s first statement and as `app/api/auth/**`'s first statement after the counter. The
list is data: `checkCsrfProtection()` compares `CSRF_PROTECTED_PATHS` with the set of route files that
export a `POST`, so a route added without a guard fails the gate instead of shipping.

## Sub-step 6 - UI

The screens do not change: no new field, no new text, no new state. What changes is the ten browser
files that already send a mutation - the sign in, sign up, two-factor, reset, reauth, backup-codes,
device-confirm, session-list, office reset queue and office session list - each of which now awaits
`csrfHeaders()` and spreads the result into its headers, one spread per call site (12). The token is
invisible to the person using the screen, so desktop and mobile widths have nothing to re-check; the
existing screens are unchanged at both.

## Sub-step 7 - Security proof

`checkCsrfProtection()` in `lib/auth/verify.ts`: the token shape and uniqueness, the seven cookie
attributes, the four refusal reasons, the one error code, the route inventory against the tree, the
order of the guard against the counter and the body read, the eleven-file client inventory, the token
endpoint's rate limit, disclosure classification and cache header, and the two-module boundary. Six
mutation controls, each restored: a guard removed, a spread removed, the wrong code, an unclassified
token route, an `HttpOnly` cookie, a client module importing `node:crypto`.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib`, `node lib/security/verify.ts`, `node lib/auth/verify.ts`,
`npm run verify`, one commit `STEP 057: CSRF double-submit protection for mutations` on
`arena/1dc51ec3-kd-solution-it`, pushed, with `docs/handoffs/STEP_057_COMPLETED.md`.
