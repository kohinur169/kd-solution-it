// path: docs/handoffs/STEP_056_COMPLETED.md
# STEP 056 completed - Input sanitizer library for text, rich text and URLs

Branch `arena/1dc51ec3-kd-solution-it`, base `8954137` (STEP 055).
Source: `docs/final/STEP_PLAN_250.md` line 740; `docs/final/FEATURE_LIST.md` line 12 ("Sanitization for
every input: XSS, SQL injection, CSRF, SSRF, header injection, null byte, path traversal, Unicode
normalization") and `docs/final/MASTER_PROMPT.md` rule 11.

## What the STEP asks for

One line of the feature list names seven attacks, and by STEP 055 the platform answered them in
forty different places: zod `.trim()` here, a column check there, a bound user agent in `0011`, a
disclosure table for error codes. Each answer was defensible and none of them was *the* answer, so
"is this string safe" depended on which file was asked - and the eighth STEP to need an answer would
have written an eighth version.

## Sub-steps, in order

1. **Read the contract** - line 12 of the feature list, rules 10-11 and the stack line of the master
   prompt, `lib/README.md` and `lib/errors/README.md` (the module shape and the gate convention), the
   STEP 055 handoff's "Next", and the three call sites the library would serve.
2. **Owned paths**, recorded in `docs/planning/STEP_056_SUBSTEP_BREAKDOWN.md` before any code.
3. **Database** - none: see below.
4. **Library** - `lib/security/{text,host,url,html}.ts`.
5. **Wiring** - the signup name and company name, the reset request's reason and the officer's
   document reference and note, the unlock note.
6. **Screens** - not applicable: the library runs on the server and its output is a string the existing
   screens already render as text.
7. **Security proof** - `lib/security/verify.ts` (174 checks), `checkSanitizerWiring()` in
   `lib/auth/verify.ts` (+8), and five mutation controls.
8. **Gates, commit, push, handoff** - this document.

## Database - none

The sanitiser is a pure function of its input: it reads no environment, no clock and no database, and
it writes nothing. A table for it would be a table nobody reads, and a migration here would be the
STEP 053 mistake in a new form - adding structure because the template has a slot for it.

## The library

| File | What it answers |
| --- | --- |
| `text.ts` | Unicode normalisation, unsafe-character removal, length ceilings, `escapeHtml`, `sanitizeHeaderValue`, `sanitizeFileName`, `sanitizeSlug`, `describeTextIssues` |
| `host.ts` | `isPublicAddress`, `isPublicHostname`, `isPublicHost`, `isIpLiteral` - the SSRF rule |
| `url.ts` | `sanitizeHttpUrl`, `requireHttpUrl`, `sanitizeRelativePath`, `requireRelativePath`, `isSafeRedirect` |
| `html.ts` | `sanitizeRichText`, `stripMarkup`, `tokenizeRichText`, `decodeEntities`, `RICH_TEXT_POLICY` |
| `verify.ts` | The gate and its corpus of attack strings |
| `README.md` | The four rules, the ceilings, the two halves of the SSRF rule and what is deliberately absent |

### What each attack from line 12 maps to

| Attack | Where it is answered |
| --- | --- |
| XSS | `html.ts` rebuilds rich text from an allowlist; every text node and attribute is escaped; `escapeHtml` is the one escaper |
| SQL injection | Not by escaping: every query is a PostgREST query with values in the string or the body, and no identifier is built from input. `lib/security/README.md` says why an escape function would be worse than nothing |
| CSRF | STEP 057's, recorded as the next STEP |
| SSRF | `host.ts` refuses every private, loopback, link-local, multicast, documentation and carrier-NAT address, IPv4 and IPv6, plus the private name suffixes and single-label hosts |
| Header injection | `sanitizeHeaderValue` removes CR, LF, the Unicode line separators and every other control |
| Null byte | Removed in text, refused in a URL and in a path |
| Path traversal | `sanitizeRelativePath` decodes once, then refuses `..`, a backslash, a null byte, a scheme and an encoded traversal |
| Unicode normalisation | NFC first, then the bidirectional, zero-width, non-character and tag-block removals that the corpus names |

### Ceilings

Name 200 code points, note 4 000, header 200, file name 120, slug 80, rich text 100 000 with 5 000
nodes and depth 20, URL 2 048. All counted in **code points**, so an emoji costs one and a ceiling
means the same number of characters in every script.

## Wiring

Three call sites, each in a zod schema so no path can skip the sanitiser:

| file | schema | sanitiser |
| --- | --- | --- |
| `lib/auth/registration.ts` | `fullName` | `sanitizeSingleLineText(value, 120)` |
| `lib/auth/registration.ts` | `companyName` | `sanitizeSingleLineText(value, 120)` |
| `lib/auth/two-factor-reset.ts` | reset `reason` | `sanitizeMultilineText(value, 1 000)` |
| `lib/auth/two-factor-reset.ts` | `documentReference` | `sanitizeSingleLineText(value, 200)` |
| `lib/auth/two-factor-reset.ts` | decision `note` | `sanitizeMultilineText(value, 1 000)` |
| `lib/auth/account-unlock.ts` | unlock `note` | `sanitizeMultilineText(value, 280)` |

A transform inside the schema rather than a call beside it is the difference between "every path is
sanitised" and "every path somebody remembered". `checkSanitizerWiring()` asserts both the counts and
the behaviour: a signup whose name carries a null byte and a right-to-left override is parsed to
`Alice`, and an ordinary name comes back unchanged.

## Security proof - `lib/security/verify.ts`, 174 checks

The corpus is the point, so a sample of what it holds:

- **Text:** combining accents composed, null byte removed, CRLF and the Unicode separators turned into
  a space, C0 and C1 removed, the right-to-left override removed (including as the first character),
  zero-width and BOM and soft hyphen removed, the tag block and the non-characters removed, whitespace
  collapsed, the ceiling counted in code points with an emoji as one, `describeTextIssues` naming what
  it found **without echoing the character**, `escapeHtml` escaping all five metacharacters,
  `sanitizeHeaderValue("Subject\r\nBcc: ...")` losing the header, `../../etc/passwd` and
  `C:\Windows\win.ini` becoming one safe file name, `CON.txt` prefixed, an empty name becoming
  `file`.
- **Hosts:** loopback, private, CGNAT, link-local (the metadata address), multicast, reserved,
  documentation, unspecified - both families, plus `::ffff:127.0.0.1` checked as IPv4; and
  `localhost`, `.internal`, `.local`, `metadata.google.internal` and every single-label name refused
  while `api.stripe.com` and a punycode name pass.
- **URLs:** `javascript:` with a leading space and split by a newline, `data:`, `vbscript:`, `file:`,
  protocol-relative, credentials in the URL, the metadata address, an internal name, an unexpected
  port, a backslash, markup, plain `http:` (refused by default and allowed on request), empty,
  whitespace, scheme-only and past the ceiling; and `HTTPS://Example.COM:443/a` canonicalised to one
  value.
- **Paths and redirects:** `..`, `%2e%2e`, half-encoded traversal, `//host`, a backslash, an unrooted
  path, a scheme, `%00`; a rooted path and a same-host absolute URL accepted, another host and any
  script refused.
- **Rich text:** a script dropped with its content, the same inside an SVG, `<img onerror>` dropped,
  event and style attributes dropped, an unknown tag dropped while its content stays, a
  `javascript:` and a metadata `href` losing only the href, a safe link gaining
  `rel="noopener noreferrer nofollow" target="_blank"`, an escaped script staying escaped, an escaped
  query string staying escaped, a quoted `>` not ending a tag, an unterminated comment, the
  `<script>`-inside-`<script>` trick, an unclosed tag closed at the end, a nested link not created,
  nesting bounded at 20 and node count at 5 000, and a doctype dropped.
- **The tree:** one escaping function (`html.ts` imports it from `text.ts`), every link going through
  `url.ts`, `url.ts` asking `host.ts`, and **exactly one** `dangerouslySetInnerHTML` in `app/` and
  `components/` - the static theme script of `app/layout.tsx`, which is asserted to be that and
  nothing else.

### Mutation controls (each breaks at least one check, then is restored)

| control | failing checks |
| --- | --- |
| `fullName`'s transform becomes the identity | "the signup name and company name are sanitised" + "a name is stripped of the null byte and the override" |
| the unlock note drops its transform | "the unlock note is sanitised" |
| `escapeHtml` escapes only `&` | three checks, including "text is always escaped" and "an escaped script stays escaped" |
| the URL sanitiser stops asking `host.ts` | the SSRF checks, including a metadata `href` surviving into a link |
| `script` joins the rich text allowlist | "and a script never is" |

## Gates

`npm run verify` exit **0**: structure **17 directories** (new: `lib/security`) / 164 sources, config
10 sections/28 values, i18n 294 messages/14 placeholders, logger 117, errors 202/15 codes, lint 77,
shell 235, jobs 110, migrations 2746/92/75, `tsc --noEmit` clean, `next lint` clean, `next build`
clean. `node lib/auth/verify.ts` passes **2203 checks** (2195 before this STEP).
`node lib/security/verify.ts` passes **174 checks**.

## Package requests (both recorded here, neither applied)

1. `"check:security": "node lib/security/verify.ts"` inside `verify`, after `check:errors`. Without it
   the corpus runs only when a person runs it, which is the one thing a gate is not for. The existing
   request for `"check:auth"` remains open beside it.
2. `dompurify` for the client-side rich text preview that the CMS STEP of section 24 will own. The
   master prompt's stack names it, `package.json` is not a STEP's to edit, and nothing in this STEP
   needs it: the server never trusts the browser's copy of a document, it sanitises on the way in.

## Deliberately not done

- **No SQL escaping.** Queries carry values in the PostgREST string or body and no identifier is built
  from input; an escape function would be an invitation to interpolate.
- **No escaping on the way in.** Values are stored as written; `escapeHtml` belongs to output.
- **No DNS check.** `host.ts` answers the half that is decidable from the string, and
  `lib/security/README.md` states the second half as a rule for the STEP that opens a connection:
  resolve first, then pass the resolved address to `isPublicAddress`, and do not follow a redirect to
  a host that has not been checked.
- **No screen.** A page that demonstrates a sanitiser is a demonstration, not a feature.
- **No change to `config/app.ts`.** The ceilings are part of the sanitiser's contract, like
  `STEP_UP_WINDOW_MS` is part of 053's; a limit that can be edited on a running platform is not one.

## Next

STEP 057 - CSRF double-submit protection for mutations (`STEP_PLAN_250.md` line 754). The seam this
STEP leaves for it: every state-changing route already reads one header set and one cookie through
`readRequestActor`, which is where the second token will be compared.
