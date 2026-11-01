// path: lib/security/README.md
# lib/security/

Owner: STEP 056 (input sanitiser for text, rich text and URLs). Later STEPs call these functions;
they do not write a second escape, a second URL check or a second allowlist.

| File | Purpose |
| --- | --- |
| text.ts | Unicode normalisation, unsafe-character removal, length ceilings, `escapeHtml`, file names, slugs |
| host.ts | Which IPv4, IPv6 and named hosts a server-side request may reach - the SSRF rule |
| url.ts | `sanitizeHttpUrl`, `sanitizeRelativePath`, `isSafeRedirect` and the throwing wrappers |
| html.ts | The rich text allowlist: tokenise, filter, **rebuild**, escape |
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

## The SSRF rule has two halves

`host.ts` decides from the string: an IP literal outside the public ranges, or a name under a private
suffix, or a single-label name, is refused. That is the half that is decidable before a connection.

The half it cannot decide is DNS: a public name can resolve to `10.0.0.5`. **A caller that actually
opens a connection must resolve the host first and pass the resolved address to `isPublicAddress`
before dialling**, and must not follow a redirect to a host it has not checked. Any STEP that adds an
outbound call to a URL a merchant supplied - webhooks, a KYC document link, a return URL - owns that
second check; this module cannot do it from the string alone, and pretending otherwise is how SSRF
gets through a library that looks complete.

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
- **No CSRF token.** STEP 057 owns it.
