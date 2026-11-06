# STEP 144 — Settlement release background job after hold period

**Status: COMPLETED**

## What was built

`lib/payments/settlement-release.ts` — the settlement release background job. Section 10 says "settlement is released automatically after the hold period" and section 27 lists "settlement release after hold days" as a background job.

The service provides:
- `runSettlementReleaseJob(options)` — the job function. Finds all due settlement holds (holds in the "held" state whose release time has come), releases them through STEP 136's `releaseSettlementHolds()`, and creates a release record for each released hold. The job is idempotent: a second run finds no releaseable holds because they are already "released".

The release record (`SettlementReleaseRecord`) tracks: id, company, hold id, amount, and release time. The store (`SettlementReleaseStore`) provides `findById`, `findByCompany`, and `findByHoldId` lookups.

The job calls STEP 136's `releaseSettlementHolds()` which posts the release ledger entries (debit hold account, credit merchant_payable) and marks the hold as "released". STEP 144 adds the release records on top.

## What the gate proves

`lib/payments/settlement-release-verify.ts` — 31 checks covering:

- The job completes and releases due holds
- The released hold is marked as "released" in the hold store
- A release record is created with the right company, hold id, amount, and time
- The release record is stored and findable by hold id and by company
- A hold that is not yet due stays "held" and no release record is created
- A hold that becomes due (after the hold period) is released
- Multiple holds from the same company are released in one run
- Running the job twice does not release the same holds again (idempotency)
- Only one release record exists after two runs
- Two release records have different ids
- The release record carries the full hold amount
- Holds from different companies are released independently

## What is NOT included

- The settlement hold calculation and release logic itself (STEP 136 owns that — this file calls it)
- The payout execution (STEP 143 owns that)
- The API route or the cron schedule that triggers the job
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/settlement-release.ts` (new) — the settlement release background job
- `lib/payments/settlement-release-verify.ts` (new) — the gate (31 checks)
- `package.json` — added `check:payments-settlement-release` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the settlement-release files
- Gate — 31 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build is STEP 145: "Reconciliation import of processor reports." This STEP will build the reconciliation system that imports processor reports and matches them against system records.
