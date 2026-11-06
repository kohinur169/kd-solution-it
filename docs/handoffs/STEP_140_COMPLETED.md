# STEP 140 — Bank change manual verification flow

**Status: COMPLETED**

## What was built

`lib/payments/bank-change-verification.ts` — the bank change manual verification flow service. When a merchant wants to switch their payout bank account, they submit a change request with the new bank details. The request is stored as pending — nothing happens to the current bank account yet. An office role then reviews the request and either approves or rejects it.

**Submit:** `submitBankChangeRequest()` validates the new bank details (account holder, bank name, account number, routing/SWIFT, currency, provider), checks that the current bank account exists and is linked, checks that no other request is already pending for the same company, and stores the request as pending.

**Verify:** `verifyBankChangeRequest()` is the manual review. When the office role approves, the service calls the payout bank account add flow (STEP 139) to register the new bank with the provider and create the account. The new account becomes the active one. The request is marked approved and carries the new account id. When the office role rejects, the request is marked rejected and no new bank account is created — the previous bank stays active and the cooling period never starts.

The service enforces:
- A merchant cannot submit a second change request while one is already pending
- A request that is not pending cannot be verified again
- Approval is the only path that creates a new bank account
- Rejection is the no-op path — the previous bank is untouched

## What the gate proves

`lib/payments/bank-change-verification-verify.ts` — 37 checks covering:

- A valid bank change request is submitted as pending with the right new bank details
- The request is stored and findable as pending by company
- Empty account holder name, empty bank name, invalid account number, missing routing/SWIFT, invalid currency, and non-payout provider are all rejected
- A non-existent current bank account is rejected
- Approval creates the new bank account, stores it in the bank account store, makes it the active one, and marks the request approved with the verifier, time, and note
- Rejection marks the request rejected, creates no new bank account, and the previous bank stays active
- Verifying a non-existent request is rejected
- Verifying a non-pending request is rejected
- A second pending request is rejected
- A new request can be submitted after the previous one is resolved
- Multiple requests are stored for the same company, and only the new one is pending

## What is NOT included

- The cooling period enforcement (STEP 141 owns that)
- The API route or UI for submitting or reviewing bank change requests
- The payout bank account add flow itself (STEP 139 owns that — this file calls it)
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/bank-change-verification.ts` (new) — the bank change verification service
- `lib/payments/bank-change-verification-verify.ts` (new) — the gate (37 checks)
- `package.json` — added `check:payments-bank-change-verification` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the bank-change-verification files
- Gate — 37 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build is STEP 141: "Bank change 96 hour cooling period enforcement." After manual verification passes (approval), the cooling period starts and all payouts are paused for 96 hours. STEP 141 will build the enforcement of that pause.
