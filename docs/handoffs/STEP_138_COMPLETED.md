# STEP 138 — Negative balance handling from reserve with contract collection record

**Status: COMPLETED**

## What was built

`lib/payments/negative-balance.ts` — the negative balance handling service. When a merchant's balance goes negative (e.g., a chargeback or refund exceeds the available balance), the platform covers the negative balance in two steps:

1. **Reserve draw** — the platform draws from `reserve_held` first. The reserve is debited and the merchant's payable is credited by the same amount. The group balances.
2. **Contract collection record** — if the reserve does not cover the full negative balance, the remainder is recorded as a `ContractCollectionRecord` (company, amount, reserve drawn, source type, source id, created-at, status). The record is the basis for the legal collection process.

The service returns a discriminated union result: `covered` (reserve fully covers the balance), `partially_covered` (collection record created for the remainder), or `rejected` (invalid amount).

## What the gate proves

`lib/payments/negative-balance-verify.ts` — 28 checks covering:

- A negative balance within the reserve is fully covered (no collection record)
- A negative balance exceeding the reserve is partially covered (collection record for the remainder)
- A negative balance with no reserve is fully collected (collection record for the full amount)
- Zero and negative amounts are rejected
- The reserve draw posts a balanced group (debit reserve_held, credit merchant_payable, both for the drawn amount)
- The reserve draw group carries the caller-provided source type
- The total covered (reserve drawn + collection amount) equals the negative balance amount
- Multiple collection records can be created for the same company
- The collection record carries the right company, source type, source id, and reserve drawn
- Two collection records have different ids
- A covered result posts no collection record
- The reserve draw is limited to the available reserve

## What is NOT included

- The chargeback or refund that causes the negative balance (separate movements)
- The legal collection itself — the record is the basis, not the collection
- The API route or UI for viewing collection records
- The reserve posting itself (STEP 137 owns that)

## Files changed

- `lib/payments/negative-balance.ts` (new) — the handling service
- `lib/payments/negative-balance-verify.ts` (new) — the gate (28 checks)
- `package.json` — added `check:payments-negative-balance` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the negative-balance files
- Gate — 28 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build should wire this service into the chargeback and refund flows that can cause a negative balance. The `handleNegativeBalance` function takes the cause's source type and source id, so the caller passes the chargeback or refund that triggered the negative balance.
