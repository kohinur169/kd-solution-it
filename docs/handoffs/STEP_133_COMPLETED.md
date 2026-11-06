# STEP 133 — Ledger correction through reversing entries only

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_132_COMPLETED.md`.

## What this STEP is, in one paragraph

The ledger reversal service: the one place a correction is written, and the mirror rule that makes it a
correction rather than an edit. Section 11 of the feature list says "ledger entries are never edited or
deleted. Corrections are written as reversing entries." This service is where that sentence becomes a
check. A posted group carries a set of debit and credit entries; this service reads them, mirrors each
one with the opposite side and the same amount, and writes the mirror as a new balanced group. The
original entries are never touched — the append-only guard of the database refuses every update and every
removal, and the service never tries. The correction is the mirror. Each reversal entry names the entry
it undoes with `reversalOfId`, and an entry is reversed at most once.

## What it is not

- **It is not the posting service.** It writes reversal entries, not new movements. STEP 132 owns the
  posting. The reversal service builds entries directly rather than calling `postLedgerEntries`, because
  the reversal entries need `reversalOfId` set — something the posting service always leaves `null`.
- **It is not the append-only guard.** The database already refuses every update and every removal of a
  ledger entry. This service simply never tries to update or remove — it writes new entries and leaves the
  old ones alone.
- **It is not the balance check.** The reversal group always balances because it is a mirror of a balanced
  group. The service still checks, so a future change to the mirror cannot silently break it.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `reverseLedgerGroup`.
- **It does not need a migration.** The `public.ledger_entries` table, its `reversal_of_id` column, its
  unique reversal index, its reversal guard, and its append-only guard all exist from STEP 025 (migration
  0041). Sub-step 3 was "if any", and it was not.
- **It does not touch a provider.** It writes ledger entries; it does not call any provider's API.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §11, MASTER_PROMPT money rules, STEP 132 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/ledger-reversal.ts` — STEP 133 owns it; `lib/payments/ledger-posting.ts` extended with `findByReversalOf` | — |
| 3 | Database part | **none needed** — migration 0041 already created the reversal column, index and guards | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/ledger-reversal.ts`: reversal service with mirror rule | payments-ledger-reversal gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service validates the group exists, is not already reversed, belongs to one company and one source; the store is the caller's (RLS/audit are the store's concern); it does not touch money directly or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The reversal flow, step by step

1. **Read the original entries.** The store is asked for the entries of the group to reverse. A group
   that does not exist has nothing to reverse.
2. **Check that no entry has already been reversed.** An entry is reversed at most once. The unique index
   on `reversal_of_id` makes that a database fact; this service checks it before it writes.
3. **Check that all originals belong to one company and one source.** A reversal mirrors a group, not a
   collection of unrelated entries.
4. **Build the reversal entries.** Each mirrors its original: opposite side, same amount, same account,
   same currency, same company, same source. The reversal group is a new group id.
5. **Check the reversal group balances.** It always does — a mirror of a balanced group is balanced — but
   the check is here so a future change to the mirror cannot silently break it.
6. **Write the reversal entries.** The originals are untouched. Each reversal entry carries
   `reversalOfId` pointing to the original entry it undoes.

## The mirror rules, as enforced

The reversal guard of the database (`ledger_entries_guard_reversal`) checks five things at insert. This
service enforces the same rules before it writes:

1. **A reversal names an entry that exists.** The store returns the original entries; a group that does
   not exist is refused.
2. **A reversal is the opposite side of the entry it undoes.** A debit becomes a credit; a credit becomes
   a debit.
3. **A reversal is the same amount as the entry it undoes.** The mirror carries the original's amount.
4. **A reversal stays in the currency and the merchant of the entry it undoes.** The mirror carries the
   original's currency and company.
5. **A reversal is its own balanced group.** The mirror has a new `entryGroupId`, different from the
   original's.

Plus the one-reversal rule: an entry is reversed at most once. The unique index on `reversal_of_id`
allows an entry to be reversed once; the service checks that no entry in the group has already been
reversed before it writes.

## Verification

| Gate | Result |
|---|---|
| payments-ledger-reversal (`lib/payments/ledger-reversal-verify.ts`) | **26 checks PASSING** — a posted group can be reversed, the reversal is a mirror (opposite side, same amount, same account), the reversal is its own balanced group, a non-existent group cannot be reversed, an already-reversed group cannot be reversed again, the original entries are untouched, the reversal stays in the same currency/company/source |
| payments-ledger-posting (STEP 132) | 34 checks PASSING (unchanged) |
| payments-ledger-accounts (STEP 131) | 33 checks PASSING (unchanged) |
| payments-creation (STEP 130) | 24 checks PASSING (unchanged) |
| payments-routing (STEP 129) | 24 checks PASSING (unchanged) |
| payments-registry (STEP 128) | 42 checks PASSING (unchanged) |
| payments-money (STEP 127) | 66 checks PASSING (unchanged) |
| `npm run typecheck` | 0 errors |
| `npm run lint` (eslint) | 0 errors |
| `npm run build` | 0 errors, 156 routes |
| `npm run verify` | exit 0 |
| auth gate | 2811 checks PASSING (unchanged) |
| migrations gate | 3495 checks, 120 migrations (unchanged) |

## The correction proof, as recorded

The STEP title names the behaviour, and the gate proves it eight ways:

1. **A posted group can be reversed.** A balanced payment group is posted, and `reverseLedgerGroup`
   returns `reversed` with two entries.
2. **The reversal is a mirror.** Each reversal entry is the opposite side of the original, the same
   amount, and posts to the same account. Each reversal entry names the original it undoes with
   `reversalOfId`.
3. **The reversal is its own balanced group.** The reversal entries carry a different `entryGroupId`
   from the original. The reversal group balances (debits = credits).
4. **A group that does not exist cannot be reversed.** Reversing a non-existent group id returns
   `rejected`.
5. **A group that is already reversed cannot be reversed again.** The second reversal returns `rejected`.
6. **The original entries are untouched.** After the reversal, the original entries still have
   `reversalOfId === null`, their original sides, and their original amounts.
7. **The reversal stays in the same currency, company and source.** Every reversal entry carries the
   same currency, company and source type as the original.
8. **The reversal entries carry the same source.** Every reversal entry carries the same source id and
   payment id as the original.

## The double-entry proof, as recorded

The master prompt says "every STEP that touches money must prove balanced double-entry ledger postings for
its flows and record the proof in the handoff file." The proof here is the mirror:

- **Original group:** one debit of 10000 to the merchant's clearing account, one credit of 10000 to the
  merchant's payable. Debits = 10000, credits = 10000. Balanced.
- **Reversal group:** one credit of 10000 to the merchant's clearing account (the opposite of the
  original debit), one debit of 10000 to the merchant's payable (the opposite of the original credit).
  Debits = 10000, credits = 10000. Balanced.

The two groups together net to zero: the debit and credit of the original are undone by the credit and
debit of the reversal. The original entries are never edited or deleted; the correction is a new balanced
group that mirrors them.

## Package request

None. The ledger reversal service is a plain TypeScript module with no dependencies beyond `node:crypto`
for `randomUUID()` and the `LedgerEntry`, `LedgerEntryStore` and `postLedgerEntries` types from
`lib/payments/ledger-posting.ts` (STEP 132).

## What is next

STEP 134 — "Ledger balance integrity check job with office alerts" — owns the job that continuously
checks that the ledger is balanced and alerts the office on any mismatch. STEP 133 writes reversals;
STEP 134 verifies that every group in the ledger — originals and reversals — balances.
