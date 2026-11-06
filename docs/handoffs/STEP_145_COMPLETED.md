# STEP 145 — Reconciliation import of processor reports

**Status: COMPLETED**

## What was built

`lib/payments/reconciliation-import.ts` — the reconciliation import service. Section 11 says "reconciliation matches system records with processor reports. A mismatch must be resolved by the responsible team within 3 days."

The service provides:
- `importProcessorReport(report, options)` — imports a processor report and matches every entry against system records. For each processor report entry, it looks up the system record by provider transaction id and compares:
  - **matched**: both sides have the transaction with the same amount
  - **processor_only**: the processor reports a transaction the system does not have
  - **amount_mismatch**: both sides have the transaction but the amounts differ
  - Then finds **system_only** records: system records not in the processor report

The import result carries the report id, total entry count, and counts for each match status, plus the full match array with per-entry metadata (provider transaction id, type, processor amount, system amount, status).

The `SystemRecordLookup` interface is the seam: the caller implements `findByProviderTransactionId()` and `listByPeriod()`. The core reads system records through it.

## What the gate proves

`lib/payments/reconciliation-import-verify.ts` — 36 checks covering:

- All matching entries are counted as matched
- A processor-only entry is counted with null system amount
- A system-only record is counted with zero processor amount
- An amount mismatch is counted with both amounts
- Mixed outcomes produce correct counts for all four statuses
- The match records carry the right metadata (transaction id, processor amount, system amount)
- An empty processor report finds all system records as system-only
- An empty report with an empty system has zero entries
- The report id is carried in the result
- Different entry types (chargeback, payout, fee) are all handled
- The matches array is in the right order (processor entries first, then system-only)

## What is NOT included

- The mismatch resolution queue with 3-day tracking (STEP 146 owns that)
- The processor adapter that fetches the report (STEPs 147-169 own those)
- The audit logging of mismatches and resolutions (a later STEP owns that)
- The API route or UI for importing reports or viewing reconciliation results

## Files changed

- `lib/payments/reconciliation-import.ts` (new) — the reconciliation import service
- `lib/payments/reconciliation-import-verify.ts` (new) — the gate (36 checks)
- `package.json` — added `check:payments-reconciliation-import` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the reconciliation-import files
- Gate — 36 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

The next STEP in the payment core build is STEP 146: "Reconciliation mismatch queue with 3 day resolution tracking." This STEP will build the queue that holds mismatches from STEP 145's import and tracks their resolution within the 3-day window.
