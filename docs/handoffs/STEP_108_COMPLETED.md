// path: docs/handoffs/STEP_108_COMPLETED.md
# STEP 108 - Product and service create and edit forms: completed

Branch `arena/5fa2593d-kd-solution-it`. This handoff and the STEP 108 code are in one commit, the one
whose message is "STEP 108: Product and service create and edit forms" (`git log -1` on the branch
shows its hash). Previous handoff: `docs/handoffs/STEP_107_COMPLETED.md`. Third STEP of the Clients,
Products, Invoices and Estimates block (106-126).

## STEP

- **Number and title:** STEP 108 - Product and service create and edit forms
  (`docs/final/STEP_PLAN_250.md`, line 1370).
- **Category:** Clients, Products, Invoices and Estimates, STEPs 106-126.
- **Owned paths (File Ownership Rules):** "Business STEPs 106-126 own `services/clients/`,
  `services/products/`, `services/invoices/` and invoice components" (line 53), plus the matching
  screens under `app/(dashboard)/` and routes under `app/api/`. This STEP created `services/products/`
  (`price.ts`, `catalogue-fields.ts`, `catalogue.ts`, `verify.ts`), `app/api/products/{route.ts,
  [id]/route.ts}`, `app/api/services/{route.ts,[id]/route.ts}`, and
  `app/(dashboard)/{products,services}/{page.tsx,new/page.tsx,[id]/page.tsx}` with the two shared
  components `app/(dashboard)/products/{catalogue-form.tsx,catalogue-screens.tsx}`. It extended
  `lib/i18n/strings/en.ts` (55 new `catalogue` messages) and `lib/security/csrf.ts` (four paths), and
  it touched `lib/auth/verify.ts` only where this STEP moves the numbers that gate asserts (route
  parity, the `SessionKeeper` count, the browser-mutation count) - see "Conflicts" below for why that
  file had to be edited at all.
- **Feature list:** section 15 line 163, "Product and service create, edit, delete and paginated
  list" - this STEP is the create and the edit of both catalogues; the delete and the list are STEP
  109, and the CSV import is STEP 110. Also line 7 (money rules), section 7 (USD only) and section 25
  (an owner manages their own catalogue).
- **Depends on:** STEP 020's `migrations/0020_products.sql` and `migrations/0021_services.sql`, which
  already carry every column, check, index and trigger this STEP needs - **no migration in this STEP,
  therefore no rollback proof to write**. STEP 106/107 (`services/clients/`) are the pattern for a
  service, a gate and a set of screens.

## What was built

- `services/products/price.ts` - the one conversion between a typed price and a stored one:
  - `priceToMinor("12.50")` is `125000n` by decimal string arithmetic and `BigInt` only; nothing in
    the module builds a `Number` from an amount, which is MASTER_PROMPT rule 2 and `config/app.ts`'s
    `money.scale = 4`.
  - `PRICE_INPUT_PATTERN` is `/^\d{1,12}([.]\d{1,4})?$/` - no sign, no separator, no exponent, no
    symbol, so `12,50`, `1e3`, `$12` and `-5` are refused instead of coerced.
  - `PRICE_MAXIMUM_MINOR` is `1_000_000_000_000n`; a price past it answers `too_large` rather than
    being written as a number the screen could not print back.
  - `priceFromMinor` prints the stored value back with four decimals, so the edit form shows exactly
    what the invoice will use.
  - This is deliberately **not** STEP 127's money module: that STEP owns rounding, currency
    arithmetic and the ledger. This file is the one conversion a catalogue form needs, kept beside
    the two services that use it.
- `services/products/catalogue-fields.ts` - the shared vocabulary of both catalogues, browser safe so
  the form imports the same lists the service validates against: `CATALOGUE_KINDS`
  (`product`/`service`), `CATALOGUE_TABLES` (`products`/`services`), `CATALOGUE_CODE_COLUMN`
  (`sku`/`code`), `CATALOGUE_DEFAULT_UNIT` (`item`/`hour`), the seven units `0019`-style check
  allows, `CATALOGUE_CURRENCIES` (`USD` alone, section 7), the field ceilings, the code pattern
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$`, the migration's own) and `CATALOGUE_PATHS`.
- `services/products/catalogue.ts` - one kind-parameterised implementation rather than two copies:
  - `createCatalogueEntry`, `getCatalogueEntry`, `updateCatalogueEntry`; the kind decides the table,
    the code column and the audit action, and nothing else.
  - Only the **owner** acts (`CATALOGUE_MANAGE_ROLES`), and the company is always
    `requireCompanyId(actor)` - never read from the body, the path or the query.
  - Validation reports **every broken field at once**, in the order the form reads, one rule per
    field, with the code named the way the merchant fills it (`sku` on a product, `code` on a
    service). The shape, the code pattern and the price are three separate judgements and all three
    run, so a merchant fixes the whole form in one pass instead of one box per submit.
  - An edit merges the sent fields onto the stored row, so a partial body is still validated as a
    whole; the row is re-read afterwards, which is what turns a row removed under the writer into
    `RESOURCE_NOT_FOUND` rather than a silent success.
  - A lost unique race answers `CONFLICT` with `{field: "sku"|"code", rule: "already_used"}`; another
    merchant may hold the same code, and a soft-deleted row releases its own.
  - Audit: `product.created`/`service.created` and `product.updated`/`service.updated`, naming the
    row, the company and the actor, with the **changed field names only**. The description never
    reaches the trail - it is free text a merchant may have pasted anything into - and neither does
    any amount beyond the `unit_price_minor` decimal string on a create.
- Routes - `app/api/products/route.ts` and `app/api/products/[id]/route.ts` define
  `createCatalogueRoute(kind)` and `createCatalogueEntryRoute(kind)`; `app/api/services/route.ts` and
  `app/api/services/[id]/route.ts` build their handlers from those factories for kind `service`. All
  four are on `CSRF_PROTECTED_PATHS` (47 -> 51) and the token is checked before the session and
  before the body is read. The write refuses a declared body over 16 KiB, and every answer is
  `no-store`.
- Screens - `app/(dashboard)/products/**` and `app/(dashboard)/services/**`. One form component and
  one screen module serve both catalogues, because a product and a service ask for the same five
  things and differ in three facts (the code's name, its hint and the default unit):
  - `/products`, `/products/new`, `/products/[id]` and the three `/services` equivalents, all
    `force-dynamic` and all mounting `<SessionKeeper>`, so a merchant reading a form keeps their
    token rotating.
  - The edit screen words four refusals apart - signed out, not an owner, the store unavailable and
    the row not there. Only the service decides who may read; the screen words the answer and states
    no role of its own.
  - The price is a **text** box with `inputMode="decimal"`: a number input in a browser is a float,
    and no amount passes through one. Nothing in the form rounds, parses or formats a price; it sends
    what the merchant typed and prints the service's refusal.
  - Every field the service names is marked at once with its own sentence, `aria-invalid` and
    `aria-describedby`; a rule this build does not know still produces a sentence rather than an
    empty line.
  - Phone-first layout: a single column, `px-4 py-8` growing to `sm:px-6 lg:px-8`, `min-h-dvh`, and
    a `max-w-3xl` column, so the form is one thumb's width on a phone and a readable column on a
    desktop. Semantic tokens only; `check:shell` proves no colour literal and no palette step.

## Security verification

- **Validation:** every ceiling, the seven-unit list, the USD-only rule, the code pattern and the
  unknown-key rule are asserted field by field in the gate, and the price pattern refuses a
  separator, a sign, an exponent, a symbol and a fifth decimal. Control characters are stripped by
  `lib/security/text.ts` before any rule runs, and the sanitiser never truncates to the ceiling - an
  over-long value is refused as `too_long` instead of being silently shortened.
- **Tenant scoping:** the company comes from the session through `requireCompanyId`; every read is
  `company_id=eq.<session company>&deleted_at=is.null&id=eq.<id>`; a foreign row, a deleted row and
  an unknown id are the same `404`, and the other catalogue never reads this one's rows. The gate
  fails if any query is issued without the tenant scope.
- **Permissions:** only `owner` may read or write a catalogue. The gate refuses `compliance_kyc`,
  `support`, `finance_ops`, `ceo`, `super_admin` and `blogger`, and refuses a platform account with
  no company.
- **Audit:** create and edit both append, the payload names the fields and never the description,
  and a sink that is down does not fail the write it records.
- **CSRF and headers:** the four paths are on `CSRF_PROTECTED_PATHS` and the repository's own parity
  assertion (`postRoutes` vs the list) passes. Against the production build:
  `POST /api/products` with no token answers `422` `VALIDATION_FAILED` with
  `{field: "csrf", rule: "csrf_token_invalid"}`, and `GET /api/products/<id>` with no session answers
  `401` `AUTHENTICATION_REQUIRED` - neither reaches the service, and neither leaks a row.
- **Screens:** all six paths answered `200` against the production build. `/products/new` renders the
  five fields, the seven units and the USD hint; the edit screens show the signed-out sentence and a
  sign-in link rather than a form, because a form a visitor cannot submit is a form that invites a
  post with nothing behind it.
- **Money flow ledger proof:** not applicable, no money moves in this STEP.
- **Provider sandbox cycle:** not applicable, no provider in this STEP.

## Verification

- `node services/products/verify.ts` -> "catalogue gate passed: 377 checks, 2 catalogues, 6 fields,
  7 units, products/services, sample 36 id characters", exit 0. The gate drives the real service over
  an in-memory PostgREST of `0020`/`0021` that keeps the tenant scope, the live-row rule and both
  partial unique indexes (including `lower()`), so a duplicate code answers `CONFLICT` exactly as
  Postgres would.
- `npm run -s typecheck` exit 0. `npm run -s lint` exit 0 (no `any`, no non-null assertion, no
  `console`).
- Gates: `check:structure` 365 source files, `check:i18n` 1752 messages / 193 placeholders,
  `check:shell` 605 checks / 173 files, `check:migrations` 3261 checks / 111 migrations / 85 tables
  (unchanged - this STEP writes no migration), `check:jobs` 110, `check:env` 16 - all green.
- `npm run -s build` green; the route table now lists `/products`, `/products/[id]`, `/products/new`,
  `/services`, `/services/[id]`, `/services/new` (all `ƒ`) beside `/api/products`, `/api/products/[id]`,
  `/api/services`, `/api/services/[id]`.
- Screens checked at both widths against the production build: one column and `px-4` at 360 px wide,
  the `max-w-3xl` column and `sm:px-6 lg:px-8` at 1440 px, no horizontal overflow at either.
- ASCII and path-header scans clean on all 16 touched files (the gate asserts both, plus the absence
  of `console.log` outside itself).

## Conflicts and pre-existing failures (recorded, not fixed here)

- **`lib/auth/verify.ts` had to be edited, and only for its own counts.** Three of its assertions are
  counts this STEP necessarily moves: the `CSRF_PROTECTED_PATHS` / `postRoutes` parity (four new
  routes), the `SessionKeeper` count (21 -> 22 - the catalogue screens are one component mounted at
  four paths), and the browser-mutation count (32 files / 36 call sites -> 33 / 37 - the one form
  that posts). No assertion was weakened and no boundary moved.
- **One assertion needed a real correction, not a number.** `"<path> checks the token exactly once"`
  counted `requireCsrfToken(` occurrences in the route's own file. A route that builds its handler
  from another route's factory - which is the whole point of the two `/api/services` routes, and is
  how this block avoids two copies of the same handler - holds no token call of its own, and the
  assertion would fail a route whose check is one file away. The chain is therefore followed one
  level: the route's own source plus any `route` module it imports, and exactly one file in that
  chain must check the token. That is the property the assertion is named for, and `/api/products`
  and `/api/products/[id]` are still judged on their own source alone.
- `node lib/auth/verify.ts` reports **three** problems that are not from this STEP. I ran the gate on
  a clean worktree of `fd0c76e` to confirm the list: `/api/clients/[id]` "checks the token exactly
  once" (2, because the file has three handlers with one check each), `/api/clients/[id]` "checks the
  token before it looks the session up" (the file's first `readRequestActor` precedes its first token
  check because `GET` has no token to check), and "the server has one door ... and no third module
  dials" (the expected list omits `storage/http.ts`, added by STEP 100-105). All three belong to
  `lib/auth/verify.ts`, whose owner is the auth block (STEP 037-055), and all three were present
  before this STEP. Fixing the two `/api/clients/[id]` assertions properly means judging per handler
  rather than per file; that is the auth block's decision to take, and this STEP left it alone.
- A first draft of the shared form posted the code under the merchant's name (`sku`) and the service
  translated it for the schema; the strict schema then saw both keys and refused every create. The
  gate caught it before the commit, the translation now happens in the sanitiser, and the case is
  asserted (`a product code is reported as sku`, `a service code is reported as code`).
- **FEATURE_LIST section 15 promises a product/service delete and a paginated list; the 250 plan
  gives both to STEP 109** (product list with search), so this STEP deliberately delivers no delete
  and no list, and no route beyond the four named above. The screens therefore link to the hub and
  the create form only; STEP 109 adds the table, the search and the removal.

## Next

- **Next STEP:** 109 - Product list with search (`services/products/`, the paginated read over
  `0020` and `0021`, and the delete section 15 also promises).
- **What the next chat must know:** the catalogue is one implementation over two tables.
  `services/products/client-list.ts`-shaped work means: copy the shape of
  `services/clients/client-list.ts` (sanitise, then validate and **report** rather than rewrite;
  query as data; role list applied in the service; one row more than the page), and extend
  `CATALOGUE_SEARCH_PATTERN`-style alphabet with the characters a SKU carries (`.`, `-`, `_`) if a
  search needs them. `services/products/catalogue-fields.ts` is the one place the two catalogues'
  vocabulary lives - a list screen must read `CATALOGUE_TABLES`, `CATALOGUE_CODE_COLUMN` and
  `CATALOGUE_PATHS` from it rather than restate them. A delete is this block's existing template:
  soft delete, read-then-write so a repeat is a `404`, a re-read to prove the write landed, and an
  audit entry naming the row only. `PRICE_INPUT_PATTERN`'s twelve whole digits is the ceiling on what
  a list may print; `priceFromMinor` is the only thing that may format a price, and STEP 127 owns
  the general money module that may one day replace it.
