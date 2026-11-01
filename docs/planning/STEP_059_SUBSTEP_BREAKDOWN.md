// path: docs/planning/STEP_059_SUBSTEP_BREAKDOWN.md
# STEP 059 - Sub-step breakdown

STEP 059: **Nonce based Content Security Policy builder** (`docs/final/STEP_PLAN_250.md` line 772),
from the stack line of `docs/final/MASTER_PROMPT.md` ("nonce-based CSP") and rule 11 of the same file.

## What already exists, and what is missing

The platform produces no `Content-Security-Policy` header at all: `next.config.mjs` sets
`reactStrictMode` and `poweredByHeader`, and nothing else. Every defence so far - the sanitisers of
STEP 056, the CSRF token of STEP 057, the destination rule of STEP 058 - assumes the browser executes
only what the platform wrote. A CSP is what makes that assumption true rather than hoped for: if an
injected script ever reaches a response, the header is the second line that stops it.

Three facts shaped the implementation:

- the repository writes exactly one inline script (`THEME_SCRIPT`, rendered in `app/layout.tsx`) and
  the security gate already asserts that it is the only `dangerouslySetInnerHTML` in the tree;
- Next 16 renamed the middleware convention to `proxy.ts`, and `middleware.ts` now logs a deprecation
  warning at build time;
- Next reads the nonce from the **request** `content-security-policy` header
  (`next/dist/server/render.js` -> `getScriptNonceFromHeader`), not from the response.

## The decisions this STEP makes

1. **A nonce, not a host list.** A policy made of `'self'` alone says any same-origin script may run,
   which is true of a compromised dependency and of an injected `<script src="/anything.js">`. A nonce
   says "only the scripts this response was rendered with", and `'strict-dynamic'` carries that
   authority onward to the chunks the bootstrap loads.
2. **The header is set twice, on purpose.** On the request (so the framework stamps its own tags) and on
   the response (so the browser enforces it). Setting only the response is the mistake that looks
   correct in a browser tab and breaks, or silently relaxes, everything else.
3. **Every route is rendered per request.** A prerendered document carries inline `self.__next_f`
   bootstrap scripts written before any nonce existed; a nonce policy blocks them, and a build-time hash
   cannot cover scripts that change with every build. `app/layout.tsx` therefore declares
   `force-dynamic`, and the seven routes that were static become dynamic (reported as dynamic in the build output). This
   is the documented price of a nonce-based policy, and the alternative - staying static and adding
   `'unsafe-inline'` - is a policy that permits the attack it exists to stop.
4. **The layout refuses to render without a nonce.** A missing nonce means the theme script would be
   blocked and the page would paint the wrong theme with one line in a browser console as the only
   evidence. The layout throws instead, and the gate asserts the validation is there.
5. **The proxy excludes files, not pages.** `_next/static`, `_next/image`, the favicon and a set of
   asset extensions are skipped: they are immutable, content addressed and cannot execute. Everything
   else - every page, every route handler, the 404 - gets a policy, and the gate asserts the exclusion
   list so a later edit cannot quietly drop a page.
6. **The allowances are named and reasoned.** `style-src 'unsafe-inline'` (the framework injects critical
   CSS; an inline style cannot run script), `img-src data: blob:`, and - in development only -
   `'unsafe-eval'` and `ws:`/`wss:`. Production adds `frame-ancestors 'none'` and
   `upgrade-insecure-requests`; development omits both, because the preview embeds the platform and it
   serves plain http.
7. **One module, no imports.** `lib/security/csp.ts` imports nothing at all, so the proxy, a route
   handler and the gate can all load it; the nonce comes from `crypto.getRandomValues`, which is a
   global in every runtime here. No `node:crypto`, no `Buffer`, no `process.env`.

## Owned paths

New: `lib/security/csp.ts`, `proxy.ts`, `docs/planning/STEP_059_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_059_COMPLETED.md`.

Edited: `app/layout.tsx` (the nonce, `force-dynamic`), `config/structure.json` (`proxy.ts` as a root
file), `lib/security/verify.ts` (the policy corpus and the wiring), `lib/security/README.md`.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_058_COMPLETED.md` (committed `57982c0`), `STEP_PLAN_250.md` line 772, the stack line of the master
prompt, `lib/security/README.md`, `app/layout.tsx`, `next.config.mjs`, and the installed framework
(`node_modules/next/dist/server/render.js`, `build/templates/middleware.js`) to confirm the nonce
mechanism of Next 16.4.3 and the `proxy.ts` convention rather than trusting a memory of Next 14.

## Sub-step 2 - Owned paths

Listed above. Nothing outside them is touched; `package.json` is not edited, and no dependency is added.

## Sub-step 3 - Database

None. A policy is a header; nothing is stored, and no table gains a column.

## Sub-step 4 - The core logic

`lib/security/csp.ts`:

- `CSP_HEADER_NAME`, `CSP_NONCE_HEADER_NAME`, `CSP_NONCE_BYTES`, `CSP_NONCE_PATTERN`;
- `createCspNonce()` - 16 bytes from `crypto.getRandomValues`, base64url, 22 characters;
- `isCspNonce(value)` - the shape, for a caller that compares rather than repairs;
- `buildCspDirectives({ nonce, development })` - the fifteen (thirteen in development) directives as
  data, in a fixed order, with a bad nonce refused rather than serialised;
- `buildContentSecurityPolicy({ nonce, development })` - the one-line header value.

## Sub-step 5 - Routes and jobs

`proxy.ts` is the connection: it runs before every page and every route handler the matcher admits,
mints the nonce, reads the development flag through `getServerConfig()` (never `process.env` directly -
the lint gate refuses that anywhere but `lib/env/`), and sets `content-security-policy` and `x-nonce` on
the request and on the response. No route handler changes, because the policy is a response property
rather than a per-handler decision.

## Sub-step 6 - UI

The visible change is the absence of a broken one: the pre-paint theme script keeps working because it
carries the nonce, and no screen gains a field, a string or a state. Checked at both widths against a
running server: `/`, `/signin`, `/2fa`, `/office/*` and the 404 return `200`/`404` with the header, every
script tag in the document carries the nonce (22 of 22), the theme script is present and nonced, and the
nonce differs on every request. A production build was served too: 13 scripts, all nonced, one
stylesheet link, `frame-ancestors 'none'` and `upgrade-insecure-requests` present.

## Sub-step 7 - Security proof

`checkCsp()` and `checkCspWiring()` in `lib/security/verify.ts`: the nonce shape, uniqueness and refusal
of a malformed value; the exact directive list in order; the negative assertions (`'unsafe-inline'` never
in `script-src`, no wildcard, no scheme source, no duplicate directive, no empty semicolon); the
development difference; the serialisation; and eight mutation controls, all caught - including
`'unsafe-inline'` added to `script-src`, `frame-ancestors` relaxed, the request header dropped from the
proxy, the nonce dropped from the script tag, `force-dynamic` removed, the pattern loosened, the asset
exclusion removed and the layout's validation removed.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts config`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, one commit
`STEP 059: Nonce based Content Security Policy builder` on `arena/1dc51ec3-kd-solution-it`, pushed, with
`docs/handoffs/STEP_059_COMPLETED.md`.
