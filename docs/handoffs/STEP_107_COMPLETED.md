// path: docs/handoffs/STEP_107_COMPLETED.md
# STEP 107 - Client paginated list with search: completed

Branch `arena/5fa2593d-kd-solution-it`. This handoff and the STEP 107 code are in one commit, the one
whose message is "STEP 107: Client paginated list with search" (`git log -1` on the branch shows its
hash). Previous handoff: `docs/handoffs/STEP_106_COMPLETED.md`. Second STEP of the Clients, Products,
Invoices and Estimates block (106-126).

## STEP

- **Number and title:** STEP 107 - Client paginated list with search (`docs/final/STEP_PLAN_250.md`,
  line 1358).
- **Category:** Clients, Products, Invoices and Estimates, STEPs 106-126.
- **Owned paths (File Ownership Rules):** "Business STEPs 106-126 own `services/clients/`,
  `services/products/`, `services/invoices/` and invoice components" (line 53), plus the matching
  screens under `app/(dashboard)/` and routes under `app/api/`. This STEP added
  `services/clients/client-list.ts`, `app/(dashboard)/clients/{client-list-table,client-search-form}.tsx`,
  and `app/api/clients/list/route.ts`; it rewrote `app/(dashboard)/clients/page.tsx` (the STEP 106
  hub, owned by this same block), extended `services/clients/verify.ts` (the block's gate),
  `lib/i18n/strings/en.ts` (21 new `clients` messages) and this area's `app/(dashboard)/README.md`.
- **Feature list:** section 15 line 163, "Client create, edit, delete and paginated list" (the
  paginated list half; delete and the CSV import belong to later STEPs of the block), and line 11
  ("Zod validation on client and server for every form and API").
- **Depends on:** STEP 106 (`services/clients/clients.ts`, `client-fields.ts`, the two write routes
  and the client screens) and STEP 020's `migrations/0019_clients.sql` - `clients_page_idx`
  (`(company_id, created_at desc, id desc) where deleted_at is null`) is already exactly the order
  this list reads, so **no migration in this STEP**; the STEP 070-078 office audit-log viewer
  (`lib/audit-log/{registry,service}.ts`, `app/(admin)/audit-log/*`) is the precedent for a
  paginated, filterable, server-rendered read whose refused filter is reported rather than applied.

## What was built

- `services/clients/client-list.ts` - the read of many rows, separate from `clients.ts` (which is
  the read/write of one):
  - `parseClientListQuery` reads `search` and `offset` from the address bar. The term goes through
    `lib/security/text.ts`'s single-line sanitiser first, is then bounded to
    `CLIENT_SEARCH_MAXIMUM_LENGTH` (80) and finally matched against `CLIENT_SEARCH_PATTERN`
    (`^[\p{L}\p{N}\p{M} .'\-_@+]+$` - letters, digits and combining marks of any script, spaces and
    the six punctuation characters names and email addresses are made of). Everything PostgREST
    reads as structure - comma, parenthesis, quote, backslash, colon, asterisk, percent - is therefore
    absent from anything that can reach a filter. A refused term is **reported and dropped**, never
    rewritten: `{field: "search", rule: "invalid_format" | "too_long"}`. The sanitiser runs at a
    ceiling above the rule (200) so an over-long term is refused as `too_long` instead of being
    silently truncated into a different search. `offset` accepts digits only, is clamped to
    `CLIENT_LIST_MAXIMUM_OFFSET` (2 000) and is landed on the page grid, so the position line always
    describes the window that was read; anything else is `{field: "offset", rule: "invalid_format"}`.
  - `clientListQueryOf` builds the PostgREST query as data: eight selected columns (`id, name,
    company_name, email, phone, city, created_at, updated_at` - the notes, the tax identifier and the
    address lines never leave the database for a screen that does not print them), the tenant scope,
    `deleted_at=is.null`, the optional `or=(name.ilike.*term*,company_name.ilike.*term*,
    email.ilike.*term*,phone.ilike.*term*)` with the term `encodeURIComponent`-escaped, then
    `order=created_at.desc,id.desc`, `limit` and `offset` - the order and the tiebreak `clients_page_idx`
    stores.
  - `listClients` applies `CLIENT_MANAGE_ROLES` (the owner, exactly as every write of `clients.ts`),
    takes the company from `requireCompanyId` (never from the query), asks for
    `CLIENT_LIST_PAGE_SIZE + 1` rows so `nextOffset` costs no second count, and answers a
    `ClientListPage` (rows, search, offset, page number, both neighbour offsets, the refused problems,
    the read instant). Every row is validated by `clientListRowSchema` on the way out.
  - 25 clients per page, ten pages of reach. A read writes **no audit entry**: MASTER_PROMPT rule 9
    binds mutations, and `getClient` of STEP 106 made the same decision.
- `app/api/clients/list/route.ts` - `GET` the page over HTTP: reads only `search` and `offset` from
  the URL (anything else in the address bar is ignored), parses through the same
  `parseClientListQuery`, reads the actor from the cookie and answers `no-store`. It is not on
  `CSRF_PROTECTED_PATHS` and must not be: it answers no mutation, so there is no body to forge -
  the auth gate asserts that every path which exports `POST` is on that list, and this one does not.
  A separate route file rather than `GET /api/clients` because `GET` on a collection with a body
  contract would have to share that path with a `POST` that needs a token, and the two would then
  differ only in method.
- `app/(dashboard)/clients/page.tsx` - the hub of STEP 106 becomes section 15's list: search form,
  "Add a client", the table, the pager ("Newer clients" / "Older clients" / "Clients 26 to 50") and
  the refused-filter reports beside the rows. The four states are worded apart (signed out, not an
  owner, unavailable, ready) and the page restates neither the role list nor the tenant scope - it
  calls the service. `force-dynamic`, `<SessionKeeper />`, and the offset report is a separate
  sentence from the search report because they name different inputs.
- `app/(dashboard)/clients/client-search-form.tsx` - a plain `GET` form (no token, no client state, a
  bookmarkable address), `type="search"`, `maxLength` at the module's ceiling, its hint and its
  refusal sentence from the catalog, no hidden `offset` (a new question starts at the newest row),
  and a "Clear search" link that appears only when a search is applied. The form carries no pattern
  of its own: the alphabet lives in the service.
- `app/(dashboard)/clients/client-list-table.tsx` - six columns, `overflow-x-auto` with a
  `min-w-3xl` table so every column stays on one line at phone width and a keyboard user can reach
  the overflow, a missing value printed as "Not set" rather than as an empty cell, UTC instants with
  their suffix, and the name as the one link into the edit screen.
- `services/clients/verify.ts` - the gate grows from 175 to **308 checks**: an in-memory PostgREST
  that now honours `select`, `or=(...)ilike`, `order`, `limit` and `offset` (and refuses a search
  clause set that names different phrases per column, a column outside the four, or a non-substring
  pattern), then paging (page size, newest first, no row on two pages, remainder page, last page has
  no next, clamp and grid, `select`/`order`/`limit`/`offset` in the query, notes and tax id and street
  line absent from it), search (name, company name case insensitively, email with a dot, phone,
  no match, blank term, collapsed whitespace, comma and eight other hostile terms refused and
  reported, ceiling accepted, over-ceiling refused), tenancy (another merchant's book, the same
  phrase not reaching across the tenant, six office roles and a company-less platform account
  refused, a deleted row not findable) and sources (the route is `GET`-only with no token and
  `no-store`, the term is escaped into the filter, the screen restates no role, the form carries no
  pattern, the catalog carries every key the two files use).
- `lib/i18n/strings/en.ts` - 21 new `clients` messages (list and search copy, six column headings,
  the pager, "Not set" and the two refused-filter sentences).
- `app/(dashboard)/README.md` - the `clients/page.tsx` paragraph.

## Database

- **Migrations added: none.** `0019_clients.sql` already carries `clients_page_idx`
  (`(company_id, created_at desc, id desc) where deleted_at is null`), which is the order this list
  reads, and `clients_name_idx` for the name lookup. A new index was considered for the substring
  search and rejected: a `%term%` predicate cannot use a btree prefix (`lower(name)`) and the only
  index that would serve it is a trigram GIN, which needs the `pg_trgm` extension - and rule 9 of
  `migrations/README.md` forbids this folder from creating extensions. The search is therefore a
  scan of one merchant's own live rows, which is bounded by the tenant scope and by the page window.
- **Rollback verified on clean database:** not applicable, no migration was added.

## Environment

- **Environment variables added to .env.example:** none.
- **Secrets handled:** none new; the list reads through the existing `SUPABASE_URL` /
  service role configuration in `lib/auth/config.ts`.

## Packages

- **Package requests for the integrator:** none.

## Behaviour Proof (acceptance checklist)

The behaviours named in the title - a **paginated** client list with **search** - were exercised on
the real stack: the service gate drives the shipped code over the in-memory PostgREST, and a
production build was served on `http://127.0.0.1:3117` on 2026-11-03.

- **Pagination:** 55 clients seeded for one company (`2 * 25 + 5`) plus one client of a second
  merchant and one soft deleted row. Page 1 answers 25 rows, `pageNumber: 1`, `previousOffset: null`,
  `nextOffset: 25`; page 2 answers 25 different rows with `previousOffset: 0` and `nextOffset: 50`;
  page 3 answers the remaining 5 with `nextOffset: null`. No row id appears on two pages, rows come
  back newest first (`created_at desc, id desc`), the second merchant's client and the deleted client
  never appear, and every query built for the page carried `company_id=eq.<actor company>`,
  `deleted_at=is.null`, `select=id,name,company_name,email,phone,city,created_at,updated_at`,
  `order=created_at.desc,id.desc`, `limit=26` and the offset. `offset=30` reads from 25 (the page
  that holds it), `offset=999999999` is clamped to 2000, and `offset=-1` / `offset=2;drop` are refused
  as `invalid_format` with the first page read.
- **Search:** `search=client 05` answers exactly `Client 05`; `search=LAKE VIEW` answers every client
  whose company name is "Lake View Studio" (case insensitive, matched against the company rather
  than the person); `search=client7@example.com` answers one row (the dot of the address survives
  the filter's own separator); `search=1711` answers the whole book because that phone prefix is on
  every seeded row, and each match carries the digits; `search=nobody` answers an empty page with no
  next page; `search=   ` is no search at all and `  Amina  Rahman ` collapses to `Amina Rahman`.
  `search=a,b`, `x*`, `a)`, `(a`, `a"`, `a\`, `a:b`, `a%` and `a(b)` are each refused with
  `{field: "search", rule: "invalid_format"}` and dropped (the list widens to the whole book and says
  so), and an 81-character term is refused as `too_long` while 80 characters is accepted.
- **Tenancy and roles:** the second merchant's page holds only their own one row and a search for
  another tenant's client name answers nothing; `compliance_kyc`, `support`, `finance_ops`, `ceo`,
  `super_admin` and `blogger` are each refused with `PERMISSION_DENIED`, and so is a platform account
  with no company. A soft deleted client is not findable by its name.
- **UI checks:** the two components were rendered through a production build in a temporary probe
  page (since removed, no route shipped for it) at the mobile first layout (`px-4`, stacked form and
  button, `overflow-x-auto` table) and the desktop layout (`sm:px-6 lg:px-8`, `max-w-5xl`, form and
  "Add a client" on one row) - the rendered markup was checked at both breakpoints: six `<th>`
  headings, one row per client, "Not set" in every empty cell, one edit link per name, the hint and
  the refusal sentence under the search field, `maxlength="80"`, and "Clear search" present only
  when a search was applied. Keyboard: every control is a native `form`, `input[type=search]`,
  `button`, `Link` and `table` element, so tab order, Enter-to-submit and the browser's own
  clear-the-field affordance work without script; the focus ring is `focus-visible:ring-primary` on
  the input, both buttons, the pager links and every name link. Light and dark: every colour is a
  semantic token (`bg-background`, `text-foreground`, `text-muted-foreground`, `text-destructive`,
  `border-border`, `bg-muted`, `text-primary`) and `npm run check:shell` proves no literal and no
  palette step exists in the file.
- **API checks** (`GET /api/clients/list?search=amina&offset=25` against the production build):
  unauthorised - `401` with the error envelope and `cache-control: no-store, max-age=0` + the full
  security header set (CSP with a per-response nonce, HSTS, `x-frame-options: DENY`, and the rest of
  STEP 060's set), and no data in the answer. The signed-in success, validation-failure and
  cross-tenant paths are proven above against the same service the route calls, and the screen
  paths (`/clients`, `/clients?search=amina`, `/clients?search=a%2Cb`, `/clients?offset=50`,
  `/clients?offset=abc`, `/clients/new`) each answered `200` signed out with the signed-out sentence
  - the screen never renders the table to a visitor with no session.
- **Money flow ledger proof:** not applicable, no money in this STEP.
- **Provider sandbox cycle:** not applicable, no provider in this STEP.

## Verification

- `node services/clients/verify.ts` -> "clients gate passed: 308 checks, 12 fields, 25 per page,
  table \"clients\"", exit 0.
- `npm run -s typecheck` exit 0.
- `npm run -s lint` exit 0.
- Gates: `check:structure` 348 source files (the handoff itself is a source file), `check:i18n` 1687 messages / 191 placeholders,
  `check:shell` 567 checks / 159 files, `check:migrations` 3261 checks / 111 migrations / 85 tables
  (unchanged), `check:jobs` 110 checks, `check:env` 16 variables - all green.
- `npm run -s build` green; the route table now lists `/clients` (dynamic), `/api/clients`,
  `/api/clients/[id]` and the new `/api/clients/list` - all `ƒ`.
- ASCII and forbidden-marker scans clean on every touched file (the structure gate reads all 348).

## Conflicts and pre-existing failures (recorded, not fixed here)

- `node lib/auth/verify.ts` reports two problems that are **not** from this STEP and were present on
  `main` at `db5da6c` (verified by running the gate on a clean stash):
  1. "`/api/clients/[id]` checks the token before it looks the session up" - the check demands
     `header checks < readRequestActor index || !source.includes("readRequestActor(")`, but STEP
     106's route legitimately calls `readRequestActor` twice (once in `GET`, once in `POST`) so the
     index of the first occurrence precedes the token check. The route itself checks the token first
     in `POST`.
  2. "the server has one door ... and no third module dials" - the expected list omits
     `storage/http.ts`, which STEP 100-105 added as the storage transport's one door.
  Both belong to `lib/auth/verify.ts`, whose owner is the auth block (STEP 037-055), so this STEP
  did not edit it. The fix for each is a one-line change in that gate and is left to its owner.
- No STEP 096 handoff exists (`docs/handoffs/` goes 095 -> 097). STEP 107 does not depend on it.

## Next

- **Next STEP:** 108 - Product and service create and edit forms (`services/products/`).
- **What the next chat must know:** the paginated-list pattern is now `services/clients/client-list.ts`:
  a parser that sanitises then validates and reports rather than rewrites, a query builder exported as
  data, a service that applies the role list and takes the company from the session, one row more
  than the page to answer "is there a next page", a `GET` route that is deliberately off
  `CSRF_PROTECTED_PATHS`, and a server-rendered screen whose address bar is the state. STEP 109
  (product list with search) is the same shape over `0020`. `CLIENT_LIST_PAGE_SIZE` is 25 and
  `CLIENT_LIST_MAXIMUM_OFFSET` is 2 000; the search alphabet is the one thing a product list must
  extend with the characters a SKU carries, if it needs them.
