# STEP 141 — Bank change 96 hour cooling period enforcement

**Status: COMPLETED**

## What was built

`lib/payments/bank-change-cooling.ts` — the bank change cooling period enforcement service. When a bank change request is approved by manual verification (STEP 140), the platform starts a 96-hour cooling period for the company. During this period, all payouts are fully paused — including to the previous verified bank. After 96 hours, the cooling period expires and payouts resume to the new bank account.

The service provides:
- `startCoolingPeriod(requestId, options)` — starts the cooling period when a request is approved. Checks that the request exists, is approved, and that no other cooling period is already active for the same company. The period is stored with start time, end time (start + 96 hours), and the new bank account id.
- `checkPayoutPause(companyId, nowEpochMs, options)` — checks whether payouts are paused for a company. Returns "paused" with the end time during the cooling period, "allowed" when no period is active or the period has expired. Expired periods are updated to "expired" status.
- `getCoolingPeriodEnd(companyId, nowEpochMs, options)` — returns the end time of the active cooling period (or null when none is active). Useful for the UI to show when payouts resume.

The 96-hour period is defined as `COOLING_PERIOD_MS = 96 * 60 * 60 * 1000`.

## What the gate proves

`lib/payments/bank-change-cooling-verify.ts` — 25 checks covering:

- A cooling period is started for an approved request with the right company, request id, start time, end time (96 hours), and status
- The cooling period is stored and findable as active by company
- Starting a cooling period for a non-approved request is rejected
- Starting a cooling period for a non-existent request is rejected
- Starting a second cooling period while one is active is rejected
- During the cooling period, payouts are paused with the right end time and reason
- After the cooling period ends (at 96 hours), payouts are allowed
- Payouts stay allowed after the cooling period expires
- When there is no active cooling period, payouts are allowed
- The cooling period expires and updates its status to "expired"
- No active cooling period remains after expiry
- A new cooling period can start after the previous one expires
- `getCoolingPeriodEnd` returns null when no period is active and the right end time when one is
- The cooling period carries the new bank account id

## What is NOT included

- The bank change manual verification flow itself (STEP 140 owns that — this file reads from it)
- The payout job that sends money (a later STEP owns that — this file is what that job checks before it pays)
- The API route or UI for viewing or managing cooling periods
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/bank-change-cooling.ts` (new) — the cooling period enforcement service
- `lib/payments/bank-change-cooling-verify.ts` (new) — the gate (25 checks)
- `package.json` — added `check:payments-bank-change-cooling` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the bank-change-cooling files
- Gate — 25 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build is STEP 142: "Minimum payout threshold of 100 USD with remainder rule." Below 100 USD, funds are paid out as the accumulated remainder after the holding period. STEP 142 will build the threshold calculation and the remainder rule.
