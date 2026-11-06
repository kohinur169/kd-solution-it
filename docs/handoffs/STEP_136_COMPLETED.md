# STEP 136 — Settlement hold calculation and scheduled release job

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_135_COMPLETED.md`.

## What this STEP is, in one paragraph

The settlement hold service: the hold that keeps captured funds in the ledger for the configured number
of days, and the scheduled release job that makes them available after the period. Section 10 of the
feature list says "settlement hold days are set by super_admin, globally and per sub-merchant when needed"
and "settlement is released automatically after the hold period." When a payment is captured, the
merchant's payable increases. But the platform does not release the funds yet — it holds them for the
configured number of days. The hold posts a balanced ledger group (source type `hold`): the merchant's
payable is debited and credited by the same amount. The group balances, and the net effect on the payable
is zero — the entry records the state change, not a balance change. The settlement release posts a second
balanced group (source type `settlement`) that mirrors the hold, recording the release. The scheduled
release job reads every hold, finds the ones whose release date has passed, and releases them. A hold
that is released is not released again.

## What it is not

- **It is not the payment capture.** STEP 132 owns the posting of the payment group. This STEP owns the
  hold that follows the capture.
- **It is not the payout.** A later STEP owns moving the released funds to the merchant's bank. This
  STEP releases the hold; the payout moves the money.
- **It is not the reserve.** STEP 137 owns the rolling reserve. The settlement hold is a timing
  mechanism; the reserve is a risk mechanism.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `createSettlementHold` and `releaseSettlementHolds`.
- **It does not need a migration.** The `public.ledger_entries` table and the `merchant_payable` account
  already exist from STEP 025 (migrations 0040 and 0041). Sub-step 3 was "if any", and it was not.
- **It does not touch a provider.** It posts ledger entries; it does not call any provider's API.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §10, MASTER_PROMPT money rules, STEP 135 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/settlement-hold.ts` — STEP 136 owns it | — |
| 3 | Database part | **none needed** — tables and accounts already exist | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/settlement-hold.ts`: hold calculation + scheduled release | payments-settlement-hold gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service validates the amount and hold period; the stores are the caller's (RLS/audit are the store's concern); it does not touch money directly or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The types, where each one lives

- **`SettlementHold`** — a hold record: id, company, amount in minor units, hold period in days, capture
  time, release time, and status (held or released).
- **`SettlementHoldStore`** — what the service reads and writes. The store is the caller's: the database
  implementation, or the in-memory store below.
- **`InMemorySettlementHoldStore`** — the reference implementation. It keys on hold id and tracks which
  holds belong to which company.
- **`createSettlementHold(amountMinor, holdDays, { holdStore, ledgerStore, companyId, capturedAtEpochMs })`**
  — validates the input, calculates the release date, posts the hold group, and stores the hold.
- **`releaseSettlementHold(holdId, { holdStore, ledgerStore })`** — releases a single hold. Returns the
  released hold, or null when the hold does not exist.
- **`releaseSettlementHolds({ holdStore, ledgerStore, nowEpochMs })`** — the scheduled release job.
  Releases every hold whose release date has passed. Returns the released holds.
- **`MILLISECONDS_PER_DAY`** — 86400000. One day in milliseconds.
- **`DEFAULT_SETTLEMENT_HOLD_DAYS`** — 2. The default hold period.

## The hold flow, step by step

1. **Validate the input.** The amount must be positive. The hold period must not be negative.
2. **Calculate the release date.** `releaseAtEpochMs = capturedAtEpochMs + holdDays * MILLISECONDS_PER_DAY`.
3. **Post the hold group.** A balanced ledger group: one debit to `merchant_payable`, one credit to
   `merchant_payable`, both for the hold amount. The group balances. The net effect on the payable is
   zero — the entry records the state change.
4. **Store the hold.** The `SettlementHold` record is inserted into the `SettlementHoldStore`.

## The release flow, step by step

1. **Find releaseable holds.** The `SettlementHoldStore` returns every hold whose status is `held` and
   whose release date has passed.
2. **For each hold, release it.** The hold's status is changed to `released`. A settlement group is
   posted: one debit to `merchant_payable`, one credit to `merchant_payable`, both for the hold amount.
   The group balances. The net effect on the payable is zero — the entry records the release.
3. **Store the released hold.** The `SettlementHold` record is updated (overwriting the previous
   version with the same id, now with `status: "released"`).

## Verification

| Gate | Result |
|---|---|
| payments-settlement-hold (`lib/payments/settlement-hold-verify.ts`) | **34 checks PASSING** — a hold is created with the right amount and release date, a hold is not releaseable before the release date and is releaseable after, a zero-day hold is immediately releaseable, a negative amount or period is rejected, the release date is correct for different hold periods, a hold can be released individually, a non-existent hold cannot be released, an already-released hold is not released again, the batch job releases all ready holds, the hold and settlement groups balance with the right source types |
| payments-platform-fee (STEP 135) | 34 checks PASSING (unchanged) |
| payments-ledger-balance (STEP 134) | 33 checks PASSING (unchanged) |
| payments-ledger-reversal (STEP 133) | 26 checks PASSING (unchanged) |
| payments-ledger-posting (STEP 132) | 34 checks PASSING (unchanged) |
| payments-ledger-accounts (STEP 131) | 33 checks PASSING (unchanged) |
| payments-creation (STEP 130) | 24 checks PASSING (unchanged) |
| payments-routing (STEP 129) | 24 checks PASSING (unchanged) |
| payments-registry (STEP 128) | 42 checks PASSING (unchanged) |
| payments-money (STEP 127) | 66 checks PASSING (unchanged) |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate | 2811 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The hold-and-release proof, as recorded

The STEP title names the behaviour, and the gate proves it twenty ways:

1. **A hold is created with the right amount and hold period.** `createSettlementHold(10000, 2, ...)`
   produces a hold with amount 10000 and holdDays 2.
2. **The release date is calculated correctly.** `releaseAtEpochMs = capturedAt + 2 * MILLISECONDS_PER_DAY`.
3. **A hold is not releaseable before the release date.** `findReleaseable` returns empty at the capture
   time and one day after.
4. **A hold is releaseable after the release date.** `findReleaseable` returns the hold at the release
   date and after.
5. **A zero-day hold is immediately releaseable.** `findReleaseable` returns it at the capture time.
6. **A negative amount is rejected.** `createSettlementHold(-1, 2, ...)` returns `rejected`.
7. **A negative hold period is rejected.** `createSettlementHold(10000, -1, ...)` returns `rejected`.
8. **The release date is correct for different hold periods.** A 1-day hold releases one day after
   capture. A 7-day hold releases seven days after.
9. **Multiple holds can be created for the same company.** `findByCompany` returns all holds.
10. **A hold can be released individually.** `releaseSettlementHold` returns the released hold.
11. **A non-existent hold cannot be released.** `releaseSettlementHold("nonexistent")` returns null.
12. **An already-released hold is not released again.** The second release returns the same hold with
    the same release date.
13. **A released hold is not returned by `findReleaseable`.** After release, `findReleaseable` returns
    empty.
14. **The batch job releases all ready holds.** With two 1-day holds and one 5-day hold, the batch job at
    day 2 releases the two 1-day holds.
15. **No holds are releaseable after the batch release.** At day 2, after the batch, `findReleaseable`
    returns empty (the 5-day hold is not yet releaseable).
16. **The hold is stored in the store.** `findById` returns the hold.
17. **Two holds have different ids.**
18. **The hold posts a ledger group.** The ledger store has at least two groups (hold and settlement).
19. **The hold ledger group balances with the right source type.** The group has two entries, both with
    sourceType `hold`, and debits = credits = the hold amount.
20. **The settlement ledger group balances with the right source type.** The group has two entries, both
    with sourceType `settlement`, and debits = credits = the hold amount.

## The double-entry proof, as recorded

The master prompt says "every STEP that touches money must prove balanced double-entry ledger postings for
its flows and record the proof in the handoff file." The proof is the hold and settlement groups:

- **A payment of 10000 minor units is captured.** The payment group (STEP 132) debits processor_clearing
  and credits merchant_payable. The merchant's payable increases by 10000.
- **The settlement hold is placed.** The hold group debits merchant_payable and credits merchant_payable
  by 10000. The group balances. The net effect on merchant_payable is zero — the entry records that the
  10000 is now "held."
- **After two days, the settlement is released.** The settlement group debits merchant_payable and credits
  merchant_payable by 10000. The group balances. The net effect on merchant_payable is zero — the entry
  records that the 10000 is no longer "held" and is now "available."

The two groups together net to zero on merchant_payable. The hold and settlement entries are recorded so
the statement shows the hold and the release as movements, even though the net effect on the balance is
zero. The state change (held → available) is tracked in the `SettlementHold` record.

## Package request

None. The settlement hold service is a plain TypeScript module with no dependencies beyond `node:crypto`
for `randomUUID()` and the `postLedgerEntries`, `LedgerEntryStore` types from `lib/payments/ledger-posting.ts`
(STEP 132).

## What is next

STEP 137 — "Rolling reserve posting, tracking and release" — owns the rolling reserve that the platform
holds back from every transaction as risk protection. STEP 136 holds the captured funds for a period;
STEP 137 holds back a percentage of the balance for risk.
