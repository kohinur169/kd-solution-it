// path: docs/handoffs/STEP_110_COMPLETED.md
# STEP 110 - CSV import for clients with per-row error reporting: completed

Branch `arena/5fa2593d-kd-solution-it`. This handoff and the STEP 110 code are in one commit, the one
whose message is "STEP 110: CSV import for clients with per-row error reporting" (`git log -1` on the
branch shows its hash). Previous handoff: `docs/handoffs/STEP_109_COMPLETED.md`. Fifth STEP of the
Clients, Products, Invoices and Estimates block (106-126), and the first half of section 15's data
import.

## STEP

- **Number and title:** STEP 110 - CSV import for clients with per-row error reporting
  (`docs/final/STEP_PLAN_250.md`, line 1394).
- **Category:** Clients, Products, Invoices and Estimates, STEPs 106-126.
- **Owned paths (File Ownership Rules):** "Business STEPs 106-126 own `services/clients/`,
  `services/products/`, `services/invoices/` and invoice components" (line 53), plus the matching
  screens under `app/(dashboard)/` and routes under `app/api/`. This STEP created
  `services/clients/csv.ts`, `services/clients/client-import.ts`,
  `app/api/clients/import/route.ts`, and
  `app/(dashboard)/clients/import/{page.tsx,client-import-form.tsx}`. It extended
  `services/clients/verify.ts` (this block's gate), `lib/i18n/strings/en.ts` (38 new `clients`
  messages), `lib/security/csrf.ts` (one path) and the client list's header (one link). It touched
  `lib/auth/verify.ts` only where this STEP's route and screen move the numbers it counts.
- **Feature list:** section 15 line 164, "CSV data import for client and product lists. Invalid rows
  are reported row by row while valid rows are imported." This STEP is the client half; the product
  half is STEP 111.
- **Depends on:** STEP 106 (`services/clients/clients.ts` - `createClient` is the validator this
  import calls) and `migrations/0019_clients.sql`. **No migration in this STEP, therefore no rollback
  proof to write:** the import writes nothing `0019` does not already describe, and it creates no
  staging table - it calls the existing service row by row.

## What was built

- `services/clients/csv.ts` - a CSV reader, written here rather than taken from a package:
  - RFC 4180's four rules and nothing else: comma separates, a double quote opens and closes a quoted
    field, a doubled quote inside one is one literal quote, a record ends at a line break outside
    quotes. A spreadsheet's real output - `"Amina, Jr"`, `"a ""quoted"" note"`, a note spanning two
    lines - therefore reads as the merchant sees it in the grid instead of shifting every later column.
  - Each record carries **the line it began on in the uploaded file**, so a refusal names the row the
    merchant can find in their own spreadsheet rather than an index into an internal array. A record
    that follows a three-line quoted field starts on line five, and the gate asserts that.
  - The UTF-8 BOM a spreadsheet writes is removed, because otherwise the first header cell is
    `\ufeffname` and every column is one to the right.
  - Four refusals, each with its line: `too_large` (over `MAXIMUM_CSV_CHARACTERS`), `too_many_rows`
    (over `MAXIMUM_CSV_ROWS`), and `invalid_quote` for all three ways a quote can be wrong - a quote
    inside an unquoted field (`Smith"s`), text after a closing quote (`"a"b`), and a quote never
    closed. RFC 4180 gives none of those a meaning, and guessing between a typo and a missing pair of
    quotes would produce one of two different rows.
  - A blank line is skipped, but `""` is **one field holding nothing** - the distinction the
    `fieldWasQuoted` flag preserves, and the one that lets an empty quoted name reach the validator and
    be refused as `required` instead of quietly disappearing.
  - `normaliseHeader` drops case, space and every non-alphanumeric character, so `Company Name`,
  `company_name` and `COMPANY NAME` are one column. That leniency is applied to column *names* only,
    never to a value.
- `services/clients/client-import.ts` - the import itself:
  - **Every row goes through `createClient`.** The definition of "valid" is the form's, not a second
    looser one written for the importer: the same Zod schema, the same section 55 sanitiser, the same
    `0019` address rule, the same `owner` role check, the same `client.created` audit entry. A row this
    import accepts is a row the merchant could have typed, and the day the form learns a rule the
    import learns it in the same commit. The gate asserts this by **sending the same body both ways**
    and requiring the same fields and the same rules back.
  - A refused row is **recorded and the loop continues**: one bad email in fifty rows yields
    forty-nine clients and one report line. Only a defect about the *file* stops the run.
  - A `CONFLICT` from `clients_email_key` is a **row** refusal (`{field: "email", rule:
    "already_used"}`), not a file failure - otherwise one existing client would throw away the other
    forty-nine rows.
  - An error that is neither validation nor conflict is re-thrown: an outage must not be reported as a
    file full of refusals.
  - The report says "line 12, email: invalid format" and **never repeats the value** - an uploaded
    client file is personal data - except the name and id of a row that *succeeded*, which the merchant
    needs to recognise what they just imported. The gate asserts that no value from the file, and no
    imported address, appears anywhere in the report.
  - Header handling: a file with no name column is refused once (`header_missing`) rather than once per
    row; two columns for one field is refused (`header_duplicate`) because there is no honest winner;
    a row wider than the header is `row_too_wide` rather than truncated, since a shifted row imports
    the wrong data silently. An unknown column (`id`, `created at`) is ignored and named, so a
    re-import of the platform's own export works.
  - One `client.imported` summary entry records the run - row count, how many were taken, which
    columns the file supplied - and never a value. Each created client still wrote its own
    `client.created`.
- `app/api/clients/import/route.ts` - `POST`, on `CSRF_PROTECTED_PATHS` (51 -> 52):
  - The body is the file's own bytes as `text/csv`, not multipart, so `content-length` is the file's
    length and the bound is honest. Checks run CSRF -> declared length -> media type -> session ->
    import, so a request that is not shaped like an import costs no directory lookup.
  - A file that was read answers `200` with the per-row report - a file with one bad row is a
    successful import of the rest - and a file whose *shape* is wrong answers `200` with the problem
    and its line, because that is about the file the merchant chose and the screen must word it.
    A request the server will not process at all (no token, too large, wrong type, no session) is an
    error status.
  - The media-type refusal does **not** use `UNSUPPORTED_MEDIA_TYPE`: that code's shared sentence
    reads "this endpoint accepts JSON request bodies only", which is false for a route whose purpose is
    to accept CSV. It refuses with `VALIDATION_FAILED` and `{field: "file", rule: "invalid_type"}`, which
    the screen words for itself and which cannot mislead a merchant reading the answer.
- Screens - `app/(dashboard)/clients/import/`:
  - The page reads the account on the server and words the three states (`actor` / `anonymous` /
    `unavailable`) exactly as the client list and form do, printing the import's own limits
    (`CLIENT_IMPORT_MAXIMUM_ROWS`, `MAXIMUM_CSV_ROWS`) from the service's constants so the sentence
    cannot drift from the code.
  - The form reads the chosen file with `file.text()`, refuses an empty or oversized file before
    uploading, and posts the text with the CSRF token.
  - The report is a **table, one row per line of the file**: line number, imported or refused, and the
    fields that refused with a sentence each. "3 of 40 rows failed" would leave the merchant to find
    those three; the line numbers send them to the row in their own spreadsheet.
  - A refused file keeps the merchant's choice and names the problem and its line, so a fixed header
    is one more press rather than a fresh upload.
  - Phone-first: `px-4 py-8` to `sm:px-6 lg:px-8`, a `max-w-3xl` column, and the report table in an
    `overflow-x-auto` wrapper at `min-w-2xl` so its three columns stay on one line at 360 px.
- The client list now links to the import beside "Add a client", so the feature is reachable from where
  a merchant's clients are.

## Security verification

- **Validation:** every row is validated by `createClient`, and the gate asserts the import and the form
  refuse the **same fields with the same rules** for eight broken bodies (missing name, name past its
  ceiling, bad email, bad phone, a city with no street line, a country that is not two letters, a
  one-character postal code, notes past their ceiling). The reader refuses four malformed-file shapes
  with their line, and header mapping is asserted over eleven real spreadsheet spellings.
- **Tenant scoping:** the company comes from the session through `createClient`'s
  `requireCompanyId`; the gate proves the import names no table and opens no insert of its own, so it
  cannot write outside the row-level rule. Another merchant importing the same file gets their own
  client rather than an overwrite, and the summary audit entry lands on the actor's company chain.
- **Permissions:** only `owner` imports. The gate refuses `compliance_kyc`, `finance_ops`, `support`,
  `ceo`, `super_admin` and `blogger`, and refuses a platform account with no company.
- **Audit:** one `client.created` per created row (from the service the form also uses) plus one
  `client.imported` summary naming the company, the actor, the row counts and the columns - and no
  value from the file.
- **CSRF, size and type**, verified against the production build with a forged matching
  `__Host-kd_csrf` cookie and `x-csrf-token` header:

  | Request | Answer |
  | --- | --- |
  | No token | `422` `VALIDATION_FAILED`, `{field: "csrf", rule: "csrf_token_invalid"}` |
  | Valid token, `application/json` | `422` `VALIDATION_FAILED`, `{field: "file", rule: "invalid_type"}` |
  | Valid token, `text/csv`, no session | `401` `AUTHENTICATION_REQUIRED` |
  | Valid token, 3.3 MB body | `413` `PAYLOAD_TOO_LARGE` |

  Each is refused before the next check runs, and none reaches the service.
- **Screens:** `/clients/import` and `/clients` both answered `200`; signed out, the import screen shows
  the signed-out sentence and **no file input**, so a visitor is not offered an upload that cannot work.
- **Money flow ledger proof / provider sandbox cycle:** not applicable - no money and no provider in
  this STEP.

## Verification

- `node services/clients/verify.ts` -> "clients gate passed: 520 checks, 12 fields, 25 per page, table
  \"clients\"", exit 0 (351 at STEP 107, so 169 new).
- Behaviours exercised: a five-column file with one bad address importing two rows and refusing one at
  its own line while the row after it still lands; twelve reader cases including quoted commas, doubled
  quotes, quoted newlines, CRLF, BOM, blank lines and `""`; four malformed-file refusals with lines;
  eleven header spellings; the form/import agreement over eight bodies; a duplicate address inside one
  file refused on the second row only; an existing client refused on its row while the rest imports;
  six role refusals; and the two-merchants-one-file case.
- `npm run -s typecheck` exit 0. `npm run -s lint` exit 0.
- Gates: `check:structure` 376 source files, `check:i18n` 1833 messages / 209 placeholders,
  `check:shell` 631 checks / 181 files, `check:migrations` 3261 / 111 / 85 (unchanged - no migration),
  `check:jobs` 110, `check:env` 16 - all green. The catalogue gate is still 707.
- `npm run -s build` green; the route table lists `/api/clients/import` and `/clients/import`, both `ƒ`.
- No CSV package was added: the gate reads `package.json` and fails if one appears, because the reader
  is a hundred lines of rules this STEP owns and a dependency would have brought its own opinions
  about the ambiguous cases.

## Conflicts and pre-existing failures (recorded, not fixed here)

- **`lib/auth/verify.ts` counts moved and only for that reason:** the `<SessionKeeper>` count 22 -> 23
  (the import screen mounts it) and the browser-mutation count 33 files / 37 call sites -> 34 / 38 (the
  one new form). The route/CSRF parity required no edit beyond the one path added to
  `CSRF_PROTECTED_PATHS`, and the per-handler token rule STEP 109 corrected covers the new route
  unchanged.
- `node lib/auth/verify.ts` still reports one problem that is not from this STEP and was present on
  `main`: "the server has one door ... and no third module dials" - the expected list omits
  `storage/http.ts`, added by STEP 100-105. It belongs to the auth block and this STEP left it alone.
- **`UNSUPPORTED_MEDIA_TYPE`'s shared message is wrong for any non-JSON endpoint.** `lib/errors/codes.ts`
  and `lib/i18n/strings/en.ts` (both another block's) say "This endpoint accepts JSON request bodies
  only". This STEP did not change that message - it changed its own route to refuse with a field and a
  rule instead. A later STEP that adds a second non-JSON endpoint should give the code a neutral
  sentence, and this handoff records the reason.
- The `client.created` audit entries the import writes cannot be distinguished from form-created ones
  by action name; the `client.imported` summary is what marks the run. A later STEP that wants to show
  "imported" on a client would need a column `0019` does not have, which is a schema decision and not a
  decision this STEP could take.

## Next

- **Next STEP:** 111 - CSV import for products with per-row error reporting.
- **What the next chat must know:** the two halves of section 15's import are one design.
  `services/clients/csv.ts` is the reader and **should be reused as-is** by the product import rather
  than copied: it knows nothing about clients, its refusals are already worded, and its record carries
  the line number the report needs. `services/clients/client-import.ts` is the shape to follow - map
  the header, then hand each row to the *existing* create service (`createCatalogueEntry` for STEP 111)
  so the two writers cannot disagree, catch a refusal per row and continue, re-throw anything that is
  not the row's fault, and report field-and-rule pairs only. Two details will need product-specific
  answers: a product's code column is `sku` (`CATALOGUE_CODE_COLUMN`), so a duplicate is
  `{field: "sku", rule: "already_used"}` from `CONFLICT`; and a price arrives as text from the file, so
  it must reach `priceToMinor` as the merchant typed it - never through a float, and refused as
  `invalid_format` or `too_large` exactly as the form refuses it. `MAXIMUM_CSV_CHARACTERS` and
  `MAXIMUM_CSV_ROWS` are the reader's; `CLIENT_IMPORT_MAXIMUM_ROWS` (1 000) is this import's own, and
  the product import should choose its own for the same reason.
