# STEP 114 — Decimal invoice calculation engine with discount and totals

**Status: complete.** `FEATURE_LIST.md` §16 line 171: *"Line items can be added, edited and ordered
correctly. Full discount support."* STEP 113 made the lines editable; this STEP makes the numbers above
them real.

## STEP

- Number and title: STEP 114 — Decimal invoice calculation engine with discount and totals
- Category: Business STEPs 106-126
- Depends on: STEP 112 (invoice create, `0022`), STEP 113 (`0023` line editor). Both handoffs read.

## Files

- **Created:**
  - `services/invoices/invoice-discount.ts` — the basis vocabulary, percentage parsing, the resolution and
    its rounding, and the guard that keeps a stored discount inside its subtotal.
  - `app/api/invoices/[id]/discount/route.ts` — `POST`, CSRF first, 2 KiB body bound.
  - `migrations/0112_invoice_discount_basis.sql` + `.down.sql` — the two columns and their three checks.
  - `migrations/0113_invoice_discount_reresolve.sql` + `.down.sql` — replaces `invoice_items_sync_totals`
    so a percentage follows the subtotal.
- **Modified:** `services/invoices/invoices.ts` (row schema, parse, create, snapshot),
  `services/invoices/invoice-lines.ts` (the totals update, and the guard on edit/remove),
  `services/invoices/invoice-totals.ts` (re-export surface unchanged, `selectInvoiceTotals` lives in the
  discount module), `services/invoices/verify.ts`, `lib/security/csrf.ts` (+1 path),
  `lib/auth/verify.ts` (one call-site count), `lib/i18n/strings/en.ts` (+14 messages),
  `app/(dashboard)/invoices/invoice-form.tsx`, `app/(dashboard)/invoices/invoice-line-editor.tsx`.
- **Owned paths touched:** all under `services/invoices/`, the invoice components under
  `app/(dashboard)/invoices/`, and this STEP's own two migrations — matching *"Business STEPs 106-126 own
  services/clients/, services/products/, services/invoices/ and invoice components."*

## Database

- Migrations added: `0112_invoice_discount_basis.sql`, `0113_invoice_discount_reresolve.sql`.
- **Rollback verified on a clean database: no — and it must not be reported as yes.** This sandbox has no
  PostgreSQL server and no Docker (`which psql postgres pg_ctl initdb docker` returns nothing), so neither
  migration can be executed. What *is* proven, statically, by `npm run check:migrations` at **3303 checks /
  113 migrations**: numbering is contiguous, every forward file has its `.down.sql` and vice versa, both are
  `begin;` … `commit;` and ASCII only, the forward files never `drop table`/`truncate`/`delete from`, and
  `0112`'s rollback drops the three constraints and the two columns it added. `0113`'s rollback restores
  the `0023` body verbatim. **The migration and rollback still have to be run against PostgreSQL before
  this STEP is considered deployable.**

### Why two migrations and not one

`0112` could add the columns; it could not change what the trigger does. A percentage discount is only
meaningful if it is re-resolved when the subtotal moves, and that is `invoice_items_sync_totals`' job.
Migrations are append-only, so `0023` may not be edited — `0113` replaces the function with
`create or replace`. The gate asserts both halves of that: `0113` contains the new body, and `0023` still
contains the old one unchanged.

## Environment

- Environment variables added: none.
- Secrets handled: none.

## Packages

- None requested. The arithmetic is integer `bigint` throughout; no decimal library was needed, and rule 2's
  requirement that money never passes through a float is met by construction rather than by a dependency.

## Behaviour Proof (acceptance checklist)

**The four behaviours in the title, exercised in the gate (546 checks) and observed:**

| Behaviour | Proof |
| --- | --- |
| Decimal arithmetic | `percentToBasisPoints("0.29")` is `29n`; the gate also asserts that `Number("0.29") * 100 !== 29`, so the float path this avoids is shown to be genuinely wrong. `percentDiscountMinor` rounds half away from zero: 10% of 12.35 → 124, not 123. |
| Discount, both bases | A flat amount is the money typed and is never re-resolved; a percentage is a share of the subtotal and follows it. `resolveDiscount` answers both, so no caller can pick the wrong one. |
| Totals | `selectInvoiceTotals` chains subtotal → resolved discount → tax and asserts the whole document: 2.5×125.00 plus 1.00×1.00 less 0.10 = 313.40, less 10% = 282.56. |
| Rounding agreement | A line's gross and an invoice's percentage both round half away from zero, asserted against each other, so one document cannot round two ways. |

**Two real defects found and fixed, each proved by disabling the fix:**

1. **A stale percentage.** With `0113` modelled but the re-resolution removed, the gate fails with
   *"and the percentage re-resolved: ten percent of 10.00 is 1.00, not the 2.00 it was worth on 20.00"*.
   The client was being charged the stale share.
2. **A latent 500 on line removal.** `invoices_discount_check` is `discount_minor <= subtotal_minor`, and
   the trigger recomputes the subtotal on every line change. A draft with a flat discount larger than its
   remaining lines used to fail the parent's own UPDATE — the merchant saw a 500 and could not remove the
   line. The fixture's `syncSubtotal` now models that check (it did not, which is why the gate had approved
   this failure mode since STEP 113), and the removal is refused as `CONFLICT {field:"discount",
   rule:"too_large"}` — actionable, and it succeeds once the discount is reduced. With the guard disabled
   the gate dies on an unexplained `RESOURCE_NOT_FOUND`.

**UI checks:** responsive read from classes (no headless browser in this sandbox): the basis is a
`flex-wrap` radio pair, the discount/tax boxes are `grid-cols-1 sm:grid-cols-2`, and the panel is locked once
`draftLocked`. Desktop and 360px widths both hold one column of money boxes. Keyboard: both bases are real
`<input type="radio">` in a named group, so arrow keys move between them; every label is bound by `htmlFor`.
Light and dark: only theme tokens (`bg-background`, `text-foreground`, `text-destructive`) are used.

**API checks on `POST /api/invoices/[id]/discount` (production build, port 3114):**

| Case | Answer |
| --- | --- |
| Cross-site post (wrong cookie name) | `422` `VALIDATION_FAILED {field:"csrf", rule:"csrf_token_invalid"}` |
| Same site, no session | `401` `AUTHENTICATION_REQUIRED` |
| 3 KiB body | `413` `PAYLOAD_TOO_LARGE` |
| Cross-tenant invoice id | `RESOURCE_NOT_FOUND` (gate) — never a 403 that confirms existence |
| Office role | `PERMISSION_DENIED` (gate) |
| Invoice past draft | `CONFLICT {field:"status", rule:"already_changed"}` (gate) |

**Money flow ledger proof:** not applicable. This STEP posts no money and touches no ledger; it computes
the totals a future payment STEP will charge against.

**Provider sandbox cycle:** not applicable — no provider is touched.

## Verification

- Typecheck: `npx tsc --noEmit` — clean.
- Lint: `npm run lint` — clean.
- Build: `npm run build` — clean; `/api/invoices/[id]/discount`, `/invoices/[id]` and `/invoices/new`
  all registered as dynamic routes.
- Gates: invoice **546** (was 442), i18n **1994 / 227**, structure **403** files, clients **520**,
  catalogue **1029**, migrations **3303 / 113** (was 3261 / 111, +2 migrations), CSRF paths **59** (was 58),
  auth browser-mutation files **39** / call sites **47** (was 46).
- Baseline retained, not widened: `lib/auth/verify.ts`'s one-door check still reports exactly one miss
  (`lib/storage/http.ts`).

## Next

- **Next STEP number: 115** — Invoice numbering service per merchant.
- **The next chat must know:**
  1. **The two migrations are unproven against a real database.** Run `0112`/`0113` and their rollbacks on
     clean PostgreSQL and record the transcript before this ships. Nothing else in this STEP is outstanding.
  2. A percentage discount is resolved by the **trigger**, not by the service. Any future STEP that changes
     lines must not "helpfully" recompute the discount: `invoice_items_sync_totals` already does, and a
     second opinion is the stale-amount bug this STEP fixed.
  3. The invoice-level discount and tax are edited through `POST /api/invoices/[id]/discount`. The create
     path still writes the discount as a second statement after the lines exist, because
     `invoices_discount_check` cannot be satisfied on a row whose subtotal is still zero.
  4. Drag-to-reorder remains out of scope (STEP 113's note stands); so does a general `position: n` move.
