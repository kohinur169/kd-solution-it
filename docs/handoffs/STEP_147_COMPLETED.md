# STEP 147 — NMI documentation verification and sandbox notes recording

**Status: COMPLETED**

## What was built

`lib/payments/adapters/nmi.ts` — the NMI adapter's documentation verification and sandbox notes recording service. This is the first of five provider adapters (STEPs 147-169).

The service provides:
- `recordNmiVerification(input, options)` — records a NMI verification: documentation checks (topics reviewed, URLs, verified status, notes), sandbox notes (tests run, results, details), and an overall status calculated from them.

The overall status is calculated:
- **verified**: all documentation checks are verified AND all sandbox tests pass
- **partial**: at least one check is verified or at least one test passes, but not all
- **not_verified**: no checks are verified and no tests pass

The verification record (`NmiVerificationRecord`) tracks: id, provider name, documentation checks, sandbox notes, overall status, verification time, and verifier. The store (`NmiVerificationStore`) provides `findById`, `findByProvider`, and `findLatest` lookups.

Also created `docs/final/PROVIDER_DOCS.md` — the provider documentation notes file. This file is created by STEP 147 and extended only by adapter STEPs (147-169). The NMI section records documentation sources, integration notes, sandbox notes, and the capability matrix.

## What the gate proves

`lib/payments/adapters/nmi-verify.ts` — 27 checks covering:

- All checks and tests passing gives overall status "verified"
- No checks passing gives overall status "not_verified"
- Mixed checks give overall status "partial"
- The record carries the right provider name, verifier, and time
- The record carries all documentation checks and sandbox notes
- Documentation check notes and sandbox note details are stored
- The record is stored and findable by provider
- `findLatest` returns the most recent record
- Empty documentation checks are rejected
- Empty verifier is rejected
- Documentation check without topic or url is rejected
- Sandbox note without test name is rejected
- Multiple records can be created for the same provider
- `findLatest` returns the most recent when multiple exist
- Not-tested sandbox notes with verified checks give "partial"
- Two records have different ids

## What is NOT included

- The NMI API client itself (a later STEP in 147-169 builds that)
- The `lib/gateways/registry.ts` provider declaration (already exists from the gateways system)
- The API route or UI for viewing verification records
- The other four provider adapters (Payoneer, Rainforest, Stripe Connect, Airwallex)

## Files changed

- `lib/payments/adapters/nmi.ts` (new) — the NMI adapter verification service
- `lib/payments/adapters/nmi-verify.ts` (new) — the gate (27 checks)
- `docs/final/PROVIDER_DOCS.md` (new) — provider documentation notes (NMI section)
- `package.json` — added `check:payments-adapters-nmi` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the NMI adapter files
- Gate — 27 checks passing
- `npm run verify` — exit 0 (all gates green, including lint)

## Next steps

The next STEP in the adapter build is STEP 148: "NMI encrypted key configuration and connection test." This STEP will build the NMI API client with encrypted key storage and a connection test function.
