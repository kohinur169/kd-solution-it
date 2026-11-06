# STEP 148 — NMI encrypted key configuration and connection test

**Status: COMPLETED**

## What was built

`lib/payments/adapters/nmi-client.ts` — the NMI adapter's encrypted key configuration and connection test service. Section 29 says "provider keys... entered in admin screens are AES-256-GCM encrypted at rest and shown only masked."

The service provides:
- `configureNmiKeys(input, options)` — validates, encrypts the API key and secret key with AES-256-GCM, stores the encrypted configuration, and returns the masked view (first and last 4 characters with the middle masked).
- `testNmiConnection(companyId, options)` — finds the active configuration, decrypts the keys in memory, calls the connection test function with the decrypted keys and environment, and returns the result.
- `encryptKey(plaintext, encryptionKey)` / `decryptKey(encrypted, encryptionKey)` — the AES-256-GCM encryption/decryption utilities. The output is base64 of IV + tag + ciphertext.
- `maskKey(key)` — masks a key for display: shows the first and last 4 characters with the middle masked. Short keys (≤ 8 chars) are fully masked.

The key configuration (`NmiKeyConfig`) stores: id, company, encrypted API key, encrypted secret key, environment (sandbox/production), creation time, and update time. The store (`NmiKeyStore`) provides `findById`, `findByCompany`, and `findActiveByCompany` lookups.

## What the gate proves

`lib/payments/adapters/nmi-client-verify.ts` — 38 checks covering:

- Configuring NMI keys succeeds and stores the config with the right company, environment, and timestamps
- The stored keys are encrypted, not plaintext
- Decrypting the stored keys returns the original plaintext
- The masked keys show only first and last characters
- The config is stored and findable by id, company, and active lookup
- Testing the connection with valid keys returns "connected" with the right message
- Testing the connection with invalid keys returns "failed" with the right message
- Testing the connection with no config is rejected
- Empty API key, empty secret key, and empty company id are rejected
- Multiple configs for different companies work correctly
- Re-configuring replaces the old config and updates the active config
- Two configs have different ids
- `maskKey` handles short keys (fully masked), empty keys, and long keys (first/last 4 visible)
- The connection test receives the decrypted API key, secret key, and environment

## What is NOT included

- The NMI API client for making charges (STEP 149 owns that)
- The gateway registry provider declaration (STEP 147 owns the adapter file)
- The API route or UI for entering keys
- The encryption key management (the encryption key is passed as a parameter; a later STEP or the deployment config owns where it comes from)

## Files changed

- `lib/payments/adapters/nmi-client.ts` (new) — the NMI client key configuration and connection test service
- `lib/payments/adapters/nmi-client-verify.ts` (new) — the gate (38 checks)
- `package.json` — added `check:payments-adapters-nmi-client` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the NMI client files
- Gate — 38 checks passing
- `npm run verify` — exit 0 (all gates green, including lint)

## Next steps

The next STEP in the NMI adapter build is STEP 149: "NMI Collect.js token integration on payment pages." This STEP will build the integration with NMI's Collect.js hosted fields for token generation on payment pages.
