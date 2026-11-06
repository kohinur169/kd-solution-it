# STEP 142 — Minimum payout threshold of 100 USD with remainder rule

**Status: COMPLETED**

## What was built

`lib/payments/minimum-payout.ts` — the minimum payout threshold rule. Section 10 says "minimum payout amount is 100 USD. Below that amount, funds are paid out as the accumulated remainder after the holding period."

The service provides:
- `MINIMUM_PAYOUT_MINOR` — the constant: 100 USD in minor units (10,000 cents)
- `calculatePayoutAmount(availableMinor, { allowRemainder })` — the calculation:
  - Zero or negative balance: hold (never paid out)
  - `allowRemainder: true` (after the holding period): pay out the full balance, even if below the minimum
  - `allowRemainder: false` (normal operations): pay out the full balance only if it meets or exceeds 100 USD; otherwise hold with a descriptive reason
- `canPayout(availableMinor, { allowRemainder })` — a convenience check returning boolean

The remainder rule is the release valve: a merchant is never stranded with money they cannot withdraw because they are a few dollars short of the threshold. After the settlement holding period (STEP 136) ends, the accumulated balance is paid out regardless of whether it meets the 100 USD minimum.

## What the gate proves

`lib/payments/minimum-payout-verify.ts` — 28 checks covering:

- A balance above the minimum can be paid out during normal operations
- A balance below the minimum cannot be paid out during normal operations
- A balance above the minimum can be paid out under the remainder rule
- A balance below the minimum can be paid out under the remainder rule
- Zero balance cannot be paid out (both normal and remainder)
- Negative balance cannot be paid out
- The minimum payout constant is exactly 10,000 cents (100 USD)
- Exactly 100 USD can be paid out (boundary)
- 9,999 cents cannot be paid out normally but can be paid out under the remainder rule
- 10,001 cents can be paid out (boundary)
- 1 cent can be paid out under the remainder rule but not during normal operations
- 99 USD 99 cents cannot be paid out normally but can be paid out under the remainder rule
- `canPayout` returns true when the calculation says payout and false when it says hold
- The hold reason is descriptive (includes the available amount and the minimum)
- A large balance is paid out in full

## What is NOT included

- The settlement hold calculation itself (STEP 136 owns that)
- The payout execution and failure email notification (STEP 143 owns that)
- The API route or UI for payouts
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/minimum-payout.ts` (new) — the minimum payout threshold rule
- `lib/payments/minimum-payout-verify.ts` (new) — the gate (28 checks)
- `package.json` — added `check:payments-minimum-payout` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the minimum-payout files
- Gate — 28 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build is STEP 143: "Payout execution and failure email notification." This STEP will build the service that actually sends money to the merchant's bank account through the provider and handles failures with email notifications.
