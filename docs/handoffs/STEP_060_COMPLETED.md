// path: docs/handoffs/STEP_060_COMPLETED.md
# STEP 060 completed - Security headers middleware for every response

Branch `arena/1dc51ec3-kd-solution-it`, base `44facf5` (STEP 059).
Source: `docs/final/STEP_PLAN_250.md` line 784; `docs/final/FEATURE_LIST.md` line 12 and
`docs/final/MASTER_PROMPT.md` rule 11.

## What the STEP asks for

STEP 059 gave a rendered response a Content Security Policy and left every other header unset: no
`nosniff`, no referrer policy, no framing rule for a browser that does not read CSP, no HSTS, no
permission policy, no origin isolation. Its own handoff called those "a deployment concern" - and this
STEP is that sentence being taken back, because the platform targets two hosts and a header that depends
on which one is running is a header that will differ between them.

"Every response" is the part that changed the architecture. STEP 059's matcher skipped
`_next/static`, `_next/image`, the favicon and a list of extensions, so a static chunk carried nothing.
The matcher now skips only the development hot reload socket.

## Sub-steps, in order

1. **Read the contract** - line 784, the ownership rules at line 45 of the same plan (STEPs 056-067 own
   `lib/security/`; `next.config.mjs` belongs to the foundation STEPs), rule 11, STEP 059's handoff,
   `proxy.ts` and `next.config.mjs`.
2. **Owned paths** - one new module, three edited files, one README; listed in
   `docs/planning/STEP_060_SUBSTEP_BREAKDOWN.md`.
3. **Database** - none.
4. **Core logic** - `lib/security/headers.ts`, and the asset path rule in `lib/security/csp.ts`.
5. **Routes and jobs** - `proxy.ts` writes the table on every response; no handler changes.
6. **UI** - no screen changes; verified by serving the app in both modes (below).
7. **Security proof** - 126 new checks and seven mutation controls.
8. **Gates, commit, push** - recorded below.

## Database - none

Nothing is stored. No migration, no rollback to prove.

## The table

`lib/security/headers.ts` (245 lines, **imports nothing**):

| Header | Document | Asset | Production only | What it stops |
| --- | --- | --- | --- | --- |
| `x-content-type-options: nosniff` | yes | yes | no | a `.txt` treated as a document, a document treated as a script |
| `referrer-policy: no-referrer` | yes | no | no | a token in `/i/<token>` or `/e/<token>` leaking as a `Referer` |
| `permissions-policy: ...=()` | yes | no | no | a camera, microphone, location, payment sheet or sensor no code asks for |
| `cross-origin-opener-policy: same-origin` | yes | no | no | a hostile page holding a window handle into this one |
| `cross-origin-resource-policy: same-origin` | yes | yes | no | another site embedding this platform's files |
| `x-dns-prefetch-control: off` | yes | no | no | a host name resolved - and leaked - before a click |
| `x-permitted-cross-domain-policies: none` | yes | no | no | a cross-domain policy file nobody meant to serve |
| `strict-transport-security: max-age=63072000; includeSubDomains` | yes | no | yes | a downgrade to plain http, for two years and every subdomain |
| `x-frame-options: DENY` | yes | no | yes | framing, in the browser family that does not read `frame-ancestors` |

Exported: `SECURITY_HEADERS` (frozen), `SECURITY_HEADER_NAMES`, `headersFor({ development, scope })`
(frozen and deterministic), `isSecurityHeaderName(name)`.

`lib/security/csp.ts` gained `FRAMEWORK_ASSET_PREFIXES` (`/_next/static/`, `/_next/image`) and
`isFrameworkAssetPath(pathname)`: the one question the proxy asks to decide whether a response is a
document.

## The proxy

```ts
const asset = isFrameworkAssetPath(request.nextUrl.pathname);

// No header in the asset scope is production only, so a static file does not read the configuration.
const development = asset ? false : getServerConfig().isDevelopment;

const requestHeaders = new Headers(request.headers);
let nonce: string | null = null;
let policy: string | null = null;

if (!asset) {
  nonce = createCspNonce();
  policy = buildContentSecurityPolicy({ nonce, development });
  requestHeaders.set(CSP_HEADER_NAME, policy);
  requestHeaders.set(CSP_NONCE_HEADER_NAME, nonce);
}

const response = NextResponse.next({ request: { headers: requestHeaders } });

for (const header of headersFor({ development, scope: asset ? "asset" : "document" })) {
  response.headers.set(header.name, header.value);
}
```

and the matcher is now `["/((?!_next/webpack-hmr).*)"]` - everything but the hot reload socket, which is
a websocket upgrade rather than a response. The cost is one function call per asset; the gain is a
header set that cannot be bypassed by asking for a file instead of a page.

The proxy still reads no body, writes no cookie and never asks who the caller is.

## A defect found by serving it, and the rule it produced

The first version classified a request as a static file **by extension**. `/missing.css` does not exist,
so the framework answers it with the application's own 404 page - a rendered document whose script tags
need a nonce, which the proxy had skipped because the path looked like a file. `app/layout.tsx` refuses
to render without a nonce, so the response was a **500**.

Serving the app found it (`/missing.css` and `/missing.png` returned 500; the server log showed the
layout's own error). The rule is now the one in the code: only `/_next/static/` and `/_next/image` are
build output, because those are the paths the framework serves as files; everything else is a document
and pays one nonce for the guarantee that a page can never be rendered without a policy. After the fix
both paths answer `404` with a policy and the document header set.

## Security proof - `checkSecurityHeaders()` + `checkSecurityHeaderWiring()`, 126 checks

The table: frozen; unique names; lower case kebab-case; printable ASCII only; no `\r`, `\n`, NUL or
wildcard in any value; every header has a scope the module knows; at most 512 bytes per value.

The answers: the exact ordered list for a production document (nine) and a development one (seven,
`strict-transport-security` and `x-frame-options` absent, everything else byte for byte the same); the
asset scope is exactly `x-content-type-options` and `cross-origin-resource-policy` in both environments,
proving the proxy's environment shortcut cannot change an answer; every asset header appears in the
document set with the same value; two calls give the same answer; the returned arrays are frozen.

The values: `nosniff`, `no-referrer`, `same-origin` for both origin policies, `off`, `none`, `DENY`,
`max-age=63072000; includeSubDomains` **without** `preload`, and a permission list that denies camera,
microphone, geolocation, payment, USB, display capture, serial and HID with no `*`.

The wiring: `headers.ts` imports nothing and reads no environment; the proxy resolves the scope, writes
each header in a loop, matches every response but `_next/webpack-hmr`, and reads the configuration only
where the environment can change an answer; `next.config.mjs` has no header table of its own and still
sets `poweredByHeader: false`; and a tree scan proves no module outside `headers.ts` names a security
header.

## Mutation controls

| Mutation | Failed on |
| --- | --- |
| HSTS removed from the table | "a production document carries exactly these headers, in this order" |
| `referrer-policy` relaxed to `unsafe-url` | "and never refers another origin to a tokenised URL" |
| `x-frame-options` sent in development | "and never refuses to be framed, because the preview embeds it" |
| the proxy writes no header | "the proxy resolves the scope of the response" |
| `camera` granted in `permissions-policy` | "the browser feature camera is denied to every origin" |
| the matcher excludes assets again | "it runs for every response, including a static file" |
| a second header table in `next.config.mjs` | "next.config.mjs carries no second header table" |

## Behaviour, verified against a running server

**Development** (`npm run dev`, Next 16.4.3): `/signin`, `/api/health`, `/nope`, `/missing.css`,
`/missing.png`, `/sessions`, `/office/sessions`, `/2fa/settings` all carry the seven document headers and
a nonced policy; the four that are pages render `200` and the missing ones `404`; a 502 error envelope
carries the headers too; a `_next/static` chunk carries exactly `cross-origin-resource-policy` and
`x-content-type-options` and no policy.

**Production** (`next build` + `next start`): the document set plus
`strict-transport-security: max-age=63072000; includeSubDomains` and `x-frame-options: DENY`, a policy
without `'unsafe-eval'`, and the same two headers on the chunk.

## Gates

`npm run verify` exit **0**: structure 17 directories / **14 root files** / **170 source files** (one
new), config 10 sections/28 values, i18n 294 messages, logger 117, errors 202/15 codes, lint 77, shell
237, jobs 110, migrations 2 746/92/75, `tsc --noEmit` clean, `next lint` clean, `next build` clean.

`node lib/security/verify.ts` passes **477 checks** (351 before this STEP).
`node lib/auth/verify.ts` passes **2 385 checks**, unchanged.

## Deliberately not done

- **No second header table in `next.config.mjs`.** That file belongs to the foundation STEPs, and two
  tables are two answers; the gate fails if a `headers` key ever appears there.
- **No `cross-origin-embedder-policy: require-corp`.** It would force every subresource to opt in with
  CORP, and the capability it unlocks (`SharedArrayBuffer`) is used by nothing here.
- **No `origin-agent-cluster: ?1`.** The process grouping it buys duplicates what Site Isolation already
  does for this deployment.
- **No HSTS `preload`.** Preloading is a domain-wide, effectively irreversible commitment; it belongs to
  the deployment STEPs (244-250), not to a header a security STEP switches on.
- **No `Content-Security-Policy-Report-Only` and no report collector.** STEP 059 said why: a collector is
  a public `POST` that browsers send without a CSRF token, which the rule of STEP 057 does not allow.
- **No audit entry, no permission check, no RLS change.** A header is written before identity is known
  and has no subject to audit; every route keeps the checks it already had.
- **No change to `lib/auth/`.** The headers apply to a response whatever it carries, so no auth path was
  touched and the auth gate stays at 2 385 checks.

## Next

The security library set of `lib/security/` is complete for the surface this platform has today: text and
rich text (056), CSRF (057), SSRF (058), the policy (059) and the headers (060). STEP 061 continues the
security STEPs 056-067 block. The seams this STEP leaves: any new response goes through `proxy.ts`, so a
STEP that adds a route gets the headers for free; and a STEP that needs a browser feature
(`permissions-policy`), a cross-origin partner (`cross-origin-resource-policy`) or a frame
(`x-frame-options` / `frame-ancestors`) must change the table in `lib/security/headers.ts` and say why in
its handoff.
