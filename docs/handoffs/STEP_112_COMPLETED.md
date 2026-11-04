# STEP 112 — Invoice create form with client and line items

**Status:** complete. `FEATURE_LIST.md` §16, line 170: *"Invoice create, edit, duplicate, void,
numbering, and status workflow: draft, sent, viewed, partially paid, paid, overdue, void."* This STEP
does the **create** half, and only the first of the seven status words: a create writes a **draft**.

## What was built

A merchant picks one of their own clients, adds the lines they are billing, sees the running total, and
saves. What is stored is a draft: no number, no issue instant, no client-visible state. That is not a
limitation of this STEP, it is the only shape `0022` permits for a document that has not been sent.

### New files

| Path | What it is |
| --- | --- |
| `services/invoices/invoice-fields.ts` | The vocabulary of `0022`/`0023`: statuses, units, ceilings, patterns. Every constant names the migration line it repeats. |
| `services/invoices/invoice-totals.ts` | The arithmetic. `(quantity * unit_price_minor)::bigint - discount`, in integers, with PostgreSQL's rounding. |
| `services/invoices/invoices.ts` | The create, the read, and the two selectors. 1101 lines. |
| `services/invoices/verify.ts` | The gate: 299 checks. |
| `app/api/invoices/route.ts` | `POST` — the create. |
| `app/api/invoices/clients/route.ts` | `GET` — the client selector's options. |
| `app/api/invoices/catalogue/route.ts` | `GET` — the "fill from your catalogue" options, per kind. |
| `app/(dashboard)/invoices/invoice-form.tsx` | The client form: line editor, running totals, field-by-field refusals. |
| `app/(dashboard)/invoices/invoice-screens.tsx` | The server screen: session, role, client book, four refusals kept apart. |
| `app/(dashboard)/invoices/new/page.tsx` | Thin wrapper, `force-dynamic`. |
| `app/(dashboard)/invoices/page.tsx` | Redirects to `/invoices/new`; the list is a later STEP's screen. |

### Changed

| Path | Change |
| --- | --- |
| `lib/security/csrf.ts` | `CSRF_PROTECTED_PATHS` 54 → **55**: `/api/invoices`. |
| `lib/i18n/strings/en.ts` | 79 `invoices.*` keys. |
| `lib/auth/verify.ts` | Three counts: session keepers 24 → 25, browser-mutation files 35 → 36, call sites 39 → 40. |

`4243` lines added, `6` removed, 14 files.

## The decisions, and why

**No migration, and that is a decision.** `0022`, `0023` and `0024` already exist and describe the
document completely. `migrations/verify.ts` passed at 111 migrations / 85 tables before and after, and
`package.json` is untouched. This STEP writes no schema.

**The database owns the arithmetic; this module restates it once.** `invoice_items.line_total_minor` is
a generated column and `invoice_items_sync_totals` sums it into the parent, so the service never sends
a money total — the gate asserts that, from the rows the service actually sent, not from how its source
looks. But a form has to show a total before saving, and a merchant who reads one number in the browser
and another on the saved invoice has found a bug either way. So `invoice-totals.ts` states the rule
once, the form and the service both import it, and the gate proves it agrees with an **independent**
implementation of PostgreSQL's cast.

**The rounding is half away from zero, not truncation.** `(quantity * unit_price_minor)::bigint` casts a
`numeric` to `bigint`, and PostgreSQL rounds that cast away from zero. Truncating would be off by a
minor unit on exactly the fractional-hour lines §30 is full of. The gate pins this with cases that
separate the two (`2.5` minor units → `3`, not `2`), each checked against the engine *and* against
the cast model.

**A quantity travels as thousandths internally, and as a decimal on the wire.** `numeric(12,3)` stores
`2.500`; this module carries `2500n` so no quantity is a float. A bug this gate caught: the first draft
sent `2500` straight into the column, which the database reads as *two thousand five hundred units* — a
1000× overstatement on every invoice. The service now sends `thousandthsToQuantity(...)`, and a fourth
decimal is refused rather than silently rounded by the column.

**The invoice-level discount is a second write, and the schema forces it.** `0022` states
`invoices_discount_check: discount_minor <= subtotal_minor`, and a row is checked on insert — when the
invoice has no lines and its subtotal is still the default `0`. So *any* invoice discount on the insert
violates the check; the subtotal only becomes non-zero once `invoice_items_sync_totals` has fired. The
discount is therefore applied once the lines exist, in a scoped update that also carries
`status=eq.draft`, and `invoices_derive_total` recomputes the total from two correct values. The gate
asserts the order of the statements, not just the final number, and asserts that a create with no
discount writes no update at all.

**A failed line insert removes the invoice it wrote.** PostgREST over HTTP has no transaction spanning
two requests, so the compensating action is the honest option: a **soft** delete (the row stays readable,
as `0022` intends for anything payments may point at), scoped to the company, gated on `status=draft`,
and audited as `invoice.abandoned`. Leaving the row would show the merchant a draft for a request that
reported failure.

**The client is read, never trusted.** The body carries a `client_id`; the printed name, email and
address come from the merchant's own book through `getClient`, which applies the role and the company
scope. A client belonging to another merchant and a client that does not exist are the **same 404** — a
403 would confirm the id exists somewhere.

**One validation pass, deliberately.** Every field is judged independently and all failures are
returned at once, ordered as the screen reads them: the invoice's own fields, then `lines[2].unit_price`
style paths per row. A schema that refused a blank description before the quantity was checked would
make a merchant fix one box per save on a list of twenty rows. `lines[10]` sorts after `lines[2]`,
because the ordering is numeric on the index, not a string sort.

**The amounts cross the wire as text.** `JSON.stringify` throws on a `bigint`. The snapshot therefore
carries each amount twice — exact minor units as a decimal string, and the printed major units — and the
gate now proves both that a real snapshot serialises and that no field of an exported snapshot type is a
`bigint`, so a field added later cannot reintroduce the failure.

**The role is `owner`, and it is the client book's own.** An invoice is a document made out of the
client book and the catalogue; an account that may not read a client must not be able to bill one. The
selectors apply that role too, so a non-owner is not offered a client to bill.

## Verification

### Gates

| Gate | Before | After |
| --- | --- | --- |
| `services/invoices/verify.ts` | — | **299 checks** |
| `services/clients/verify.ts` | 520 | 520 |
| `services/products/verify.ts` | 1029 | 1029 |
| `npx tsc --noEmit` | 0 | **0** |
| `npm run lint` | 0 | **0** |
| `npm run build` | green | **green**; `/api/invoices`, `/api/invoices/clients`, `/api/invoices/catalogue`, `/invoices`, `/invoices/new` all registered |
| `check:structure` | 383 files | **394** |
| `check:i18n` | 1874 / 218 | **1947 messages / 222 placeholders** |
| `check:errors` | 202 checks | 202 |
| `check:logger` | 117 checks | 117 |
| `check:migrations` | 3261 checks / 111 migrations | **3261 / 111** — no migration added |
| `lib/auth/verify.ts` | 3 counts | **3 bumped**, 1 pre-existing failure (below) |

### The gate's own findings

The gate failed against its first draft repeatedly, and the failures were the point:

1. **The 1000× quantity bug** — the service sent `2500` into `numeric(12,3)`, which the column reads as
   two thousand five hundred units. Found by the fixture computing line totals independently of the
   module under test. **This was a real money bug in shipping code.**
2. **The invoice-discount impossibility** — the gate refused a legal 100%-off request. Investigating
   showed the schema itself forbids an invoice discount on the insert, which is why the discount is now
   a second write. **A design change forced by `0022`.**
3. **The bigint-in-JSON 500** — found by a one-line probe, not by the gate: every successful create
   would have thrown in `JSON.stringify`. The runtime curl probes could not reach it (no session), so
   the positive path needed a different proof. Fixed, and now guarded by two assertions.
4. **Two-phase validation hid fields** — a Zod failure returned early, so a broken client id masked
   every broken line. Restructured to one semantic pass.
5. **My own arithmetic expectations were wrong in 8 places** — I had multiplied by 1000. The engine was
   right every time; the assertions were rewritten against an independently-computed cast.
6. **Four assertions were over-crude** — a source regex matched Zod schema fields as if they were column
   writes, a doc comment naming `bigint` failed an ASCII/bigint check that should read declarations, and
   two rule expectations (`too_many` for too many lines, `too_long` from Zod's `too_big`) were simply the
   wrong words. Two `refusalOf` helpers also rethrew `PERMISSION_DENIED` as if it were a test failure.

### Runtime, against a freshly rebuilt `next start`

| Request | Answer |
| --- | --- |
| `kd_csrf` cookie (wrong name in a secure build) + matching header | `422` `[{field: "csrf", rule: "csrf_token_invalid"}]` — CSRF first, provably |
| `__Host-kd_csrf` + matching header, no session | **`401 AUTHENTICATION_REQUIRED`** — past CSRF, stopped by the session gate |
| no token at all | `422` CSRF, never a hint about the body |
| 385 KB body | **`413 PAYLOAD_TOO_LARGE`** |
| `GET /api/invoices` | `405` |
| `GET /api/invoices/clients`, `/catalogue` | `401` when signed out |
| response headers | `cache-control: no-store, max-age=0` |
| `/invoices/new` | `200`, `<title>New invoice</title>`, signed-out copy renders instead of the form |
| `/invoices` | `307 -> /invoices/new` |

### Widths

Read from the markup; there is no headless browser here. The screen is `mx-auto w-full max-w-3xl`,
`px-4 sm:px-6 lg:px-8`, title `text-2xl sm:text-3xl` — one column at every width. Inside the form, every
grid is `grid-cols-1` and only pairs at `sm:grid-cols-2` (quantity/price, and the invoice fields), so at
360px nothing is side by side. The line footer is `flex flex-wrap`, so the running total and the remove
button stack rather than overflow. There is no table and therefore no horizontal scroller needed: the
whole form is a vertical stack.

## Recorded, not fixed

`lib/auth/verify.ts`'s one-door check still reports a fourth module, `lib/storage/http.ts`. **This is not
STEP 112's**: neither that file nor the expectation is in this STEP's diff, and it is present at the base
commit `4f7cded`. The right fix is a decision about whether the storage client is a permitted third door
— not a count bump in an unrelated STEP. Only the three counts this STEP legitimately moves were bumped.

## Prerequisite worth recording

The sandbox pins Node v22 while `.npmrc` sets `engine-strict=true` against `"node": ">=26.13.0"`, so a
clean `npm install` fails without `--engine-strict=false`. Nothing in this STEP depends on the newer
runtime, and the flag affects the sandbox only — no repository file was changed for it.

## Next

**STEP 113 — Line item editor with quantity, rate, discount and ordering.** Note that this STEP already
ships a functional editor (quantity, unit price, per-line discount, add/remove, catalogue fill) because a
create form with no way to enter lines could not be exercised; STEP 113 owns the *ordering* controls
(move up/down), the `position` renumbering path, and the edit of an existing draft's lines — the parts
`invoice_items_sync_totals` locks once an invoice leaves `draft`.
