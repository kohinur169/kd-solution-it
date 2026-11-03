// path: docs/handoffs/STEP_090_COMPLETED.md
# STEP 090 - Underwriting criteria settings managed by compliance team: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 090 code are in one commit, the
one whose message is "STEP 090: Underwriting criteria settings managed by compliance team" (`git log -1`
on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_089_COMPLETED.md`.

## STEP

- **Number and title:** STEP 090 - Underwriting criteria settings managed by compliance team
  (`docs/final/STEP_PLAN_250.md`, the STEP 090 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Twelfth STEP of the block.
- **Owned paths (File Ownership Rules):** same block paths as 088/089 - `app/(dashboard)/onboarding/`,
  `services/kyc/`, the `app/api/onboarding/` routes the block owns, its migrations, and the shared
  files the block extends (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`, `lib/auth/verify.ts`
  baselines, the gate harnesses, `app/(dashboard)/README.md`). `app/(admin)/`, `app/api/office/` and
  `components/office/` were not touched.
- **Feature list:** section 5 line 62 - "Underwriting criteria are set by the compliance team:
  starting monthly transaction limit for new merchants, MCC based risk tiers with extra reserve or
  longer hold, required bank statement period, and holding unusually large transactions for review";
  section 2 - compliance_kyc works the underwriting criteria, super_admin has full control, ceo and
  finance_ops read them.
- **Depends on:** STEP 036 (`0077` mcc_codes with `risk_tier`), STEP 081 (`0104` profile
  `mcc_code` + the index this STEP's overview uses), STEP 086 (`bankStatementPeriodMonths`
  dependency of the capture service, previously defaulted), STEPs 088-089 (the office service
  pattern in `services/kyc/`).

## Migration added, and the rollback proof

- `migrations/0106_underwriting_criteria.sql` + `0106_underwriting_criteria.down.sql`. The forward
  file creates `underwriting_criteria` (one platform row; guard refuses a second live row, any
  delete and any soft delete), `underwriting_risk_tiers` (one row per low/medium/high with
  `extra_reserve_percent` and `hold_days`), RLS with default deny on both, manage policies for
  compliance_kyc + super_admin, office read policies for ceo + finance_ops, an owner select on the
  criteria row only, one select policy on `business_profiles` for the four office roles, and seeds
  (1000.0000 USD starting limit, 3 months statement period, hold on at 10000.0000 USD; tiers at
  0.00% / 0 days). The rollback drops the added policy, both tables and both guard functions.
- `npm run -s check:migrations` passed: 3101 checks, **106 migrations, 80 tables** (was 105/78).
  Like every STEP since 012, the SQL is proven statically by this gate; the live apply/rollback
  transcript of STEP 012 on PostgreSQL 16.2 in `docs/handoffs/STEP_012_COMPLETED.md` is the standing
  proof pattern, and this file changes no constraint that pattern does not already cover. No
  existing row is rewritten: the file only creates tables, policies and seeds.

## Files

- **Created:** `migrations/0106_underwriting_criteria.sql`, `migrations/0106_underwriting_criteria.down.sql`,
  `services/kyc/underwriting.ts`, `app/api/onboarding/underwriting-criteria/route.ts` (POST),
  `app/api/onboarding/underwriting-risk-tier/route.ts` (POST),
  `app/api/onboarding/underwriting-mcc-tier/route.ts` (POST),
  `app/api/onboarding/underwriting-mcc/route.ts` (GET),
  `app/(dashboard)/onboarding/underwriting/page.tsx`,
  `app/(dashboard)/onboarding/underwriting/underwriting-panel.tsx`,
  `docs/planning/STEP_090_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_090_COMPLETED.md`.
- **Modified:** `lib/security/csrf.ts` (three new POST paths), `lib/i18n/strings/en.ts` (new
  `onboardingUnderwriting` block, 45 keys; 1426 -> 1471 messages, 162 -> 165 placeholders),
  `services/kyc/verify.ts` (2509 -> 2855 checks), `lib/auth/verify.ts` (2499 -> 2511; baselines
  15 keepers / 28 mutation files / 32 call sites), `app/api/onboarding/kyc-document/route.ts`
  (enforces the stored statement period), `app/(dashboard)/onboarding/documents/page.tsx` and
  `documents-form.tsx` (the form checks the compliance-set period), `app/(dashboard)/README.md`.

## Behaviour

- **Settings read** (`readUnderwritingSettings`): ceo, compliance_kyc, finance_ops, super_admin; one
  criteria row + three tier rows, one `underwriting.criteria_read_by_office` audit entry (sink down
  tolerated), no company filter on any query. Missing row -> 404.
- **Merchant summary** (`readMerchantUnderwritingSummary`): owner with a company only; answers
  `{ bankStatementPeriodMonths }` and nothing else - never the limit, the threshold or the tiers.
- **Criteria save** (`POST /api/onboarding/underwriting-criteria`): manage roles only; zod body with
  money as digit strings (<= 4 decimals) and ranges matching the `0106` checks; one conditional
  update by id + current version with version+1 and `updated_by`; re-read race check (CONFLICT
  `stale`); one `underwriting.criteria_updated` audit on the platform chain with the new values;
  returns the fresh settings. Eight malformed/out-of-range bodies each refuse with 422 and zero
  writes; range refusals name the `out_of_range` rule.
- **Tier save** (`POST /api/onboarding/underwriting-risk-tier`): manage roles; per-tier conditional
  update, race check, `underwriting.risk_tier_updated` audit; re-saving identical values writes and
  audits nothing.
- **Code tier** (`POST /api/onboarding/underwriting-mcc-tier`): code validated as four digits before
  any query; unknown -> 404; retired code -> CONFLICT `retired_code`; same tier -> idempotent; else a
  version-bumped conditional update on `mcc_codes.risk_tier` with a race check and an
  `underwriting.mcc_tier_set` audit; `unassigned` clears a tier.
- **MCC overview** (`GET /api/onboarding/underwriting-mcc`): read roles; active codes with title and
  tier, plus the count of live profiles per code read across companies on purpose
  (`mcc_code=not.is.null`, the only unscoped profile read - the gate asserts every other profile
  query carries a company), ordered by count desc then code; audited.
- **Screen:** `/onboarding/underwriting` renders server-side with the four states and hands the
  settings + overview to a client panel whose three saves share one POST helper (one POST literal,
  one awaited CSRF spread). The documents step now shows and enforces the compliance-set bank
  statement period instead of the build-time default.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 2855 checks (see `docs/planning/STEP_090_SUBSTEP_BREAKDOWN.md`
  090.6 for the full list of the new underwriting checks).
- `node lib/auth/verify.ts` - 2511 checks; baselines 15/28/32 (the underwriting page's keeper and
  the panel's single POST site); every POST route is on the CSRF list and checks the token first.
- `npm run -s check:i18n` - 1471 messages / 165 placeholders; `npm run -s check:migrations` - 106
  migrations / 80 tables; `npm run -s typecheck` and `npm run -s lint` clean; `npm run -s verify`
  exit 0 (9 gates + production build listing `/onboarding/underwriting` and the four new routes).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): the page answers 200
  signed-out; each new POST route without a token answers 422 `csrf_token_invalid`; the overview GET
  without a session answers 401.

## Acceptance checklist

- The four behaviours of the title were exercised through the gate harness (success, validation
  failure, unauthorized and cross-role requests for each of the three writes and both reads), not
  only probed in source: role refusals run with zero queries and zero writes, conflicts and races
  are asserted, and every mutation's audit entry is asserted.
- UI: the screen follows the same responsive classes as the 088 queue (`sm:` breakpoints, table
  scrolls horizontally on narrow widths); all strings come from the `onboardingUnderwriting` block;
  keyboard operation is native inputs/selects/buttons.
- No money STEP ledger applies here (criteria are settings, not postings); money values are validated
  as strings and stored as numeric(18,4).

## Notes for the next STEP

- STEP 091 (starting transaction limit enforcement) should read `underwriting_criteria` through
  `services/kyc/underwriting.ts` and enforce `starting_monthly_limit` on new merchants; the large-
  transaction hold (`large_transaction_hold_enabled` + threshold) belongs to the payment core STEPs,
  which can read the same row.
- The MCC tier costs (`underwriting_risk_tiers`) are read by whoever prices reserves/holds; the tier
  on a code is already settable here and audited.
- 089's rule still stands: only STEP 093 writes approved/rejected on a KYC submission.
- `0106` added the only cross-company read on `business_profiles`; keep any future one equally
  deliberate and probed in the gate.
