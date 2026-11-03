// path: docs/handoffs/STEP_092_COMPLETED.md
# STEP 092 - Unusual large transaction hold and review trigger: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 092 code are in one commit, the
one whose message is "STEP 092: Unusual large transaction hold and review trigger" (`git log -1`
on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_091_COMPLETED.md`.

## STEP

- **Number and title:** STEP 092 - Unusual large transaction hold and review trigger
  (`docs/final/STEP_PLAN_250.md`, the STEP 092 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Fourteenth STEP of the block.
- **Owned paths (File Ownership Rules):** the block's paths - `app/(dashboard)/onboarding/`,
  `services/kyc/`, the `app/api/onboarding/` routes the block owns, its migrations, and the shared
  files the block extends (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`, the gate harnesses,
  `app/(dashboard)/README.md`). `app/(admin)/`, `app/api/office/`, `components/office/`,
  `lib/settings/` untouched.
- **Feature list:** section 5 line 62 - the underwriting criteria include "holding unusually large
  transactions for review" (stored by STEP 090 on the `0106` criteria row as
  `large_transaction_hold_enabled` / `large_transaction_hold_threshold`, set by compliance); line 21 -
  compliance_kyc does "manual payment review" (the release/reject decision); line 277 - a merchant
  sees their own holds.
- **Depends on:** STEP 090 (the two criteria columns and the `readLargeTransactionHold` export added
  to `underwriting.ts`), STEP 091 (the BigInt minor-unit money pattern in `merchant-limit.ts`, reused
  unchanged).

## Migration added, and the rollback proof

- `migrations/0108_payment_holds.sql` + `0108_payment_holds.down.sql`. Forward: `payment_holds` -
  one row per held transaction (`company_id` FK, nullable trimmed `reference` 1..120, `amount`
  numeric(18,4) checked `(0, 100000000000000]`, `status` held/released/rejected with decision checks
  - held rows carry no reviewer, decided rows must, a rejection needs a trimmed 1..280 reason,
  `reviewed_at >= held_at` - `held_at`, `reviewed_by` FK, `reviewed_at`, `decision_reason`, timestamps,
  `deleted_at`, `version`), guard trigger (no deletes/soft deletes, `company_id` frozen), partial
  queue index on `held_at where status='held'`, `(company_id, held_at desc)` index, RLS default-deny
  + owner read own company + office read (ceo/compliance_kyc/finance_ops/super_admin) + manage write
  (compliance_kyc/super_admin). No seed. Rollback drops the table, guard and index.
- `npm run -s check:migrations` passed: 3165 checks, **108 migrations, 82 tables** (was 107/81).
  Static gate as since STEP 012; the file only creates one table.

## Files

- **Created:** `migrations/0108_payment_holds.sql`, `...down.sql`, `services/kyc/payment-hold.ts`,
  `app/api/onboarding/payment-holds/route.ts` (GET queue),
  `app/api/onboarding/payment-hold-decide/route.ts` (POST),
  `app/api/onboarding/merchant-holds/route.ts` (GET own list),
  `app/(dashboard)/onboarding/payment-holds/page.tsx`, `.../payment-holds-panel.tsx`,
  `docs/planning/STEP_092_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_092_COMPLETED.md`.
- **Modified:** `services/kyc/underwriting.ts` (new `readLargeTransactionHold` export),
  `lib/security/csrf.ts` (`/api/onboarding/payment-hold-decide`), `lib/i18n/strings/en.ts` (new
  `onboardingPaymentHolds` block, 31 keys; 1473 -> 1504 messages, 169 -> 175 placeholders),
  `services/kyc/verify.ts` (3021 -> 3309 checks), `lib/auth/verify.ts` (2515 -> 2519 checks,
  baselines 16/29/33), `app/(dashboard)/README.md`.

## Behaviour

- **Trigger** (called by the payment core per transaction): `holdLargeTransaction` - owner-only,
  company from the session, amount validated as a numeric(18,4) money string (BigInt minor units,
  scale 10^4, ceiling 1e14 USD, no float) before any query; reads the `0106` criteria via
  `readLargeTransactionHold`; switch off or amount below the threshold -> `{ held: false }`, nothing
  written; at/above the threshold -> one insert (status `held`, `held_at` now, version 1), re-read of
  the merchant's newest hold, one `payment_hold.created` audit. A `reference` (the payment's id or
  idempotency key) makes the trigger idempotent: a repeated call answers with the existing hold, no
  second row. A down audit sink never fails the write.
- **Review queue:** `GET /api/onboarding/payment-holds` - the four office read roles, deliberately
  cross-company, oldest first (`order=held_at.asc&limit=200`), one `payment_hold.read_by_office` audit
  per read with the waiting count; `no-store`. UI: `/onboarding/payment-holds` renders the queue with
  status, company, amount, reference, held-at, and the decision + reason once made.
- **Decision:** `POST /api/onboarding/payment-hold-decide` - compliance_kyc/super_admin only; CSRF
  token first, 8 KiB body ceiling, hold id validated as UUID before any query, body
  `{ hold_id, decision: release|reject, reason? }` with reject requiring the trimmed 1..280 reason;
  404 unknown id; CONFLICT `already_decided` on a decided hold; one conditional update by id +
  `status=eq.held` + current version + live rows (status, reviewer, instant, reason, version+1),
  re-read race check (CONFLICT `stale`), one `payment_hold.decided` audit, `logger.info`, `no-store`.
- **Merchant view:** `GET /api/onboarding/merchant-holds` - owner-only, own company from the session
  (never the query string), newest first (`limit=100`), `no-store`.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3309 checks (see
  `docs/planning/STEP_092_SUBSTEP_BREAKDOWN.md` 092.6 for the full list of the new hold checks,
  including at-threshold/below-threshold, reference idempotency, the cross-company queue, the
  already-decided and stale races, and zero-query refusals for every wrong role).
- `node lib/auth/verify.ts` - 2519 checks, baselines now 16 keepers / 29 mutation files / 33 call
  sites (the new page + panel); the new POST route is on the CSRF list and checks the token first.
- `npm run -s check:i18n` - 1504/175; `npm run -s check:migrations` - 3165 checks, 108/82;
  `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify` exit 0 (all gates +
  production build listing `/api/onboarding/payment-holds`, `/api/onboarding/payment-hold-decide`,
  `/api/onboarding/merchant-holds`).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200 signed-out;
  `GET /api/onboarding/payment-holds` and `GET /api/onboarding/merchant-holds` without a session ->
  401 `AUTHENTICATION_REQUIRED`; `POST /api/onboarding/payment-hold-decide` without a token -> 422
  `csrf_token_invalid`; `/onboarding/payment-holds` 200 signed-out.

## Acceptance checklist

- The behaviour of the title was exercised through the gate harness: at/above the compliance-set
  threshold a transaction is held (one audited insert, idempotent per reference), below it nothing is
  written, the office queue is cross-company oldest-first, the desk releases or rejects with a
  mandatory trimmed reason on rejection, decided holds conflict `already_decided`, lost races
  conflict `stale`, and every wrong role is refused before a single query.
- Money STEP rule: no ledger postings exist yet (payment core is STEPs 127+), so there is no
  double-entry proof to show here; the hold amounts are proven exact by the gate's four-decimal
  assertions. When payment core lands, `holdLargeTransaction` must be called inside the same
  transaction that creates the payment - exactly as STEP 091's note says for the limit check.
- UI: the queue screen uses the onboarding block's existing responsive classes and SessionKeeper; all
  strings from the `onboardingPaymentHolds` catalog; every templated line rendered through
  `formatMessage`; the panel sends exactly one POST literal with one CSRF spread per call.

## Notes for the next STEP

- STEP 093 (KYC approval/rejection with reasons) reuses the same decision shape as
  `decidePaymentHold` (conditional version-bumped update, re-read race check, trimmed 1..280 reason,
  `already_decided` conflict) - copy that pattern, and reuse the queue screen's four-state read.
- When payment core lands (STEPs 127+), call `holdLargeTransaction` per transaction inside the
  payment's own transaction, beside `checkTransactionAgainstLimit`/`recordTransactionUsage`, passing
  the payment id as `reference` for idempotency.
- FEATURE_LIST wins any conflict: the hold criterion stays office-set on the `0106` row; merchants
  never see the switch or the threshold, only their own holds (line 277).
