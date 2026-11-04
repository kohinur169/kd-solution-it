# STEP 113 — Line item editor with quantity, rate, discount and ordering

**Status: complete.** Delivered in the three sub-steps the user asked for.

| Sub-step | Scope | Commit |
| --- | --- | --- |
| 113a | line write vocabulary — add, edit, remove | `74c57bd` |
| 113b | ordering — adjacent move, collision-free swap | `ef441fd` |
| 113c | the editor UI, i18n, responsive | this commit |

## What ships

### 113a — the write vocabulary

`services/invoices/invoice-lines.ts` adds `addInvoiceLine`, `updateInvoiceLine`, `removeInvoiceLine`, with
routes `POST /api/invoices/[id]/lines` and `POST|DELETE /api/invoices/[id]/lines/[lineId]`.

### 113b — ordering

`services/invoices/invoice-line-order.ts` adds `moveInvoiceLine(direction: "up" | "down")`, route
`POST /api/invoices/[id]/lines/[lineId]/move`.

The swap is **three scoped writes**:

1. park the mover at `max(position) + 1` — the one value no live row holds;
2. move the neighbour into the slot the mover just vacated;
3. move the mover into the neighbour's slot.

Every statement targets a position freed by the previous one, so `invoice_items_position_key` — which is
**not deferrable** — is satisfied after each statement. No loop, no renumber, no migration.

A move past either end is a **no-op answering with the current list**, not an error; an unknown line is a
404. Only adjacent up/down is offered: a general reorder would need every line between the two ends
renumbered, which cannot be done against that index without a deferrable constraint or a full renumber.
Drag-to-reorder is recorded as out of scope rather than half-built.

### 113c — the editor

- `app/(dashboard)/invoices/invoice-line-editor.tsx` — the client editor.
- `app/(dashboard)/invoices/invoice-screens.tsx` — new `InvoiceEditorScreen`.
- `app/(dashboard)/invoices/[id]/page.tsx` — the route.
- `app/(dashboard)/invoices/invoice-form.tsx` — a saved draft now links to its editor, so the editor is
  reachable.

Design decisions:

- **One row open at a time.** The list prints every line as it will appear; tapping one opens its boxes.
  Twenty open rows of seven boxes is a page nobody can find their place in, and this editor corrects one
  line of a document that already exists — unlike the create form, which is writing the whole thing.
- **Every save is its own request.** Four endpoints, four failure sentences. A request that did two would
  have to answer "which half failed".
- **The server's list is adopted whole**, never patched locally — the positions after a removal are the
  server's decision.
- **Amounts are text.** No amount passes through a float; the row's running amount uses the same
  `grossLineMinor` the database's generated column restates, and the gate asserts no `parseFloat`/`Number(`.
- **Boundaries are disabled, not hidden.** "Move up" on the first line reads as "this is the end", where a
  missing button reads as a bug — and the server treats the same request as a no-op, so the two agree.
- **A sent invoice renders read-only**, not a 404: it exists and its lines are visible.

## Gate growth

| Gate | Before | After |
| --- | --- | --- |
| invoice | 299 | **442** |
| i18n | 1947 / 222 | **1980 / 226** |
| structure | 394 files | **401 files** |
| clients | 520 | 520 |
| catalogue | 1029 | 1029 |
| CSRF paths | 55 | **58** |
| auth files / call sites | 36 / 40 | **39 / 46** |
| migrations | 3261 / 111 | 3261 / 111 (unchanged) |

### One gate strengthened, and a real gap closed

The auth gate counted a "browser mutation" as a file containing `method: "POST"`. The two browser files
that only ever **delete** — `clients/[id]/delete-client-form.tsx` and
`products/delete-catalogue-form.tsx` — therefore entered neither list, and *nothing* asserted they carried
the CSRF token. The line editor is the first file that posts **and** deletes, which is what surfaced it.

The gate now counts `POST` and `DELETE` alike, over 39 files and 46 call sites, and both delete-only forms
are covered for the first time.

## Verification

- `tsc --noEmit` clean, `next lint` clean, `npm run build` clean — `/invoices/[id]` and all four line
  routes registered as dynamic.
- The swap was proved by **temporarily replacing it with a naive two-write swap**, which the fixture's
  unique-index check rejected. The three-write version passes, so the design is load-bearing rather than
  decorative. The fixture checks the whole table after *every* intermediate write under `strictPositions`.
- Runtime probe against a production server: all four line routes answer `csrf_token_invalid` before
  anything else, then `AUTHENTICATION_REQUIRED`; `/invoices/[id]` returns 200 with the editor title and
  the signed-out sentence. Positive paths are proved in the service gate, since a session cannot be minted
  from curl.
- Responsive read from classes (no headless browser): single column, `sm:grid-cols-2` for the money boxes,
  `flex-wrap` on every button row, `min-w-0` + `truncate` on the description so it cannot push buttons off.

## Baseline retained, not widened

`lib/auth/verify.ts`'s one-door check still reports exactly one miss — `lib/storage/http.ts` — unchanged
from before this STEP.

## No migration

STEP 113 adds none. `check:migrations` is unchanged at **3261 / 111**. Adjacent-only ordering was chosen
precisely so that no schema change was needed.

## Files

**New:** `services/invoices/invoice-lines.ts`, `services/invoices/invoice-line-order.ts`,
`app/api/invoices/[id]/lines/route.ts`, `app/api/invoices/[id]/lines/[lineId]/route.ts`,
`app/api/invoices/[id]/lines/[lineId]/move/route.ts`,
`app/(dashboard)/invoices/invoice-line-editor.tsx`, `app/(dashboard)/invoices/[id]/page.tsx`

**Edited:** `services/invoices/invoices.ts` (exported `ParsedLine`, `invoiceLineInputSchema`,
`parseInvoiceLine`), `services/invoices/verify.ts`, `lib/security/csrf.ts` (+3 paths),
`lib/auth/verify.ts` (mutation counting), `lib/i18n/strings/en.ts`,
`app/(dashboard)/invoices/invoice-screens.tsx`, `app/(dashboard)/invoices/invoice-form.tsx`

## Next

STEP 114 — *Decimal invoice calculation engine with discount and totals* (`STEP_PLAN_250.md` line 1442).
