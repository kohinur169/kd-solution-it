# STEP 193 — Platform fee on refund rule applied from super admin setting

Status: **complete**. One commit, `STEP 193: Platform fee on refund rule applied from super admin setting`, on
`arena/ca936761-kd-solution-it`, branched from STEP 192's `2b83322`. Typecheck, lint and build are clean, and the
STEP's own gate is `services/payments/refund-fee-verify.ts` at **213 checks**, mutation-checked with thirteen
mutations.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 193: Platform fee on refund rule applied from super admin setting**
> Sub-step 4: Implement the core service and logic for: Platform fee on refund rule applied from super admin
> setting.

FEATURE_LIST §18, in the middle of the payment-page section: *"Whether the platform fee is returned on a refund is
set by super_admin."* §10 says the fee itself is a percentage of every transaction which the platform keeps when
the payment is captured; §11 says the ledger covers a refund; §19 says every refund action is audit logged.

STEP 191 built the request and the decision, and STEP 192 the execution through the provider. Both left the two
columns `0038` had already built - `platform_fee_returned` and `platform_fee_returned_minor` - written by nobody,
and both handoffs named the fee rule as this STEP's. This is that STEP: one person answers the question once, and
every refund that afterwards sends money back has the answer applied to it.

Eight sub-steps, all done. Sub-step 3 is a migration, and sub-step 5 is where the answer is applied (the screen,
two routes, and the execution route's one step after a success).

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `migrations/0123_refund_fee_rule.sql` + `.down.sql` | new | `refunds.platform_fee_settled_at`, the two constraints that keep it honest, the sweep's partial index, and the seeded switch |
| `services/payments/refund-fee-fields.ts` | new | The vocabulary: the setting key and its closed default, eleven rule codes, three audit actions, the two limits, the proportion and the deterministic ledger group |
| `services/payments/refund-fee.ts` | new | `readRefundFeeRule`, `saveRefundFeeRule`, `applyRefundFeeReturn`, `sweepRefundFeeReturns`, `readRefundFeeBacklog` |
| `services/payments/refund-fee-runtime.ts` | new | The production wiring: the PostgREST client, the signed chain, the clock, and the absent ledger store with its reason |
| `services/payments/refund-fee-verify.ts` | new | The gate: 213 checks over a fixture carrying `0038`'s refund checks and `0123`'s two new ones |
| `app/api/office/refunds/fees/route.ts` | new | `GET` the switch and the backlog, `POST` the answer (super administrator, device proof, version guard) |
| `app/api/office/refunds/fees/settle/route.ts` | new | `POST` the pass: apply the answer to the refunds still unanswered |
| `app/(admin)/office/refunds/fees/page.tsx` | new | The screen: the answer in force, what it does, the backlog, and the two acts |
| `app/(admin)/office/refunds/fees/refund-fee-form.tsx` | new | The switch form and the pass button, each with the device proof and the CSRF token |
| `services/payments/refund.ts` | untouched | Reused: `findRefund`'s projection, `viewOf`, `moveRefund` (the versioned guarded write) and `appendTolerated` |
| `app/(admin)/office/refunds/page.tsx` | edited | A succeeded row now prints the fee answer, and the queue links to the screen that answers it |
| `app/api/office/refunds/[id]/execute/route.ts` | edited | One step after a success: apply the rule to the refund that just went back, tolerantly |
| `lib/security/csrf.ts` | edited | The two new routes added to `CSRF_PROTECTED_PATHS` |
| `lib/i18n/strings/en.ts` | edited | 36 strings: a `refundFees` group of 33 and three keys in `refunds` |
| `lib/auth/verify.ts` | edited | One browser file and two call sites added to the scan's counts |
| `services/payments/refund-verify.ts`, `refund-execution-verify.ts` | edited | One assertion each: the newest migration is `123`, and each still says it owns none |

`lib/payments/`, `lib/settings/` and `services/products/price.ts` are **untouched**: the posting service, the
ledger interfaces and the money formatting are imported, not edited.

## The database sub-step

`0123` does four things, and each answers a question the two `0038` columns cannot:

1. **`refunds.platform_fee_settled_at timestamptz`** - when the section 18 rule was applied to this refund. It is
   a different fact from "the fee came back", because the rule has three answers and `false / 0` can only hold
   two of them: the fee came back, the rule was open with nothing to return (a fee of zero, or a share that
   rounds to zero), and the rule was closed so the platform keeps its fee. A null here is the only state that
   means *not answered yet*, which is what makes the sweep a queue instead of a full scan and what stops a second
   pass from answering the same refund twice.
2. **`refunds_platform_fee_settled_check`** - the instant exists only on a `succeeded` refund, and never before
   the refund was asked for. The rule is about money that went back; a rule applied to a `requested` refund would
   be a fee returned for a refund that never happened.
3. **`refunds_platform_fee_answered_check`** - `platform_fee_returned` implies both a settled instant and a
   positive amount. Together with `0038`'s `refunds_platform_fee_check` (`returned or minor = 0`) and
   `refunds_guard_amount` (`minor <= payments.platform_fee_minor`), the four constraints make the two columns and
   the new instant agree in every combination except "nothing came back", which is the state a closed rule leaves.
4. **`refunds_fee_settle_idx`** - a partial index over `(processed_at)` where `status = 'succeeded'` and
   `platform_fee_settled_at is null` and the row is not soft deleted: the pass reads the work, not the table.

It then seeds the switch: `refunds.platform_fee_returned` as a JSON `false`. Section 18 makes returning the fee a
deliberate act, and a switch that seeded open would quietly hand back fees in a deployment where nobody had
decided to - the opposite of `0081`, which seeded the breached-password check open because failing open was the
safe side there. Whichever way a switch is easier to leave alone should be the side that moves no money.

**Rollback proof.** `0123_refund_fee_rule.down.sql` deletes the seeded row first, so a deployment that rolls back
while the service still runs finds the switch **closed** rather than open with a reader that lost its columns
(a missing row is the closed side, exactly as `lib/auth/breach-check.ts` reads a missing switch). Then the index,
then the column - and dropping the column drops the two constraints with it, so nothing is named twice. What the
rollback costs is the record of *when* the rule was applied; it does not lose the answer, because
`platform_fee_returned` and `platform_fee_returned_minor` are `0038`'s and survive. The gate reads the down file
and asserts all three statements, and `node migrations/verify.ts` passes with **123 migrations, 92 tables**.

## The rule, as arithmetic

For a refund of `r` against a payment of `a` that carried a fee `f`, with `already` already returned by the
payment's other succeeded refunds:

```
remaining = f - already
completes = payments.refunded_minor >= a        (the trigger's own number, already including this refund)
return    = completes ? remaining : min(floor(f * r / a), remaining)
```

Two properties, both checked in the gate as table rows rather than prose:

- **No part returns more than its proportion.** A quarter of a payment returns a quarter of the fee; a part so
  small that its share is under one minor unit returns **nothing** rather than a rounded amount.
- **A payment refunded in full returns the whole fee, exactly.** The refund that completes the payment takes the
  remainder instead of its own share, so three parts of 25/25/50 on a 100.00 payment with a 2.90 fee return
  0.7250 + 0.7250 + 1.4500 = 2.9000 - and rounding down twice never leaves dust the platform kept from a merchant
  who refunded everything.

`already` is summed from the siblings' `platform_fee_returned_minor`, and it caps the return so a fee is never
returned twice. The switch being closed is an answer too, and so is a fee of zero, a share of zero, and a fee an
earlier refund already returned in full: each writes the settled instant with `false / 0` and one chain entry
naming its rule, so the queue empties and the answer is on the record.

## The two acts

**Answering** - `saveRefundFeeRule`. Section 18's role (`super_admin` only) plus a fresh second factor, the
version the screen read, an insert when no row exists and a version-guarded update when one does. A save of the
value already in force writes nothing and audits nothing: the chain records answers, not button presses. A stale
screen is a `409` with `rule: "stale"`, so two officers who both flip the switch do not silently overwrite each
other. One audit entry, `refund.fee_rule_updated`, with the answer and the one it replaced.

**Applying** - `applyRefundFeeReturn` for one refund, `sweepRefundFeeReturns` for the backlog. The sweep is that
same function in a loop over `0123`'s index, fifty at a time, oldest processed first, so one press is bounded work
and a row that moved under the pass is counted as skipped instead of failing the pass. The execution route also
calls the single application for a refund it just settled, inside a `try`, because the refund has already left and
a fee that cannot be written yet is the desk's next press - never a `500` on a refund that succeeded.

The order inside one application is deliberate:

1. the desk role, the refund (platform-scoped: the desk settles for every merchant), the status, and whether the
   question was already answered;
2. the payment, in the refund's own company - its fee and its refunded total are the inputs;
3. the switch;
4. the plan;
5. **the ledger group** - the money;
6. **the refund row** - the record, through STEP 191's versioned guarded write, so the answer cannot overwrite a
   row that moved;
7. one chain entry - the record of the record.

A crash between 5 and 6 leaves a posted pair and an unrecorded refund; the next pass derives the **same** group id
because it is `feeReturnGroupIdOf(refundId)` - a SHA-256 digest shaped as a version 5 UUID - finds the group
instead of posting a second one, reads the amount the ledger actually holds, and writes *that*. A random id would
post a second pair and pay a merchant twice, which is the failure the deterministic id exists to make impossible.
The gate stages exactly that crash (a group of 5000 posted for a refund whose plan says 7250) and asserts the
retry records 5000 and writes no second pair.

## Security

| Concern | Where it is answered |
| --- | --- |
| Permission | Answering the question is `super_admin` alone (§18). Reading it and running the pass are the refund desk (`finance_ops`, `super_admin`); a merchant is refused by the service, not by the screen. |
| Second factor | The save and the pass require `requireFreshReauthentication` - a ten-minute window - on top of the role, because one press writes many merchants' records. |
| CSRF | Both routes call `requireCsrfToken` first, and both are on `CSRF_PROTECTED_PATHS`; the smoke test shows an unauthenticated `POST` answering `422 {field: "csrf", rule: "csrf_token_invalid"}`. |
| Device proof | `verifySensitiveRequest` + `requireTrustedDevice` over the exact bytes, and the browser signs what it sends (`deviceProofHeaders`). |
| Validation | A boolean and an instant, 512 bytes; `returned` must be a JSON boolean (a string is refused, and a stored `"true"` reads as the default rather than as on); `savedAt` must be a string when present; the pass takes no field at all. |
| Optimistic locking | The switch is written with `version=eq.` and read back; the refund row goes through `moveRefund`, which names the status and the version and reads back both. |
| Tenancy | The refund is read platform-scoped (a desk acts for every merchant) and the **payment** is read `company_id=eq.{refund.company_id}`; the ledger pair carries the refund's company. |
| Idempotency | `platform_fee_settled_at` is the marker: answered once, and a second pass changes nothing. The ledger group id is derived from the refund, so a retry finds the pair. |
| Ledger honesty | The pair is written *before* the row, so a lost row write is repairable and a failed pair leaves the refund unanswered. `0041`'s pairing is respected: a `refund` source carries `refund_id` and **no** `payment_id`. |
| Audit | Three actions under entity `refund` (and the switch under `platform_settings`), written tolerantly so a chain that is down never blocks money; each carries the amount, the fee, what was already returned, and the ledger group id. |
| RLS | `refunds` and `platform_settings` are unchanged in policy; `0123` adds a column, two checks and an index, and no policy is loosened. |
| Failure mode | A ledger that refuses is `unavailable` with the refund untouched; a missing payment is the same; a row that moved is `refund_moved`; nothing writes a payment - the gate asserts the service's only direct table write is the switch. |

## The gate

`node services/payments/refund-fee-verify.ts` - **213 checks** in eleven sections, over a PostgREST fixture that
carries `0038`'s `refunds_platform_fee_check` and `0123`'s two new constraints, so three mutations are caught by
the database's rules rather than by an assertion:

- **the vocabulary**: eleven distinct rule codes in the envelope's alphabet, three dotted audit actions, a setting
  key `platform_settings_key_check` accepts, the role lists, the two limits, the group id (deterministic, valid,
  distinct per refund), and five share cases including the divisor-of-zero guard;
- **the plan**: nine cases - a quarter, the remainder, the cap by what is left, a fee already exhausted, a fee of
  zero, a share of zero, a payment of zero;
- **the switch**: the default when nobody answered, a stored `"true"` read as unset, a merchant and a finance
  officer refused, a stale second factor refused, a no-op save writing nothing, the insert, the second save, the
  stale-save conflict, the closing update with its version bump, and the chain entry each way;
- **a return**: 7250 of 29000 on a quarter refund, the row's instant and version, the pair's two entries (fee
  income debited, merchant payable credited, balanced, sourced as a refund, carrying no payment id, in the
  derived group), the chain entry, no payment write - then a second application that changes nothing;
- **parts**: three refunds of 25/25/50 returning 7250 + 7250 + 14500 = 29000 exactly, with the last one knowing
  it completes the payment because the payment's own total says so;
- **the answers that return nothing**: the closed switch, a fee of zero, a share below a minor unit, a fee already
  exhausted, and a refund that is not `succeeded` - each recorded once, and the unsettled one left untouched;
- **the ledger**: a store that refuses leaving the row unanswered and the chain empty, and a deployment with no
  store recording the answer as `ledger: "absent"`;
- **the crash**: the pair posted, the row write lost, and the retry recording the ledger's 5000 without a second
  pair; plus a row that moved reported as `refund_moved`;
- **who may ask**: a merchant refused, an unknown refund not found;
- **the pass**: two of three refunds settled, the second pass finding nothing, a bound of fifty on a backlog of
  fifty-five with five left, the backlog read, a merchant refused, a stale super administrator refused, and a
  closed switch still recording its answer;
- **the sources**: `0123`'s column, constraints, index and seed; the down file's three statements; `123` as the
  newest migration; the service's only direct write being the switch; the vocabulary module importing no database,
  chain or clock; the runtime passing no ledger store and saying why; CSRF, device proof, ceiling and `no-store`
  on both routes and both routes in the CSRF inventory; the execution route applying the rule only after
  `succeeded` and inside a `try`; the screens rendering the switch only when `canEdit` and printing the answer on
  the queue; and the sixteen catalogue keys the screens name.

**Mutation-checked, thirteen mutations, thirteen caught:**

| Mutation | What caught it |
| --- | --- |
| the switch defaults to open | "the default keeps the platform's fee" |
| every part takes the remainder | "a quarter refund returns a quarter of the fee (expected 7250, got 29000)" |
| no cap by what is left of the fee | "and the rule says why (expected `refund_fee_exhausted`, got `refund_fee_share_zero`)" |
| a closed switch is not recorded | "the question is recorded as answered, so the pass never asks it again" |
| the settled instant is not checked | "a refund the rule already answered is skipped (got returned)" |
| the row claims a return of zero | `0123`'s `refunds_platform_fee_answered_check` refused the row |
| the group id is random | "the ledger group of a refund is the same group every run" |
| the pair carries the payment id | "and not the payment, which `0041` refuses a refund source to carry" |
| the pass ignores its bound | "a pass works through fifty refunds and stops (expected 50, got 55)" |
| the pass needs no fresh second factor | "the pass needs a fresh second factor even for the super administrator (nothing was thrown)" |
| a stale save overwrites | "a screen built before somebody else answered cannot overwrite their answer" |
| a merchant may settle | "a merchant cannot settle the platform fee on any refund (nothing was thrown)" |
| the execution route applies the rule whatever the outcome | "the execution route applies the fee rule only to a refund that went back" |

## Desktop and mobile widths

The screen is three blocks in the office shell's column: the header, the answer in force, and the pass. At 1440 px
the cards sit at the shell's content width with `p-4` and their own vertical rhythm, exactly as the settings screen
does; at 360 px nothing is fixed-width, so the two radio choices (`flex-wrap`) stack, the save button keeps its own
line with the hint wrapping under it (`flex flex-wrap items-center gap-2`), and the backlog sentence wraps rather
than scrolling. The queue row grows by one paragraph on a `succeeded` refund, in the same `text-sm` body style as
the two lines above it, so it wraps in the same place they do. The page also carries the shared link style for the
way back, which is a `w-fit` inline link and therefore never wider than its text.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean (0 errors) |
| `npm run lint` | clean |
| `npm run build` | compiled; `/api/office/refunds/fees`, `/api/office/refunds/fees/settle` and `/office/refunds/fees` are dynamic |
| `node services/payments/refund-fee-verify.ts` | **213 checks** |
| `node services/payments/refund-verify.ts` | 259 checks (259 rather than 256: the queue page's three new labels are catalogue keys that gate also checks) |
| `node services/payments/refund-execution-verify.ts` | 141 checks |
| `npm run check:i18n` | 2862 messages (was 2826), 298 placeholders, 1 locale |
| `npm run check:structure` | 703 source files (was 695) |
| `npm run check:audit` | 3967 checks (was 3918) |
| `npm run check:shell` | 1041 checks, 331 files |
| `npm run check:migrations` | 3593 checks, **123 migrations**, 92 tables |
| `npm run check:lint` / `check:errors` | 77 / 202 checks |
| `npm run check:config` / `check:env` / `check:logger` / `check:jobs` | 10 / 16 / 117 / 110 |
| `node lib/auth/verify.ts` | 1 problem, the same pre-existing dialers equality (its browser counts were updated for this STEP) |
| `node lib/security/verify.ts` | 3 problems, the same pre-existing three STEP 191 recorded |
| `node components/office/verify.ts` | 13 problems, **identical to the list at `2b83322`** - checked in a baseline worktree, so this STEP adds none |

### Runtime smoke, against `next dev`

| Probe | Answer |
| --- | --- |
| `GET /api/office/refunds/fees` | `401 AUTHENTICATION_REQUIRED` - the session is the first guard on a read |
| `POST /api/office/refunds/fees` | `422`, `{field: "csrf", rule: "csrf_token_invalid"}` - the token is the first guard on a write |
| `POST /api/office/refunds/fees/settle` | `422`, the same refusal |
| `POST` with a 2 000-byte body | `422` (token first, then the 512-byte ceiling) |
| `GET /office/refunds/fees` | `307 → /signin`, the office shell's own refusal |
| `GET /office/refunds` | `307 → /signin`, unchanged by the fee line |

### The gates that were red before this STEP

`lib/security/verify.ts` (a dotted audit-action literal somewhere in the tree, and `nmi-client.ts` naming an
encryption algorithm beside the two modules allowed to), `lib/auth/verify.ts`'s one remaining problem (eighteen
provider adapters calling `fetch(` outside the guarded transport), and `components/office/verify.ts`'s thirteen
(the navigation catalogue lists a `provisioningQueue` entry the gate's expected role lists do not). None is refund
or fee code; the office gate's failure list was diffed against a worktree at `2b83322` and is identical, and the
auth gate's browser counts and the two earlier refund gates' migration assertions were updated for this STEP.

## What is genuinely unfinished

1. **No ledger store in production.** `lib/payments/ledger-posting.ts` needs a transactional `LedgerEntryStore`,
   and this build has none - the same gap STEP 132 and STEP 135 recorded. The answer is therefore recorded on the
   refund and in the signed chain, and the pair is posted the moment a store is supplied; the result says
   `ledger: "absent"` rather than pretending a pair exists, and the chain carries the derived group id, so returns
   recorded before that day can be posted later without posting twice. The screen says this in words.
2. **No scheduler.** The pass is a button on the fees screen and the execution route's one inline call; a
   scheduler would run `sweepRefundFeeReturns` on a clock. `lib/jobs` still has no database store, so a scheduled
   run would not survive a restart - the reason STEP 011's runtime is unused so far.
3. **No retroactive application, by design.** A refund the platform settled under a closed switch keeps its
   answer when the switch opens: the instant records that the question was asked. A super administrator who wants
   history re-answered would need a deliberate reopening pass, which does not exist and is not obviously right.
4. **Four providers are unaffected.** The fee rule is about the platform's own fee, not the processor's: nothing
   here depends on which provider took the payment, and STEP 192's four unsupported providers remain so.
5. **No notification.** Neither the answer nor a return is emailed to anybody; the merchant sees the amount on
   the refund row and the office sees it on the queue. §19's notification work is a later STEP.
6. **No office navigation entry** for `/office/refunds`, `/office/refunds/fees` or `/office/provisioning`. The
   navigation catalogue and its gate are another STEP's; the gate's list is unchanged by this STEP and still red.

## Left for the STEPs after this one

- STEP 194: the dispute list and status tracking from provider webhooks (§19's dispute half).
- A transactional ledger store, a scheduler for the pass, and §19's notification of a refund decision and a fee
  return.
