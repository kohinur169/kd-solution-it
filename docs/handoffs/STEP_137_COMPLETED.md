# STEP 137 — Rolling reserve posting, tracking and release

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_136_COMPLETED.md`.

## What this STEP is, in one paragraph

The rolling reserve service: the percentage the platform holds back from every transaction as risk
protection, and the scheduled release that returns it after the configured number of days. Section 10 of
the feature list says "rolling reserve exists for risk and negative balance protection. Reserve percent
and release days are set by super_admin." When a payment is captured, the platform holds back a percentage
of the amount as a rolling reserve. The merchant's payable is debited by the reserve amount, and the
platform's reserve account is credited by the same amount. The group balances. After the release period,
the reserve is returned: the reserve account is debited and the merchant's payable is credited by the
same amount. The group balances. The reserve is "rolling" because it is continuously adjusted: new
transactions add to the reserve, and old reserves are released on schedule. The `ReserveHold` record
tracks each individual hold — its amount, its release date, and its status — so the release job can find
the ones that are ready.

## What it is not

- **It is not the negative balance handling.** STEP 138 owns that — "a negative balance is covered first
  from reserve." This STEP posts and releases reserves; STEP 138 uses the released reserve to cover a
  negative balance.
- **It is not the settlement hold.** STEP 136 owns the settlement hold (the entire captured amount held
  for a period). The reserve is a percentage of the amount, held for a different (usually longer) period.
- **It is not the payout.** A later STEP owns moving the released funds to the merchant's bank.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `postReserve` and `releaseReserves`.
- **It does not need a migration.** The `public.ledger_entries` table, the `reserve_held` account, and
  the `source_type` vocabulary already exist from STEP 025 (migrations 0040 and 0041). Sub-step 3 was
  "if any", and it was not.
- **It does not touch a provider.** It posts ledger entries; it does not call any provider's API.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §10, MASTER_PROMPT money rules, STEP 136 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/reserve.ts` — STEP 137 owns it | — |
| 3 | Database part | **none needed** — tables and accounts already exist | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/reserve.ts`: reserve posting + tracking + release | payments-reserve gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service validates the amount, rate range and release period; the stores are the caller's (RLS/audit are the store's concern); it does not touch money directly or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The types, where each one lives

- **`ReserveHold`** — a hold record: id, company, reserve amount in minor units, release period in days,
  capture time, release time, and status (held or released).
- **`ReserveHoldStore`** — what the service reads and writes. The store is the caller's: the database
  implementation, or the in-memory store below.
- **`InMemoryReserveHoldStore`** — the reference implementation. It keys on hold id.
- **`calculateReserve(amountMinor, basisPoints)`** — returns the reserve in whole minor units:
  `(amount * basisPoints) / 10000`.
- **`postReserve(amountMinor, basisPoints, reserveDays, { holdStore, ledgerStore, companyId, capturedAtEpochMs })`**
  — validates, calculates, posts the reserve group, and stores the hold.
- **`releaseReserve(holdId, { holdStore, ledgerStore })`** — releases a single hold. Returns the released
  hold, or null when the hold does not exist.
- **`releaseReserves({ holdStore, ledgerStore, nowEpochMs })`** — the scheduled release job. Releases
  every hold whose release date has passed.
- **`DEFAULT_RESERVE_BPS`** — 500 (5%). The default reserve rate.
- **`DEFAULT_RESERVE_DAYS`** — 30. The default release period.

## The reserve flow, step by step

1. **Validate the input.** The amount must be positive. The rate must be between 0 and 10000 basis
   points. The release period must not be negative.
2. **Calculate the reserve.** `reserve = (amount * basisPoints) / 10000`. Integer division, so the
   reserve is always a whole number of minor units.
3. **Check the reserve is positive.** A zero reserve (zero rate) is refused — there is nothing to post.
4. **Calculate the release date.** `releaseAtEpochMs = capturedAtEpochMs + reserveDays * MILLISECONDS_PER_DAY`.
5. **Post the reserve group.** A balanced ledger group: one debit to `merchant_payable`, one credit to
   `reserve_held`, both for the reserve amount. The group balances.
6. **Store the hold.** The `ReserveHold` record is inserted into the `ReserveHoldStore`.

## The release flow, step by step

1. **Find releaseable holds.** The `ReserveHoldStore` returns every hold whose status is `held` and whose
   release date has passed.
2. **For each hold, release it.** The hold's status is changed to `released`. A release group is posted:
   one debit to `reserve_held`, one credit to `merchant_payable`, both for the hold amount. The group
   balances.
3. **Store the released hold.** The `ReserveHold` record is updated (overwriting the previous version with
   the same id, now with `status: "released"`).

## Verification

| Gate | Result |
|---|---|
| payments-reserve (`lib/payments/reserve-verify.ts`) | **35 checks PASSING** — the reserve is calculated correctly in whole minor units, the reserve group is posted and balanced (debit merchant_payable, credit reserve_held), a zero reserve is refused, an out-of-range rate is refused, a negative period is refused, the hold is not releaseable before the release date and is releaseable after, a zero-day hold is immediately releaseable, the batch job releases all ready holds, the release group balances with the opposite accounts (debit reserve_held, credit merchant_payable), a released hold is not released again |
| payments-settlement-hold (STEP 136) | 34 checks PASSING (unchanged) |
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

## The reserve-and-release proof, as recorded

The STEP title names the behaviour, and the gate proves it eighteen ways:

1. **The reserve is calculated correctly.** A 5% reserve on 10000 minor units is 500. On 1000000 minor
   units is 50000. On 105 minor units is 5 (the fractional part is truncated).
2. **A 0% reserve is zero.** `calculateReserve(10000, 0) === 0`.
3. **The reserve group is posted.** `postReserve` returns `created` with a hold carrying the right amount
   and release period.
4. **The reserve group balances.** The group has two entries: one debit to `merchant_payable`, one credit
   to `reserve_held`, both for the reserve amount.
5. **A zero reserve is refused.** `postReserve` with a zero rate returns `rejected`.
6. **An out-of-range rate is refused.** `postReserve` with a rate above 10000 returns `rejected`.
7. **A negative release period is refused.** `postReserve` with a negative period returns `rejected`.
8. **A reserve is not releaseable before the release date.** `findReleaseable` returns empty at the
   capture time and before the release date.
9. **A reserve is releaseable after the release date.** `findReleaseable` returns the hold at the release
   date and after.
10. **A zero-day reserve is immediately releaseable.** `findReleaseable` returns it at the capture time.
11. **A reserve can be released individually.** `releaseReserve` returns the released hold.
12. **A non-existent reserve cannot be released.** `releaseReserve` returns null.
13. **An already-released reserve is not released again.** The second release returns the same hold with
    the same release date.
14. **A released reserve is not returned by `findReleaseable`.** After release, `findReleaseable` returns
    empty.
15. **The batch job releases all ready reserves.** With two 10-day holds and one 50-day hold, the batch
    job at day 11 releases the two 10-day holds.
16. **No reserves are releaseable after the batch.** At day 11, after the batch, `findReleaseable` returns
    empty.
17. **The release group balances with the opposite accounts.** The release group has one debit to
    `reserve_held`, one credit to `merchant_payable`, both for the reserve amount.
18. **The constants are correct.** The default rate is 500 basis points (5%), the default period is 30
    days.

## The double-entry proof, as recorded

The master prompt says "every STEP that touches money must prove balanced double-entry ledger postings for
its flows and record the proof in the handoff file." The proof is the reserve and release groups:

- **A payment of 10000 minor units is captured.** The payment group (STEP 132) debits processor_clearing
  and credits merchant_payable. The merchant's payable increases by 10000.
- **The reserve is posted.** The reserve group debits merchant_payable and credits reserve_held by 500
  (5% of 10000). The group balances. The merchant's payable decreases by 500; the platform's reserve
  increases by 500.
- **After 30 days, the reserve is released.** The release group debits reserve_held and credits
  merchant_payable by 500. The group balances. The platform's reserve decreases by 500; the merchant's
  payable increases by 500.

The two groups together net to zero on both accounts. The reserve posting holds back risk money; the
release returns it. The `ReserveHold` record tracks the state so the release job can find the ones that
are ready.

## Package request

None. The reserve service is a plain TypeScript module with no dependencies beyond `node:crypto` for
`randomUUID()`, `BASIS_POINTS_PER_UNIT` / `MIN_FEE_BPS` / `MAX_FEE_BPS` from
`lib/payments/platform-fee.ts` (STEP 135), and the `postLedgerEntries`, `LedgerEntryStore` types from
`lib/payments/ledger-posting.ts` (STEP 132).

## What is next

STEP 138 — "Negative balance handling from reserve with contract collection record" — owns the flow that
covers a negative balance first from the reserve, and any remaining amount through the contract process.
STEP 137 posts and releases reserves; STEP 138 uses the released reserve to cover a negative balance.
