# STEP 150 — NMI API transaction types (sale, authorization, capture, refund, void) implemented exactly per official NMI API documentation

**Status: COMPLETED**

## What was built

`lib/payments/adapters/nmi-api.ts` — the NMI adapter's API transaction types service. Implements the five NMI API transaction types — sale, authorization, capture, refund, and void — with request building, validation, and response parsing per the official NMI API documentation.

The service provides:
- `validateNmiRequest(input)` — validates a NMI transaction request: API key and secret key are always required; sale and authorization require a positive amount and a token; capture, refund, and void require an original transaction id.
- `buildNmiRequest(input)` — builds the NMI API request payload (form-encoded fields): `api_key`, `secret_key`, `type`, `amount`, `token`, `customer_id`, `reference`, `original_transaction_id`, and `capture` (for authorization). Sale and authorization include amount and token. Capture and refund include amount when provided. Void does not include amount.
- `parseNmiResponse(raw)` — parses a raw NMI API response into a structured `NmiApiResponse`: success (response_code "0"), response code, message, transaction id, amount, auth code, AVS result, and CVV result.
- `executeNmiTransaction(input, rawResponse)` — combines validation, request building, and response parsing into a single `NmiTransactionResult` (success/failed/rejected).

## What the gate proves

`lib/payments/adapters/nmi-api-verify.ts` — 45 checks covering:

- Validating a sale request with all required fields
- Rejecting a sale request with empty, negative, or zero amount
- Rejecting a sale request with empty token
- Rejecting a request with empty API key or secret key
- Validating an authorization request
- Validating a capture request with original transaction id
- Rejecting a capture request without original transaction id
- Validating a refund request and a void request
- Building a sale request with all required fields
- Building a sale request with optional fields (customer_id, reference)
- Building an authorization request with capture flag (true and false)
- Building a capture request with original transaction id (no token)
- Building a refund request with partial amount
- Building a void request with original transaction id (no amount)
- Parsing a successful response (code "0")
- Parsing a failed response (code "6")
- Executing a sale transaction (success, failed, and rejected paths)
- Executing a capture, refund, and void transaction

## What is NOT included

- The HTTP transport that sends the request to NMI's API (STEP 151 owns that)
- The Collect.js token integration (STEP 149 owns that — this file receives the token)
- The key configuration and encryption (STEP 148 owns that)
- The API route or UI for transaction execution

## Files changed

- `lib/payments/adapters/nmi-api.ts` (new) — the NMI API transaction types service
- `lib/payments/adapters/nmi-api-verify.ts` (new) — the gate (45 checks)
- `package.json` — added `check:payments-adapters-nmi-api` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the NMI API files
- Gate — 45 checks passing
- `npm run verify` — exit 0 (all gates green, including lint)

## Next steps

The next STEP in the NMI adapter build is STEP 151: "NMI shared server payment module exchanging Collect.js tokens through the NMI API per official documentation." This STEP will build the server-side payment module that sends the NMI API requests built by this STEP and exchanges Collect.js tokens for payments.
