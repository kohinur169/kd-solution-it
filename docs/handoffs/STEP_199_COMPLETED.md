# STEP 199 — Chargeback rate monitoring with graduated actions and configurable thresholds

Status: **complete**. Commit `STEP 199: Chargeback rate monitoring with graduated actions and configurable thresholds`
(`0c106ea`), then this handoff, on `arena/ca936761-kd-solution-it`, branched from STEP 198's `b674fe3`. Typecheck,
lint and build are clean, `npm run verify` is exit 0 over **70 gate lines**, and the STEP's own gate is
`services/disputes/chargeback-rate-verify.ts` at **416 checks**, mutation-checked with **22 distinct mutations, all
red**.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 199: Chargeback rate monitoring with graduated actions and configurable thresholds**
> Chat line: Implement STEP 199 only: Chargeback rate monitoring with graduated actions and configurable thresholds.

FEATURE_LIST §18 (`:198`), the sentences this STEP owns: *"Chargeback handling follows international card network
rules: rate and transaction count are both considered, a minimum transaction count must be reached before a
percentage threshold applies, and action is graduated: warning and monitoring, then extra reserve, then
suspension. Every threshold value is configurable by `super_admin`."*

The eight sub-steps, as walked: read §18 / MASTER_PROMPT / the STEP 198 handoff; confirm the owned paths; the
migration and its rollback; the service (measure, decide, act, clear, sweep); the three routes and the job; the
office screen at two widths; the security slice (validation, RLS, audit, permissions); then the gate, the
mutations, the smoke, one commit, the push and this file.

STEP 200 was **not** started, and STEP 198 was not reopened.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `migrations/0128_chargeback_actions.sql` | new | 385 | One append-only table with eleven checks, a five-foreign-key effect web, `chargeback_actions_guard()`, the metadata trigger, the live-key and open-step indexes, RLS default-deny |
| `migrations/0128_chargeback_actions.down.sql` | new | 29 | The rollback: trigger, guard, table, in one transaction |
| `services/disputes/chargeback-fields.ts` | new | 271 | The browser-safe vocabulary: three steps, two modes, three role lists, seven threshold definitions, ten rules, four audit actions, the 280/1024 ceilings, 500×40 paging |
| `services/disputes/chargeback-policy.ts` | new | 343 | The seven `chargeback.*` rows of `platform_settings`: defaults, bounds, ordering, digest, version-guarded write with read-back, `ChargebackPolicyView` |
| `services/disputes/chargeback-rate.ts` | new | 1281 | `readWindowCounts`, `countRows`, `measurementOf`, `rateBpsOf`, `decideChargebackStep`, `detailOf`, `readChargebackScreen`, `applyChargebackStep`, `clearChargebackAction`, `runChargebackSweep`, `queueNotice`, `startExtraReserve`, `writeSuspensionEvent`, the three body parsers |
| `services/disputes/chargeback-rate-job.ts` | new | 112 | `dispute.chargeback_rate` — the sweep on a clock, registered idempotently, payload `{ company_id?: uuid }` strict |
| `services/disputes/chargeback-rate-verify.ts` | new | 1773 | The gate, 416 checks, over an in-memory PostgREST carrying `0128`'s trigger body and its checks plus `0080`, `0044` and `0111`'s rules for the four tables this STEP writes |
| `services/disputes/dispute-runtime.ts` | edited | +14 | `ChargebackRuntime` and `getChargebackRuntime()` beside the three runtimes already there |
| `app/api/office/disputes/chargeback/policy/route.ts` | new | 98 | `POST` — the thresholds: CSRF, the 1024-byte ceiling, the session, the device proof over these exact bytes, the parse, one service call |
| `app/api/office/disputes/chargeback/apply/route.ts` | new | 89 | `POST` — one step, the same five guards, and a log line carrying the *length* of the officer's sentence |
| `app/api/office/disputes/chargeback/clear/route.ts` | new | 89 | `POST` — the clearing, the same five guards, the same kind of log line |
| `app/(admin)/office/disputes/chargeback-panel.tsx` | new | 575 | The programme: the thresholds form (read-only for a role that may not edit), the watchlist with due/standing badges and one button per step, the history with a clearing |
| `app/(admin)/office/disputes/page.tsx` | edited | +26 | `chargeback: ChargebackScreenView \| null` in the ready state, `mayWatch(actor)`, the read behind it, and the `chargeback-heading` section |
| `lib/i18n/strings/en.ts` | edited | +57 | The `disputes.chargeback*` block and `email.chargebackWarning.subject` |
| `lib/security/csrf.ts` | edited | +3 | The three office paths on `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | 57→58 files, 84→87 calls | The browser mutation inventory, with the reason written beside it |
| `services/disputes/dispute-verify.ts`, `-response-`, `-warnings-`, `-evidence-`, `-submission-` | edited | pins | The chain head: 127 → **128** |
| `services/payments/refund-verify.ts`, `-execution-`, `-fee-` | edited | pins | The same 127 → 128 |
| `package.json` | edited | +1 link | `check:chargeback-rate`, one link in the `verify` chain |

## The programme, in one paragraph

**A rate is two numbers, and both have to be counted inside the same window.** `readWindowCounts` walks `0037`'s
payments by `captured_at` and `0039`'s disputes by `opened_at` in two pages of five hundred rows rather than two
queries per merchant, and `measureOne` does the same walk for one company when a person presses a button. The rate
is `round(chargebacks × 10000 / payments)` in basis points, an integer, and `decideChargebackStep` asks exactly
four questions in section 18's order: *is this read complete* (a walk past forty pages is refused, not computed on
a capped denominator) → *is the transaction count above the minimum* (below it, the percentage means nothing and
the merchant earns no step whatever the rate reads) → *is the rate at the suspension bar, then the reserve bar, then
the warning bar* → *nothing*. The decision is not trusted on its own: **`0128` re-derives the step from the row's
own numbers**, `payments_count >= minimum_transactions` first and then the bar the row's `kind` names, so a service
that mislabelled a warning as a suspension cannot record the lie. What is recorded is the whole measurement: the
window in days, both counts, the rate, the minimum, and all four bars, so a super administrator who raises a
threshold tomorrow does not rewrite the reason a merchant was warned today.

**The ladder is climbed, and only up.** The row carries a rank — warning 1, reserve 2, suspension 3 — and the guard
refuses a step below the highest live one, refuses any step at all while a suspension stands, and refuses a second
live row of the same kind through its partial unique index. **A warning and a reserve are the platform acting; a
suspension is a person's.** Both automatic steps take no actor and `mode = 'automatic'`; a suspension demands
`super_admin` with a satisfied second factor, a reason sentence, `mode = 'manual'`, the officer's own id, and it
writes the `0111` event the account lifecycle already knows how to derive (`suspended`, reason `chargeback_program`)
and names that event on the row. The extra reserve is a fresh `0044` agreement at the policy's percent for the
policy's days; a merchant with an older active reserve at a lower percent has it **paused** — terms are never
rewritten — and the new row names the new agreement. A warning queues one `0061` notice on the `dispute_update`
template to the merchant's owner, and records the send id on the row; if there is nobody to write to, the step is
still recorded and the row says so. Clearing is the one transition the table allows, only for a warning or a
reserve, with an officer, a sentence and an instant, and only a super administrator takes it; a suspension returns
through `0111`'s reactivation flow, which already records who let the merchant back.

**The sweep counts and never takes.** `dispute.chargeback_rate` measures every merchant, takes the automatic steps
the numbers earn, and *counts* the merchants whose numbers earn a suspension — `suspensionsDue`, plus a
`disputes_due` list — because a report a person acts on is not the same object as a decision. That is why the job
is safe on a clock and why the screen has one button per step.

## What the gate proves (15 sections, 416 checks)

| Section | What it pins |
| --- | --- |
| 1 | `0128` and its rollback: one `begin;`/`commit;` each, the table, RLS, the default-deny policy, the three indexes, both trigger bodies, every check and every `raise exception` sentence, in the order the rollback needs; the chain head is 128 of 128 |
| 2 | The seven settings: defaults, digest stability and movement, `0080`'s key pattern, a null value, a second live row for one key, an out-of-range stored bar as a loud `DEPENDENCY_FAILED` rather than a quiet default |
| 3 | `parsePolicyBody`: strict, whole days, the three bound pairs, the two orderings, a bar above a hundred percent |
| 4 | Who may set thresholds: the compliance desk, the chief executive, the finance desk and support are all refused, and so is a super administrator without a second factor |
| 5 | The arithmetic: `rateBpsOf` rounds once, the window starts exactly one policy window back, the minimum is asked before any bar, each bar earns its own step, a truncated read earns nothing, the ranks, what may be cleared |
| 6 | Counting: paging reads every row once and stops at its ceiling, and a candidate that reports truncation; the window read excludes the old rows placed outside it |
| 7 | The watchlist: three roles read it and four do not, every merchant is a row even with no transactions, zero-transaction rows carry `minimumNotReached`, and `canApply`/`canSuspend` differ for the super administrator, the desk and the chief executive |
| 8 | Taking a step: the warning's row, its notice, its audit entry with the rate and *not* the sentence; the second press refused and silent; below the minimum, below the bar, a company that does not exist, a desk that may not suspend, a suspension with no sentence, then the suspension itself with its `0111` event and the refusal that follows it; and the reserve, both fresh and over an older paused agreement |
| 9 | Clearing: the desk refused, an empty sentence refused, the clearing written with its officer and note, a second clearing refused, a suspension not clearable; then the guard itself entered directly — a duplicate kind, a suspension under its bar, a reserve with no reserve, a rate that is not the division it claims, and a delete, which the guard refuses |
| 10 | The sweep and the job: every merchant measured, one warned and two skipped, the suspension counted and never taken, one merchant on request, registration idempotent, the real handler taking the step, the strict uuid payload |
| 11 | The two bodies: `companyId` and `kind` are owned by the browser payloads, sentences are trimmed, and eleven malformed bodies are refused |
| 12 | The three routes: CSRF first, the session, the device proof over these bytes, the body ceiling, the envelope, the runtime, a log line, and no `console`; all three paths on the CSRF list |
| 13 | The screen: a browser component the office page renders behind `mayWatch(actorState.actor)`, three mutations and three token spreads, the device proof, `role="alert"`, `router.refresh()`, read-only thresholds for a role that may not edit, a disabled button while busy, no clearing offered on a suspension |
| 14 | Every message the panel, the page and the service name exists, the warning's subject fits `0061`'s ceiling, and the template is one of its twenty |
| 15 | The words: three steps, ten rules that are machine words, the bounds, and defaults that are already ordered |

### The mutations

All 22 red, each restored immediately:

1. the minimum count asked first → `if (false)`
2. a truncated read stopping the decision
3. the window filter on `measureOne`'s payments
4. the window filter on the batch walk
5. the second factor on saving the thresholds
6. the role on saving the thresholds
7. the role on suspending
8. the template key on the warning's notice
9. the older reserve paused rather than left active
10. the suspension's `chargeback_program` reason
11. the sweep taking a suspension instead of counting it
12. clearing a suspension
13. the row's `minimum_transactions` read from the policy
14. the device proof on the apply route
15. the body parse on the clear route
16. the clear path off the CSRF list
17. the gate out of the `verify` chain
18. the page's guard replaced by `true`
19. `0128`'s `payments_count >= minimum_transactions`
20. `0128`'s `(kind = 'suspension') = (mode = 'manual')`
21. `0128`'s "a chargeback action is never removed"
22. the rollback no longer dropping the table

Three of these were **missed on the first pass** and the gate was strengthened rather than the mutation dropped: the
window filter is now proved by a merchant with two hundred old payments and two hundred old chargebacks whose
inclusion would move the decision across a bar; the page's guard is pinned as it is *called*; and the save guard is
pinned in the source as well as in behaviour.

## Security

- **Validation.** Every one of the three bodies is a strict object — `{ companyId: uuid, reason?: ≤280 }`,
  `{ companyId: uuid, kind, note: 1..280 }`, the seven whole numbers — and the seven threshold values are checked
  for type, bound *and* order twice: in `parsePolicyBody` and again in `saveChargebackPolicy`, because a service is
  allowed to be called by a future route that forgot.
- **Body ceilings.** 1024 bytes, refused on `content-length` before a byte is read and again on the decoded length
  after.
- **RLS.** `0128` enables row level security and creates one policy: default-deny, no role named. The service writes
  through the service role, as every service in this repository does; the table is not reachable from a browser.
- **Audit.** Four actions on `lib/audit`'s chain: `chargeback.policy_saved` (all seven keys and the digest),
  `chargeback.action_applied` (rate, both counts, both bars, the kind — never the officer's sentence),
  `chargeback.action_cleared`, `chargeback.sweep_run`. Automatic steps carry no actor and say so; a suspension
  carries the officer's id.
- **Permissions.** Read: `super_admin`, `compliance_kyc`, `ceo` with a second factor. Apply a warning or a reserve:
  `super_admin`, `compliance_kyc`. Suspend, clear, edit thresholds: `super_admin` only. Each list is one exported
  constant, and the page's own `mayWatch` asks the same one.
- **CSRF and device proof.** All three routes are on `CSRF_PROTECTED_PATHS`, and each one verifies the enrolled
  device over the exact body bytes before the body is parsed.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean
npm run check:chargeback-rate     416 checks
npm run verify                    exit 0, 70 gate lines
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables
node lib/i18n/verify.ts           3161 messages, 342 placeholders
node lib/auth/verify.ts           58 files / 87 call sites (one pre-existing failure, unchanged)
node lib/jobs/verify.ts           110 checks
node scripts/verify-structure.mjs 757 source files
node scripts/verify-audit.mjs     4303 checks
```

The pre-existing red set is unchanged and was not absorbed: `lib/auth/verify.ts` 1 (`auth/device-proof-store`),
`lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3404. A sixth environment fact came out of this smoke and is worth writing down: as well as
`APP_URL`, `DATABASE_URL`, `ENCRYPTION_MASTER_KEY`, `AUDIT_SIGNING_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and the
two *distinct* Supabase keys, production also wants **`SUPABASE_URL`** and it must be `https` — an `http://127.0.0.1`
value boots and then fails every request with `SUPABASE_URL must use https outside a local development environment`,
which reads like a 500 in the handler and is nothing of the sort.

| Request | Answer |
| --- | --- |
| `GET /signin` | `200` |
| `GET /office/disputes` signed out | `307` to `/signin`, the same answer `/office/refunds` gives |
| `POST /api/office/disputes/chargeback/policy` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` |
| `POST .../chargeback/apply` (no token) | the same `422`, the same rule |
| `POST .../chargeback/clear` (no token) | the same `422`, the same rule |
| `apply` with a header that does not match its cookie | the same `422`, so the guard compares rather than merely looks |
| `apply` with a matching fake pair and `not-a-uuid` | the same `422` — the token is checked before the company |
| `GET` on all three | `405` |
| `next build` | the three routes listed as dynamic function routes |

The authenticated paths cannot be walked here: `GET /api/auth/csrf` answers `503 DEPENDENCY_FAILED` without a
Supabase project, so there is no token to sign a real request with and no session to read a real screen with. Those
paths are exercised end to end against the fixture in the gate, which carries `0128`'s trigger body, its eleven
checks, its partial unique indexes, `0080`'s key and live-key rules, `0044`'s one-active-reserve rule and frozen
terms, and `0111`'s suspension-needs-a-reason rule. `.env.local` was deleted again (checked: absent).

**Desktop and mobile widths** — the threshold form is `grid-cols-1` on a phone, `sm:grid-cols-2` from the tablet
breakpoint and `lg:grid-cols-3` on a desktop, because seven numbers in one row is a spreadsheet and not a form. The
watchlist is a stacked list at every width: one block per merchant, its counts and rate on one line, its badges and
its two buttons wrapping under them, so a phone shows one merchant per screen rather than a horizontally scrolling
table. The history is the same shape. No table is used, so nothing scrolls sideways.

## Carried gaps (named rather than hidden)

1. **The sweep is not scheduled.** `dispute.chargeback_rate` is registered and idempotent and the gate runs it, but
   no scheduler calls it: this repository's job registry has no ticker, and section 18's reporting cadence is not
   stated. A later STEP that lands the scheduler adds one line in `lib/jobs/defaults.ts`; nothing in this STEP
   changes.
2. **A suspension is counted, never taken by a clock.** Deliberate and documented above — but it does mean a
   merchant over the suspension bar sits in the watchlist until a super administrator presses. That is the same
   trade `0111` makes everywhere else.
3. **The rate counts *all* disputes in the window, not won ones.** `0039`'s disputes are the record of a chargeback;
   whether one was lost is a separate column with its own lifecycle, and section 18's sentence names a rate and a
   count, not an outcome. If an acquirer's programme later means "lost chargebacks only", that is one predicate in
   `readWindowCounts` and one in `measureOne`, and the gate would need one new fixture.
4. **Card network thresholds are defaults, not citations.** The 1.00/1.50/2.50 percent defaults are the numbers the
   industry most often quotes, not a claim about a particular network's current programme, and the migration says so.
   Every value is editable by a super administrator, which is what section 18 asks for.
5. **No per-merchant trend.** The screen shows the measurement now and the last twenty steps; there is no chart of a
   merchant's rate over time. `0037` has the rows for it and nothing here forbids it, but it is a screen, not a
   service.
6. **The warning notice is queued, not sent.** One `0061` row on the `dispute_update` template, for section 23's
   sender, exactly as STEP 198 queues its `dispute_update`.
7. **Clearing is a person's word, not a measurement.** A super administrator may clear a warning while the rate is
   still above the bar; the note is required and the audit records who, but nothing re-measures before the clearing.
   The next sweep would warn again, which is the guard the design relies on.
