// path: docs/handoffs/STEP_059_COMPLETED.md
# STEP 059 completed - Nonce based Content Security Policy builder

Branch `arena/1dc51ec3-kd-solution-it`, base `57982c0` (STEP 058).
Source: `docs/final/STEP_PLAN_250.md` line 772; the stack line of `docs/final/MASTER_PROMPT.md`
("nonce-based CSP") and rule 11 of the same file.

## What the STEP asks for

Before this STEP the platform sent no `Content-Security-Policy` at all. Every defence so far assumes
the browser runs only what the platform wrote - the sanitisers of 056, the CSRF token of 057, the
destination rule of 058 - and a CSP is what makes that assumption true instead of hoped for. If an
injected script ever reaches a document, this header is the line that stops it.

## Sub-steps, in order

1. **Read the contract** - line 772, the stack line, STEP 058's handoff, `app/layout.tsx`,
   `next.config.mjs`, and the installed framework itself: `node/**/render.js` for how Next 16.4.3 lifts
   the nonce out of the request header, and `build/templates/middleware.js` for the `proxy.ts`
   convention. The version matters: `middleware.ts` is deprecated in Next 16 and prints a warning.
2. **Owned paths** - one new module, one new root file, two edited files and a README; listed in
   `docs/planning/STEP_059_SUBSTEP_BREAKDOWN.md`.
3. **Database** - none.
4. **Core logic** - `lib/security/csp.ts`.
5. **Routes and jobs** - `proxy.ts` applies the policy to every page and every route handler the
   matcher admits; no handler changes.
6. **UI** - no screen changes; verified by serving the app at both modes (below).
7. **Security proof** - 65 new checks and eight mutation controls.
8. **Gates, commit, push** - recorded below.

## Database - none

A policy is a response header. Nothing is stored, no table gains a column, no migration is added.

## The module

`lib/security/csp.ts` (196 lines, **imports nothing**):

| Export | What it decides |
| --- | --- |
| `CSP_HEADER_NAME` / `CSP_NONCE_HEADER_NAME` | `content-security-policy` and `x-nonce` |
| `CSP_NONCE_BYTES` / `CSP_NONCE_PATTERN` | 16 bytes; 22 base64url characters |
| `createCspNonce()` | `crypto.getRandomValues` - a global in the proxy, a route handler and the gate alike |
| `isCspNonce(value)` | the shape, for a caller that compares rather than repairs |
| `buildCspDirectives({ nonce, development })` | the directives as data, in a fixed order; a malformed nonce throws instead of serialising |
| `buildContentSecurityPolicy({ nonce, development })` | the one-line header value |

The policy, in the order it is emitted:

```
script-src 'self' 'nonce-<n>' 'strict-dynamic'
style-src 'self' 'unsafe-inline'
img-src 'self' data: blob:
font-src 'self'
connect-src 'self'
form-action 'self'
base-uri 'none'
object-src 'none'
frame-src 'none'
worker-src 'none'
media-src 'none'
manifest-src 'self'
frame-ancestors 'none'            (production only)
upgrade-insecure-requests         (production only, no source list)
default-src 'self'
```

Development replaces the last two with nothing and adds `'unsafe-eval'` to `script-src` and `ws:`/`wss:`
to `connect-src`, because React Refresh needs the first and hot reload needs the second.

## The proxy

`proxy.ts` is Next 16's name for the middleware convention (`middleware.ts` logs a deprecation warning
in this version). It does one thing:

```ts
const nonce = createCspNonce();
const policy = buildContentSecurityPolicy({ nonce, development: getServerConfig().isDevelopment });

const requestHeaders = new Headers(request.headers);
requestHeaders.set(CSP_HEADER_NAME, policy);
requestHeaders.set(CSP_NONCE_HEADER_NAME, nonce);

const response = NextResponse.next({ request: { headers: requestHeaders } });
response.headers.set(CSP_HEADER_NAME, policy);
response.headers.set(CSP_NONCE_HEADER_NAME, nonce);
```

**The request header is load bearing.** Next reads `content-security-policy` from the request and lifts
the nonce out of `script-src` (`getScriptNonceFromHeader`), and that is how every framework `<script>`
gets a nonce without this repository writing one. Setting only the response - the obvious
implementation - produces a header that looks correct and a page whose scripts are all blocked, or a
policy relaxed until the page works again. The gate asserts both `set` calls.

`getServerConfig()` is the validated accessor of STEP 004, not `process.env`: the lint gate refuses a raw
environment read anywhere outside `lib/env/`, and the configuration is memoised after boot.

The matcher skips `_next/static`, `_next/image`, the favicon and asset extensions - immutable, content
addressed, unable to execute - and admits everything else, including the 404 and every route handler.

## The layout

`app/layout.tsx` gained three things and no more:

```ts
export const dynamic = "force-dynamic";

const nonce = (await headers()).get(CSP_NONCE_HEADER_NAME);

if (nonce === null || !isCspNonce(nonce)) {
  throw new Error("the Content Security Policy nonce is missing from the request");
}

<script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
```

**Why `force-dynamic`, and what it costs.** A prerendered document is served from the build and its
inline `self.__next_f` bootstrap scripts were written before any nonce existed, so a nonce policy blocks
them; a build-time hash cannot cover scripts that differ per build. The seven routes that were static in
STEP 058 (`/`, `/_not-found`, `/2fa`, `/2fa/reset`, `/signin`, `/signup`, `/verify`) are now dynamic in the
build output. That is the documented price of a nonce-based policy, and the alternative - stay static
and add `'unsafe-inline'` - is a policy that permits exactly the attack it exists to stop. Every page on
this platform is a small server component around a client form, so the cost is a render per request, not
a query per request.

**Why the layout throws on a missing nonce.** Without it the theme script is blocked, the page paints
the wrong theme, and the only evidence is a console line in one browser. A 500 is loud; a wrong theme is
not.

## Security proof - `checkCsp()` + `checkCspWiring()`, 65 checks

The nonce: shape, length, uniqueness, and refusal of `""`, a short value, a padded value, a value with a
symbol. The policy: the exact directive list in order (so an added directive must be reviewed), the
nonce present exactly once and equal to the input, one semicolon per directive, one line, deterministic
output per input. The negative half, which is the half that matters: `script-src` never contains
`'unsafe-inline'`, never a wildcard, never `http:`, `https:` or `*`; `'unsafe-eval'` only in development;
`frame-ancestors` and `upgrade-insecure-requests` only in production; exactly one directive without a
source list; eight malformed nonces refused.

The wiring: `csp.ts` imports nothing and uses `crypto.getRandomValues`; `proxy.ts` exports `proxy`, sets
the policy on the request **and** the response, sends the nonce header, excludes the static prefixes,
reads `getServerConfig()` and never `process.env`; the layout declares `force-dynamic`, reads the nonce,
validates it, throws without it, and has exactly one hand written `<script>` that carries the nonce with
`THEME_SCRIPT` as its content; `config/structure.json` lists `proxy.ts`; and a tree scan proves that no
module outside `csp.ts` writes the header string by hand.

## Mutation controls

| Mutation | Failed on |
| --- | --- |
| `'unsafe-inline'` added to `script-src` | "an inline script is never allowed without a nonce" |
| `frame-ancestors` relaxed to `'self'` | "frame-ancestors is 'none'" |
| the policy set only on the response | "the policy is set on the request, which is what the framework reads" |
| the nonce dropped from the theme script | "and that tag carries the nonce" |
| `force-dynamic` removed | "the layout is rendered per request, because a nonce is per response" |
| the nonce pattern loosened | "a short value is not a nonce" |
| the asset exclusion removed from the matcher | "immutable assets are not given a policy" |
| the layout's nonce validation removed | "and validates the value instead of trusting the header" |

## Behaviour, verified against a running server

**Development** (`npm run dev`, Next 16.4.3, Turbopack): `/`, `/signin`, `/2fa`, `/nope` return
`200/200/200/404`; the response carries `content-security-policy` and `x-nonce`; the document has **22
script tags, all 22 with the nonce**, four of them inline and all four nonced; the theme script is
present and nonced; two consecutive requests carry two different nonces; `/api/health` carries the
header; a `/_next/static` chunk carries none. No console error was reported by the server.

**Production** (`npm run build` + `next start`): every route is dynamic and the build reports
the proxy entry with no deprecation warning; `/signin` returns `200` with **13 script tags, all
nonced**, one stylesheet link, and a policy that ends `frame-ancestors 'none'; upgrade-insecure-requests;
default-src 'self'`.

## Gates

`npm run verify` exit **0**: structure **17 directories** / **14 root files** (new: `proxy.ts`) / **169
source files**, config 10 sections/28 values, i18n 294 messages, logger 117, errors 202/15 codes, lint
77, shell 237, jobs 110, migrations 2 746/92/75, `tsc --noEmit` clean, `next lint` clean,
`next build` clean.

`node lib/security/verify.ts` passes **351 checks** (286 before this STEP).
`node lib/auth/verify.ts` passes **2 385 checks**, unchanged: this STEP touches no auth path.

## Deliberately not done

- **No CSP reporting endpoint.** `report-uri` is useful only with a collector, and a collector is a
  public `POST` that browsers send without a CSRF token - the single route that would have to be exempt
  from STEP 057's rule. It belongs to the logging pipeline, with its own rate limit and retention.
- **No `'unsafe-inline'` in `script-src`, anywhere, in any environment.** The gate fails on it, and a
  development machine is not an exception: a nonce works there too.
- **No `report-sample`, no `require-trusted-types-for`.** Trusted Types needs its sinks migrated, which
  is a rendering refactor rather than a header, and a directive that half-works is worse than one that
  is missing.
- **No other security header.** `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and HSTS are
  a deployment concern (the hosting platform terminates TLS and sets HSTS); `frame-ancestors` here covers
  the framing part of it, and `poweredByHeader: false` already removes the framework's advertisement.
- **No `nonce` on styles.** `style-src 'unsafe-inline'` is the framework's requirement; a style nonce
  would need the same `headers()` plumbing for no security gain, because an inline style cannot execute
  script.

## Next

STEP 060 - the first STEP of the platform's business surface after the four security libraries. The
seams this STEP leaves: every response now carries a per-request nonce, so a future STEP that renders
third-party script or a widget must add its host to `script-src` in `lib/security/csp.ts` and say why in
its handoff; and `connect-src 'self'` is what a browser-side provider integration would have to change.
