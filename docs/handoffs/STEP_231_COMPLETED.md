# STEP 231 — Public layout with header, footer and SEO structure

Status: **complete**. Commit `STEP 231: Public layout with header, footer and SEO structure` (`1c9be55`), then this
handoff, on `arena/ca936761-kd-solution-it`, branched from STEP 202's `4b5fa6b`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **74 gate lines**, and this STEP's gate is `components/public/verify.ts` at
**162 checks**, mutation-checked with **34 mutations, 34 caught**.

## STEP

From `docs/final/STEP_PLAN_250.md:2935`:

> **STEP 231: Public layout with header, footer and SEO structure**

FEATURE_LIST §25 (`:264`), the sentences this STEP owns: *"SEO metadata and sitemap are generated for public pages"*
and the partner naming line. The pages themselves are STEPs 232-237; the CMS that edits them is 238.

## Order, and the one conflict this STEP carries

MASTER_PROMPT's working method says steps run in numeric order and that a later category may start only when the
earlier category's handoffs exist. **STEPs 203-230 have no handoff in this tree** - the categories between the API
STEPs and the public website (plans, billing, email, support, status) are absent - so this STEP was implemented
against the instruction that named it, and the gap is recorded here rather than smoothed over. STEP 231 depends on
none of those steps: it reads no merchant, payment or identity data, and the only thing it shares with the missing
`app/(public)/status/` route is the group.

The other conflict is technical and has one resolution: `/` cannot have two owners. The foundation's placeholder
`app/page.tsx` moved to `app/(public)/page.tsx`, unchanged apart from its height, so that the public shell has the
one page the product already had and STEP 232 replaces that page's content rather than its route. One comment in
`app/layout.tsx` naming the old path was updated in the same commit - a comment line, no behaviour.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `app/(public)/layout.tsx` | new | 83 | The shell: `generateMetadata` (metadata base and title template from the validated environment), the nonce check, the header, the content, the footer and the two structured data blocks |
| `app/(public)/page.tsx` | **moved** from `app/page.tsx` | 72 | The home page inside the shell - the foundation's copy, `flex-1` instead of a viewport height, metadata through the shared builder |
| `app/(public)/sitemap.ts` | new | 22 | `GET /sitemap.xml`, one absolute URL per published page |
| `app/robots.ts` | new | 29 | `GET /robots.txt` - at the app root, because the framework collects a robots file only from there |
| `components/public/site.ts` | new | 154 | The route table: one entry per published page, the header filter, the footer columns, the sitemap rows |
| `components/public/seo.ts` | new | 419 | The metadata builder, canonical path validation, the site address, the JSON-LD builders and serialiser, the crawler rules, the sitemap rows as URLs |
| `components/public/public-header.tsx` | new | 92 | The site header: a labelled navigation from the table, and the two account actions |
| `components/public/public-footer.tsx` | new | 105 | The footer: the brand statement, section 25's partner naming, the copyright line and the columns that exist |
| `components/public/structured-data.tsx` | new | 59 | The JSON-LD blocks, written as script children with the response's nonce |
| `components/public/verify.ts` | new | 726 | The gate, 162 checks, over the table, the tree, the metadata, the serialiser and the crawler rules |
| `app/(public)/README.md` | edited | 26 | What the group holds now, and where `robots.txt` comes from |
| `lib/i18n/strings/en.ts` | edited | +25 | The `publicSite` group: nav label, sign in, create account, partner naming, copyright, legal note, three footer headings |
| `package.json` | edited | +1 link | `check:public-site`, one link in the `verify` chain |
| `migrations/` | **untouched** | - | Nothing in this STEP stores anything |

## The table, and why the site starts with one page

**One list, three readers.** The header, the footer and the sitemap all answer "which pages exist", and they must
answer it identically. `PUBLIC_ROUTES` is that answer once, and the gate resolves each entry to a `page.tsx` under
`app/(public)/` **and** each page back to an entry. A page added without an entry is an orphan nobody links to; an
entry without a page is a 404 in the navigation. STEPs 232-237 each add their entry in the same commit as their page,
which is the same contract `components/office/navigation.ts` already enforces for the office sidebar.

The honest consequence is that the site has one link today: `Home`, because `Home` is the only public page that
exists. A nav item is a promise that something is behind it, and this STEP does not make promises it cannot keep.

## Metadata, in one paragraph

**Three facts in, a complete head out.** `buildPublicMetadata({ title, description, path })` returns the title, the
description, the canonical, the open graph block, the twitter card and the robots directives for one page; the plain
page, the home page that opts out of the title template (`absoluteTitle`, so the site's name is not appended to
itself), the article with its two dates, and the no-index page are four shapes the gate walks. The site's address is
set once, in the layout's `generateMetadata`, from `getServerConfig().appUrl` - **not from the `Host` header** - so a
request through a proxy or to an attacker's host cannot change the canonical a page publishes. `canonicalPathOf`
refuses an absolute URL, a protocol relative path, a query, a fragment, whitespace, a capital letter, a non-ASCII
character, a trailing slash and an over-long path, and each refusal names its own reason, which the gate pins
sentence by sentence.

## Structured data, and the one rule it had to obey

Two blocks - `Organization` and `WebSite` - carrying only what the platform actually holds: name, description,
address, language, publisher. No address, telephone number or tax id is invented, because false structured data is a
manual action and somebody ringing a number that is not ours.

`serializeStructuredData` escapes `<`, `>`, `&`, `\u2028` and `\u2029` into JSON unicode escapes, so a value carrying
`</script>` cannot close the block it is written into; the gate serialises such a value, parses it back and compares
the object, and asserts the string contains no angle bracket at all.

The first draft wrote the block through `dangerouslySetInnerHTML`. `lib/security/verify.ts` (STEP 056) allows exactly
**one** module to write markup from a string - the root layout's pre-paint theme script - and it said so immediately.
The block is now an ordinary script **child**: React writes a script element's content verbatim (proved with a
`renderToStaticMarkup` probe and again against the running server), which is exactly what a JSON-LD block needs, and
the escape in the serialiser is what keeps that verbatim write safe. The gate now asserts the component does **not**
carry `dangerouslySetInnerHTML` and **does** call the serialiser at the point each block is written.

## The crawler rules, computed from the tree

`robots.txt` may not read the filesystem at request time, so `PRIVATE_URL_PREFIXES` is a constant - 33 first path
segments: the office, the dashboard, the tokenised client portal (`/i`, `/e`, `/p`), the API, the auth screens and
every other non-public surface. The gate **recomputes that set from `app/`** on every run and fails when the two
disagree, in either direction, so a STEP that adds a screen cannot leave it indexable and a removed screen cannot
leave a stale rule. It also refuses any public route that starts with a disallowed prefix - a page the robots file
closes can never be indexed - and asserts the portal prefixes are in the list by name, because one indexed token URL
is a client's payment page in a search result.

## What the gate proves (10 sections, 162 checks)

| Section | What it pins |
| --- | --- |
| 1 | The table and the tree are the same set, in both directions; no path or id twice; every path canonical; every priority a crawlable number; a home page exists; and the seam - the home page is in the group and `app/page.tsx` is gone |
| 2 | Navigation: the header filter honours its own flag (proved on a three-row synthetic table, not on the one row that exists), the order is the table's, and every footer column that is rendered holds a page, with every footer-bound route in exactly one column |
| 3 | The catalog: every label, title and description resolves; the shell's six sentences resolve; section 25's partner naming carries both of its halves; the copyright sentence still needs its year |
| 4 | Thirteen refused canonical paths, each with the reason it must give, plus a traversal refused whichever guard catches it, and four paths that must come back unchanged |
| 5 | The site address: plain, with a path, trailing slash stripped, joined once - and four refusals (not a URL, not http, a query, a fragment) |
| 6 | The metadata block for all four shapes: the plain page, the home page's absolute title, the article's two dates, the no-index page, plus "a key is absent rather than undefined" and the layout's metadata base and title template |
| 7 | Structured data: both blocks' types and addresses, the organisation inventing no telephone, and the serialiser escaping `<`, `&` and `\u2028` while every payload parses back to the object it came from |
| 8 | The crawler rules: the declared prefixes equal the tree's, seven of them named, no public page shadowed, `Allow: /`, 33 `Disallow` lines, and the sitemap line |
| 9 | The sitemap: one row per page, absolute, no query, no fragment, never a private surface, the table's order, and no invented `lastModified` |
| 10 | The shell's source: the layout renders header, footer and structured data, reads and refuses a missing nonce, renders no main landmark; the header does not repeat the brand or the theme control; the footer carries the partner line; the block carries the nonce and the serialiser; and both machine routes render per request |

### The mutations

Thirty-four, each restored immediately, all caught: a table entry no page serves; a page with no table entry; the
foundation placeholder restored at `app/page.tsx`; a protocol relative path; a trailing slash; a query; whitespace; a
capital letter; a non-ASCII character; the length ceiling; angle brackets no longer escaped; the ampersand no longer
escaped; the API prefix left indexable; the token portal prefix left indexable; a stale prefix nobody serves; the
sitemap line pointing at the wrong file; the open graph locale drifting; a public page no-index by default; the home
page losing its absolute title; the title template dropping the site name; the organisation inventing a telephone
number; the sitemap dropping its absolute URLs; a `lastModified` in the table's rows; a `lastModified` in the
sitemap's rows; the sitemap dropping a page; the header ignoring its own flag; the footer keeping an empty column;
the footer putting every page in one column; two pages sharing a path; the layout dropping the footer; the header
repeating the theme control; the block losing its nonce; the block serialised without the serialiser; raw markup
reintroduced for the block; a second main landmark on the home page.

**Two findings are written down rather than hidden.**

- Three of the path guards were first indistinguishable from the pattern that follows them: `//evil.example`,
  `/pricing/` and `/pricing/../admin` all fail the "lowercase letters, digits, hyphens and slashes" pattern, so
  deleting the explicit checks changed no answer. The gate now pins **the reason each path is refused**, which keeps
  every branch alive and named, and the unreachable `.`/`..` loop was **removed** rather than left as decoration:
  the pattern is the guard that carries traversal.
- The mutation "the block serialised without the escaping serialiser" was missed on the first pass, because the gate
  checked that the component *imported* the serialiser rather than that it *called* it where the block is written.
  The check now matches the call site.

## Security

- **No new write path from a string.** The platform still has exactly one module that builds markup from a string,
  and it is the theme script. The JSON-LD block is a text child, so React's own escaping is in force, and the
  serialiser's unicode escapes are what make the raw-text script element safe.
- **The nonce is required, twice.** The root layout refuses a request without one; the public layout keeps the same
  check rather than assume the order of two files that do not import each other, and the block carries the
  response's nonce so a `script-src` policy does not block it.
- **The canonical cannot be pointed at another host.** Paths are validated and the base comes from the validated
  environment, never from the request.
- **The token portal is closed to crawlers** by name, and the gate keeps the whole private list equal to the tree.
- **No data of any kind is read.** The group reads no merchant, payment or identity row; the only dynamic input is
  the response's nonce and the site's configured address.
- **Nothing user supplied is rendered.** Every string on the page comes from the catalog, and the one interpolated
  value (the year) is a number.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean - `/`, `/robots.txt`, `/sitemap.xml` listed as dynamic routes
npm run check:public-site         162 checks
npm run verify                    exit 0, 74 gate lines
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables (unchanged: no migration)
node lib/i18n/verify.ts           3228 messages, 343 placeholders (25 messages and one placeholder added)
node scripts/verify-structure.mjs 781 source files (nine new or moved)
node scripts/verify-audit.mjs     4429 checks
```

The pre-existing red set is unchanged and was not absorbed - and the security gate was watched during this STEP
precisely because the first draft tripped it: `lib/auth/verify.ts` 1 (`auth/device-proof-store`),
`lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3404 with the placeholder environment STEP 199 recorded (plus `SUPABASE_SERVICE_ROLE_KEY`,
which production boot requires).

| Request | Answer |
| --- | --- |
| `GET /` | `200`; `<header>` twice (the root bar and the site header), `<footer>` once, `nav aria-label="Primary"` with `Home`, `Sign in` → `/signin`, `Create account` → `/signup`, section 25's partner line, `Copyright 2026 KD Solution IT. All rights reserved.` |
| `GET /` head | `<title>KD Solution IT</title>` (not doubled), `<link rel="canonical" href="http://localhost:3404">`, `robots: index, follow, max-video-preview:-1, max-image-preview:large, max-snippet:-1`, `og:type website`, `og:site_name`, `og:locale en_US`, `twitter:card summary_large_image` |
| `GET /` structured data | two `<script type="application/ld+json">` blocks - `Organization` and `WebSite` - each carrying the response's nonce and each parsing as JSON from the served HTML |
| `GET /robots.txt` | `200`; `User-Agent: *`, `Allow: /`, **33** `Disallow` lines (`/2fa` first, `/verify` last), `Sitemap: http://localhost:3404/sitemap.xml` |
| `GET /sitemap.xml` | `200`; one `<url>` - `<loc>http://localhost:3404/</loc>`, `weekly`, priority `1` |
| `GET /signin` | `200`, unchanged by the move of `/` |
| `next build` | `/`, `/robots.txt`, `/sitemap.xml` in the route table |

`.env.local` was deleted afterwards (checked: absent) and the server was killed by pid.

**Desktop and mobile widths** - one DOM for every width. The header is a flex row that wraps at any size, so at
360 px the navigation and the two actions sit on separate lines instead of pushing each other off the screen, and
from the small breakpoint they share a row. The footer is one column below `sm` and two from `sm`, with the legal
line under a rule; the page section is a single centred column with `p-6` at a phone and `p-8` from `sm`. Every
colour is a semantic token (`background`, `surface`, `foreground`, `muted-foreground`, `primary`,
`primary-foreground`, `border`), so both themes come from `styles/tokens.css` with no conditional class - the shell
gate refuses a colour literal anywhere under `components/`. Every link is a real anchor with a `focus-visible` ring,
and there is no client JavaScript in this STEP at all, so keyboard navigation is the browser's own tab order: root
skip link → brand → theme → site navigation → actions → the page → the footer.

## Carried gaps (named rather than hidden)

1. **Public pages are rendered per request.** The root layout needs a per-response nonce for the pre-paint theme
   script, which makes everything beneath it dynamic; the sitemap and robots handlers declare `force-dynamic` for the
   same reason. §28 asks for cached public pages, and the caching step is the one that has to move that nonce out of
   the document. Nothing in this STEP can fix it without editing the root layout's security decision.
2. **The home page's copy is still the foundation's.** STEP 232 builds the home page from CMS content; this STEP only
   moved the route so the shell has a page, and the metadata it publishes is the brand's own description.
3. **The navigation has one item, and the footer has no columns.** Both grow one page per STEP, in the commit that
   adds the page, because the gate refuses the other order.
4. **No open graph image.** A card without an image is better than an `og:image` pointing at an asset that does not
   exist; the builder takes one the moment STEP 232 or 238 publishes a real illustration.
5. **`app/robots.ts` sits outside the group.** Next collects a robots file only from the root of the app directory -
   a `robots.ts` inside `app/(public)/` compiles to nothing, which the first build proved. The rules it serves are
   `components/public/seo.ts`'s, so the ownership of the behaviour is still this category's; only the two lines of
   handler live at the root.
6. **`app/page.tsx` was moved, and one comment in `app/layout.tsx` follows it.** A foundation file was touched for two
   lines because `/` cannot have two owners and a comment naming a path that no longer exists is drift. Nothing else
   in the root layout changed.
7. **The sitemap carries no `lastModified`.** A date that is "now" on every request is a date a crawler learns to
   ignore; real dates arrive with the CMS's publish control in STEP 238.
8. **STEPs 203-230 are absent from this tree.** The plan's order rule is therefore broken by the instruction that
   named STEP 231, and the missing categories (billing, email, support, status) are recorded here rather than
   pretended away. The shell does not depend on them, but `app/(public)/status/` - STEP 230 - will arrive inside a
   group whose layout, table and crawler rules are already built, and its author must add a table entry or the gate
   will refuse the page.
