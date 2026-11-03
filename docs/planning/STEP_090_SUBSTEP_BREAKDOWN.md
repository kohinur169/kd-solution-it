// path: docs/planning/STEP_090_SUBSTEP_BREAKDOWN.md
# STEP 090 - Underwriting criteria settings managed by compliance team: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 090.1 - The database part: `0106_underwriting_criteria.sql` (+ rollback)

- FEATURE_LIST line 62 names four criteria the compliance team sets: starting monthly transaction
  limit for new merchants, MCC based risk tiers with extra reserve or longer hold, required bank
  statement period, and holding unusually large transactions for review.
- Two new platform tables (both `company_id` checked null, like `0080`/`0077`):
  - `underwriting_criteria` - ONE singleton row with `starting_monthly_limit numeric(18,4)`,
    `bank_statement_months 1..36`, `large_transaction_hold_enabled`, `large_transaction_hold_threshold
    numeric(18,4)`, `updated_by`, version. A guard trigger refuses a second live row, any delete and
    any soft delete, and freezes `company_id`, so the criteria are one policy row that changes with a
    version bump, never a registry of keys (`0080` owns that shape for operator switches).
  - `underwriting_risk_tiers` - one row per tier (`low`/`medium`/`high`, unique while live) with
    `extra_reserve_percent numeric(5,2) 0..100` and `hold_days 0..90`. The tier a code carries already
    exists as `mcc_codes.risk_tier` (`0077`, compliance-updatable); this table is what a tier costs.
- One policy added to an existing table: `business_profiles_underwriting_read` (select for ceo,
  compliance_kyc, finance_ops, super_admin), serving the MCC overview's cross-company count through
  `business_profiles_mcc_idx` of `0104`.
- RLS per table: default deny; manage (all) for compliance_kyc + super_admin; office select for ceo +
  finance_ops; `underwriting_criteria` alone also has an owner select, because the merchant's
  documents screen must read the required statement period - the service answers only that column.
- Seeds carry no audit (platform chain rule of the `0080` seed): criteria at 1000.0000 USD starting
  limit, 3 months statement period, hold enabled at 10000.0000 USD; tiers at 0.00% / 0 days, because
  assigning a cost to a tier is the compliance team's decision.
- Rollback `0106_underwriting_criteria.down.sql` drops the added policy, both tables and both guard
  functions. `npm run -s check:migrations`: 105 -> 106 migrations, 78 -> 80 tables.

## 090.2 - The service (`services/kyc/underwriting.ts`)

- Roles: `UNDERWRITING_MANAGE_ROLES` = super_admin + compliance_kyc (section 5 gives the criteria to
  the compliance team; section 2 keeps full control with super_admin); `UNDERWRITING_READ_ROLES` adds
  ceo + finance_ops. Refusals throw before any query; the gate asserts zero queries.
- `readUnderwritingSettings` - one criteria select + one tiers select, one tolerated audit entry
  (`underwriting.criteria_read_by_office`), platform scoped (no company filter on any query).
- `readMerchantUnderwritingSummary` - owner + company required; answers
  `{ bankStatementPeriodMonths }` and nothing else.
- `updateUnderwritingCriteria` - zod body (money as digit strings with <= 4 decimals, ranges against
  the `0106` ceilings), one conditional update by id + current version with version+1, re-read race
  check (CONFLICT `stale`), one `underwriting.criteria_updated` audit with the new values on the
  platform chain, returns the fresh settings.
- `updateUnderwritingRiskTier` - same shape per tier row; re-saving identical values is idempotent
  (no write, no audit); audit `underwriting.risk_tier_updated`.
- `setMccRiskTier` - code validated as four digits before any query; unknown code -> 404; retired
  code -> CONFLICT `retired_code` (`0104` leaves that refusal to the service); same tier ->
  idempotent; else conditional update on `mcc_codes` by id + version, re-read, audit
  `underwriting.mcc_tier_set`, returns the fresh overview.
- `readUnderwritingMccOverview` - active codes (ordered by code) plus the one deliberate cross-company
  profile read (`select=mcc_code&mcc_code=not.is.null`), counts aggregated in memory, rows ordered by
  count desc then code. The gate asserts no OTHER profile query is unscoped.
- Money travels as strings; PostgREST may answer numeric as a number, so row schemas accept both.
  Range checks convert to a JS number only to compare against ceilings <= 10^14 (< 2^53, exact); the
  stored value is always the caller's string. No ledger math here.

## 090.3 - Routes and CSRF

- `POST /api/onboarding/underwriting-criteria`, `/underwriting-risk-tier`, `/underwriting-mcc-tier`
  (CSRF first, 8 KiB ceiling, session, JSON parse, service, no-store) - three new entries in
  `lib/security/csrf.ts`. POST-only files, like every other mutation route, so the auth gate's
  "token before session" probe holds per file.
- `GET /api/onboarding/underwriting-mcc` (no CSRF - reads have no body) for the code overview.
- The criteria read needs no GET route: the screen reads server-side through the service.

## 090.4 - The screen

- `onboarding/underwriting/page.tsx` (server): `readOwnerActor` + `readUnderwritingSettings` +
  `readUnderwritingMccOverview`, four states (signed-out/forbidden/unavailable/ready), `SessionKeeper`.
- `underwriting-panel.tsx` ("use client"): criteria form, three tier editors, and the MCC table with a
  filter and a tier select per row. All three saves share one `postJson` - a single POST literal and
  one awaited CSRF spread. No company is ever sent; the criteria, tiers and codes are platform scoped.
- Copy: new `onboardingUnderwriting` block in `en.ts` (1426 -> 1471 messages, 162 -> 165
  placeholders), with its own catalog check wired into the onboarding gate.

## 090.5 - The merchant wiring (the "required bank statement period" criterion made real)

- `0048`-era `saveKycDocument` already took `bankStatementPeriodMonths` as a dependency with a
  build-time default; STEP 090 feeds it from the stored row: `app/api/onboarding/kyc-document/route.ts`
  reads `readMerchantUnderwritingSummary` and passes the period into the service, so the server
  validates uploads against the compliance-set period.
- `onboarding/documents/page.tsx` reads the same summary and passes `statementPeriodMonths` to
  `DocumentsForm`, which now checks the covered period against the prop instead of the constant (the
  constant stays in `kyc-document-types.ts` as the service-side fallback).

## 090.6 - Verification

- `services/kyc/verify.ts`: 2509 -> 2855 checks. The fake store grew the criteria row, the tier rows,
  select/update branches for both `0106` tables (updates conditional on id + version, with a race flag),
  an update branch for `mcc_codes`, and the one allowed unscoped profile read (`mcc_code=not.is.null`).
  New `checkUnderwriting` covers: role lists, read/manage refusals with zero queries, the seeded read
  + read audit, the owner-only summary, the criteria save (conditional query, version bump, updater,
  audit payload, platform chain), eight validation refusals with zero writes, the `out_of_range` rule,
  the lost-race conflict, the tier save + idempotency + four refusals, the code tier set (audit,
  idempotency, retired conflict, unknown code, bad format before any query, clearing to unassigned),
  and the overview (active-only codes, cross-company counts, ordering, audited). Plus
  `checkUnderwritingSources` (routes/page/panel/service/migration/wiring probes) and
  `checkUnderwritingCatalog`.
- `node lib/auth/verify.ts`: 2499 -> 2511; baselines 14 -> 15 keepers (the new page), 27 -> 28 browser
  mutation files, 31 -> 32 POST call sites (the panel's one shared POST site).
- `npm run -s check:i18n` 1471/165; `npm run -s typecheck`, `npm run -s lint` clean;
  `npm run -s verify` exit 0 (9 gates + build listing the four routes and `/onboarding/underwriting`).
- Dev smoke on port 3107: `/onboarding/underwriting` 200 signed-out; each new POST route without a
  token -> 422 `csrf_token_invalid`; `GET /api/onboarding/underwriting-mcc` without a session -> 401.
