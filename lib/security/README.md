// path: lib/security/README.md
# lib/security/

Owner: STEP 056 (input sanitiser for text, rich text and URLs), STEP 057 (the double submit token)
and STEP 058 (the destination rule). Later STEPs call these functions; they do not write a second
escape, a second URL check, a second allowlist, a second CSRF token or a second DNS check.

| File | Purpose |
| --- | --- |
| text.ts | Unicode normalisation, unsafe-character removal, length ceilings, `escapeHtml`, file names, slugs |
| host.ts | Which IPv4, IPv6 and named hosts a server-side request may reach - the SSRF rule |
| url.ts | `sanitizeHttpUrl`, `sanitizeRelativePath`, `isSafeRedirect` and the throwing wrappers |
| html.ts | The rich text allowlist: tokenise, filter, **rebuild**, escape |
| csrf.ts | The server half of the double submit token: mint, cookie, compare, `requireCsrfToken` |
| csrf-client.ts | The browser half: read the cookie, add the header, ask `/api/auth/csrf` when absent |
| ssrf.ts | The destination rule: the allowlist, the resolver, and the three checks a URL must pass |
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
