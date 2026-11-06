# STEP 139 — Payout bank account add flow with automatic provider bank linking

**Status: COMPLETED**

## What was built

`lib/payments/payout-bank-account.ts` — the payout bank account add flow service. When a merchant adds a payout bank account in their profile payout settings, the platform validates the bank details, calls the provider's bank linking function automatically (Payoneer or Airwallex), and stores the provider's response.

The service validates:
- Account holder name (non-empty, trimmed)
- Bank name (non-empty, trimmed)
- Account number (6-34 digits)
- Routing number (9 digits) OR SWIFT code (valid format) — at least one required
- Currency (3-letter ISO 4217 code, normalized to uppercase)
- Provider name (must be "payoneer" or "airwallex")

The provider call is the automatic linking: the merchant does not go to Payoneer or Airwallex to add the bank account themselves. The platform calls the provider's bank linking function, receives a provider bank account ID, and stores it with the record. The provider implementation is an adapter concern (STEPs 147-169); the core defines the `ProviderBankLinkingFn` port.

The record tracks: id, company, account holder name, bank name, account number, routing number, SWIFT code, currency, provider name, provider bank account ID, status (linked/failed), failure reason, and timestamps.

## What the gate proves

`lib/payments/payout-bank-account-verify.ts` — 40 checks covering:

- A valid bank account is added and linked successfully
- The record carries the right status, provider name, currency, and timestamps
- The provider bank account ID is stored when linked
- The record is stored in the store and findable by company
- Empty account holder name, empty bank name, invalid account number, missing routing/SWIFT, invalid routing number, invalid SWIFT code, invalid currency, and non-payout provider are all rejected
- A failed provider link sets the status to "failed", stores the failure reason, and keeps the record
- Multiple bank accounts can be added for the same company
- `findActiveByCompany` returns the most recent linked account, skips failed accounts, and returns null when none is linked
- Two records have different ids
- The routing number and SWIFT code are stored correctly
- Airwallex is a valid payout provider
- The provider receives trimmed account holder name, trimmed bank name, normalized currency, and the company id

## What is NOT included

- The API route or UI for the payout settings page
- The payout job that actually sends money to the bank account
- The bank change verification flow (STEP 140) that gates switching the active bank
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/payout-bank-account.ts` (new) — the add flow service
- `lib/payments/payout-bank-account-verify.ts` (new) — the gate (40 checks)
- `package.json` — added `check:payments-payout-bank-account` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the payout-bank-account files
- Gate — 40 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build should wire this service into the merchant profile payout settings API route and UI. The `addPayoutBankAccount` function takes the provider name as a parameter, so the caller passes the provider the routing engine (STEP 129) chose for payouts. STEP 140 will build the bank change manual verification flow that gates switching the active bank account.
