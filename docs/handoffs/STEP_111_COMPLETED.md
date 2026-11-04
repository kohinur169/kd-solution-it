# STEP 111 — CSV import for products, with per-row error reporting

**Status:** complete. `FEATURE_LIST.md` §15, line 166: *"CSV data import for client and product lists.
Invalid rows are reported row by row while valid rows are imported."* STEP 110 did the client half; this
is the product half, and the services catalogue comes with it because it is the same table shape.

## What was built

A merchant with a price list exported from a spreadsheet uploads one `.csv` and gets back a report:
which line was taken, which was refused, and on which column with which rule. The good rows land; the
bad rows do not stop them. That last sentence is the whole feature — an import that refuses a whole
file because line 87 has a stray character is an import nobody uses twice.

### New files

| Path | What it is |
| --- | --- |
| `services/products/catalogue-import.ts` | The import: header mapping, per-row loop, report. 448 lines. |
| `app/api/products/import/route.ts` | `createCatalogueImportRoute(kind)`, and the product route it builds. |
| `app/api/services/import/route.ts` | Twelve lines: the same factory, called with `"service"`. |
| `app/(dashboard)/products/catalogue-import-form.tsx` | The client form: pick a file, post it, print the report. |
| `app/(dashboard)/products/catalogue-import-screen.tsx` | The screen both catalogues mount, plus its metadata. |
| `app/(dashboard)/products/import/page.tsx` | Thin wrapper, `kind="product"`. |
| `app/(dashboard)/services/import/page.tsx` | Thin wrapper, `kind="service"`. |

### Changed

| Path | Change |
| --- | --- |
| `app/(dashboard)/products/catalogue-screens.tsx` | The list links to `${path}/import` beside the add button, for both catalogues. |
| `lib/security/csrf.ts` | `CSRF_PROTECTED_PATHS` 52 → **54**: `/api/products/import`, `/api/services/import`. |
| `lib/i18n/strings/en.ts` | 41 `catalogue.import*` keys. |
| `lib/auth/verify.ts` | Three counts: session keepers 23 → 24, browser-mutation files 34 → 35, call sites 38 → 39. |
| `services/products/verify.ts` | +322 lines of gate: 707 → **1029** checks. |

`1677` lines added, `9` removed, 12 files.

## The decisions, and why

**`services/clients/csv.ts` is reused, not copied.** One reader, two catalogues. `readCsv`,
`normaliseHeader`, `MAXIMUM_CSV_CHARACTERS`, `MAXIMUM_CSV_ROWS` and `CsvSyntaxProblem` are imported
as they stand — STEP 110's file is not touched by this STEP at all. Two readers would mean two answers
to "is this file malformed", and the second one would drift.

**The importer owns no insert, no table name and no role list.** Every row goes through
`createCatalogueEntry`, which is the same function the form's `POST` calls. The import therefore
*inherits* the price parser, the code pattern, the field ceilings, the RLS scoping, the per-entry audit
entry and the role check. It cannot become a second, looser definition of a valid catalogue row, and
the gate asserts it: `catalogue-import.ts` contains no `insertReturning(`, no `CATALOGUE_TABLES`, no
`requireAnyRole(`, no `priceToMinor`, and no `Number(` / `parseFloat(`.

**One module serves both catalogues.** They differ in exactly three things — the table, the code column
(`sku` / `code`) and the default unit (`item` / `hour`) — so `kind` is an argument rather than a second
file. The gate runs every import check twice, once per catalogue.

**A blank cell is not a wrong cell.** A blank unit takes the catalogue's own default from
`CATALOGUE_DEFAULT_UNIT`; a blank currency takes `CATALOGUE_CURRENCIES[0]`. A *stated*
`stone` is passed through untouched and refused by the service as `unit/invalid_format`. Filling a
bad value with a default would be quietly changing the merchant's data.

**The price is never parsed in the import.** `unit_price` arrives as a string and goes to the service
as a string; `priceToMinor` converts it at scale four, so `19.999` is `199990` minor units and no
amount ever passes through a float. The gate asserts the absence of both a float parse and a
`priceToMinor` call in the import module.

**`header_missing_price` is its own refusal.** A file with a name column but no price column is
refused once, at the header, rather than producing N row refusals — a price list without prices cannot
be guessed at, and the honest answer names the missing column.

**A duplicate code is a row refusal, not a whole-file `CONFLICT`.** A code already used by the
merchant, or repeated inside the file, refuses that line and let the rest through, with
`{ field: "sku" | "code", rule: "already_used" }`. `already_used` is mapped from the unique index's
`23505`, not from a lookup, so the answer comes from the database that enforces it.

**The report carries fields and rules, never values.** A row is `{ line, status, name?, problems }`.
The gate proves it by asserting that the refused price `1 200` and an imported description appear
nowhere in the serialised report — a CSV is often a customer list, and an import report is the kind of
thing that ends up pasted into a support ticket.

**One audit summary per run, plus per-row entries.** Each created entry writes its own
`product.created` / `service.created` through the service; the run adds one `catalogue.imported`
carrying `{ kind, created, refused }`. It is deliberately not per-kind: the action says what happened,
the payload says where.

**A row failure does not stop the run; an outage does.** The loop catches per row, converts the known
reasons (`VALIDATION_FAILED`, `CONFLICT` → `already_used`) into problems, and rethrows anything else.
A database that is down must not be reported as forty invalid rows.

## Verification

### Gates

| Gate | Before | After |
| --- | --- | --- |
| `services/products/verify.ts` | 707 checks | **1029 checks** |
| `services/clients/verify.ts` | 520 checks | 520 checks (unchanged, `csv.ts` reused as-is) |
| `npx tsc --noEmit` | 0 errors | **0 errors** |
| `npm run lint` | 0 | **0** |
| `npm run build` | green | **green**, `/products/import` and `/services/import` both `ƒ` |
| `check:structure` | 376 files | **383** files |
| `check:i18n` | 1833 / 209 | **1874 messages / 218 placeholders** |
| `lib/auth/verify.ts` | 3 counts stale | **3 counts bumped**, 1 pre-existing failure (below) |

### The gate's own findings

Four assertions failed against the first draft of the code, and three were real:

1. **`service: a blank unit takes the default` (expected `hour`, received `item`)** — my fixture stated
   `item` on the row that landed, so the default was never exercised and the two catalogues looked
   identical. Fixture fixed to leave the unit blank on the row that lands.
2. **`the header Service,Code,Amount,Unit of Measure,Currency is refused`** — the header was not
   wrong; my values line had five cells against a two-column header, so the file was correctly refused
   as `row_too_wide`. Each header case now carries its own value line. This also exposed a real gap:
   `Product` and `Service` are now accepted as name columns, because a catalogue's own export titles
   the column with the catalogue.
3. **`no amount passes through a float parse`** — matched the *doc comment* explaining why there is no
   float parse. The source assertions now strip comment lines before matching. Same trap as STEP 110.
4. **`19.999 is stored as 199990`** — expected a bigint, received the string `"199990"`. The fixture
   stores the wire form, where a bigint is text. The assertion was wrong, not the code.

Two assertions were also over-strict against the design and were corrected, not the code: the
form/service agreement now fills the two cells a CSV may omit before comparing (a CSV cell may be
absent, a form body may not — the screen sends its select's default), and the "no handler of its own"
check applies only to the service wrapper, because the product route *is* the factory.

### Runtime, against a freshly rebuilt `next start`

CSRF first, proven by the refusal's own shape — the cookie name decides which check answered:

| Request | Answer |
| --- | --- |
| `kd_csrf` cookie, matching header, no session | `422` `[{ field: "csrf", rule: "csrf_token_invalid" }]` — the name mismatch, so CSRF still first |
| `__Host-kd_csrf`, matching header, `text/csv`, no session | **`401 AUTHENTICATION_REQUIRED`** — past CSRF, past media type, stopped by the session gate |
| same, `/api/services/import` | **`401`** — identical, because it is the same handler |
| `__Host-kd_csrf`, `application/json` | `422` `[{ field: "file", rule: "invalid_type" }]` |
| `__Host-kd_csrf`, `image/png` | `422` `[{ field: "file", rule: "invalid_type" }]` |
| `__Host-kd_csrf`, real 4 MB body | **`413 PAYLOAD_TOO_LARGE`** |
| `__Host-kd_csrf`, `application/vnd.ms-excel` | `401` — accepted media type, reached the session gate |
| `__Host-kd_csrf`, `text/plain` | `401` — likewise |
| no token at all, any body | `422` CSRF, never a hint about the file |
| `GET` on the route | `405` |
| response headers | `cache-control: no-store, max-age=0` |

Pages: `/products/import` and `/services/import` both answer `200` with the right titles
(`Import products from a CSV`, `Import services from a CSV`) and render the signed-out state rather
than the form when there is no session. The `200`-instead-of-redirect is this codebase's existing
pattern (`/products` behaves the same), so it is consistent rather than novel.

### Widths

Read from the markup, since there is no headless browser here. The screen is one column at every width
— `mx-auto flex w-full max-w-3xl flex-col gap-6`, with `px-4 sm:px-6 lg:px-8` and
`text-2xl sm:text-3xl` on the title — so nothing is arranged side by side that would need to reflow.
The report table is the one wide thing, and it sits in `overflow-x-auto` at `min-w-2xl` inside the
3xl-capped column: at 375 px it scrolls within its own box instead of pushing the page sideways. The
list's new import link is in a `flex flex-wrap items-center gap-2` group beside the add button, so the
two stack rather than overflow on a phone.

## Recorded, not fixed

`lib/auth/verify.ts`'s one-door check reports a fourth module, `lib/storage/http.ts`. **This is not
STEP 111's**: neither that file nor `lib/auth/verify.ts`'s expectation is in this STEP's diff, and
`lib/storage/http.ts` exists at the base commit `e221192`, where the same check would have reported the
same four modules. It is recorded here rather than widened away, because the right fix is a decision
about whether the storage client is a permitted third door — not a count bump in an unrelated STEP.

## Next

**STEP 112 — the invoice create form.**
