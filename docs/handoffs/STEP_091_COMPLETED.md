// path: docs/handoffs/STEP_091_COMPLETED.md
# STEP 091 - Starting transaction limit enforcement for new merchants: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 091 code are in one commit, the
one whose message is "STEP 091: Starting transaction limit enforcement for new merchants" (`git log -1`
on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_090_COMPLETED.md`.

## STEP

- **Number and title:** STEP 091 - Starting transaction limit enforcement for new merchants
  (`docs/final/STEP_PLAN_250.md`, the STEP 091 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Thirteenth STEP of the block.
- **Owned paths (File Ownership Rules):** the block's paths - `app/(dashboard)/onboarding/`,
  `services/kyc/`, the `app/api/onboarding/` routes the block owns, its migrations, and the shared
  files the block extends (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`, the gate harnesses,
  `app/(dashboard)/README.md`). `app/(admin)/`, `app/api/office/`, `components/office/` untouched.
- **Feature list:** section 5 line 62 - the underwriting criteria include "starting monthly
  transaction limit for new merchants", set by the compliance team (stored by STEP 090 on the `0106`
  criteria row; enforced per merchant by this STEP).
- **Depends on:** STEP 090 (`underwriting_criteria.starting_monthly_limit`, and the new
  `readStartingMonthlyLimit` export), STEP 087 (the merchant status screen that shows the limit).

## Migration added, and the rollback proof

- `migrations/0107_merchant_transaction_limits.sql` + `0107_merchant_transaction_limits.down.sql`.
  Forward: `merchant_transaction_limits` - one row per company (`company_id` unique while live,
  `month_key` `YYYY-MM`, `monthly_limit` numeric(18,4) with the criteria ceiling, `used_amount`
  numeric(18,4), and the check `used_amount <= monthly_limit` so the database itself refuses over-limit
  usage), guard trigger (no deletes, `company_id` frozen), RLS default-deny + owner read (own company)
  + office read (four roles) + manage write (compliance_kyc, super_admin). No seed. Rollback drops
  the table and the guard function.
- `npm run -s check:migrations` passed: 3133 checks, **107 migrations, 81 tables** (was 106/80).
  Static gate as since STEP 012; no existing row is rewritten - the file only creates one table.

## Files

- **Created:** `migrations/0107_merchant_transaction_limits.sql`, `...down.sql`,
  `services/kyc/merchant-limit.ts`, `app/api/onboarding/merchant-limit/route.ts` (GET),
  `app/api/onboarding/merchant-limit-set/route.ts` (POST),
  `docs/planning/STEP_091_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_091_COMPLETED.md`.
- **Modified:** `services/kyc/underwriting.ts` (new `readStartingMonthlyLimit` export),
  `lib/security/csrf.ts` (`/api/onboarding/merchant-limit-set`), `lib/i18n/strings/en.ts`
  (`onboardingStatus` +2 keys; 1471 -> 1473 messages, 165 -> 169 placeholders),
  `app/(dashboard)/onboarding/status/page.tsx` (limit section), `services/kyc/verify.ts`
  (2855 -> 3021 checks), `app/(dashboard)/README.md`.

## Behaviour

- **Lazy assignment:** the first `readMerchantLimit` (or the office's first `updateMerchantLimit`)
  creates the merchant's row from `underwriting_criteria.starting_monthly_limit` - `month_key` =
  current UTC month, `used_amount` = 0 - one insert protected by the partial unique index (a lost race
  re-reads the winner's row), audited `merchant_limit.assigned` with `source: "underwriting_criteria"`.
- **Enforcement point** (called by the payment core per transaction): `checkTransactionAgainstLimit`
  answers whether an amount fits (CONFLICT `monthly_limit_exceeded` before any write); `recordTransactionUsage`
  records a settled amount with one conditional update (id + company + version + month key), version+1,
  re-read race check (CONFLICT `stale`), audit `merchant_limit.usage_recorded`. A month rollover resets
  usage in the same conditional write that moves `month_key`, audited as a rollover. Amounts are
  validated as numeric(18,4) strings; all money math is BigInt minor units (no float, no decimal
  package - `package.json` is integrator-owned).
- **Office override:** `POST /api/onboarding/merchant-limit-set` - compliance_kyc/super_admin only,
  body `{company_id, monthly_limit}`; 404 for a merchant with no row; conditional update with
  `updated_by`, race check, audit `merchant_limit.updated`. `GET /api/onboarding/merchant-limit`
  serves the owner their own limit (limit, used, month, remaining).
- **Merchant UI:** the status screen shows "Your monthly transaction limit" - starting limit, used
  this month, remaining.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3021 checks (see `docs/planning/STEP_091_SUBSTEP_BREAKDOWN.md` 091.5
  for the full list of the new limit checks, including the exact-at-limit and one-cent-over cases and
  the rollover).
- `node lib/auth/verify.ts` - 2515 checks, baselines unchanged at 15 keepers / 28 mutation files /
  32 call sites; the new POST route is on the CSRF list and checks the token first.
- `npm run -s check:i18n` - 1473/169; `npm run -s check:migrations` - 107/81; `npm run -s typecheck`,
  `npm run -s lint` clean; `npm run -s verify` exit 0 (9 gates + production build listing
  `/api/onboarding/merchant-limit` and `/merchant-limit-set`).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/onboarding/status`
  200 signed-out; the limit GET without a session -> 401; the limit-set POST without a token -> 422
  `csrf_token_invalid`.

## Acceptance checklist

- The behaviour of the title was exercised through the gate harness: a new merchant's row is created
  from the compliance-set criteria, usage is recorded exactly, the limit is enforced at and over the
  boundary (allowed at exactly the limit, refused one cent over), the month rolls over, races conflict
  cleanly, and every mutation is audited; unauthorized (non-owner) and cross-company requests are
  refused with zero queries.
- Money STEP rule: no ledger postings exist yet (payment core is STEPs 127+), so there is no
  double-entry proof to show here; the limit math itself is proven exact by the gate's four-decimal
  assertions. When payment core lands, `checkTransactionAgainstLimit`/`recordTransactionUsage` must be
  called inside the same transaction that creates the payment.
- UI: the new section uses the status page's existing responsive classes; all strings from the
  catalog; templated line rendered through `formatMessage`.

## Notes for the next STEP

- STEP 092 (the unusual large transaction hold) reads `large_transaction_hold_enabled` /
  `large_transaction_hold_threshold` from the same `0106` criteria row and will want a per-transaction
  hook beside the limit check - the same service file is the natural home.
- STEP 093's approval flow should call `readMerchantLimit`'s ensure path (or read it) so the row
  exists before the merchant's first transaction; the office can raise it via `merchant-limit-set`
  at decision time.
- The `used_amount <= monthly_limit` column check means an office *lowering* a limit below current
  usage would fail at the database - the service should answer that case cleanly when 093 wires it.
