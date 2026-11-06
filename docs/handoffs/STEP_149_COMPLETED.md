# STEP 149 — NMI Collect.js token integration on payment pages

> Review correction: Protocol and test details in this historical handoff were superseded by `docs/handoffs/STEP_117_151_REVIEW.md`. Do not rely on the old endpoint, field names or response mappings.

**Status: COMPLETED**

## What was built

`lib/payments/adapters/nmi-collectjs.ts` — the NMI adapter's Collect.js token integration service. Section 17 says "card data is collected only through Collect.js hosted fields (https://secure.nmi.com/token/Collect.js), which returns a payment token to the browser." Section 18 says "platform code and servers never read, store or track card data or keystrokes."

The service provides:
- `generateCollectJsConfig(companyId, options)` — generates the Collect.js configuration for a payment page: company, API key, environment, and the Collect.js script/token URLs. The browser uses this to initialize Collect.js hosted fields.
- `validateCollectJsToken(token, type)` — validates a Collect.js payment token: checks it is non-empty, at least 10 characters, and contains only alphanumeric characters and underscores (NMI tokens use underscores as separators). Returns the validated token with its type (card, bank, crypto).
- `COLLECT_JS_SCRIPT_URL` / `COLLECT_JS_TOKEN_URL` — the Collect.js constants: both point to `https://secure.nmi.com/token/Collect.js`.

The core service never handles card data. It generates the configuration the browser needs and validates the token Collect.js returns. Card data flows directly from the browser to NMI through the hosted fields.

## What the gate proves

`lib/payments/adapters/nmi-collectjs-verify.ts` — 32 checks covering:

- Generating a Collect.js config with valid input succeeds and carries the right company, API key, and environment
- The config carries the correct Collect.js script and token URLs
- The URLs are the same for sandbox and production
- Empty company id and empty API key are rejected
- Validating a valid card token returns valid with the right token string and type
- Validating a bank token and a crypto token returns valid with the right types
- An empty token is rejected
- A too-short token (9 chars) is rejected
- A 10-character token is accepted (boundary)
- A token with spaces or dashes is rejected (invalid characters)
- Multiple configs for different companies work correctly
- The config is deterministic for the same input
- The Collect.js constants are correct

## What is NOT included

- The Collect.js script or hosted field UI (browser-side concern)
- The NMI API client that uses the token for payment (STEP 150 owns that)
- The payment page component
- The API route that receives the token from the browser

## Files changed

- `lib/payments/adapters/nmi-collectjs.ts` (new) — the NMI Collect.js token integration service
- `lib/payments/adapters/nmi-collectjs-verify.ts` (new) — the gate (32 checks)
- `package.json` — added `check:payments-adapters-nmi-collectjs` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the NMI Collect.js files
- Gate — 32 checks passing
- `npm run verify` — exit 0 (all gates green, including lint)

## Next steps

The next STEP in the NMI adapter build is STEP 150: "NMI API transaction types (sale, authorization, capture, refund, void) implemented exactly per official NMI API documentation." This STEP will build the NMI API client that uses the Collect.js token for actual payment transactions.
