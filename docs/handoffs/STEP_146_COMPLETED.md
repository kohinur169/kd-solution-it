# STEP 146 — Reconciliation mismatch queue with 3 day resolution tracking

**Status: COMPLETED**

## What was built

`lib/payments/reconciliation-mismatch.ts` — the reconciliation mismatch queue. Section 11 says "a mismatch must be resolved by the responsible team within 3 days. Every mismatch and resolution step is audit logged."

The service provides:
- `addMismatch(input, options)` — adds a mismatch (processor_only, system_only, or amount_mismatch) to the queue. Validates the input, checks for duplicate open mismatches for the same company and transaction id, and creates an open mismatch with a 3-day resolution deadline (`MISMATCH_RESOLUTION_DEADLINE_MS = 3 * 24 * 60 * 60 * 1000`).
- `resolveMismatch(mismatchId, options)` — resolves an open mismatch, marking it resolved with the resolver, time, and note.
- `checkOverdue(mismatchId, nowEpochMs, options)` — checks whether a mismatch is past its 3-day deadline and marks it overdue.

The queue stores `ReconciliationMismatch` records with: id, company, provider, transaction id, type, processor amount, system amount, status (open/resolved/overdue), creation time, resolution deadline, resolution time, resolution note, and resolver.

The store (`MismatchStore`) provides `findById`, `findByCompany`, `findOpenByCompany`, `findOverdue`, and `findOpen` lookups.

## What the gate proves

`lib/payments/reconciliation-mismatch-verify.ts` — 39 checks covering:

- Adding a mismatch creates an open mismatch with the right company, provider, transaction id, and type
- The resolution deadline is 3 days from creation
- The mismatch has no resolver, time, or note while open
- Duplicate mismatches for the same transaction id are rejected
- Matched entries are rejected as mismatches
- Empty company, provider, and transaction id are rejected
- Resolving an open mismatch marks it resolved with the right resolver, time, and note
- Resolving a non-existent mismatch is rejected
- Resolving a non-open mismatch is rejected
- Checking an overdue mismatch marks it overdue
- Checking a non-overdue mismatch returns ok
- Checking a non-existent mismatch is rejected
- `findOpenByCompany` returns only open mismatches
- `findOverdue` returns only overdue mismatches (open past deadline + already-marked overdue)
- Multiple mismatches can be added for the same company
- Two mismatches have different ids
- The mismatch carries the right processor and system amounts
- Processor-only mismatches have null system amount
- System-only mismatches have zero processor amount

## What is NOT included

- The reconciliation import that produces the mismatches (STEP 145 owns that — this file receives them)
- The audit log itself (a later STEP owns that — this file records the resolution fields the audit log would read)
- The API route or UI for viewing the queue
- The provider adapter implementations (STEPs 147-169 own those)

## Files changed

- `lib/payments/reconciliation-mismatch.ts` (new) — the mismatch queue service
- `lib/payments/reconciliation-mismatch-verify.ts` (new) — the gate (39 checks)
- `package.json` — added `check:payments-reconciliation-mismatch` script and verify-chain entry

## Verification

- `npx tsc --noEmit --strict` — 0 errors in the reconciliation-mismatch files
- Gate — 39 checks passing
- `npm run verify` — exit 0 (all gates green)

## Next steps

STEP 146 completes the payment core build (STEPs 127-146). The next section is "Payment Provider Adapters" (STEPs 147-169), which build the adapter files under `lib/payments/adapters/` for each provider (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex).
