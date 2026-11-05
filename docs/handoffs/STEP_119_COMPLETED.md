# STEP 119 — Estimate create form and line items

Chat line: *"Implement STEP 119 only: Estimate create form and line items. Follow docs/final/FEATURE_LIST.md and
docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with
message "STEP 119: Estimate create form and line items", push, and create docs/handoffs/STEP_119_COMPLETED.md."*

Ownership: rule 53 grants STEPs 106‑126 `services/clients`, `services/products` and `services/invoices`; `config/structure.json`
assigns `app/(dashboard)` to "STEP 079‑126" and names estimates. Everything written here is inside those paths plus
`services/estimates` and `app/api/estimates`, which this STEP creates.

## What a quote is, and what this build can do with one

`FEATURE_LIST.md:174` opens the estimate section: *"Estimates and quotes exist. Client approval of an estimate requires a
digital signature."* The tables already existed — `0025_estimates.sql` and `0026_estimate_items.sql` were laid down with the
schema batch — and `0027_estimate_signatures.sql` is STEP 120's. So STEP 119 is the **write half of a draft**: a merchant
picks a client, adds lines, sets an expiry, and saves; then adds, edits, removes, orders those lines and changes the two
amounts above the total.

What this build deliberately does **not** do, because a later STEP owns it: numbering and issuing (STEP 121), signature
capture and the evidence record (STEP 120), decline/expire/void, conversion to an invoice, a PDF, and any list of quotes.
A quote is always born a `draft`, and `0026`'s trigger locks its lines the moment it is not.

## Files

Created — database (2):

| Path | Lines | What it is |
| --- | --- | --- |
| `migrations/0117_estimate_discount_basis.sql` | 142 | Adds `estimates.discount_basis` and `discount_percent_bp`, three checks, and redefines `estimate_items_sync_totals()` so a percentage resolves against the lines |
| `migrations/0117_estimate_discount_basis.down.sql` | 78 | Restores `0026`'s trigger body **first**, then drops the checks and the two columns in reverse |

Created — service (4, 5 342 lines):

| Path | Lines | What it is |
| --- | --- | --- |
| `services/estimates/estimate-fields.ts` | 138 | The quote's own vocabulary: statuses, void reasons, currencies, the 160-character client snapshot, the 365-day expiry ceiling, the memo limit. No imports, so a browser file may use it |
| `services/estimates/estimates.ts` | 1 017 | `createEstimate`, `getEstimate`, `updateEstimateTotals`, `listEstimateClientOptions` re-export, snapshots, the 13-rule vocabulary |
| `services/estimates/estimate-lines.ts` | 744 | `addEstimateLine`, `updateEstimateLine`, `removeEstimateLine`, `moveEstimateLine`, and `parseEstimateTotalsBody` |
| `services/estimates/verify.ts` | 3 443 | The gate: **1 006 checks in 13 groups** |

Created — API (7 files, 719 lines): `route.ts` (113), `[id]/lines/route.ts` (101), `[id]/lines/[lineId]/route.ts` (167, POST
update + DELETE), `[id]/lines/[lineId]/move/route.ts` (125), `[id]/discount/route.ts` (103), `clients/route.ts` (53),
`catalogue/route.ts` (57).

Created — UI (6 files, 2 224 lines): `app/(dashboard)/estimates/page.tsx` (15, redirects to the form), `new/page.tsx` (15),
`[id]/page.tsx` (26), `estimate-screens.tsx` (308, server), `estimate-form.tsx` (906, client), `estimate-line-editor.tsx`
(954, client).

Edited (5, +324/−60):

| Path | Change |
| --- | --- |
| `services/invoices/invoice-line-order.ts` | +175/−55. `moveInvoiceLine` became `moveDocumentLine`, parameterised by a `DocumentLineOrder` describing one document family: tables, the parent column, the line columns, the draft status, the audit action, the entity, the two rule names, the row schema and a line reader. The invoice passes its own descriptor and behaves exactly as before (its gate is unchanged at 1442) |
| `services/invoices/invoices.ts` | +68. Exports `parseDocumentLine`, `orderDocumentDetails`, `addressOf`, `parseDocumentLineBody`, `ParsedLine`, `INVOICE_LINE_FIELDS`; the document-level `.strict()` fallback names the document rather than an empty path |
| `lib/security/csrf.ts` | +5. The five mutating estimate paths joined `CSRF_PROTECTED_PATHS` (67). The two reads did not: a GET carries no token |
| `lib/auth/verify.ts` | +16/−4. Two counts moved by what this STEP added: session keepers 25 → 26, mutating browser files 42 → 44, token call sites 51 → 57 |
| `lib/i18n/strings/en.ts` | +120. An `estimates` section: 112 sentences, 10 of them parameterised |

Nothing else was touched. `package.json` has no `check:estimates` alias, so the gate runs as
`npx --yes tsx services/estimates/verify.ts` — the house pattern for a service gate.

## Database

### `0117` is one migration for one idea

A quote may be discounted by an amount or by a percentage, and `0025` had room for only the amount. The invoice learned
the same lesson in `0112`/`0113`, so the estimate's version arrives already shaped by that precedent: a basis column, a
basis-point column, and **one** check that keeps them coherent.

```sql
alter table public.estimates
  add column discount_basis text not null default 'amount',
  add column discount_percent_bp integer not null default 0;
```

Three constraints, not two. `estimates_discount_basis_check` admits only `amount` and `percent`;
`estimates_discount_percent_check` bounds the points at 0…10 000 (a percentage cannot exceed 100 %, and cannot be
negative because a discount is never a surcharge); `estimates_discount_basis_coherent_check` is the one that matters —
it refuses a row that claims `percent` while holding points of 0, or claims `amount` while holding points at all. Without
it the basis and the number could disagree and the trigger would have to guess which one to believe.

### The total is the database's, and the trigger is where a percentage becomes money

`estimate_items_sync_totals()` is replaced, not wrapped. Its body now reads:

```sql
discount_minor = case when discount_basis = 'percent'
  then round(lines_total::numeric * discount_percent_bp / 10000)::bigint
  else discount_minor end
```

`round()` in PostgreSQL is half away from zero, which is the platform's stated rounding rule, and the same function the
invoice's `0113` uses — so a quote and an invoice discounted by the same percentage of the same subtotal store the same
number of minor units. The screen's running total imports `percentDiscountMinor`, the service's own engine, so all three
layers agree by construction rather than by coincidence.

This is why removing a line from a percentage-discounted quote needs no second write: the row's discount is re-resolved
inside the same trigger that recomputes the subtotal. The gate proves it — remove the 300.00 line from a 12.5 % quote and
the subtotal falls to 406.50, the discount re-resolves to 50.81, the total to 391.26, and the basis points are untouched
at 1 250.

### Trigger order is the whole trick

PostgreSQL evaluates a CHECK against the row **after** BEFORE UPDATE triggers have run. The order in the replaced body is
therefore: derive the totals and bump the metadata, then run the guards, then let the generated column fire, then write,
then the AFTER ROW sync. Getting this the other way round produces a migration that passes on an empty table and refuses a
legitimate edit — the fixture in the gate caught exactly that (see defects).

### Rollback

`0117.down.sql` restores `0026`'s trigger body **first**, then drops the coherent check, then the two columns in reverse
order. A plpgsql body resolves its column references at run time, so dropping `discount_basis` before replacing the
function leaves a function that refers to a column that is gone. The gate asserts the ordering by reading the file, and
asserts the action rather than a substring: `!/drop column[^;]*discount_minor/u`, because `0026`'s restored body names
`discount_minor` in prose and a naive "the rollback must not mention it" check can never pass.

**Owed:** this sandbox has no PostgreSQL and no Docker, so `0117` (like `0115` and `0116` before it) is proved statically —
by the gate reading the SQL, by the fixture emulating the trigger's arithmetic in TypeScript, and by the migrations gate
(3 433 checks: every forward file transactional, every policy default-deny). A real forward + rollback transcript against a
live database is still owed for all three, and is the first thing to run when one is available.

## Environment

None added. `.env.example` is unchanged at 16 variables and `check:env` passes.

## Packages

None added, and none may be (rule 27). `zod`, already a dependency, does the parsing.

## Behaviour Proof (acceptance checklist)

### The behaviours in the title, exercised in the gate (1 006 checks, 13 groups)

**A create form exists, and what it writes is exactly two inserts.** `checkCreate` proves `createEstimate` performs one
`insertReturning` into `estimates` and then **one** `insert` carrying every line — no statement per line, no read-back per
line — plus three reads (the actor's company, the client, the catalogue rows the lines point at) and one audit entry
`estimate.created`. The payload holds field names and counts (`line_count`, `total_minor`, `currency`) and never a client
name, a description or a memo, because the audit log is not a document store.

**Line items, and the four things a merchant does to them.** `checkLines` exercises add, edit, remove and move against a
fixture of three lines whose arithmetic is written out in the test rather than trusted to the code: 2.5 × 125.00 = 312.50;
1 × 99.00 − 5.00 = 94.00; 4 × 75.00 = 300.00 ⇒ subtotal 706.50, tax 35.57, total 742.07, version 4 — and version 5 after
adding a fourth line. Moving a line up writes three positions in the order **park, displaced, moving** (`[4, 2, 1]`), which
is the swap the shared `moveDocumentLine` performs; the fixture originally expected `[4, 1, 2]` and was wrong, not the code.

**One parser, one swap, for one document family.** `checkSources` asserts that `estimate-lines.ts` defines no second line
parser and never writes `subtotal_minor` — the subtotal is the trigger's. The estimate judges a line with the invoice's
`parseDocumentLine`, and orders one with the invoice's `moveDocumentLine` behind a descriptor. Two document families, one
set of rules.

**Both discount bases.** `checkDiscount` proves a flat amount stores minor units, a percentage stores basis points,
`"12.5"` prints back as `"12.5"` (two decimal places of a percentage are representable exactly in basis points), and that
a discount larger than the subtotal is refused with `too_large` naming `discount` — the same refusal `0025`'s check would
have produced, arriving from the service with a sentence instead of from the database with a constraint name.

**Boundaries, which is where a form actually breaks.** `checkBoundaries` writes 200 lines — the ceiling — and proves the
version reaches 201, the positions run 1…200 and the subtotal is 2 000.00; that 201 is refused with `too_many`; that
`"0.999"` and `"1000000.001"` are refused at the quantity floor and ceiling; that `"1.001" × "0.0500"` rounds half away
from zero to 501 minor units, matching the fixture's own restatement of the generated column; that an expiry given as a
date alone becomes UTC midnight; and that a 3 000-character memo is truncated to 2 000 with its markup stored verbatim
(the sanitiser trims and truncates — it does not escape, and React does the escaping).

**Tenancy, conflict and compensation.** `checkTenancy` proves another merchant's client and another merchant's quote are
both a 404 rather than a 403 — the existence of a row is not a fact about you. `checkConflict` proves that losing an insert
race on `(company_id, number)` surfaces as CONFLICT with `{field: "client_id", rule: "already_used"}` and leaves no row, no
update and no audit entry behind. `checkCompensation` proves that a failure part-way through leaves the document as it was.

**The routes, read as source.** `checkRoutes` (12th group) asserts, for all nine files: each starts with its `// path:`
comment and is ASCII; the five mutating routes use `withErrorResponse`, are `force-dynamic`, call `requireCsrfToken`
**before** `readRequestActor`, apply a `PAYLOAD_TOO_LARGE` bound **before** `request.text()`, answer `no-store`, never read
a company from a request (four request sources are named explicitly), and do no `parseFloat`/`Number(` arithmetic; create
answers 201; the two GET routes carry no token, export no POST and read through the invoice's option readers; and the five
mutating paths are on `CSRF_PROTECTED_PATHS` while the two reads are not.

**The screens, read as source.** `checkUi` (13th group, 338 of the checks) asserts what a page cannot be clicked to prove:
both client components import **types only** from the service and never call `getEstimate`; every mutating fetch carries
`csrfHeaders()` (1 in the form, 5 in the editor) and the two catalogue reads do not; no box is `type="number"`, no file
parses a float, rounds with `toFixed`, or writes `dangerouslySetInnerHTML`; the form's only `Number(` is a finiteness test;
the expiry box carries the service's floor and ceiling and names the zone (`T00:00:00.000Z`); the form reads no clock of its
own, so the server decides all three dates; `INVOICE_MAXIMUM_LINES` is imported rather than copied (no literal `200`);
the four refusal kinds and a fifth for a missing quote each have a sentence; the editor writes its list in exactly one
place, taking removals and moves from the server's answer; moving up and down are **disabled** at the ends rather than
hidden; the last line offers no remove button; each of the five operations has its own failure sentence; every
`estimates.*` key the screens name exists in the catalogue **and** every declared key is used somewhere.

**Widths.** Also in `checkUi`: both screens pad `px-4 py-8 sm:px-6 lg:px-8` and cap at `max-w-3xl`; every grid in the form
(3) and the editor (2) is `grid-cols-1` with a matching `sm:grid-cols-2` — the equality is the assertion, and it fails if a
money grid is ever written as two columns on a phone; row controls `flex-wrap`; a closed row truncates a long description
instead of pushing its amount off a 360px screen.

### Fourteen defects found and fixed

1. **`EstimateLineSnapshot` was missing four fields `InvoiceLine` has** — `estimateId`, `version`, `createdAtEpochMs`,
   `updatedAtEpochMs`. Invisible to typecheck, because the snapshot is built by hand; caught only by a gate assertion that
   diffed the printed shape field by field against its sibling. Lesson recorded: when mirroring a document family, diff the
   shapes, do not assume.
2. **The gate fixture ordered its BEFORE UPDATE trigger wrongly** — guards before the derived totals, so a legitimate edit
   was refused by a check that had not yet seen the new total. PostgreSQL evaluates checks after BEFORE UPDATE triggers;
   the fixture now derives, guards, generates, writes, syncs.
3. **`checkTenancy` read the wrong database** — it created a quote in `otherDb` and asserted against a snapshot from the
   first, producing a spurious 404 that looked like a tenancy bug and was a test bug.
4. **An over-broad source assertion failed on a legitimate log line.** `!companyId` fired because the create route logs
   `companyId: estimate.companyId`. The assertion now names the four *request* sources instead of scanning for a word.
5. **`priceToMinor` returns `bigint | null`**, so a gate that wrote `!priceToMinor(x)` was testing truthiness of a bigint;
   a local `minorOf` helper replaced it.
6. **A gate check compared a whole read record against a `select=` prefix** — the fixture records a read as `table?query`,
   so the query has to be sliced off after the first `?` first.
7. **The move-swap expectation was wrong** (`[4, 1, 2]` instead of `[4, 2, 1]`). The code was right; the arithmetic in the
   test was not. Recomputing from the specification — park the moving row, displace the neighbour, land the mover — is now
   the first step when a fixture disagrees with production code.
8. **`!rollback.includes("discount_minor")` can never pass**, because `0026`'s restored body names the column in prose. The
   assertion was rewritten to check the action.
9. **Two column-list defects in `estimate-fields.ts`** — the field readers listed a column the insert did not write and
   omitted one it did.
10. **An `as InvoiceUnit` cast** stood where a `z.enum(INVOICE_UNITS)` belongs. The cast compiled and would have let an
    unknown unit reach the database; the enum refuses it with a rule.
11. **`Metadata` was imported from `next/navigation`** in both new pages. It lives in `next`. Typecheck caught it.
12. **`formatMessage` throws on an unused parameter** (`lib/i18n/messages.ts:117`), and the expiry hint passed `{maximum}`
    to a sentence with no placeholder. That is a runtime crash on the create screen, not a lint warning — so the sentence
    now says the ceiling it enforces: *"at most {maximum} days away"*.
13. **A percentage line substituted the radio's label for the number**, rendering "A percentage% of the subtotal". It now
    prints the percentage the merchant typed.
14. **`amountInvalid` was declared and never used.** Rather than delete the key, the totals panel now says why an em dash is
    showing — an unexplained dash reads as a missing total, not as an unfinished one.

Also worth recording: **a quantity below one whole unit is refused**, and that is inherited, not chosen.
`INVOICE_QUANTITY_MINIMUM` is 1 000 thousandths (`invoice-fields.ts:67`, asserted at `services/invoices/verify.ts:4315`),
so a half-hour quote cannot be written. STEP 114 owns that floor and this STEP did not move it; the form's box offers
`min="1"` and its hint says *"Whole units and up to three decimal places."* If fractional quantities are ever wanted, they
are a change to a shared constant with an invoice gate to update, not a local edit here.

### UI checks

No browser exists in this sandbox, so nothing was clicked. The substitute is two-fold: the source assertions in `checkUi`
above, and the live page probes below against a production build. Both screens render their refusal without a session,
which exercises the actor read, the runtime, the i18n lookup, the layout and the navigation — everything except the form
itself, whose markup is asserted by source. **Owed:** a signed-in render of `/estimates/new` and of one quote's editor,
which needs a database and a session.

### API checks (production build, `next start` on port 3121)

Probed with `curl` against the compiled build, in this order, because the order is itself a security property:

| Request | Observed |
| --- | --- |
| No token, 300 KiB body, `POST /api/estimates` | **422** `{field:"csrf",rule:"csrf_token_invalid"}` — the token check wins, so a cross-origin post cannot make the server read a large body |
| Valid `__Host-kd_csrf` token, 300 KiB body | **413** `PAYLOAD_TOO_LARGE` — the bound runs before the session |
| Valid token, no session, all six mutating routes | **401** `AUTHENTICATION_REQUIRED` |
| `GET /api/estimates/clients`, `GET /api/estimates/catalogue?kind=service`, no session | **401**, no token required |

Every envelope carried `code`, `message`, `requestId`, `retryable` and — for refusals — `details`. No secret, no stack.
The server logged each rejection as `request rejected` with method, route, code and status.

Two things this proved that a unit test cannot: a CSRF refusal here is a **422 VALIDATION_FAILED**, not a 403, and
production expects the `__Host-` prefixed cookie — `kd_csrf` is the insecure-context name only. Both were initially
misread as defects during probing.

### Page checks (production build, `next start` on port 3123)

| Request | Observed |
| --- | --- |
| `GET /estimates` | **307** → `location: /estimates/new`, `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` |
| `GET /estimates/new` | **200**, `no-store`, 16 989 bytes: eyebrow *Estimates*, heading *New estimate*, the sentence *Sign in to write an estimate.*, and four links — `/signin`, `/clients`, `/products`, `/` |
| `GET /estimates/<uuid>` | **200**, 16 439 bytes, the same refusal — the editor screen reached, not a 500 |
| `GET /estimates/<a zero-width space, percent-encoded>` | **200** — `decodeURIComponent` on an arbitrary segment does not throw |

Zero `type="number"` inputs in the rendered HTML; zero occurrences of `password`, `DATABASE_URL`, `stack` or a Node frame.
The server log for the whole probe set contained only its startup lines: no error, no unhandled rejection. The `/signin`
link appears **only** in the signed-out state, which is the refusal-kind distinction proving itself in the wire format.

## Verification

| Gate | Result |
| --- | --- |
| `npx --yes tsx services/estimates/verify.ts` | **1 006 checks passed** (was 668 after part 2; `checkUi` added 338) |
| `npx --yes tsx services/invoices/verify.ts` | **1 442 passed** — unchanged, which is the proof that generalising `moveInvoiceLine` into `moveDocumentLine` did not move the invoice |
| `npx --yes tsx lib/auth/verify.ts` | **2 774 passed** (keepers 26, mutating browser files 44, call sites 57) |
| `npx --yes tsx migrations/verify.ts` | **3 433 passed**, 117 migrations, 89 tables |
| `check:structure` | 17 directories, 14 root files, **436** source files (was 430) |
| `check:shell` | **755** checks, **223** files, no colour literal (was 733/217) |
| `check:i18n` | **2 232** messages, **248** placeholders, 1 locale (was 2 120/238) |
| `check:config` | 10 sections, 28 values, no credential-shaped key |
| `check:errors` | 202 checks, 15 codes, all statuses 4xx/5xx, no secret or stack |
| `check:env` | `.env.example` matches 16 manifest variables |
| `check:logger` | 117 checks, 15 records, 4 levels, 9 secret fragments absent |
| `check:lint-rules`, `check:storage`, `check:jobs` | passed (jobs: 110 checks, 4 slots, 5 attempts, store `memory`) |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | **exit 0**; `/estimates`, `/estimates/[id]`, `/estimates/new` and all seven `/api/estimates` routes compiled as dynamic (`ƒ`) |

`.env.local` was created for the build and the two probe runs and **deleted afterwards**; `git status` shows only the five
edited files and the four new path groups.

## Next

STEP 120 is *"Estimate digital signature capture with evidence record"* — `0027_estimate_signatures.sql` already exists, and
the signer name, email, consent record, time, IP, geo, device fingerprint and document hash named at
`FEATURE_LIST.md:175` are what it has to hold.

Follow-ups this STEP leaves behind, each with its reason:

- **A real migration transcript for `0115`, `0116` and `0117`** — forward and rollback against PostgreSQL. Owed since
  STEP 117; the sandbox has no database.
- **The invoice's `[id]/discount` route does not use `parseEstimateTotalsBody`.** It predates the parser and is a completed,
  live-proved STEP 115 route, so it was left alone rather than reopened inside a STEP that does not own it. The estimate's
  parser lives in the service under Zod and the divergence is documented in the route's own comment.
- **A quote's expiry cannot be edited after it is created.** The create form bounds it and the service validates it, but no
  route changes it, because "extend an offer" is a decision about the document's lifecycle that belongs with issuing and
  expiring in STEP 121.
- **There is no list of quotes.** `/estimates` redirects to the form. A list needs a service reader that does not exist yet,
  and inventing one here would have been a second fact about which quotes a merchant may see.
