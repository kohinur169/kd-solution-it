// path: lib/security/README.md
# lib/security/

Owner: STEP 056 (input sanitiser for text, rich text and URLs), STEP 057 (the double submit token),
STEP 058 (the destination rule), STEP 059 (the Content Security Policy), STEP 060 (the security headers)
and STEP 061 (the upload validator). Later STEPs call these functions; they do not write a second
escape, a second URL check, a second allowlist, a second CSRF token, a second DNS check, a second policy
header, a second header table or a second file type check.

| File | Purpose |
| --- | --- |
| text.ts | Unicode normalisation, unsafe-character removal, length ceilings, `escapeHtml`, file names, slugs |
| host.ts | Which IPv4, IPv6 and named hosts a server-side request may reach - the SSRF rule |
| url.ts | `sanitizeHttpUrl`, `sanitizeRelativePath`, `isSafeRedirect` and the throwing wrappers |
| html.ts | The rich text allowlist: tokenise, filter, **rebuild**, escape |
| csrf.ts | The server half of the double submit token: mint, cookie, compare, `requireCsrfToken` |
| csrf-client.ts | The browser half: read the cookie, add the header, ask `/api/auth/csrf` when absent |
| ssrf.ts | The destination rule: the allowlist, the resolver, and the three checks a URL must pass |
| csp.ts | The Content Security Policy: the nonce, the fifteen directives, and what each allowance is for |
| headers.ts | The security headers of every response, in two scopes: a document and a static file |
| upload.ts | What a file must be before it is stored: purpose, size, magic bytes, and the quarantine verdict |
| verify.ts | The gate behind `npm run check:security`, and the attack corpus it runs |

## The four rules

1. **A value is rebuilt, not cleaned.** Rich text is tokenised and printed again from an allowlist, so
   nothing from the input reaches the output verbatim. Every sanitiser that removes things from a
   string has to recognise what it removes, and a browser's parser does not agree with it:
   `<!--<script>-->`, `<img src=x onerror=...>` and `<a href="jav&#x61;script:...">` are the three
   classic disagreements, and all three are in the corpus.
2. **Unicode before anything else.** NFC first, then the null byte, the C0 and C1 controls, the line
   and paragraph separators, the zero-width characters, the bidirectional overrides, the
   non-characters and the deprecated tag block. A string that displays as something other than what
   it is has no place in a payment record.
3. **A refusal has a reason.** `sanitizeHttpUrl` and `sanitizeRelativePath` answer
   `{ ok: false, reason }` with a reason a form can show (`private_host`, `credentials`,
   `traversal`, ...). The `require*` wrappers turn that into `VALIDATION_FAILED` with the field and the
   rule, which is what a route wants.
4. **The library is a pure function of its input.** It reads no environment, no clock and no
   database, and it imports only `lib/errors` (inward). That is what lets the gate call it a thousand
   times without a fixture.

## The SSRF rule has two halves, and both are here

`host.ts` decides from the string: an IP literal outside the public ranges, or a name under a private
suffix, or a single-label name, is refused. That is the half that is decidable before a connection.

The half it cannot decide is DNS: a public name can resolve to `10.0.0.5`. STEP 058 is that half, in
`ssrf.ts`, and its rule has three parts that must all hold:

1. **The string** - `sanitizeHttpUrl` and `host.ts` doing what they already own. No range is listed a
   second time in `ssrf.ts`; the gate asserts that it is not.
2. **The allowlist** - a name that resolves publicly is not thereby a legitimate destination. The
   policy names the hosts one process may reach: the project origin from the environment, the two
   provider endpoints, and whatever a deployment adds. A wildcard, a CIDR, a bare address or a private
   suffix is refused when the policy is *built*, because a policy is code and that is the only moment
   anyone is watching.
3. **The addresses** - the host is resolved and every address it answers with must be public. Every
   one: the runtime picks one of them, and "the first answer was public" says nothing about the second.

The answer is cached for one minute, and the cache holds the addresses rather than the verdict, so a
cached answer is re-judged on every use. A destination that fails is not dialled: `lib/auth/http.ts`
asks the guard before it builds a request, `redirect: "error"` means no hop is followed
unguarded, and the auth gate asserts that a refused URL never reaches `fetch`.

**What is still open** is the window between the lookup and the connection: a rebinding zone can answer
public and connect private. Closing it needs the socket pinned to the checked address, which `fetch`
does not expose without a dispatcher package; it is a package request in the STEP 058 handoff. The
window is narrowed - a one-minute cache means a zone has to change its answer and keep it changed - and
no caller of this transport follows redirects, which removes the hop that made the window famous.

**The one exception** is a development deployment whose project origin is loopback: `allowLoopback` is
true only when the environment is not production and the configured origin is on the machine itself,
which is the same condition `lib/auth/config.ts` already uses for plain http. It does not widen the
allowlist, and in production the sanitiser refuses a loopback host before this file is consulted.

## Why the CSRF module is split in two

`csrf.ts` imports `node:crypto` for a random token and a `timingSafeEqual` comparison. A `"use client"`
module that imported it would pull the Node builtin into a browser bundle, so the browser gets
`csrf-client.ts`, which imports **nothing** - not a type, not a constant, not even for convenience. The
cookie name survives the duplication because both halves agree with a comment and the auth gate
asserts the agreement; an import would be tidier and would break the build.

The token is a second value on purpose. `__Host-kd_session` is `HttpOnly` and `SameSite=Strict`, and a
cross-site form post carries neither - but a same-site subdomain, or a browser that mishandles
`SameSite`, is exactly the gap the header closes: a script on another origin can make the browser send
a cookie, and cannot read a value to put in a header. The cookie is therefore **readable by design**,
and the one place that fact is allowed to look like a mistake is this paragraph.

## The policy is per response, and that decides the rendering mode

`csp.ts` builds one header from one nonce. `proxy.ts` (the Next 16 name for middleware) mints the nonce
and sets the policy on the **request** as well as the response, because the framework reads the nonce
out of the request header to stamp its own script tags - a response header alone looks right in a
browser and leaves every framework script without a nonce.

That choice has one consequence a reader must know about: a prerendered document is served from the
build and its inline `self.__next_f` bootstrap scripts were written before any nonce existed, so a nonce
policy blocks them, and a build-time hash cannot cover scripts that differ per build. `app/layout.tsx`
therefore declares `force-dynamic`, and the seven routes that were static in STEP 058 are rendered per
request. The alternative - staying static and allowing `'unsafe-inline'` - is a policy that protects
nothing, which is why it is not offered as an option here.

The allowances, each with the reason it exists: `style-src 'unsafe-inline'` because the framework
injects critical CSS and an inline style cannot execute script; `'self'` in `script-src` as the fallback
for a browser without `'strict-dynamic'`; `data:` and `blob:` in `img-src` for the same framework
reason; `ws:`/`wss:` in `connect-src` and `'unsafe-eval'` in `script-src` for a development server only.
A directive that is not listed falls back to `default-src 'self'`, which is the point of listing
`default-src` last.

`frame-ancestors 'none'` is sent in production and **not** in development, where the platform is
embedded in a preview frame: a policy that blocks the frame the work is reviewed in gets switched off,
and a switched-off policy is worse than a documented exception.

## The headers of every response

`headers.ts` is a table, not a function: nine headers, each with the sentence that explains why it is
there, and each tagged with the scopes it belongs on. `proxy.ts` writes them on every response it sees -
a page, a route handler, a 404, a redirect, a static chunk - and `headersFor({ development, scope })`
answers the subset that matters for that kind of response.

| Header | Document | Asset | What it stops |
| --- | --- | --- | --- |
| `x-content-type-options: nosniff` | yes | yes | a browser treating an uploaded `.txt` as a document, or a document as a script |
| `referrer-policy: no-referrer` | yes | no | a token in `/i/<token>` or `/e/<token>` travelling to the next origin as a `Referer` |
| `permissions-policy: ...=()` | yes | no | a sensor, camera, location or payment sheet that no code on the platform asks for |
| `cross-origin-opener-policy: same-origin` | yes | no | a hostile page holding a window handle into this one |
| `cross-origin-resource-policy: same-origin` | yes | yes | another site embedding any of this platform's files |
| `x-dns-prefetch-control: off` | yes | no | a host name resolved before a click, and therefore leaked |
| `x-permitted-cross-domain-policies: none` | yes | no | a cross-domain policy file nobody meant to serve |
| `strict-transport-security` | production | no | a downgrade to plain http, for two years and every subdomain |
| `x-frame-options: DENY` | production | no | framing, in the one browser family that does not read `frame-ancestors` |

Two of them are production only, for reasons that are not obvious: a development server speaks plain
http on loopback, so an HSTS header would poison `localhost` for every other project on the machine;
and a development deployment is embedded in a preview frame, so refusing to be framed would break the
window the work is reviewed in. The gate asserts both omissions.

`cross-origin-embedder-policy: require-corp` is deliberately absent: it would force every subresource to
opt in with CORP, and the one capability it unlocks (`SharedArrayBuffer`) is used by nothing here.

### Why the asset test is a prefix and not a file extension

The first version of STEP 060 classified a request as a static file by its extension, which is the
obvious rule and the wrong one: `/missing.css` does not exist, so the framework answers it with the
application's own 404 page - a rendered document whose script tags need a nonce. The proxy had skipped
the nonce because the path looked like a file, `app/layout.tsx` refused to render without one, and the
response was a 500. Serving it is what found it, and the fix is the rule this file now states: only
`/_next/static/` and `/_next/image` are build output, because those are the paths the framework itself
serves as files. Everything else is a document, and pays one nonce for the guarantee that a page can
never be rendered without a policy.

## What a file must be

`upload.ts` answers three questions, in this order, and the second one is the only one that is evidence:

1. **How big is it?** A limit per purpose, every one of them at or under the 50 MB row check of migration
   `0057`. A size is a claim the client makes, so the caller passes the number it counted, not the one
   the request declared.
2. **What is it, really?** The first 32 bytes are compared with the signatures of the four types this
   platform accepts - `%PDF-`, `FF D8 FF`, the eight byte PNG signature, and `RIFF` plus `WEBP` at
   offset eight. The `Content-Type` header a browser sends is a claim: a POST can say `image/png` and
   send HTML, and a handler that stores the claim and serves it back is a stored XSS with a download
   button.
3. **Do the claim and the evidence agree?** They must, and when they do not the answer is **quarantine**,
   not refusal: the object becomes a row with a hash, `magic_byte_verified = false` and a reason an
   operator reads, because "this merchant sent a file that lied about its type" is evidence a refusal
   throws away. A refusal is reserved for what never deserved a row: an empty file, a size over the
   purpose limit, a missing or unacceptable type.

Two types are refused on purpose. **`image/svg+xml`** because an SVG is a document that can carry
`<script>`, an external reference or a font, and this repository has no SVG sanitiser - the rich text
allowlist of `html.ts` is a different job. **ZIP containers** (`application/zip`, the OOXML formats)
because a container needs an extractor with its own bomb, traversal and macro rules, and none of the five
purposes of section 21 needs one.

The module reads bytes a route already has. It does not encrypt (section 21 puts AES-256-GCM before the
upload, owned by the storage STEPs 100-105), it does not store, and it does not sign a URL. The rule it
leaves for whoever serves a stored file: **send `content-disposition: attachment` and keep `nosniff`** -
a browser rendering a quarantined PDF inline is the one thing a magic byte check cannot prevent alone.

## Ceilings

| Value | Ceiling | Why |
| --- | --- | --- |
| Name, title, subject | 200 code points | one line in a table and one line in a mail |
| Note, description | 4 000 code points | a support reply, not a document |
| Header value | 200 code points | a subject line, after the CR/LF are gone |
| File name | 120 code points | what every file system and every upload form agrees on |
| Slug | 80 code points | a URL segment that stays readable in a log |
| Rich text | 100 000 code points, 5 000 nodes, depth 20 | a document, bounded in size and in nesting |
| URL | 2 048 code points | the length a browser and a proxy both handle |

Ceilings count **code points**, not UTF-16 units, so an emoji costs one and a limit means the same
number of characters in every script.

## What is deliberately not here

- **No SQL escaping.** Every query in this platform goes through PostgREST with values in the query
  string or the body, and identifiers are never built from input. An "escape for SQL" function would
  be a temptation to interpolate.
- **No HTML escaping on the way in.** `escapeHtml` exists for the moment of output; storing escaped
  text is how a database ends up holding `O&#39;Brien`.
- **No browser sanitiser.** The stack names DOMPurify for client-side rich text preview. That is a
  package request in the STEP 056 handoff, because `package.json` is not a STEP's to edit.
- **No CSRF token in `text.ts`.** A token is not text that a user typed; it is 32 random bytes with a
  comparison rule, and it lives in `csrf.ts` beside the cookie policy it has to agree with.
- **No nonce or header in `proxy.ts` for anything but the policy.** A proxy runs on every request,
  including the ones that must stay cheap; identity, redirects and body handling are the routes' work,
  and a security header is the whole of the proxy's job.
- **No CSP reporting endpoint.** A `report-uri` is useful only with a collector, and a collector is a
  public `POST` that browsers send without a CSRF token - the one route that would have to be exempt
  from the rule of STEP 057. It belongs to the logging pipeline, with its rate limit and its retention,
  not to the STEP that writes the policy.
