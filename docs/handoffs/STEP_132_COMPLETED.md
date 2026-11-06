# STEP 132 — Ledger posting service requiring balanced debit and credit pairs

Branch `arena/17762737-kd-solution-it`.
Previous handoff: `docs/handoffs/STEP_131_COMPLETED.md`.

## What this STEP is, in one paragraph

The ledger posting service: the one place a debit and a credit are written, and the balance rule that
makes the pair a pair. Section 11 of the feature list says "every money movement writes a debit entry and
a credit entry and the pair always balances to zero." This service is where that sentence becomes a check:
a posting group carries a set of entries — some debits, some credits — and the service sums them before it
writes anything. A group whose debits and credits are not equal is refused, and nothing is written. The
caller learns the reason and corrects the group. The ten movements of section 11 are the closed vocabulary
of source types, and the service checks the source pair the database enforces: a payment source carries a
payment id, a refund source carries a refund id, a chargeback source carries a dispute id.

## What it is not

- **It is not the reversal.** It writes new entries; it does not reverse old ones. STEP 133 owns the
  reversal. The `reversalOfId` on every entry this service creates is `null`.
- **It is not the account setup.** The accounts this service posts to are opened by STEP 131. This service
  writes entries against account ids; it does not open accounts.
- **It is not the API route or the UI.** It is a library module. The API route and the UI are later STEPs
  that call `postLedgerEntries`.
- **It does not need a migration.** The `public.ledger_entries` table, its ten source types, its balanced
  group constraint, its append-only guard, its reversal mirror, and its source-pair checks all exist from
  STEP 025 (migration 0041). Sub-step 3 was "if any", and it was not.
- **It does not touch a provider.** It writes ledger entries; it does not call any provider's API. The
  adapter STEPs (147-169) own the provider calls.

## Sub-steps, as executed

| # | Sub-step | Deliverable | Gate |
|---|---|---|---|
| 1 | Read FEATURE_LIST §11, MASTER_PROMPT money rules, STEP 131 handoff | — | — |
| 2 | Confirm owned paths | `lib/payments/ledger-posting.ts` — STEP 132 owns it | — |
| 3 | Database part | **none needed** — migration 0041 already created the table | migrations 3495 checks, 120 migrations (unchanged) |
| 4 | Core service and logic | `lib/payments/ledger-posting.ts`: posting service with balance rule | payments-ledger-posting gate |
| 5 | API route | **none** — a library, not an endpoint | — |
| 6 | UI | **none** — a library, not a screen | build 0 (156 routes) |
| 7 | Security | the service validates balance, amounts, source pairs and descriptions; the store is the caller's (RLS/audit are the store's concern); it does not touch money directly or call a provider | gate + auth gate |
| 8 | typecheck, lint, build, commit, push, handoff | tsc 0, eslint 0, build 0 | `npm run verify` exit 0 |

## The types, where each one lives

- **`LedgerSourceType`** — the ten closed source types of section 11: payment, platform_fee, hold,
  reserve, settlement, payout, refund, chargeback, chargeback_fee, subscription_charge.
- **`LedgerPosting`** — one side of a money movement: an account, a side, and an amount in minor units.
- **`LedgerPostingGroup`** — a group of postings that must balance, with the source that caused the
  movement. The group carries the company, the group id, the source type and id, the optional payment /
  refund / dispute ids, the optional description, and the postings.
- **`LedgerEntry`** — what the store holds: the posting plus its identity (id, group id, occurred-at,
  posted-at) and its metadata (currency, source type, source id, payment / refund / dispute ids,
  description, reversal-of).
- **`LedgerEntryStore`** — what the service reads and writes. The store is the caller's: the database
  implementation, or the in-memory store below.
- **`LedgerPostingResult`** — what the service answers: `{ status: "posted", entries }` when the group
  balanced and the entries were written, or `{ status: "rejected", reason }` when it was refused.
- **`InMemoryLedgerEntryStore`** — the reference implementation. It keys on entry id and tracks which
  entries belong to which group.

## The posting flow, step by step

1. **Check the balance.** The service sums every debit and every credit. If they are not equal, the group
   is refused. If both sums are zero, the group is refused — a movement of zero is not a movement.
2. **Check the amounts.** Every posting must carry a positive amount. A zero or negative amount is
   refused.
3. **Check the source pair.** A payment source must carry a payment id. A refund source must carry a
   refund id. A chargeback or chargeback_fee source must carry a dispute id. An entry without its source
   is refused.
4. **Check the description.** If provided, the description must be trimmed and between 1 and 280
   characters.
5. **Write the entries.** Each posting becomes a `LedgerEntry` with a `randomUUID()`, the group's
   company, source and metadata, and the currency (USD). The entries are inserted into the store, and the
   service returns `posted` with the entries.

## The balance proof, as recorded

The STEP title names the behaviour, and the gate proves it ten ways:

1. **A balanced group posts.** A group with one debit and one credit of the same amount is accepted, and
   the entries are in the store.
2. **An unbalanced group is refused.** A group with debits ≠ credits is refused, and nothing is written.
3. **A group with credits but no debits is refused.** A credit-only group is refused.
4. **A group with debits but no credits is refused.** A debit-only group is refused.
5. **A group whose debits and credits are both zero is refused.** A zero movement is not a movement.
6. **All ten source types are accepted.** Each of the ten movements of section 11 can be posted with a
   balanced group.
7. **The source-pair checks hold.** A payment source without a payment id is refused. A refund source
   without a refund id is refused. A chargeback source without a dispute id is refused. A chargeback_fee
   source without a dispute id is refused.
8. **Non-positive amounts are refused.** A posting with a zero amount is refused. A posting with a negative
   amount is refused.
9. **The group is scoped to one merchant.** Every entry in a group carries the same company and the same
   group id. No entry is a reversal (every `reversalOfId` is `null`). Every entry carries the source type
   of the group.
10. **The store holds exactly what was posted.** The store's `findByGroup` returns exactly the entries
    that were posted — no more, no less.

## Verification

| Gate | Result |
|---|---|
| payments-ledger-posting (`lib/payments/ledger-posting-verify.ts`) | **34 checks PASSING** — balanced groups post, unbalanced groups are refused, credit-only and debit-only groups are refused, zero groups are refused, all 10 source types are accepted, source-pair checks hold, non-positive amounts are refused, group is scoped to one merchant, store holds exactly what was posted |
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

## The double-entry proof, as recorded

The master prompt says "every STEP that touches money must prove balanced double-entry ledger postings for
its flows and record the proof in the handoff file." The proof is the balance check itself:

- **A payment of 10000 minor units** posts one debit of 10000 to the merchant's clearing account and one
  credit of 10000 to the merchant's payable. Debits = 10000, credits = 10000. Balanced.
- **A platform fee of 500 minor units** posts one debit of 500 to the merchant's payable and one credit of
  500 to the platform's fee income. Debits = 500, credits = 500. Balanced.
- **A payout of 20000 minor units** posts one debit of 20000 to the merchant's payable and one credit of
  20000 to the processor's clearing (or settlement) account. Debits = 20000, credits = 20000. Balanced.

In every case, the service refuses to write the entries unless the sum of debits equals the sum of credits.
The balance is proved before anything is written, not discovered after. The same proof carries into STEP
133: a reversal is a new balanced group that mirrors the original.

## Package request

None. The ledger posting service is a plain TypeScript module with no dependencies beyond `node:crypto` for
`randomUUID()`, `deepFreeze` from `lib/utils/freeze.ts`, `CURRENCY_USD` from `lib/payments/money.ts` (STEP
127), and the `LedgerAccountSide` type from `lib/payments/ledger-accounts.ts` (STEP 131).

## What is next

STEP 133 — "Ledger correction through reversing entries only" — owns the reversal logic that mirrors a
posted group with a new balanced group, setting `reversalOfId` on each entry of the reversal. STEP 132
writes the entries; STEP 133 corrects them by writing new ones, never by editing or deleting the originals.
