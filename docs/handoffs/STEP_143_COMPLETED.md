# STEP 143 — Payout execution and failure email notification

**Status: COMPLETED**

## What was built

`lib/payments/payout-execution.ts` — the payout execution service. Section 10 says "failed payouts are reported to the merchant by email." A payout takes money from the merchant's balance and sends it to the merchant's bank account through the provider. The provider either sends the money (success), refuses (failed with a reason), or says it is still processing (pending). The platform records the result and, when the payout fails, sends an email to the merchant so they know the money did not arrive.

The service provides:
- `executePayout(input, options)` — validates the input (positive amount, merchant email required), creates a pending execution record, calls the provider's payout function, records the result (success/failed/pending), and on failure sends an email notification to the merchant.

The execution record tracks: id, company, amount, bank account id, provider bank account id, provider name, status (pending/success/failed), error message, email sent flag, creation time, and completion time.

The provider call is an adapter concern (STEPs 147-169). The core defines the `ProviderPayoutFn` port. The email is also a port (`EmailNotificationFn`) — the email system itself is owned by STEPs 221-230.

## What the gate proves

`lib/payments/payout-execution-verify.ts` — 31 checks covering:

- A valid payout is executed successfully with the right status, no error message, no email, and a completion time
- The execution record is stored and findable by company
- Zero amount, negative amount, and empty merchant email are rejected
- A failed provider payout records the failure with the error message, marks email as sent, and records the completion time
- An email is sent on failure to the merchant with the right subject and body (including the failure reason)
- A pending provider payout keeps the record as pending with no completion time and no email
- Multiple payouts can be executed for the same company (success and failed)
- `findFailedByCompany` returns only failed payouts
- The execution carries the right company, amount, bank account id, provider bank account id, and provider name
- Two executions have different ids

## What is NOT included

- The payout threshold check (STEP 142 owns that — the caller checks before calling this)
- The cooling period pause check (STEP 141 owns that)
- The email system itself (STEPs 221-230 own that — this file uses a function port)
- The API route or the background job that triggers payouts
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/payout-execution.ts` (new) — the payout execution service
- `lib/payments/payout-execution-verify.ts` (new) — the gate (31 checks)
- `package.json` — added `check:payments-payout-execution` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the payout-execution files
- Gate — 31 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build is STEP 144: "Settlement release background job after hold period." This STEP will build the background job that releases settlement holds after the configured hold period ends, triggering payouts for eligible balances.
