// path: docs/planning/STEP_060_SUBSTEP_BREAKDOWN.md
# STEP 060 - Sub-step breakdown

STEP 060: **Security headers middleware for every response** (`docs/final/STEP_PLAN_250.md` line 784),
from `docs/final/FEATURE_LIST.md` line 12 (the sanitisation line) and `docs/final/MASTER_PROMPT.md`
rule 11, and continuing the stack line's "nonce-based CSP" from STEP 059.

## What already exists, and what is missing

STEP 059 gave every rendered response a Content Security Policy and every static asset nothing at all:
its matcher excluded `_next/static`, `_next/image`, the favicon and a list of extensions. That left the
rest of the header surface empty - no `nosniff`, no referrer policy, no framing rule outside CSP, no
HSTS, no permission policy, no origin isolation - and it left the `_next` prefixes without even the two
headers that mean something for a file.

STEP 059's own handoff said so: "No other security header. X-Frame-Options, Referrer-Policy,
Permissions-Policy and HSTS are a deployment concern". This STEP is that sentence being taken back, with
one difference: it does not leave those headers to a deployment, because the platform targets two hosts
(Vercel and Netlify) and a header that depends on which one is running is a header that will differ
between them.

## The decisions this STEP makes

1. **One table, one writer.** `lib/security/headers.ts` is data: nine headers, each with the reason it
   exists and the scopes it belongs on. `proxy.ts` writes them. `next.config.mjs` is not touched, and the
   gate asserts it still has no `headers` key - two tables would be two answers, and the second one is
   always the stale one.
2. **Two scopes, because an asset is not a document.** A document is rendered, scripted and framed; an
   immutable chunk is none of those. A document gets all nine; a static file gets `nosniff` and
   `cross-origin-resource-policy`, which are the two that mean something for a file.
3. **The proxy now runs for every response.** STEP 059's matcher excluded the framework's assets, which
   made "every response" false. The matcher is now everything but the development hot reload socket, and
   the cost is one function call per asset - the price of a header set that cannot be bypassed by asking
   for a file instead of a page.
4. **The asset test is a prefix, not an extension.** The extension rule looked right and produced a 500:
   `/missing.css` does not exist, so the framework answers with the application's own 404 page, a
   document whose scripts need a nonce the proxy had skipped. Found by serving it; fixed by asking only
   whether the path is framework build output.
5. **Two headers are production only, and the reasons are not obvious.** HSTS on a development server
   would tell a browser to remember a secure-only policy for `localhost`, poisoning it for every other
   project on the machine. `x-frame-options` in development would block the preview frame the platform
   is reviewed in - the same reasoning that keeps `frame-ancestors` out of a development policy.
6. **`Referrer-Policy: no-referrer`, not `strict-origin-when-cross-origin`.** The client portal and the
   estimate links carry a token in the path. A referrer is a header this platform has no reason to send
   at all.
7. **`Permissions-Policy` denies every feature explicitly.** Camera, microphone, location, payment, USB,
   serial, HID, display capture and the sensors are each `=()`. The platform uses none of them, and a
   browser feature nobody asks for is a feature an injected script can ask for.
8. **No COEP, no `origin-agent-cluster`, no `preload`.** Each named in the module with the reason it is
   absent: `require-corp` would break a future image or font for a capability nothing needs;
   `origin-agent-cluster` duplicates Site Isolation for this deployment; and HSTS `preload` is a
   domain-wide, effectively irreversible commitment that belongs to STEPs 244-250, not to a security
   STEP.

## Owned paths

New: `lib/security/headers.ts`, `docs/planning/STEP_060_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_060_COMPLETED.md`.

Edited: `proxy.ts` (the scopes, the matcher, the header loop), `lib/security/csp.ts` (the asset path
rule), `lib/security/verify.ts` (the corpus, the wiring, and the STEP 059 assertions that the asset rule
moved), `lib/security/README.md`.

STEPs 056-067 own `lib/security/`; `proxy.ts` is the file STEP 059 created for the policy and this STEP
extends for the rest of the header set. `next.config.mjs` belongs to the foundation STEPs and is not
edited - the gate asserts that instead.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_059_COMPLETED.md` (committed `44facf5`), `STEP_PLAN_250.md` line 784, the ownership rules at line
45 of the same file, `docs/final/MASTER_PROMPT.md` rule 11, `lib/security/README.md`, `proxy.ts` and
`next.config.mjs`.

## Sub-step 2 - Owned paths

Listed above. Nothing outside them is touched; `package.json` is not edited, and no dependency is added.

## Sub-step 3 - Database

None. A header is a property of a response; nothing is stored.

## Sub-step 4 - The core logic

`lib/security/headers.ts`, importing nothing:

- `SECURITY_HEADERS` - the frozen table of nine headers with name, value, scopes and `productionOnly`;
- `SECURITY_HEADER_NAMES` - the names, in table order;
- `headersFor({ development, scope })` - the subset for one response, frozen and deterministic;
- `isSecurityHeaderName(name)` - the shape check for a caller that compares rather than repairs.

`lib/security/csp.ts` gained `FRAMEWORK_ASSET_PREFIXES` and `isFrameworkAssetPath(pathname)`, which is the
one question the proxy asks before it decides whether a response is a document.

## Sub-step 5 - Routes and jobs

`proxy.ts` is the connection, and it now covers every response: one nonce and one policy for anything
rendered, two headers for anything served as a file, and the document set on both kinds where it applies.
No route handler changes, because a header is not a handler's decision.

## Sub-step 6 - UI

No screen changes; the check is that nothing broke. Verified against a running development server:
`/signin`, `/api/health`, `/nope` (404), `/missing.css` (404 after the fix), `/missing.png`, `/sessions`,
`/office/sessions` and `/2fa/settings` all carry the document set, a nonced document and a policy; a
`_next/static` chunk carries exactly the two asset headers; a 502 error envelope carries the headers too.
Production (`next build` + `next start`): the document set plus `strict-transport-security` and
`x-frame-options: DENY`, the policy without `'unsafe-eval'`, and the chunk still on the asset scope.

## Sub-step 7 - Security proof

`checkSecurityHeaders()` and `checkSecurityHeaderWiring()` in `lib/security/verify.ts`: the table's shape
(unique, lower case, printable ASCII, no control character, no wildcard, at most 512 bytes), the exact
ordered list for a production document and for a development one, the two-header asset scope that the
environment cannot change, every value asserted one by one, the permission list, and a tree scan proving
no module outside `headers.ts` names a security header. Seven mutation controls, all caught.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, one commit
`STEP 060: Security headers middleware for every response` on `arena/1dc51ec3-kd-solution-it`, pushed,
with `docs/handoffs/STEP_060_COMPLETED.md`.
