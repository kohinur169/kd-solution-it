# STEP 115 — Invoice numbering service per merchant

**Status: complete.** `FEATURE_LIST.md` §16 line 170 names *"numbering"* among the things an invoice does.
`0022` left the counter explicitly unwritten (*"The counter itself lives in code"*); this STEP is that code.

## STEP

- Number and title: STEP 115 — Invoice numbering service per merchant
- Category: Business STEPs 106-126
- Depends on: STEP 112 (`0022` invoices, the `number` column and its checks), STEP 114 (the totals the
  number will be attached to). Both handoffs read.

## Files

- **Created:**
  - `services/invoices/invoice-numbering.ts` — printing, prefix and next-number parsing, the settings read
    and write, and the take.
  - `app/api/invoices/numbering/route.ts` — `GET` (read the series) and `POST` (save it, CSRF first).
  - `app/(dashboard)/invoices/numbering/page.tsx` — the route.
  - `app/(dashboard)/invoices/numbering/numbering-form.tsx` — the client form with the live preview.
  - `migrations/0114_invoice_numbering.sql` + `.down.sql`.
- **Modified:** `app/(dashboard)/invoices/invoice-screens.tsx` (`InvoiceNumberingScreen`, plus the link that
  makes it reachable), `lib/security/csrf.ts` (+1 path), `lib/auth/verify.ts` (one browser-mutation file and
  one call site), `lib/i18n/strings/en.ts` (+23 messages), `services/invoices/verify.ts`.
- **Owned paths touched:** `services/invoices/`, the invoice components under `app/(dashboard)/invoices/`,
  and this STEP's own migration — matching *"Business STEPs 106-126 own ... services/invoices/ and invoice
  components."*

## Database

- Migrations added: `0114_invoice_numbering.sql`.
- **Rollback verified on a clean database: no — and it must not be reported as yes.** This sandbox has no
  PostgreSQL and no Docker, so the migration cannot be executed. What is proven statically by
  `npm run check:migrations` at **3347 checks / 114 migrations / 87 tables**: numbering contiguous, the
  `.down.sql` pairing present, both files `begin;` … `commit;` and ASCII only, the forward file never
  `drop table`/`truncate`/`delete from`, both new tables carry `id`/`company_id`/`created_at`/`updated_at`/
  `deleted_at`/`version` with a UUID v7 default, RLS enabled and a default-deny policy in the same file, and
  the rollback drops both tables. **It still has to be run against PostgreSQL before this ships.**

### Two tables, not one

| Table | Written by | Why separate |
| --- | --- | --- |
| `invoice_number_settings` | the settings screen, on a click | merchant configuration: prefix, next number, padding, reset rule |
| `invoice_number_counters` | `take_invoice_number`, on every issue | a consumed counter, read and rewritten constantly |

Keeping the counter out of the settings table means an operator editing a prefix cannot disturb the value a
series is counting at, and a table written on every issue is not the table a human edits.

### `take_invoice_number` — where correctness lives

`insert ... on conflict (company_id) do update ... returning` is a **single statement**, so Postgres
serialises two concurrent issues on the counter row: the second waits, then increments what the first wrote.
A service-level `select` followed by an `update` would lose numbers under exactly the load numbering exists
to survive. The `case` inside the update is the yearly reset, and `start_at` is the clamp described below.

## Environment

- Environment variables added: none. Secrets handled: none.

## Packages

- None requested. All arithmetic is integer; no decimal library was needed.

## Behaviour Proof (acceptance checklist)

### The four behaviours in the title, exercised in the gate (631 checks)

| Behaviour | Proof |
| --- | --- |
| Printing | `INV-00001` from prefix `INV`, sequence 1, padding 5. A counter longer than the padding prints in full (`ACME-1234`), so the hundred-thousandth invoice is unique rather than truncated into a duplicate. Every printed form satisfies `0022`'s own number check. |
| Per merchant | Two merchants each take `INV-00001`. The second merchant's counter row carries their own `company_id`; one series per merchant is a `unique (company_id)` constraint, not a convention. |
| Take | `INV-00001`, `INV-00002` — the gate asserts the issued list has no repeat. |
| Reset | A counter left in an earlier period restarts at the merchant's next number rather than continuing last year's series. |

### Three defects found and fixed, each proved by disabling the fix

1. **A merchant with imported history could never issue.** The counter started at the merchant's
   `next_number` (1 by default) while the reuse check refused any number already printed — so a merchant with
   a single imported `INV-00090`, or any history from another system, was blocked from issuing *at all*, with
   no way out through the UI. The take now clamps: `start_at := greatest(next_number, last_used + 1)`.
   Removing the clamp makes the gate die on an unexplained refusal.
2. **A non-incrementing counter duplicates numbers.** With the increment replaced by a no-op the gate reports
   *"no number is issued twice (expected [INV-00001, INV-00002], received [INV-00001, INV-00001])"* — the
   duplicate `0022`'s unique index would reject on the invoice insert, turning a numbering bug into a failed
   send.
3. **A test expectation of mine was wrong**, not the code: I asserted `"0007"` was refused as a next number.
   A merchant typing leading zeros means seven, so the parser reads it as `7n`; only zero itself is refused.

### UI checks

Responsive read from classes (no headless browser in this sandbox): one column, `sm:grid-cols-2` for the
next-number and digits boxes, `max-w-2xl` shell, `px-4` → `lg:px-8`. The preview is a `font-mono` headline
that grows `text-2xl` → `sm:text-3xl`, so the one number the merchant can actually verify is the largest
thing on the page. Keyboard: every input is labelled by `htmlFor`, the yearly reset is a real checkbox that
reveals its month select only when on. Light and dark: theme tokens only.

### API checks on `/api/invoices/numbering` (production build, port 3115)

| Case | Answer |
| --- | --- |
| POST, cross-site (wrong cookie name) | `422` `VALIDATION_FAILED {field:"csrf", rule:"csrf_token_invalid"}` |
| POST, same site, no session | `401` `AUTHENTICATION_REQUIRED` |
| POST, 5 KiB body (limit 4 KiB) | `413` `PAYLOAD_TOO_LARGE` |
| GET, no session | `401` `AUTHENTICATION_REQUIRED` |
| GET, no CSRF token at all | `401` — so the read deliberately requires no token and still requires a session |
| Cross-tenant write | Impossible by construction: the update is scoped `id=eq.…&company_id=eq.…`, and a query missing the scope updates nothing. Proved in the gate. |
| Cross-tenant read | Each merchant reads their own series; the gate asserts the second merchant sees their own defaults, never the first merchant's prefix, and that the query named the actor's own company. |
| Support role save | `PERMISSION_DENIED` (gate) |
| Office role take | `PERMISSION_DENIED` (gate) |
| Next number below one already printed | `VALIDATION_FAILED {field:"next_number", rule:"too_small"}` (gate) |

**Money flow ledger proof:** not applicable. A number is not money and no ledger entry is posted; the
numbering has no effect on any amount.

**Provider sandbox cycle:** not applicable — no provider is touched.

## Verification

- Typecheck `npx tsc --noEmit` — clean. Lint `npm run lint` — clean. `npm run build` — clean;
  `/api/invoices/numbering` and `/invoices/numbering` registered as dynamic.
- Gates: invoice **631** (was 546), i18n **2017 / 227**, structure **407** files, migrations **3347 / 114**
  (was 3303 / 113; +1 migration, +2 tables), CSRF paths **60**, auth browser-mutation files **40** /
  call sites **48** (was 39 / 47).
- Baseline retained, not widened: `lib/auth/verify.ts`'s one-door check still reports exactly one miss
  (`lib/storage/http.ts`).

## Next

- **Next STEP number: 116** — Invoice status workflow transitions with paid invoice edit lock and audit
  entries.
- **The next chat must know:**
  1. **The migration is unproven against a real database.** Run `0114` and its rollback on clean PostgreSQL
     and record the transcript. Nothing else in this STEP is outstanding.
  2. **`takeInvoiceNumber` is the issue path's entry point, and STEP 116 must call it** when a draft leaves
     `draft`. `0022`'s `invoices_issue_check` requires `number` and `issued_at` to be set together with the
     status change, so the sequence is: take the number, then write status + number + `issued_at` in one
     update.
  3. A number is **consumed even on a later failure** — a gap in a series is evident, a duplicate is a legal
     problem. Do not "helpfully" return an unused number to the counter.
  4. `POST /api/invoices` (STEP 112) still writes `number: null` and must keep doing so: a draft has no
     number until it is issued.
  5. The counter table is written only by the function. Nothing outside `0114` may insert or update it.
