// path: docs/handoffs/STEP_116_COMPLETED.md
# STEP 116 - Invoice status workflow transitions with paid invoice edit lock and audit entries: completed

Branch `arena/17762737-kd-solution-it`. This handoff and the STEP 116 code are in one commit, the
one whose message is "STEP 116: Invoice status workflow transitions with paid invoice edit lock and
audit entries" (`git log -1` on the branch shows its hash). Previous handoff:
`docs/handoffs/STEP_115_COMPLETED.md`.

## STEP

- **Number and title:** STEP 116 - Invoice status workflow transitions with paid invoice edit lock
  and audit entries (`docs/final/STEP_PLAN_250.md`, the STEP 116 block).
- **Category:** Business, STEPs 106-126.
- **Owned paths (File Ownership Rules):** "Business STEPs 106-126 own `services/clients/`,
  `services/products/`, `services/invoices/` and invoice components." This STEP used
  `services/invoices/` (the new `invoice-status.ts`, the paid rule in `invoice-lines.ts` and
  `invoice-line-order.ts`, the snapshot fields in `invoices.ts`, the label helper in
  `invoice-fields.ts`, the gate in `verify.ts`) and the invoice components
  (`app/(dashboard)/invoices/`, `app/api/invoices/`).
- **Feature list:** section 16 - line 170 "Invoice create, edit, duplicate, void, numbering, and
  status workflow: draft, sent, viewed, partially paid, paid, overdue, void"; line 181 "A paid
  invoice is locked and cannot be edited"; and the section's audit requirement that every state of
  the document is a recorded step, not an `updated_at`.
- **Depends on:** STEP 021/022 (the table, the seven statuses, `invoices_status_money_check`,
  `invoices_issue_check`, the two instant checks, `invoices_guard_paid`), STEP 024 (`0024`'s
  `invoice_events` timeline, with `sent` and `voided` already in its vocabulary), STEP 115
  (`takeInvoiceNumber` - this STEP's send path calls it, as the 115 handoff directed), STEP 112-114
  (the draft the workflow moves, and the line editor it locks).

## Migration added, and the rollback proof

- **None.** `0022` already carries the whole workflow in constraints and the paid freeze in
  `invoices_guard_paid`; `0024` already carries the timeline and its append-only guard; `0114`
  already carries the counter the issue path spends. This STEP is the application half, and it added
  no schema. `npm run -s check:migrations` passed unchanged.

## Files

- **Created:** `services/invoices/invoice-status.ts`, `app/api/invoices/[id]/send/route.ts`,
  `app/api/invoices/[id]/void/route.ts`,
  `app/(dashboard)/invoices/invoice-status-actions.tsx`, `docs/handoffs/STEP_116_COMPLETED.md`.
- **Modified:** `services/invoices/invoice-lines.ts` (`paid_locked` rule in `requireDraftParent`),
  `services/invoices/invoice-line-order.ts` (an optional `lockedStatus`/`lockedRule` in the shared
  document configuration, set by the invoice family), `services/invoices/invoices.ts` (the snapshot
  now carries `number` and `issuedAt`), `services/invoices/invoice-fields.ts` (one status-label key
  map), `services/invoices/verify.ts` (the `invoice_events` table and `0022`'s state checks in the
  fixture, plus `checkStatusWorkflow`), `app/(dashboard)/invoices/invoice-screens.tsx` (the labeled
  status, the number cell, the action bar), `lib/i18n/strings/en.ts` (the workflow's sentences).

## Behaviour

- **The graph** (`INVOICE_STATUS_TRANSITIONS` in `invoice-status.ts`): the seven states in one
  frozen table - `draft → sent, void`; `sent → viewed, partially_paid, paid, overdue, void`;
  `viewed → partially_paid, paid, overdue, void`; `partially_paid → paid, overdue, void`;
  `overdue → viewed, partially_paid, paid, void`; `paid` and `void` terminal. It is read against
  `0022`'s checks, which it never contradicts, and it is the same table the screen reads when it
  decides which buttons to offer, so a button the service would refuse never appears.
- **The engine** (`applyTransition`, private): every move - now and the ones STEP 123, 124 and the
  client's view will add - is performed the same way: the paid lock checked first (its own rule,
  before the generic graph rule), the graph checked, one guarded update whose predicate carries the
  status just read, a **re-read** because PostgREST reports a zero-row update as success, one row in
  `invoice_events` and one entry in `audit_logs`. Each caller supplies the columns its move writes
  in the same statement (the number and the issue instant for a send, the void instant for a void)
  and the facts its move records.
- **Send** (`sendInvoice`, `POST /api/invoices/[id]/send`): the draft is read, and if it has left
  `draft` the refusal is `already_changed` before the counter is touched. Otherwise
  `takeInvoiceNumber` spends the next number, and status + number + `issued_at` go out in one update
  - the sequence `invoices_issue_check` demands. A number spent on a failed send stays spent: a gap
  is evident, a duplicate is a legal problem.
- **Void** (`voidInvoice`, `POST /api/invoices/[id]/void`): any open state to `void`, with the void
  instant in the same statement. The reason is the merchant's optional words for the timeline
  (`invoice_events.detail`, trimmed, at most 200 characters) - it is never written to the document
  (which has no reason column) and never echoed in the response or the log. A paid document is
  refused with `paid_locked` before anything is read beyond the row; a voided one with
  `already_changed`.
- **The paid lock, at every edit path:** `requireDraftParent` in `invoice-lines.ts` answers a paid
  parent with `paid_locked` (the other non-draft states keep `already_changed`), and the shared
  line-order helper carries the same rule through `lockedStatus`/`lockedRule` for the invoice
  family. `invoices_guard_paid` in the database remains the authority behind all of it; the service
  checks turn its exception into the sentence the section says.
- **The screen** (`/invoices/[id]`): the status is labeled, the number and issue instant print once
  they exist, and the action bar offers exactly what the graph allows from the status the server
  just reported - send and void for a draft, void for an open document, and for a paid or voided
  document no button at all, with the reason in words. Refusals are told apart: a dead session, a
  role the service will not act for, a document that moved mid-flight (reload), a bad reason field.
- **The two entries:** a send writes `invoice.sent` to `audit_logs` (payload: the number, the total,
  the currency - field facts, never the client's name) and a `sent` row to `invoice_events` with the
  actor and the person; a void writes `invoice.voided` and a `voided` row carrying the reason.

## Security verification

Checked by the family gate (`services/invoices/verify.ts`, 1496 checks) plus the cross-cutting gate;
`npm run verify` is green end to end.

1. **Validation** - an id that is not a uuid is `VALIDATION_FAILED` before any query; a reason that
   is not a sentence, is whitespace or passes 200 characters is `VALIDATION_FAILED` with the field
   named; the void route bounds its body at 1 KiB and the send route refuses any body at all,
   because a send has no field.
2. **RLS** - every read is scoped to `company_id` from the session (the fixture refuses an unscoped
   read rather than answering it), the routes take the actor from the cookie and never the body, and
   a merchant who names another merchant's document gets `RESOURCE_NOT_FOUND` - the same answer an
   unknown id gets, so a crafted id cannot probe what exists.
3. **Audit entry** - both moves append their `audit_logs` entry and their `invoice_events` row
   before they return, the gate asserts both exist with the right action, entity, actor and
   payload, and the gate asserts the refused moves wrote **neither**.
4. **Permission** - `INVOICE_MANAGE_ROLES` (the `owner`) is applied in the service before the first
   query, so the two routes cannot be reached by anything else; an office role gets
   `PERMISSION_DENIED`.
5. **The paid lock** - asserted at the service (send and void refused with `paid_locked`, nothing
   written), at the line editor (a line is not added to a paid invoice, under the same rule), and at
   the fixture (the `invoices_guard_paid` trigger transcribed: a paid row is frozen, the metadata
   columns excepted) - the sentence the service prints and the exception the database raises are
   the same fact.
6. **The race** - the update is guarded on the status it read, and the gate's fixture keeps the
   zero-row semantics PostgREST has, so a move that loses the race misses its row, re-reads, and
   answers `CONFLICT already_changed` rather than writing over the winner.

## Gates

- `npm run verify`: all gates green, exit 0, with this file present.
- The family gate: **1496 checks** (the fixture now models `invoice_events` and the state checks of
  `0022` that a status write can break, and `checkStatusWorkflow` walks the graph, the send, the
  void, the lock, the reason's bounds and the tenancy).
- `tsc --noEmit`, `eslint` on every touched file, and the production build all clean; the build
  registers `/api/invoices/[id]/send` and `/api/invoices/[id]/void`.

## What the next STEP should know

- **STEP 124 (partial payment)** moves an invoice to `partially_paid` or `paid`. It must go through
  `applyTransition`'s shape - the graph already allows both moves - and write `paid_at` in the same
  statement as `status = 'paid'`, because `invoices_paid_instant_check` ties the two. The 20 USD
  floor is `0022`'s `invoices_partial_minimum_check`, already enforced by the database.
- **The move to `overdue` has no writer yet, and no STEP in 001-123 owns one.** STEP 123's sweep
  records `overdue_reminder` rows for issued invoices past their due date; it does not move the status.
  The graph allows the move from `sent`, `viewed` and `partially_paid`, and `invoices_due_idx` exists
  for a sweep to read - but `0024`'s event vocabulary has no word for the status move itself (only
  `overdue_reminder`), so a sweep would need both the transition and a new event word. This is the one
  state of the seven that a production invoice cannot reach today, and it is recorded as a gap rather
  than closed by inventing a STEP the plan did not allocate.
- A number is consumed even when the send fails after the take; do not return it to the counter.
- The screen's action bar reads `INVOICE_STATUS_TRANSITIONS`; a new move the service learns must
  appear in the table or the bar will not offer it.
