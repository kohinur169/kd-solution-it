# STEP 122 — Recurring invoice schedule configuration

**Status:** complete, in three parts.
**Plan entry:** `STEP_PLAN_250.md:1538`. **Feature:** `FEATURE_LIST.md:178`.
**Commits:** `550f22b` (part 1), `48501b4` (part 2), part 3 with this file.

| Part | What it is | Gate |
| --- | --- | --- |
| 1 | Vocabulary + pure date engine | `recurring-schedule-verify.ts` — **126 checks, 6 groups** |
| 2 | Service, routes, i18n, UI | `recurring-schedule-service-verify.ts` — **107 checks, 9 groups** |
| 3 | Job contract, security sweep, handoff | `recurring-schedule-job-verify.ts` — **69 checks, 3 groups** |

**302 checks** in three gates, all wired into `npm run verify`.

---

## What was already there, and what was not

`0028_recurring_schedules.sql` (written by STEP 022) modelled the whole table: 24 columns, 19 named checks,
`recurring_schedules_guard_template`, two unique/partial indexes, RLS with default-deny, and 24 column
comments. What did not exist was **a single line of TypeScript** — `grep -rln recurring` over `app/`,
`services/`, `lib/` and `components/` returned only two comments in `lib/jobs/`.

So this STEP is entirely application code against a schema that was already right. That is worth stating
because it is the opposite of STEP 121, where the schema had a defect that made the feature impossible.

### The design that `0028` already chose

A schedule does not model a second catalogue. It points at a **draft invoice** — the template — and the run
copies that invoice and its lines. The client, the currency, the prices and the arithmetic are therefore
already proved by `services/invoices/invoices.ts`, and `recurring_schedules_guard_template` enforces the three
consequences: same merchant, still a draft, same client as the template.

That trigger is why the service **reads the template before it writes**. A `raise exception` reaches the REST
layer as a `check_violation`, which is a `VALIDATION_FAILED` with no field to point at. A merchant who picked a
sent invoice would get a sentence about nothing. Reading first turns the same rule into
`{field: "template_invoice_id", rule: "not_draft"}` — a box the form can mark.

---

## Part 1 — the date engine, and why it is a separate module

"When does this run next" is the one question of section 16 whose wrong answer nobody notices for a month. If
the arithmetic lived inside the service, the only way to test it would be a fixture — and the cases that
actually break (the 31st, a leap day, a year of Februarys) are exactly the cases a fixture is least likely to
be given. So it is a pure function of `(schedule, date)` in `recurring-schedule-engine.ts`, with **no clock**:
`Date.now()` appears nowhere in it, the same discipline `lib/security/portal-token.ts` applies to its tokens.

### The anchor rule

A monthly schedule anchored on the 31st runs on the 28th of February. **The month after that is the 31st of
March, not the 28th.** Stepping from the previous *result* would leave the schedule permanently on the 28th —
a different contract from the one the merchant signed, and one no screen would ever show changing.

So every date is a grid point: the start date plus a whole number of intervals. `lastRunOn` only says which
grid point has already happened; `nextRunOf` finds that index and returns the next point. A clamp has no
memory, which is what makes a year of short Februarys harmless.

| Case | Result | Clamped |
| --- | --- | --- |
| `2026-01-31` + 1 month | `2026-02-28` | yes |
| `2026-02-28` + 1 month | `2026-03-28` | no |
| `2026-01-31` + 2 months | `2026-03-31` | no |
| `2024-01-31` + 1 month | `2024-02-29` | yes |
| `2024-02-29` + 1 year | `2025-02-28` | yes |
| `2024-02-29` + 4 years | `2028-02-29` | no |

Eleven calendar cases in total, each as data (`SHIFT_CASES`) so the table reads as the rule it proves.

### Three bugs of mine the gate caught

1. **A meaningless loop.** My first `stepOf` had a `while` that computed a value and `void`ed it, then broke —
   dead code from a half-finished thought. Caught by reading it back, not by a test.
2. **The wrong unit in `nextRunOf`.** It passed a *step count* into a function expecting a *month count*, so a
   leap-day test and a February test both failed. Fixed by introducing `gridPointOf(schedule, steps)`.
3. **`2026-02-30` was accepted as a date.** `parseDay` clamped the day to 31 rather than checking the month, so
   February's 30th round-tripped as valid. Now the month's real length is the test.

### What the engine also decides

- **Due date** — the run date plus `terms_days`, measured from the run and not from the moment the job
  executed, so an invoice generated late because the worker was down is still due when the schedule promised.
- **Ended** — `end_on` is inclusive: a schedule ending on the 31st may still run on the 31st.
- **Due** — a schedule is due on its run date *and every day after it*, because a job that missed a day still
  owes an invoice. `0028` has no catch-up column, which says the same thing.
- **Reminders** — counted from the invoice's own due date, not from the last reminder. Counting from the last
  one would let a job that ran twice in a day send two; counting from the due date makes the n-th reminder fall
  on the same day for a given invoice, which is what "at set intervals" means to a client.

### Could the bounds drift from the SQL?

Every limit exists twice: once as a constant in `recurring-schedule-fields.ts`, once as a named constraint in
`0028`. That duplication is the risk, so the gate **parses the migration text** and compares each constant
against the number the constraint declares. Mutation-tested: changing `0028`'s reminder interval to 91 fails
the gate with `expected 90, received 91`.

---

## Part 2 — the service, the routes and the screen

**Five mutations, five audit actions, one entity.** `create`, `update`, `pause`, `resume`, `end` each write
`recurring_schedule.<verb>` against entity `recurring_schedule`, so a trail says which verb happened rather
than only that one did.

### Three design decisions

1. **The client never comes from the body.** It is read from the template, because `0028` requires the two to
   be equal and reading it is the only way that stays true.
2. **`next_run_on` is not typeable.** It is the engine's answer. An edit asks the engine rather than
   recomputing, so the date arithmetic has one implementation. `template_invoice_id` is likewise absent from
   the edit body: re-pointing a schedule would silently change what a client is billed.
3. **One live schedule per template is the database's job.** The service's read cannot guarantee it — two
   requests can both pass the read before either writes. `recurring_schedules_template_key` is the answer, and
   the second create arrives as `CONFLICT: template_invoice_id: already_used`.

### The routes

| Route | Verbs | CSRF |
| --- | --- | --- |
| `/api/invoices/recurring` | GET, POST | POST only |
| `/api/invoices/recurring/[id]` | GET, PATCH | PATCH only |
| `/api/invoices/recurring/[id]/state` | POST | yes |

The item path is deliberately **not** on the CSRF list: it answers no POST, and `lib/auth/verify.ts` asserts
the two lists are equal in both directions. Adding it produced exactly that failure, which is why it is absent.

### Four bugs of mine the gate caught here

1. **`unrecognized_keys` has an empty `path` in Zod 4.** My mapper fell back to the first field in reading
   order, so a misspelt `reminder_interval` was reported against `interval_unit` — a box that was fine.
   Fixed to read `issue.keys[0]`.
2. **The fixture wrapped `AppError` in a plain `Error`**, making the service's conflict and validation paths
   unreachable. A `RestClient` rethrows what it is given.
3. **The lost-write test modelled the wrong failure.** A real PostgREST PATCH that matches nothing answers
   `204` and writes nothing — it does **not** error. The fixture now reproduces the silence, and the service's
   re-read guard is the only thing that can notice. Mutation-tested: removing that guard yields
   `received "<succeeded>"`.
4. **`<a href>` where `next/link` belongs** — caught by eslint's `no-html-link-for-pages`.

### The screen

`recurring-schedule-panel.tsx` is one screen and not a wizard: eight boxes, none of which depends on another.
It shows the **server's** `nextRunOn` after every save — a browser-side recomputation would disagree with the
job that actually bills. Ending asks once, inline, because it is the only action here that cannot be undone.
The panel imports the bounds from the vocabulary module (a value import is safe: that module has no
dependencies) and never from the server-only service.

i18n: **62 keys**, `2253 → 2315` messages, all in `lib/i18n/strings/en.ts`, nothing user-facing anywhere else.

---

## Part 3 — the job contract, and the security sweep

### The STEP boundary, stated as a seam

`FEATURE_LIST` names three things in one breath; `STEP_PLAN_250` splits them across STEP 122 (configuration)
and STEP 123 (generation, due/overdue handling, reminders). The join is a job payload, and a payload is a
contract:

```ts
{ schedule_id: uuid, run_on: "YYYY-MM-DD" }   // .strict()
```

It is a **pointer, not a copy**. A queue row can sit for minutes before a worker claims it, and a merchant can
pause the schedule in that time — so the handler must re-read the row. `run_on` is the date the run was *due*,
not the day it executed, so a run delayed by a deploy still invoices the period it was for.

`registerRecurringScheduleJob(registry, handler)` is the named seam. **Nothing calls it**, and that is the
contract: a registration here would need a handler, the handler is the generator, and a placeholder that
returned would put a job in the registry that silently invoices nobody — the worst failure a billing system
can have, because it looks like a working one.

`maxAttempts: 1`. Section 16: "when a recurring payment fails there is no automatic retry", and the same
applies to the generation that leads to it.

### The gate that was measuring nothing

My first version proved the absence with:

```ts
const registry = new JobRegistry();
expect(!registry.has(RECURRING_SCHEDULE_JOB));
```

That is true by construction — a fresh registry is empty — so it passed even with a placeholder handler
registered in the module under test. Found by mutation: I added a real `JobRegistry` registration with an empty
handler and **the gate still passed**. It now asserts what is actually checkable from source: exactly one
`.register(` call and it sits inside the seam, **zero** `new JobRegistry(`, no empty handler, and the registry
imported as a *type* so an import-time side effect is not expressible. Re-running the same mutation now fails
four checks at once.

### The six security claims

| # | Claim | How it is proved |
| --- | --- | --- |
| 1 | Validation both sides | two `.strict()` Zod schemas; the panel imports the same bounds |
| 2 | RLS + default-deny | read from `0028`: `enable row level security`, `using (false)`, `with check (false)` |
| 3 | Audit on every mutation | five actions asserted present and distinct; `appendTolerated` so a dead sink never fails the write |
| 4 | Role + tenancy from the session | `requireAnyRole(…MANAGE_ROLES)`, `requireCompanyId(actor)`, and no body can name a company |
| 5 | CSRF on every mutating route | three paths asserted, and the GET/PATCH-only path asserted **absent** |
| 6 | No secret, no client data | no client name or amount in any route log or any trail payload |

Rule 17 holds too: `RECURRING_SCHEDULE_COLUMNS` names 21 columns and carries the `select=` prefix that
PostgREST requires — the exact defect STEP 120 found in `ESTIMATE_SIGNATURE_COLUMNS`.

---

## Files

| File | Lines | What it is |
| --- | --- | --- |
| `services/invoices/recurring-schedule-fields.ts` | 120 | vocabulary only — no imports, no `async`, no `throw`, no clock |
| `services/invoices/recurring-schedule-engine.ts` | 327 | the date arithmetic, pure, clockless |
| `services/invoices/recurring-schedule.ts` | 1 045 | five mutations, two reads, the snapshot, the rules |
| `services/invoices/recurring-schedule-job.ts` | 109 | the payload contract and the STEP 123 seam |
| `app/api/invoices/recurring/route.ts` | 124 | GET + POST |
| `app/api/invoices/recurring/[id]/route.ts` | 107 | GET + PATCH |
| `app/api/invoices/recurring/[id]/state/route.ts` | 101 | POST pause / resume / end |
| `app/(dashboard)/invoices/recurring-schedule-panel.tsx` | 546 | the client panel |
| `app/(dashboard)/invoices/recurring/page.tsx` | 18 | the page |
| `app/(dashboard)/invoices/invoice-screens.tsx` | +170 | `InvoiceRecurringScreen`, which reads on the server |
| three `*-verify.ts` files | 1 918 | 302 checks |

**No migration.** `0028` was already correct and is untouched; `0022`, `0025`, `0114` and `lib/security/` are
untouched too. `lib/auth/verify.ts` changed by two numbers (see below).

### One shared-file edit, and why

`lib/auth/verify.ts` asserts two counts: browser files that send a mutation (44) and their call sites (57). The
panel adds one file and two calls — create, and state change — so the numbers became **45** and **59**. The
counts are the gate's own way of noticing that a new browser file writes something; the comment beside them
now says which STEP added what, exactly as STEP 119's note does.

---

## Verification

| Gate | Result |
| --- | --- |
| `recurring-schedule-verify.ts` | **126 checks, 6 groups** |
| `recurring-schedule-service-verify.ts` | **107 checks, 9 groups** |
| `recurring-schedule-job-verify.ts` | **69 checks, 3 groups** |
| `services/invoices/verify.ts` | 1442 (unchanged) |
| `services/estimates/verify.ts` · conversion | 1583 · 147 (unchanged) |
| `lib/auth` · `lib/security` · `lib/jobs` | 2787 · 2378 · 110 |
| `services/kyc` · `components/office` | 4142 · 545 |
| `migrations/verify.ts` | 3453 checks, 118 migrations, 89 tables |
| `check:structure` | 17 directories, 14 root files, **455** source files |
| `check:i18n` | **2315** messages, 251 placeholders |
| `check:shell` · `check:lint` · `check:config` · `check:env` | 774 · 77 · 10 · 16 |
| `typecheck` · `lint` · `build` | 0 · 0 · exit 0 (152 routes) |

### Mutation log

Every gate was proved to bite by breaking the thing it guards, then restored:

| Mutation | Result |
| --- | --- |
| step from the previous run instead of the anchor | 3 checks fail, incl. `expected "2026-03-31", received "2026-03-28"` |
| `0028`'s reminder interval 90 → 91 | `expected 90, received 91` |
| drop the re-read guard after an update | `received "<succeeded>"` |
| take the client from the body, not the template | 6 checks fail |
| remove `/api/invoices/recurring` from the CSRF list | `the create path is protected` |
| put a client name in the audit payload | `no audit payload carries the client's name` |
| register a real placeholder handler | **initially passed — see part 3**; after the fix, 4 checks fail |

### Live probe

`npm run start` on the built app, then curl:

| Request | Answer |
| --- | --- |
| `GET /api/invoices/recurring` | `401 AUTHENTICATION_REQUIRED` |
| `POST /api/invoices/recurring` (no token) | `422 VALIDATION_FAILED {field:"csrf", rule:"csrf_token_invalid"}` |
| `POST /api/invoices/recurring/{id}/state` (no token) | `422` the same |

The CSRF refusal is a `422` with a field and not a `403`, which is the shape every mutating route in this
codebase answers with.

### What a fixture still cannot see

- **No PostgreSQL.** `0028`'s behaviour is transcribed from its SQL text, not executed. A real
  forward-and-rollback transcript of `0028` remains owed, along with the RLS policy actually refusing a read
  under a role that is not the owner.
- **No headless browser.** The panel was checked by reading it and by `renderToStaticMarkup` in earlier STEPs'
  method, not by clicking it. Desktop and mobile widths are handled by the classes and unwitnessed at 360px.
- **The generation itself is unproven**, because it does not exist yet — that is STEP 123's file.

---

## Next

- **STEP 123** (`:1550`) implements the handler: `registerRecurringScheduleJob(registry, handler)` is the seam.
  It must re-read the schedule, refuse a paused or ended row, re-read the template and refuse a non-draft one,
  compute the due date with `dueDateOfRun`, and use `reminderOfInvoice` for the cadence.
- **STEP 182** still owns the tokenized estimate page, which is the only place a client can accept a quote —
  and therefore the only trigger for STEP 121's conversion.
- **The merchant has no link to the panel.** `/invoices/recurring` is reachable by URL and rendered by the
  build, but nothing in the invoice screens links to it yet; wiring that belongs with the invoices list screen.
- **`services/clients/clients.ts` still reads without `select=`** (found in STEP 121, unchanged here). Rule 17
  makes it a candidate for a later hardening pass.
