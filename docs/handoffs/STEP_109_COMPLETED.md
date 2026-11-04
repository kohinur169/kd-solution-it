// path: docs/handoffs/STEP_109_COMPLETED.md
# STEP 109 - Product paginated list with search: completed

Branch `arena/5fa2593d-kd-solution-it`. This handoff and the STEP 109 code are in one commit, the one
whose message is "STEP 109: Product paginated list with search" (`git log -1` on the branch shows its
hash). Previous handoff: `docs/handoffs/STEP_108_COMPLETED.md`. Fourth and last STEP of the Clients,
Products, Invoices and Estimates block's catalogue half (106-111).

## STEP

- **Number and title:** STEP 109 - Product paginated list with search
  (`docs/final/STEP_PLAN_250.md`, line 1382).
- **Category:** Clients, Products, Invoices and Estimates, STEPs 106-126.
- **Owned paths (File Ownership Rules):** "Business STEPs 106-126 own `services/clients/`,
  `services/products/`, `services/invoices/` and invoice components" (line 53), plus the matching
  screens under `app/(dashboard)/` and routes under `app/api/`. This STEP created
  `services/products/catalogue-list.ts`, `app/api/products/list/route.ts`,
  `app/api/services/list/route.ts`, `app/(dashboard)/products/catalogue-list-table.tsx`,
  `app/(dashboard)/products/catalogue-search-form.tsx` and
  `app/(dashboard)/products/delete-catalogue-form.tsx`. It added `deleteCatalogueEntry` and
  `CATALOGUE_DELETED_AUDIT_ACTION` to `services/products/catalogue.ts`, a `DELETE` export to both
  `[id]` route factories (`app/api/products/[id]/route.ts`, `app/api/services/[id]/route.ts`), and
  replaced STEP 108's placeholder hub in `app/(dashboard)/products/catalogue-screens.tsx` with the
  list. It extended `services/products/verify.ts` (this block's gate) and `lib/i18n/strings/en.ts`
  (44 new `catalogue` messages). It touched `lib/auth/verify.ts` only where this STEP's routes move
  the numbers it asserts - see "Conflicts" below.
- **Feature list:** section 15 line 163, "Product and service create, edit, delete and paginated
  list" - this STEP is the paginated list, the search over it, and the delete of both catalogues.
  Create and edit were STEP 108; the CSV import is STEP 111.
- **Depends on:** STEP 108 (`services/products/{catalogue,catalogue-fields,price}.ts`, the four write
  routes and the six screens) and STEP 020's `migrations/0020_products.sql` / `0021_services.sql`.
  **No migration in this STEP, therefore no rollback proof to write:** both page indexes already
  exist and are exactly the order the list reads -
  `products_page_idx` / `services_page_idx` on `(company_id, created_at desc, id desc) where
  deleted_at is null`. `services/clients/client-list.ts` is the pattern this module mirrors.

## What was built

- `services/products/catalogue-list.ts` - the read of many rows, separate from `catalogue.ts` (which
  is the read and write of one):
  - `parseCatalogueListQuery` reads `search` and `offset` from the address bar. The term goes through
    `lib/security/text.ts`'s single-line sanitiser first, is then bounded to
    `CATALOGUE_SEARCH_MAXIMUM_LENGTH` (80) and finally matched against
    `CATALOGUE_SEARCH_PATTERN` - letters, digits and combining marks of any script, spaces, and
    `. ' - _ @ +`. A refused term is **reported and dropped**, never rewritten:
    `{field: "search", rule: "invalid_format" | "too_long"}`. `offset` accepts digits only, is clamped
    to `CATALOGUE_LIST_MAXIMUM_OFFSET` (2 000) and is landed on the page grid, so the position line
    always describes the window that was read.
  - The search alphabet is the client list's, and it already covers every character
    `CATALOGUE_CODE_PATTERN` allows a SKU to carry - so a merchant can search a code without the
    filter learning a new character. PostgREST's structure characters (`, ( ) " \ : * %`) stay
    impossible.
  - `catalogueListColumnsOf` names the columns and **aliases the code column**: `code:sku` for a
    product and `code:code` for a service. That one aliasing decision is why one row schema
    (`catalogueListRowSchema`) covers both tables instead of two near-identical ones that could
    drift - and it is asserted for both kinds.
  - `listCatalogueEntries` applies `CATALOGUE_MANAGE_ROLES` (the owner, section 25), takes the company
    from `requireCompanyId`, asks for `CATALOGUE_LIST_PAGE_SIZE + 1` rows so `nextOffset` costs no
    second count, and orders by `created_at.desc,id.desc` - the index order.
  - Prices are printed by `priceFromMinor`, the one function allowed to format an amount, so the list
    and the edit form cannot disagree. The gate asserts there is no `parseFloat` or `toFixed` in the
    module and that a printed price converts back to the amount it was read from.
- `deleteCatalogueEntry` in `services/products/catalogue.ts` - the removal, following the block's
  template:
  - **The row stays.** `0020`/`0021` carry `deleted_at` because an invoice line from STEP 112 will
    quote this entry. Erasing it would break that line or take a copy of the whole entry with it; the
    marker takes it out of the catalogue and leaves history able to say what was sold. The partial
    unique indexes count live rows only, so the code becomes free again - which is what a mistyped
    code needs, and the gate proves it.
  - **Read, write, then read again.** `rest.update` reports success whether or not its filter
    matched, so the row is re-read: a row *still live* after the write means the update matched
    nothing, and that is `CONFLICT {field: kind, rule: "already_changed"}` rather than a false
    success. A row already gone is a `404`, not a second marker.
  - **Audit** `product.deleted` / `service.deleted`, naming the row, the company and the actor with
    its name, its code and the instant. Never the description.
- Routes:
  - `app/api/products/list/route.ts` defines `createCatalogueListRoute(kind)`; 
    `app/api/services/list/route.ts` re-exports it for `service`. Both are `GET`, `no-store`, and
    deliberately **absent from `CSRF_PROTECTED_PATHS`** - a read has no body to forge.
  - `DELETE` was added to both `[id]` route factories. `CSRF_PROTECTED_PATHS` stays at 51 entries
    because the paths were already listed for `POST`; the token is checked first, before the session.
- Screens:
  - `/products` and `/services` are now the paginated list: search form, rows, pager, and the
    "add" button. The address bar is the state, so a search is bookmarkable and the pager links are
    the query the next page runs. The other catalogue and the home page stay one link away.
  - The four refusals are worded apart (signed out / not an owner / store unavailable / list
    empty), because printing "no products yet" for an outage would tell a merchant their catalogue
    was erased.
  - The removal sits on the edit screen, **inside the branch that read the row** - a refusal prints
    no button, because a removal whose target the reader cannot see is a removal they cannot
    confirm. Two-step confirmation in the page (no `window.confirm`), `DELETE` with the CSRF token
    and no body, and a refusal stays on the page rather than navigating away as if it had worked.
  - Phone-first: `px-4 py-8` growing to `sm:px-6 lg:px-8`; the table keeps `min-w-3xl` inside an
    `overflow-x-auto` wrapper so six columns stay on one line at 360 px instead of wrapping a row
    onto four; the list takes a `max-w-5xl` column and the forms keep `max-w-3xl`, because a table of
    six columns does not read in a form's width.
  - The code column heading follows the catalogue: "SKU" over a product, "Code" over a service.

## Security verification

- **Validation:** the search's alphabet, its ceiling, the offset's digits-only rule and the page-grid
  landing are asserted against the real parser, including eight hostile terms (`,` `)` `*` `.` `:`
  `%25` `"` `\`). Each is reported and dropped, and the gate asserts **no filter was built from it** -
  so PostgREST's query grammar cannot be reached from the address bar. Control characters are
  stripped by the section 55 sanitiser before the rule runs.
- **Tenant scoping:** every page query is `company_id=eq.<session company>&deleted_at=is.null`; the
  gate fails the run if the fixture ever sees a read that is not company scoped. Another merchant
  sees none of these rows, the two catalogues never read each other's rows, and a foreign removal is
  a `404` with the row untouched.
- **Permissions:** only `owner` lists, reads and removes. The gate refuses `compliance_kyc`,
  `finance_ops`, `support`, `ceo`, `super_admin` and `blogger` on the list and on the removal.
- **Audit:** `product.deleted` / `service.deleted` with the row, the company, the actor and never the
  description. A list read writes nothing, because rule 9 asks for mutations.
- **CSRF:** the `DELETE` is on a path that was already protected as a `POST` route; the token is
  checked before the session and before any body. The two list routes are `GET` and absent from the
  list by design. Against the production build, `DELETE /api/products/<id>` with no token answers
  `422 VALIDATION_FAILED` with `{field: "csrf", rule: "csrf_token_invalid"}`, and both list endpoints
  answer `401 AUTHENTICATION_REQUIRED` - neither reaches the service.
- **Screens:** all eight list addresses answered `200` against the production build, and the
  signed-out body carries the signed-out sentence with no table, no search form and no removal
  button.
- **Money flow ledger proof:** not applicable, no money moves in this STEP.
- **Provider sandbox cycle:** not applicable, no provider in this STEP.

## Verification

- `node services/products/verify.ts` -> "catalogue gate passed: 707 checks, 2 catalogues, 6 fields,
  7 units, products/services, sample 36 id characters", exit 0 (377 at STEP 108, so 330 new). The
  gate's in-memory PostgREST now models what a page query actually uses - `order`, `limit`, `offset`,
  `or=()` with `ilike` patterns, and the `code:sku` projection alias - so pagination, ordering,
  search and the alias are exercised rather than assumed.
- Behaviours exercised: newest-first ordering across two pages with no overlap and every row
  accounted for; `limit=26` and no `count`; a page past the end empty rather than an error; search by
  name, by code and by description; eight refused terms; over-long term refused as `too_long` rather
  than truncated; `offset=30` landing on 25 and `offset=99999` capped; a removal marking the row,
  leaving it in the table, dropping it from the read and the list, freeing its code, answering `404`
  on a repeat, and `CONFLICT already_changed` when the update matches nothing.
- `npm run -s typecheck` exit 0. `npm run -s lint` exit 0.
- Gates: `check:structure` 371 source files, `check:i18n` 1795 messages / 202 placeholders,
  `check:shell` 620 checks / 178 files, `check:migrations` 3261 checks / 111 migrations / 85 tables
  (unchanged - this STEP writes no migration), `check:jobs` 110, `check:env` 16 - all green.
- `npm run -s build` green; the route table lists `/api/products/list` and `/api/services/list`
  beside the STEP 108 routes, and `/products`, `/services` are `ƒ`.
- The table was rendered to static markup with real rows at both widths' class sets: headings adapt
  per catalogue, `42.5000 USD` prints from minor units, and a null code or description prints
  "Not set" rather than an empty cell.

## Conflicts and pre-existing failures (recorded, not fixed here)

- **`lib/auth/verify.ts` needed a genuine correction, and this STEP made it.** The assertion
  "`<path>` checks the token exactly once" counted `requireCsrfToken(` occurrences in the route's own
  file, and "checks the token before it looks the session up" compared the *first* index of each
  string in the file. Both are the wrong unit: a route that answers `GET` beside `POST` has a reading
  handler with no token to check, so `/api/clients/[id]` failed on `main` for a rule its `POST`
  satisfied - a failure STEP 107 recorded and left to the auth block. STEP 109 could not leave it: by
  adding `DELETE` to the catalogue `[id]` routes it made every one of those routes fail.
  The assertion now splits the file into exported handlers, requires **the token check once per
  mutating handler and before the session lookup and body read inside that handler**, follows a
  handler that delegates (`= handlers.POST`, `= createCatalogueRoute(kind)`) to the factory or route
  that implements it, and adds the rule the reading handlers were missing: **a `GET` reads no body**.
  That is stricter than what was there for the handlers it was aimed at, and it removes the two false
  failures. `/api/clients/[id]` now passes without a line of its own code changing.
- `node lib/auth/verify.ts` still reports one problem that is not from this STEP and was present on
  `main`: "the server has one door and the browser has its own, and no third module dials" - the
  expected list omits `storage/http.ts`, added by STEP 100-105. It belongs to the auth block, and this
  STEP left it alone rather than widen another block's allowlist.
- **Section 15 promises a product/service delete that the 250 plan assigns to no STEP** - 108 is
  create and edit, 109 is the list, 110/111 are CSV imports, 112 is invoices. This is the same gap
  STEP 107 found and closed for clients. Because MASTER_PROMPT makes FEATURE_LIST.md win a conflict
  with the plan, this STEP delivers the delete rather than leave the promise unowned, exactly as 107
  did for clients. It needs no migration and reuses a path already on the CSRF list, so it adds no new
  surface beyond one service function, one route method per catalogue and one component in this
  block's own folder.
- STEP 108's hub (two links and a menu) was **replaced**, not duplicated: the list is the hub, at the
  same address. Nothing of the create or edit screens changed - they are still the same components,
  reached by the same paths, and their gate is still green.

## Next

- **Next STEP:** 110 - CSV import for clients with per-row error reporting.
- **What the next chat must know:** the list pattern is now in both halves of this block -
  `services/clients/client-list.ts` and `services/products/catalogue-list.ts` - and the second is the
  one to copy for a list that must print a price: it aliases the code column so one row schema covers
  two tables, reads the price through `priceFromMinor`, and asserts the order it reads is the order
  the page index stores. `CATALOGUE_LIST_PAGE_SIZE` is 25, `CATALOGUE_LIST_MAXIMUM_OFFSET` is 2 000,
  and `CATALOGUE_SEARCH_PATTERN` allows exactly the characters `CATALOGUE_CODE_PATTERN` lets a code
  carry - a later search that needs another character must widen both patterns together or the CSV
  import of STEP 111 will accept a code the list cannot find.
- The removal template for the rest of the block: soft delete (the row stays because history points
  at it), read-then-write so a repeat is a `404`, a re-read to prove the write landed (a still-live
  row is `CONFLICT already_changed`), an audit entry naming the row and never copying its free text,
  and a two-step confirmation inside the page, offered only where the row was read.
- STEP 110/111 (CSV import) can build on `parseCatalogueListQuery`'s sanitiser-then-validate-then-report
  discipline, and should report per row the same `{field, rule}` pairs `catalogue.ts` already answers -
  a row refused by the import and a row refused by the form should read identically to the merchant.
