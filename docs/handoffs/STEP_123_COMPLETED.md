# STEP 123 — Recurring generation job with due and overdue handling and client reminders

Branch `arena/17762737-kd-solution-it`, commit `STEP 123: Recurring generation job with due and overdue handling and client reminders`.
Previous handoff: `docs/handoffs/STEP_122_COMPLETED.md`.

## What this STEP is, in one paragraph

A scheduler asks which recurring schedules are due, enqueues one `recurring_schedule.generate` job per schedule
occurrence, and the handler copies the schedule's draft template into a **new draft invoice** stamped with the
occurrence it bills. It then records the overdue reminders the schedule promised for that merchant. A repeated or
concurrent run must not produce a second invoice for the same occurrence, and a retried sweep must not record the
same reminder twice. Both of those are enforced by **unique partial indexes added in `0119`**, not by reading first
and hoping.

## What it is not

- **It does not issue or send an invoice.** Generated invoices are `draft`. See "The draft decision" below.
- **It does not send email.** `lib/email` belongs to STEPs 221-230 and is untouched. An `overdue_reminder` row means
  **queued/recorded**, never delivered.
- **It does not retry.** `maxAttempts: 1`, per FEATURE_LIST line 178 ("no automatic retry").
- **It does not wire a scheduler at boot.** See "The registration gap".

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §16/§27, MASTER_PROMPT, STEP 122 handoff | — | — |
| 2 | Confirm owned paths | `migrations/0119_*`, `services/invoices/recurring-generation*`, `recurring-schedule-job.ts` (STEP 122's seam, extended), `package.json` script line | — |
| 3 | Database part + rollback proof | `0119_recurring_idempotency.sql` / `.down.sql` | migrations **3475 checks, 119 migrations** (was 3453/118) |
| 4 | Core service and logic | `recurring-generation-fields.ts`, `recurring-generation.ts` | `check:recurring-generation` **128 checks, 8 groups** |
| 5 | Background job | `recurring-schedule-job.ts` (+127 lines: handler, factory, default instance, UTC day) | `check:recurring-job` **83 checks, 4 groups** (was 70/3) |
| 6 | UI | **not applicable** — this STEP adds no screen; STEP 122 built the schedule screen | — |
| 7 | Security | consolidated sweep below, plus `0119`'s RLS posture | inside the two gates |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 (**154 routes**) | `npm run verify` |

## The scope question, answered before code was written

STEP 123's title says "generation … **and client reminders**", and a reminder presupposes an invoice a client can
owe money on. Two readings were possible, and the user's ruling settled it:

1. **generation issues and sends** the invoice, then reminds — this would need `takeInvoiceNumber`, an `issued_at`,
   a status transition and mail delivery.
2. **generation creates a draft**; issue/send is STEP 116's workflow, and reminders act only on invoices that have
   genuinely been issued.

The plan was re-read before any code: STEP 116 ("Invoice status workflow transitions…") is a **separate STEP that
was never implemented**, STEP 123's eight sub-steps never mention issuing, numbering or sending, and `0022`'s status
vocabulary has no `issued` word at all (`draft, sent, viewed, partially_paid, paid, overdue, void`). Reading 2 is
therefore the only one the repository can support, and it is what was built.

### The draft decision, and what it costs

A generated invoice is written with `status: 'draft'`, `number: null`, `issued_at: null`. `0022`'s
`invoices_issue_check` refuses any non-draft row without a number and an issue instant, so a generator that wrote
`sent` would have to invent both for a bill nobody approved. That is the failure this STEP refuses.

**The cost is stated rather than hidden:** because `draft` is absent from `0022`'s `invoices_due_idx` predicate and
from `RECURRING_REMINDER_STATUSES`, a generated draft **earns no reminders** until an issue action moves it to
`sent`. Until STEP 116 exists, the reminder half of this STEP is live code with no invoice in production that can
reach it. The gate proves the reminder path against a `sent` invoice the fixture creates
(`checkReminders`), which is honest: the code is correct and the workflow that feeds it is missing.

## Reminders: recorded, never delivered

- An `overdue_reminder` row in `invoice_events` (`0024`) is the durable record. `type` and `actor` come from the
  closed vocabularies `0024` already declares, and `actor: 'system'` with `actor_user_id: null` satisfies
  `invoice_events_actor_user_check` — a scheduled job has no person behind it.
- The row carries **no delivery state**. `invoice_events` is append-only by trigger
  (`invoice_events_guard_append_only` raises on every UPDATE and DELETE, `version` stays 1 forever), so it could not
  hold a `sent → failed → retried` state machine even if this STEP wanted one.
- The audit entry names the fact explicitly: `delivery: "not_attempted"`. The gate asserts that field exists, so a
  later reader cannot mistake the trail for a delivery log.
- **`sentCount` is not a delivery count.** It is the number of reminder occurrences already *recorded* for that
  invoice, counted from `invoice_events` and passed to the engine's existing `reminderOfInvoice`. An occurrence whose
  email later fails is still recorded, so the next sweep does not queue it again. Making the email succeed, or
  choosing to re-send, is STEP 221-230's decision.

### Dependency to record for the email STEPs

> STEPs 221-230 must read `invoice_events` rows of type `overdue_reminder` (scoped by `company_id`, keyed by
> `dedupe_key`) as the **queue of reminders to deliver**, send them through `lib/email`, and record delivery outcome
> somewhere they own — **not** by updating `invoice_events`, which is append-only, and **not** by deleting a row.
> A row that cannot be delivered must remain in the timeline: the record that a client was owed a reminder is
> evidence, and the delivery attempt is a separate fact.

## `0119` — what it adds, and why an index rather than a check in code

`invoice_events` had **no unique constraint of any kind** (`grep -c unique` → 0) and only two non-unique indexes.
`invoices` had no column naming a schedule or an occurrence. Read-then-write idempotency is a race; the fix has to be
a uniqueness statement the database evaluates as one act.

| Object | Definition | Guards |
|---|---|---|
| `invoices.recurring_schedule_id` | `uuid`, nullable, FK → `recurring_schedules (id)` | which schedule produced the invoice |
| `invoices.recurring_run_on` | `date`, nullable | which occurrence it bills — the **schedule's** date, never `now()` |
| `invoices_recurring_run_key` | `unique (company_id, recurring_schedule_id, recurring_run_on) where recurring_schedule_id is not null` | **one invoice per occurrence**; hand-written invoices are outside the predicate |
| `invoices_recurring_pair_check` | `(recurring_schedule_id is null) = (recurring_run_on is null)` | a schedule is never named without its occurrence |
| `invoice_events.dedupe_key` | `text`, nullable, bounded 8–200 and trimmed | names the occurrence a timeline row records |
| `invoice_events_dedupe_key_key` | `unique (company_id, dedupe_key) where dedupe_key is not null` | **one reminder per occurrence**, scoped by tenant |

**Not a composite tenant FK.** `0024` reaches its invoice through `(invoice_id, company_id)` because `0022` carries
`invoices_tenant_key unique (id, company_id)`. `0028` has no such key — only its primary key on `(id)` — and adding
`recurring_schedules_tenant_key` would mean altering a table STEP 122 owns, which this STEP does not do. The
reference is therefore a plain FK by id, and tenancy is held by the `company_id` in the unique index plus the
service, which reads the schedule through the session's company before writing. This is the one place where this
STEP is weaker than `0024`'s pairing, and it is weaker because the schema it would need is owned elsewhere.

**Rollback** (`.down.sql`) drops both indexes, both `0119` constraints and both columns, in the reverse order, and
states the cost: rows already generated keep their invoices, but rows written *after* a rollback carry no key, so
re-applying the migration cannot make the guarantee retroactive.

## Idempotency, proved three ways

1. **Sequential redelivery.** The same `(schedule_id, run_on)` a second time is refused by the `next_run_on` gate,
   reported as `skipped / already_generated`, and `world.invoices.length` is unchanged.
2. **The race the gate cannot see.** The fixture rewinds `last_run_on`/`next_run_on` after a successful run — the
   state a worker leaves if it dies between the invoice insert and the schedule update — and calls again. The
   schedule gate passes, the insert is attempted, and **only `invoices_recurring_run_key` stops it**, again as
   `already_generated`.
3. **Reminders.** Four consecutive sweeps of one overdue invoice leave exactly **one** event. Removing `dedupe_key`
   from the insert makes the same gate fail four checks (`expected 0, received 1` … `expected 1, received 4`).

## The due query and `0022`'s index

`0022` already ships `invoices_due_idx` with the comment *"The overdue sweep of section 27 reads the open invoices
that are due"* — and nothing in the repository read it before this STEP. The sweep query is written to that
predicate shape:

- `status=in.(sent,viewed,partially_paid)`, from a frozen constant, so the query and the index cannot drift;
- `deleted_at=is.null`;
- `due_at=lt.<today>T00:00:00.000Z` — a **range on the column**, never `date(due_at)`, which would defeat the index;
- `recurring_schedule_id=not.is.null`, because the cadence belongs to a schedule.

The index is **never named** in the query — an index is chosen by the planner, not called. The gate asserts that no
code mentions it (prose may, and does), and that no function wraps `due_at`.

**What cannot be proved here:** there is no PostgreSQL in this sandbox, so nothing demonstrates that the planner
*chooses* `invoices_due_idx`, only that the predicate is in the shape it was built for. An `EXPLAIN` on a database
with realistic row counts is the remaining check, and it is listed below.

## The registration gap — stated, because it looks like a bug

`GET /api/jobs/health` on the built app reports `"scheduler":{"registered":0}`. **This STEP did not cause that, and
this STEP did not change it.** There is no boot-time job registration anywhere in the repository: the invoice PDF
job registers itself **lazily** when a document is requested (`registerInvoicePdfJob` called from `requestInvoicePdf`,
`services/invoices/invoice-pdf-document.ts:587`), and the sub-merchant jobs are registered by whoever needs them.
The recurring generator follows the same pattern, which is why the live probe below registers it explicitly.

What exists and is proved: `registerRecurringGenerationJob(registry, dependenciesOf)` puts
`recurring_schedule.generate` into a **real** `JobRegistry` exactly once (twice called → one name), with
`maxAttempts: 1` and the `.strict()` payload. The `registration` group asserts that against the real registry, in
contrast to the `job contract` group which asserts *absence* from the module source. Both are needed: absence at
import time and presence when asked.

What does not exist: a startup hook that calls it, and a scheduler that enqueues `listDueRecurringSchedules()`.
Wiring those is deployment work (a `register()` in `instrumentation.ts` or an explicit bootstrap), and it is
deliberately outside this STEP's ownership.

## Live proof on the built app

| Probe | Result |
|---|---|
| `npm run build` | exit 0, **154 routes** |
| `GET /api/jobs/health` | `200`, `{"status":"ok"}`, `scheduler.registered: 0` (the gap above) |
| `registerRecurringGenerationJob` against a real registry, called twice | `names() == ['recurring_schedule.generate']`, count 1, `maxAttempts 1` |
| registered `parsePayload`, valid contract | accepted |
| registered `parsePayload`, extra `amount_minor` | **refused** (`.strict()`) |
| registered `parsePayload`, missing `run_on` | **refused** |
| `runRecurringScheduleJob` against a store that finds nothing | `kind: "skipped", reason: "missing"` — real code, honest answer |
| `POST /api/invoices/recurring` with no token | `422 VALIDATION_FAILED {field:"csrf", rule:"csrf_token_invalid"}` (STEP 122's route, unchanged) |

## Mutation log — what the gates actually catch

| Mutation | Result |
|---|---|
| Remove `dedupe_key` from the reminder insert | **4 failures**, incl. `four runs of one sweep still leave one reminder (expected 1, received 4)` |
| Set `RECURRING_GENERATED_STATUS = "sent"` | **19 failures** — `invoices_issue_check` refuses the row, so the fake-send path cannot even exist |
| Drop `recurring_schedule_id` / `recurring_run_on` from the insert | run becomes `skipped`; invoice columns `undefined` |
| Delete the `isConflictError` → `already_generated` branch | idempotency group throws `CONFLICT` instead of passing |
| Delete the post-update re-read guard | `a schedule update that silently matched nothing is caught by the re-read` |
| Make `registerRecurringGenerationJob` a no-op | **4 failures** in the `registration` group (invisible before that group existed) |

## Three real bugs found while building, two of them mine in the fixture

1. **Service bug:** the end-date check had its arguments reversed. `daysBetweenRecurringDates(from, to)` is `to −
   from`, so `daysBetween(runOn, endOn) > 0` asks "is the run before the end?" — always false for a past end date,
   so **every** occurrence past the schedule's end would have generated. The gate caught it; the fix measures from
   the end date to the run.
2. **Fixture bug:** `"lte."` starts with `"lt."`, and the shorter test was evaluated first, so every `lte.` filter
   compared against the text `e.2026-11-05` and silently matched nothing — a due schedule looked not-yet-due. Fixed
   by testing `lte.` first, with a comment saying why the order matters.
3. **Gate bug (mine):** the second-occurrence check reused a world that had been deliberately rewound to replay
   November, then asked it for December. Given its own world, it passes.

## The three discovery reads, and why they are not a tenancy hole

The fixture rejects any read without a `company_id`, and exactly three may omit one:

1. **bootstrap** — `recurring_schedules` by `id`. The job payload is a pointer by STEP 122's design, so the generator
   must read the schedule before it knows the merchant. It reads once, by primary key.
2. **due discovery** — `recurring_schedules where status = 'active'`, which is the scheduler's own question and is
   `limit`-bounded.
3. **fleet discovery** — `invoices`, to learn which merchants have overdue generated invoices; de-duplicated with
   `new Set(...)` before any merchant is visited.

Every other read in the STEP carries an explicit `company_id=eq.<session or row tenant>`.

## Behaviour worth keeping in mind

- **`run_on` is the occurrence, not the day the job ran.** A run delivered two days late bills the period it was for,
  and `dueDateOfRun(runOn, terms_days)` measures the deadline from that date. A `now()`-based due date would give
  clients different deadlines depending on the merchant's infrastructure.
- **Next run comes from the anchor, not from adding an interval.** `nextRunOf` re-derives from `start_on`, so a year
  of clamped Februarys does not permanently move a monthly schedule to the 28th (STEP 122's proof).
- **A skipped generation sweeps nothing.** Only a `generated` outcome triggers the per-merchant sweep, so a
  redelivery costs one read rather than a full backlog scan.
- **Refusals are outcomes, not exceptions:** `missing`, `paused`, `ended`, `not_due`, `already_generated`,
  `template_not_draft`, `template_empty`. Only a real storage failure raises — which matters because `maxAttempts: 1`
  means an exception is a run nobody retries.
- **A failed line insert compensates by soft delete**, scoped by tenant *and* by the `recurring_schedule_id` the run
  wrote, so a compensating write can never touch a row it did not create. The schedule does not advance.
- **`today` is injected** and derived in **UTC** (`currentCalendarDay`), because schedules are calendar dates and two
  workers in two regions must agree on which occurrence they are filling.
- **No float touches money:** `priceText` carries the numeric text PostgREST returned.

## Gate inventory after this STEP

recurring 126 · recurring-service 107 · **recurring-job 83** · **recurring-generation 128** · invoices 1442 ·
estimates 1583 · conversion 147 · auth 2787 · security 2378 · jobs 110 · kyc 4142 · office 545 ·
**migrations 3475 / 119 / 89** · structure 458 · i18n 2315 · shell 774 · lint-rules 77 · config 10 · env 16 ·
tsc 0 · eslint 0 · build 0 (154 routes).

## What is genuinely unfinished, in order of consequence

1. **STEP 116 does not exist.** Until an issue action moves a generated draft to `sent` with a real number and
   `issued_at`, no generated invoice can be reminded about, and a client cannot pay one. This is the largest gap in
   the feature line and it is one STEP, not a rewrite.
2. **No scheduler is wired.** `listDueRecurringSchedules()` + enqueue + `registerRecurringGenerationJob()` need a
   startup hook and a cron-like driver. Deployment STEP.
3. **No email.** STEPs 221-230 own `lib/email`; the `overdue_reminder` rows this STEP writes are the queue they will
   read. See the dependency block above.
4. **No PostgreSQL, so no `EXPLAIN`.** The index-shape claim is textual. A staging `EXPLAIN (ANALYZE)` on a table with
   realistic row counts is the remaining verification, and `0119`'s forward/rollback should be applied to a scratch
   database for the transcript this sandbox cannot produce.
5. **No browser check.** No UI was added by this STEP, so 360px/desktop inspection does not apply here (STEP 122's
   panel remains the only affected screen).

## Next

**STEP 124** — Partial payment recording with 20 USD minimum. Not started, per instruction.

## Addendum - the overdue-state half, completed after the second audit pass

*(Written after the second audit pass over STEPs 001-123 - `docs/AUDIT_120.md`, Addendum 3 - named the gap
this handoff left behind: the sweep recorded `overdue_reminder` rows, but nothing moved the status to
`overdue`. It was then completed on instruction, as the rest of this STEP's declared scope: "due and
overdue handling".)*

What the addendum adds:

- **`migrations/0120_invoice_overdue_event.sql`** adds the `overdue` word to `0024`'s timeline vocabulary
  (nine words become ten) and creates `invoices_due_reminder_idx`, the four-open-statuses predicate the
  reminder sweep now reads, with `overdue` among them. The rollback drops the index and restores the
  nine-word check, re-validating it against the data, and is refused if an `overdue` row exists - by
  design, because a vocabulary the timeline already uses cannot be stripped.
- **`sweepOverdueInvoices`** (`services/invoices/invoice-status.ts`) moves a company's money-less open
  documents - `sent` and `viewed` - past their due date to `overdue` through STEP 116's own engine: graph
  check, guarded `status = eq.<from>` write, re-read, one timeline row (actor `system`, no user - `0024`'s
  `invoice_events_actor_user_check` exists exactly for this), one audit entry (`invoice.overdue`, null
  actor). The due date is checked twice, because the query is a fast path and the row is the authority. A
  row that moves under the sweep's feet - a payment that arrives between the list read and the move - is
  counted as skipped, not failed. `applyTransition` was generalized so the actor facts come from the
  caller; the merchant's send and void pass theirs unchanged. (STEP 124 later narrowed the sweep's sources
  to the two money-less states, because `0022`'s money check forbids an overdue document from holding the
  money a partially paid one holds - see `docs/handoffs/STEP_124_COMPLETED.md`.)
- **`services/invoices/overdue-sweep-job.ts`** is the job: name `invoice.overdue_sweep`, a `.strict()`
  payload that carries the company and nothing else - the sweep's date is its own clock, so a date does
  not travel in the payload the way a run date does in the recurring job. The attempt ceiling is the
  registry's default, because the guarded write is the dedupe and a retry resumes its remaining work. No
  import-time registration; wiring it to a scheduler is the same deployment work as the recurring job's.
- **Reminders keep running once a document is overdue.** `overdue` joined `RECURRING_REMINDER_STATUSES`,
  and `0120`'s index is the four-status predicate that constant is written for. A reminder sweep that
  stopped at the moment an invoice became overdue would stop where the work matters most - that is the
  other half of section 178: the invoice shows as overdue, and the reminders go on.

What this closes, against the unfinished list above:

- Item 1 is resolved for the state half: STEP 116 exists, and its engine now performs the `overdue` move
  as well as send and void.
- Item 2 stands for both jobs: the recurring generator and the overdue sweep are both registered by
  deployment, on the same startup hook that does not exist yet in this sandbox.

The auth gate's bookkeeping was updated with the addendum: the two browser files STEP 096 and STEP 116
added (`provisioning-console.tsx`, `invoice-status-actions.tsx`) and the three POST routes they and that
same pair of STEPs registered (`/api/office/provisioning/acknowledge`, `/api/invoices/[id]/send`,
`/api/invoices/[id]/void`) were missing from the CSRF protected list and from the gate's own counts. The
routes enforced the token inline all along; the list and the counts now say what is true.

## Gate inventory after the addendum

recurring 126 · recurring-service 107 · recurring-job 83 · recurring-generation 129 · invoices 1553 ·
estimates 1583 · conversion 147 · **auth 2805** · security 2378 · jobs 110 · kyc 4142 · office 545 ·
**migrations 3495 / 120 / 89** · structure 458 · i18n 2315 · shell 774 · lint-rules 77 · config 10 · env 16 ·
tsc 0 · eslint 0 · build 0 (154 routes).
