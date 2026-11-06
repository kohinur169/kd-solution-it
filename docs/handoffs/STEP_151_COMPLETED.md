# STEP 151 — NMI shared server payment module exchanging Collect.js tokens through the NMI API per official documentation

> Review correction: Protocol and test details in this historical handoff were superseded by `docs/handoffs/STEP_117_151_REVIEW.md`. Do not rely on the old endpoint, field names or response mappings.

**Status: COMPLETED**

## What was built

`lib/payments/adapters/nmi-payment.ts` — the NMI adapter's shared server payment module. This is the server-side piece that exchanges a Collect.js token for a payment through the NMI API. It glues together the key store (STEP 148), the transaction types (STEP 150), and the HTTP transport.

The module provides:
- `NMI_API_ENDPOINT` — the NMI API v1 transactions endpoint (`https://api.nmi.com/api/v1/transactions`), per the official NMI documentation.
- `NmiPaymentRequest` — the payment request interface: company ID, transaction type (sale/authorization/capture/refund/void), amount, Collect.js token, customer ID, reference, original transaction ID, and capture flag.
- `NmiHttpTransport` — the HTTP transport function type: takes the endpoint URL and the form-encoded payload, returns the raw response as a field map.
- `ProcessNmiPaymentResult` — the result type: success (transaction ID, auth code, amount), failed (response code and message), rejected (reason), or transport_error (message).
- `processNmiPayment(input, options)` — the main function. Resolves the company's NMI API credentials from the key store (STEP 148), decrypts them, builds the NMI transaction request (STEP 150's buildNmiRequest), validates it, sends it to the NMI API endpoint via the HTTP transport, parses the response (STEP 150's parseNmiResponse), and returns the result.

## What the gate proves

`lib/payments/adapters/nmi-payment-verify.ts` — 51 checks covering:

- Processing a sale payment (success path)
- The sale payload contains the correct fields (decrypted api_key, secret_key, type, amount, token)
- Processing an authorization payment with capture flag (true and false)
- Processing a capture payment with original transaction id (no token, no amount by default)
- Processing a capture payment with partial amount
- Processing a refund payment with original transaction id (no token)
- Processing a void payment with original transaction id (no amount, no token)
- Rejecting when no key configuration exists for the company
- Failing when decryption fails (wrong encryption key)
- Rejecting when the sale request has no amount
- Rejecting when the sale request has no token
- Rejecting when the capture request has no original transaction id
- Failing when the NMI API returns a non-zero response code
- Handling transport errors (the transport throws)
- The sale payload with optional fields (customer_id, reference)
- The endpoint URL is the NMI API transactions endpoint
- The transport receives the correct endpoint for all transaction types
- Processing a payment for a different company uses that company's keys

## What is NOT included

- The API route that calls this module (a later STEP owns that)
- The actual HTTP implementation using fetch/axios (the transport is a function the caller provides)
- The Collect.js token generation (STEP 149 owns that — this module receives the token)
- The NMI API transaction types (STEP 150 owns that — this module uses them)
- The key configuration and encryption (STEP 148 owns that — this module reads from the key store)

## Files changed

- `lib/payments/adapters/nmi-payment.ts` (new) — the shared server payment module
- `lib/payments/adapters/nmi-payment-verify.ts` (new) — the gate (51 checks)
- `package.json` — added `check:payments-adapters-nmi-payment` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the NMI payment files
- Gate — 51 checks passing
- `npm run verify` — exit 0 (all gates green, including lint)

## Next steps

The next STEP in the NMI adapter build is STEP 152: "NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation." This STEP will cover sandbox testing of the full payment flow, mapping NMI response codes to platform transaction statuses, and syncing transaction statuses.
