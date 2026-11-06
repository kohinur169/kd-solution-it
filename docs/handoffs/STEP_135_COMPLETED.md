# STEP 135 — Platform fee calculation and posting per transaction

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_134_COMPLETED.md`.

## What this STEP is, in one paragraph

The platform fee service: the percentage the platform keeps from every transaction, and the balanced
ledger group that posts it. Section 10 of the feature list says "platform fee percent is set by
super_admin, globally and per sub-merchant when needed." The fee is a percentage of the transaction
amount, calculated in whole minor units. When a payment is captured, the platform keeps its fee: the
merchant's payable is debited by the fee amount, and the platform's fee income is credited by the same
amount. The group balances because the debit and the credit are the same number. The fee is calculated
as `fee = (amount * basisPoints) / 10000` — integer arithmetic, so the fee is always a whole number of
minor units.

## What it is not

- **It is not the fee configuration.** The rate is set by the super admin and stored in the database.
  This file calculates the fee from a rate and posts it.
- **It is not the settlement.** STEP 136 owns the settlement hold and release. This STEP posts the fee;
  the settlement moves the remaining balance.
- **It is not the reserve or the payout.** Those are later STEPs in the section 10 sequence.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `postPlatformFee`.
- **It does not need a migration.** The `public.ledger_entries` table and the `platform_fee_income`
  account already exist from STEP 025 (migrations 0040 and 0041). Sub-step 3 was "if any", and it was
  not.
- **It does not touch a provider.** It posts ledger entries; it does not call any provider's API.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §10, MASTER_PROMPT money rules, STEP 134 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/platform-fee.ts` — STEP 135 owns it | — |
| 3 | Database part | **none needed** — tables and accounts already exist | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/platform-fee.ts`: fee calculation + posting | payments-platform-fee gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service validates the rate range and posts through the posting service; the store is the caller's (RLS/audit are the store's concern); it does not touch money directly or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The types, where each one lives

- **`BASIS_POINTS_PER_UNIT`** — 10000. One basis point is 0.01%; 290 basis points is 2.9%.
- **`DEFAULT_PLATFORM_FEE_BPS`** — 290. The default rate: 2.9%.
- **`MIN_FEE_BPS` / `MAX_FEE_BPS`** — 0 and 10000. The closed range the platform accepts (0% to 100%).
- **`calculatePlatformFee(amountMinor, basisPoints)`** — returns the fee in whole minor units:
  `(amount * basisPoints) / 10000`.
- **`postPlatformFee(amountMinor, basisPoints, { store, companyId, sourceId, paymentId })`** —
  calculates the fee and posts it as a balanced ledger group through `postLedgerEntries` (STEP 132).

## The fee posting, step by step

1. **Validate the rate.** The rate must be between 0 and 10000 basis points. An out-of-range rate is
   refused.
2. **Calculate the fee.** `fee = (amount * basisPoints) / 10000`. Integer division, so the fee is always a
   whole number of minor units.
3. **Check the fee is positive.** A zero fee (zero rate or zero amount) is refused — there is nothing to
   post.
4. **Post the fee group.** A balanced ledger group is built: one debit to `merchant_payable`, one credit
   to `platform_fee_income`, both for the fee amount. The group is posted through `postLedgerEntries`.

## The double-entry proof, as recorded

The master prompt says "every STEP that touches money must prove balanced double-entry ledger postings for
its flows and record the proof in the handoff file." The proof is the fee group:

- **A payment of 10000 minor units ($1.00) at a 2.9% rate** produces a fee of 290 minor units ($0.029).
- **The fee group:** one debit of 290 to `merchant_payable` (the merchant's payable decreases by the
  fee), one credit of 290 to `platform_fee_income` (the platform's fee income increases by the fee).
  Debits = 290, credits = 290. Balanced.

The fee group is separate from the payment group — it has its own `entryGroupId`. The payment group
debits the merchant's clearing account and credits the merchant's payable; the fee group then debits the
merchant's payable and credits the platform's fee income. The two groups together net the merchant's
payable by the fee amount.

## Verification

| Gate | Result |
|---|---|
| payments-platform-fee (`lib/payments/platform-fee-verify.ts`) | **34 checks PASSING** — fee calculation is exact in whole minor units, the fee group is posted and balanced, the debit goes to merchant_payable and the credit to platform_fee_income, the fee group carries the right source type and metadata, a zero fee is refused, an out-of-range rate is refused, the fee is positive for a normal transaction |
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

## The fee-calculation proof, as recorded

The STEP title names the behaviour, and the gate proves it ten ways:

1. **The fee is calculated correctly.** A 2.9% fee on 10000 minor units is 290. On 1000000 minor units
   is 29000. On 105 minor units is 3 (the fractional part is truncated).
2. **The fee is a whole number of minor units.** The calculation uses integer arithmetic; the result is
   always a `bigint`.
3. **A 100% fee equals the amount.** `calculatePlatformFee(10000, 10000) === 10000`.
4. **A 0% fee is zero.** `calculatePlatformFee(10000, 0) === 0`.
5. **A fee on a zero amount is zero.** `calculatePlatformFee(0, 290) === 0`.
6. **The fee group is posted.** `postPlatformFee` returns `posted` with two entries.
7. **The debit goes to merchant_payable.** The debit entry's account id is `merchant_payable`.
8. **The credit goes to platform_fee_income.** The credit entry's account id is `platform_fee_income`.
9. **The fee group balances.** The debit and credit are the same amount (290).
10. **A zero fee is refused.** `postPlatformFee` with a zero rate returns `rejected`, and nothing is
    posted. An out-of-range rate is also refused.

## Package request

None. The platform fee service is a plain TypeScript module with no dependencies beyond `node:crypto` for
`randomUUID()` and the `postLedgerEntries`, `LedgerEntryStore` and `LedgerPostingResult` types from
`lib/payments/ledger-posting.ts` (STEP 132).

## What is next

STEP 136 — "Settlement hold calculation and scheduled release job" — owns the settlement hold that
keeps funds in the ledger for the configured number of days before releasing them to the merchant's
payable. STEP 135 posts the fee; STEP 136 moves the remaining balance after the hold period.
