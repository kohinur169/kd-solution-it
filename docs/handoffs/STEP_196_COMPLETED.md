# STEP 196 — Deadline warning emails at start and midpoint

Status: **complete**. One commit, `STEP 196: Deadline warning emails at start and midpoint`, on
`arena/ca936761-kd-solution-it`, branched from STEP 195's `568762c`. Typecheck, lint and build are clean, and the
STEP's own gate is `services/disputes/dispute-warnings-verify.ts` at **268 checks**, mutation-checked with
fourteen mutations, all red.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 196: Deadline warning emails at start and midpoint**
> Sub-step 4: the core service and logic for the deadline warning emails.

FEATURE_LIST §19, the sentence this STEP owns: *"The merchant receives email warnings at the start and in the
middle of the deadline window."*

The window is the one STEP 195 built: 24 hours from `opened_at`, or 48 after a `super_admin` extension, counted
in absolute hours per `0039`'s `disputes_due_check`. This STEP reads that window and mails about it; it does not
move it, shrink it or extend it. The evidence pack (197) and the submission (198) are still ahead, and there is
still no scheduler to call anything - which is why the work is reachable two ways (a job and an office button)
rather than one.

Eight sub-steps, all done.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `migrations/0125_dispute_deadline_warnings.sql` | new | `dispute_deadline_warnings` - the append-only record that a stage was warned - with three unique keys, a window guard trigger and an append-only guard trigger |
| `migrations/0125_dispute_deadline_warnings.down.sql` | new | The rollback, triggers before functions, table last, in one transaction |
| `services/disputes/dispute-deadline.ts` | edited | `disputeMidpointOf` and `disputeWarningStagesOf`: half the window, and which stages one instant owes. Pure arithmetic, no database, so the clock and the sweep agree by construction |
| `services/disputes/dispute-fields.ts` | edited | The stage vocabulary, `DISPUTE_WARNING_ROLES`, the template key, the reference kind, the attempt and batch ceilings, the duplicate reason, and the `dispute.warning_sent` audit action |
| `services/disputes/dispute-warnings.ts` | new | The sweep (one merchant or every merchant), the office's "run it now", the queue's read, and `queueWarning` - email row first, claim second |
| `services/disputes/dispute-warnings-job.ts` | new | `dispute.deadline_warnings`: the strict payload, the runner, the definition, and an idempotent `registerDisputeWarningJob` |
| `services/disputes/dispute-warnings-verify.ts` | new | The gate, 268 checks, over a fixture that carries `0125`'s keys, checks and both trigger bodies |
| `app/api/office/disputes/warnings/route.ts` | new | `POST` - CSRF, the 512-byte ceiling, the session, the device proof, the role, one service call |
| `app/(admin)/office/disputes/warning-run-panel.tsx` | new | The office's button: the device proof over these exact bytes, the counts printed back, a refresh |
| `app/(admin)/office/disputes/page.tsx` | edited | The read now fetches the warnings for the listed disputes, each row prints its stage line, and the panel renders for a role that may press it |
| `lib/i18n/strings/en.ts` | edited | Two `email.disputeWarning` subjects and thirteen `disputes.warning*` strings |
| `lib/security/csrf.ts` | edited | `/api/office/disputes/warnings` on `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | The browser mutation inventory: 54 files / 74 call sites → 55 / 75, with the reason written beside it |
| `services/disputes/dispute-verify.ts`, `dispute-response-verify.ts` | edited | The migration-count assertions: the chain's head is 125 now, not 124 |
| `services/payments/refund-verify.ts`, `refund-execution-verify.ts`, `refund-fee-verify.ts` | edited | The same 124 → 125 |
| `package.json` | edited | `check:dispute-warnings`, and one link in the `verify` chain |

## The two stages, in one paragraph

Both come from the row, never from a stored clock: **the start is `opened_at`** and **the midpoint is
`opened_at + window/2`** - hour 12 of a 24-hour window, hour 24 of an extended 48-hour one. `disputeMidpointOf`
is the only place that division happens, and the extended case is the one a hardcoded "twelve hours" would get
wrong, so the gate asserts hour 24 on a 48-hour row and a mutation that returns 12 is red. A stage is **due**
while `warn_at <= now < due_at`; a sweep that was down over a stage sends it on the next tick, because the
merchant still has time to answer and a warning about a window that is still open is true. Past `due_at` nothing
is due at all - the window is closed, and a "you have twelve hours left" mail about a deadline that has passed is
worse than silence. An **answered** dispute owes nothing: the merchant has done the thing the mail would ask for.
So does a submitted pack and a resolved dispute, and `0125`'s query never even reads a decided or closed row.

## What the gate proves

268 checks in thirteen sections, over an in-memory PostgREST that re-implements `0125`'s three unique keys, both
`check` constraints and both trigger bodies - so a service that skipped its own check would still fail:

1. **The migration and its rollback** - the stage and window vocabularies, `warn_at >= opened_at`,
   `warn_at < due_at`, the midpoint constraint naming `make_interval(hours => (window_hours / 2))`,
   `due_at = opened_at + window`, the three unique keys (including the *partial* `start`-once index), RLS, the
   default-deny policy, the down file's order, and that `0059`-`0061` gain nothing: no template key, no column
   on `email_send_logs`, no column on `disputes`.
2. **The stage rule without a database** - 24 and 48 windows, before the opening, at the opening, before the
   midpoint, at the midpoint, one second before the deadline, at the deadline, and every terminal state.
3. **The sweep** - one stage each, two on a second tick after the midpoint, nothing on a third, counted.
4. **Who is written to** - the merchant's own owner; `no_owner` rather than somebody else's address;
   `sender_not_configured` writes nothing at all (so the next tick still sends); the subject comes from the
   catalogue; no `payments` row is touched.
5. **The race and the moved window** - a claim that loses reports `already_sent` and drops its email row with a
   reason; a window that moved under the read is `superseded`, also dropped, and re-sent on the next tick at the
   new stage time.
6. **The database's own rules through the fixture** - a second insert of the same stage is refused, a `start`
   after a `start` is refused, one send id twice is refused, a warning about somebody else's dispute is refused,
   a stale `due_at` is refused, an update and a delete are refused.
7. **The office's "run it now"** - `ceo` and the compliance desk may, `super_admin` may, `finance_ops` and
   `support` and a merchant's `owner` may not; without a satisfied second factor even the `ceo` is refused.
8. **The read the queue prints** - one query for the page, four facts per stage, another tenant's ids absent.
9. **The job** - the strict payload (`company_id` optional, an unknown key refused), the same sweep as the
   button, `registerDisputeWarningJob` idempotent.
10. **The route** - CSRF before the session, the device proof, the 512-byte ceiling, one field only, counts
    logged and never an address.
11. **The two screens** - the panel signs its request and the queue prints each row's line.
12. **Every message exists** - a path scan, so a screen cannot ask for a string that was never added.
13. **The service's own discipline** - no `any`, no printing, no money, no `disputes` write (only the one read
    of a row to explain a lost claim).

## Security

- **Validation** - the payload is strictly parsed with zod (an unknown key is a refusal) and capped at 512 bytes;
  every row read from PostgREST goes through a schema before it is used, so a column that comes back in the wrong
  shape is a refusal rather than a `NaN` instant.
- **RLS / tenancy** - the new table carries RLS with a default-deny policy and no grant to any browser role;
  only the server-side `service_role` client reads or writes it. A company-scoped sweep carries
  `company_id=eq.<id>` on the one `disputes` query, and `0125`'s guard trigger re-checks the dispute's own
  `company_id`, `opened_at`, `response_window_hours` and `response_due_at`, so a service that passed the wrong
  company still cannot write.
- **Append-only, in the database** - `dispute_deadline_warnings_guard_append_only` refuses both update and
  delete. The record of "this merchant was told" cannot be edited away or removed; the only mutable thing is the
  `email_send_logs` row, and its `queued → dropped` transition is the retraction of an email nobody received.
- **Audit** - one entry per warning through `appendTolerated` (so a chain outage never stops a merchant being
  told), carrying the stage, the window, the two instants, the send id and the recipient's user id - **and never
  the address**. The gate asserts the payload's key set exactly, so a later field cannot smuggle one in.
- **Permissions** - the office route requires a role in `ceo | compliance_kyc | super_admin` **and** a satisfied
  second factor **and** `requireTrustedDevice` over the request's exact bytes; the job takes no actor at all and
  is reachable only from the deployment's own runner.
- **Exactly once** - three keys, not one: `(dispute_id, stage, window_hours)`, a partial unique index that makes
  `start` once per dispute even if the window changes, and `send_id` unique so one email can never be the
  evidence of two warnings.

## Verification

| Gate | Result at this commit |
| --- | --- |
| `services/disputes/dispute-warnings-verify.ts` | **passed, 268 checks** (fourteen mutations, all red) |
| `services/disputes/dispute-verify.ts` | passed, 271 checks |
| `services/disputes/dispute-response-verify.ts` | passed, 398 checks |
| `services/payments/refund-verify.ts` / `-execution-` / `-fee-` | passed, 259 / 141 / 213 checks |
| `migrations/verify.ts` | passed, 3646 checks, **125 migrations**, 93 tables |
| `scripts/verify-audit.mjs` | passed, 4128 checks |
| `lib/i18n/verify.ts` | passed, 2965 messages, 314 placeholders |
| `scripts/verify-structure.mjs` | passed, 17 directories, 14 root files, 729 source files |
| `scripts/verify-shell.mjs` | passed, 1087 checks, 344 files |
| `lib/jobs/verify.ts` | passed, 110 checks |
| `npm run verify` (whole chain, ending in `tsc`, `eslint .`, `next build`) | passed, compiled |
| **Pre-existing red (unchanged, unchanged reasons)** | `lib/auth/verify.ts` 1 (a fourth module dials), `lib/security/verify.ts` 3 (a probe's own literals, `nmi-client.ts` naming the algorithm), `components/office/verify.ts` 13 (`provisioningQueue` unaccounted for) |

The mutations, each of which the gate catches by name: the midpoint ignoring the extended window; an answered
dispute being nudged; a stage sent after the deadline; a recorded stage planned again; a warning written with no
sending method configured; a lost claim keeping its email row; the office's sweep without a second factor; the
finance desk allowed to mail merchants; the email pointing at the wrong record; a recipient address added to the
chain; the route without its CSRF guard; the panel without its device proof; the job payload accepting extra
fields; the queue not printing its row's line.

Two exact-count assertions moved because this STEP legitimately adds what they count: `lib/auth/verify.ts`
54→55 browser files and 74→75 mutation call sites (the warning panel), with the reason written beside them. The
migration-count assertions in three refund gates and in the STEP 195 gate moved 124→125 for `0125`, which is
this STEP's.

### Exercised on a running server

`next start` on port 3100 with the placeholder environment (no database in this sandbox):

| Request | Answer |
| --- | --- |
| `POST /api/office/disputes/warnings` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` - the token is the first guard, before the session, before the role and before any row read |
| `POST /api/office/disputes/warnings` (a header that does not match its cookie) | the same `422` with the same rule, so the guard compares rather than merely looks |
| `GET /office/disputes` signed out | `307` to `/signin` from the office layout, the same answer `/office/refunds` gives |
| `next build` | `/api/office/disputes/warnings` listed as a dynamic function route |

The authenticated paths cannot be walked here because there is no Supabase project to issue a session; they are
exercised end to end against the fixture in the gate, which carries `0125`'s keys, checks and trigger bodies. The
`.env.local` used for the smoke was deleted again (checked: absent), and `git status` is the STEP's own file list.

**Desktop and mobile widths** - the panel is a single column at both, `p-4` on a phone and `sm:p-5` from the
tablet breakpoint, wrapping its two buttons and its note rather than overflowing; the queue's new line is a
`<dt>`/`<dd>` pair inside the existing description list, which is a two-column grid only at `sm:` and stacked
below it.

## Carried gaps (not this STEP's, and named rather than hidden)

1. **Nothing ticks.** No `Scheduler.tick()` caller exists in this build, so `dispute.deadline_warnings` is
   registered (idempotently) by the deployment and is not started by anything here. That is why the office's
   "run it now" button exists in the same STEP: the behaviour is reachable today by a person, and tomorrow by a
   clock, through one code path.
2. **No rendering or delivery.** This STEP writes `email_send_logs` rows - section 23's queue - and nothing more.
   The template key `dispute_update` already exists; the subject comes from the catalogue; the body is whatever
   the sender renders. Building an SMTP client here would be a second email system.
3. **No link in the mail.** The warning tells the merchant the window and its deadline, but the queue row cannot
   carry the tokenised answer URL that §19's owner-only rule wants, because that is the notification layer's
   business (a token is minted per recipient, not per template). Named rather than faked.
4. **A merchant with no owner is not warned.** Revoked-and-not-replaced owners are a real state; the sweep
   records `no_owner` and skips rather than mailing an arbitrary user. The office sees the count.
5. **`company_id = null` in the job payload means every merchant.** That is the deployment's sweep. A per-merchant
   tick is the same code with one filter, which is what the payload's field is for.
6. **No escalation after the deadline** - nothing mails a merchant whose window already closed, and nothing
   alerts the office. That is STEP 198's submission and the escalation work after it.
