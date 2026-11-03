// path: docs/planning/STEP_091_SUBSTEP_BREAKDOWN.md
# STEP 091 - Starting transaction limit enforcement for new merchants: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 091.1 - The database part: `0107_merchant_transaction_limits.sql` (+ rollback)

- FEATURE_LIST line 62 makes the starting monthly transaction limit a compliance-set criterion; STEP
  090 stored it on the `0106` criteria row. This file gives it a per-merchant home:
  `merchant_transaction_limits` - one row per company with `monthly_limit numeric(18,4)`,
  `month_key` (`YYYY-MM` UTC, checked), `used_amount numeric(18,4)` and the check
  `used_amount <= monthly_limit`, so the database itself refuses over-limit usage even if a caller
  skips the service. Partial unique index on `company_id` = one live row per merchant.
- Guard refuses deletes and soft deletes and freezes `company_id`. RLS: default deny; owner reads
  their own row (`company_id = current_actor_company_id()`); the four office roles read all rows;
  only compliance_kyc + super_admin write. No seed - rows are born from the `0106` criteria row.
- Rollback drops the table and the guard function. `npm run -s check:migrations`: 106 -> 107
  migrations, 80 -> 81 tables.

## 091.2 - The service (`services/kyc/merchant-limit.ts`)

- Money math: `package.json` is integrator-owned, so no decimal package - money is integer minor
  units (scale 10^4) in BigInt, exact, formatted back to numeric(18,4) strings. The gate probes that
  the service contains no float math.
- `monthKeyOf(epochMs)` - UTC `YYYY-MM`.
- `ensureLimitRow` (internal): read own row; if absent, read the criteria's starting limit via the
  new `readStartingMonthlyLimit` export of `underwriting.ts`, insert one row (unique race -> CONFLICT
  -> re-read the winner's row), audit `merchant_limit.assigned` with `source: "underwriting_criteria"`.
- `readMerchantLimit` - owner + company from session; ensure + snapshot with `remainingAmount`.
- `checkTransactionAgainstLimit` / `recordTransactionUsage` - the per-transaction enforcement the
  payment core will call: amount validated (money string, > 0, ceiling), month rolled over first when
  the key moved on (conditional update pinned by id + company + version + old month key, usage reset
  in the same write, audited), then `used + amount > limit` -> CONFLICT `monthly_limit_exceeded`
  before any write; the record is one conditional update with version+1, re-read race check (CONFLICT
  `stale`), audit `merchant_limit.usage_recorded` with the amount and new usage.
- `updateMerchantLimit` - office manage roles (`UNDERWRITING_MANAGE_ROLES`), body `{company_id uuid,
  monthly_limit money}`; row read by company (office acts across companies); 404 when the merchant has
  no row yet; conditional update by id + company + version with `updated_by`, race check, audit
  `merchant_limit.updated`.

## 091.3 - Routes and CSRF

- `GET /api/onboarding/merchant-limit` (owner reads own limit; the one write is the lazy, idempotent,
  audited row creation), `POST /api/onboarding/merchant-limit-set` (office raise/lower; CSRF first,
  8 KiB ceiling, session, JSON, service, no-store). The POST path is added to `lib/security/csrf.ts`.
  Both routes are single-method files so the auth gate's token-first probe holds per file.

## 091.4 - UI

- `onboarding/status/page.tsx` reads `readMerchantLimit` server-side beside `readKycSummary` and adds a
  "Your monthly transaction limit" section; two new keys in the `onboardingStatus` block
  (`limitHeading`, templated `limitLine`; 1471 -> 1473 messages, 165 -> 169 placeholders), so the
  existing status catalog check covers them.

## 091.5 - Verification

- `services/kyc/verify.ts`: 2855 -> 3021 checks. The fake store grew `limitRows`, a select branch
  (company-scoped like the KYC tables), an insert branch with the unique-race flag, and an update
  branch conditional on id + company + version + month key with a race flag. New `checkMerchantLimit`
  covers: month key, owner-only refusals with zero queries for all three owner functions, companyless
  owner, first-read creation from the criteria (limit/month/used/remaining, one insert, one assigned
  audit with the source), idempotent second read, lost-insert-race convergence, check allowed/exceeded
  with zero writes, four malformed amounts, usage record (exact 4-decimal math, conditional query,
  version bump, audit payload), over-limit record refused, exact-at-limit allowed, one-cent-over
  refused, month rollover (reset, conditional on old key+version, audited, full limit available),
  stale race, office refusals, office set (stored value, version, updater, audit entity), five bad
  bodies, unknown company 404, stale office race, and cross-company scoping of every query. Plus
  `checkMerchantLimitSources` (routes/service/migration/status-page probes, ASCII, path comments,
  folder checks).
- `node lib/auth/verify.ts`: 2511 -> 2515, baselines unchanged (15/28/32 - no new browser POST file;
  the status page's keeper was already counted).
- `npm run -s check:i18n` 1473/169; `npm run -s check:migrations` 107/81; `npm run -s typecheck`,
  `npm run -s lint` clean; `npm run -s verify` exit 0 (9 gates + build listing both routes).
- Dev smoke on port 3107: `/onboarding/status` 200 signed-out; `GET /api/onboarding/merchant-limit`
  without a session -> 401; `POST /api/onboarding/merchant-limit-set` without a token -> 422
  `csrf_token_invalid`.
