// path: docs/handoffs/STEP_086_COMPLETED.md
# STEP 086 - Bank statement and source of funds upload: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 086 code are in one commit, the
one whose message is "STEP 086: Bank statement and source of funds upload" (`git log -1` on the
branch shows its hash). Previous handoff: `docs/handoffs/STEP_085_COMPLETED.md`.

## STEP

- **Number and title:** STEP 086 - Bank statement and source of funds upload
  (`docs/final/STEP_PLAN_250.md`, the STEP 086 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Eighth STEP of the block.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/` (plus the `app/api/onboarding/` routes the onboarding block owns). This
  STEP touched the first two only - the upload route from STEP 084 already serves all six document
  types, so no `app/api/` change was needed.
- **Feature list:** section 5 - "Address verification uploads: utility bill issued within 3
  months, bank statement, source of funds document, and any extra document a processor requests",
  and "Underwriting criteria are set by the compliance team: ... required bank statement period
  ...".
- **Depends on:** STEP 084 (the upload route and `services/kyc/kyc-capture.ts`), STEP 085 (the
  shared date helpers and window), STEP 028 (`0049` kyc_documents).

## No migration - and why that needs no rollback proof

A bank statement's covered period maps onto `0049`'s existing `issued_at` (period start) and
`expires_at` (period end); the table already enforces their ordering. The required period length
and recency are upload-time business rules that only refuse - they never write - so there is no
new migration and no partial-write path: `npm run -s check:migrations` stays at 105 migrations /
78 tables.

## Files

- **Created:** `docs/planning/STEP_086_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_086_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-document-types.ts` (`dateStringOf`, `dateStringMinusMonths`,
  `monthsBetweenDates`, `BANK_STATEMENT_DEFAULT_PERIOD_MONTHS = 3`, `BANK_STATEMENT_MAX_AGE_MONTHS
  = 1`; `utilityBillIssueWindow` refactored onto the shared helpers, same answers as 085),
  `services/kyc/kyc-capture.ts` (re-exports; `bankStatementPeriodMonths` parameter on the
  dependencies and the parser options; the bank statement period rules; `saveKycDocument` passes
  both through), `app/(dashboard)/onboarding/documents/documents-form.tsx` (statement preflight,
  per-type labels and hints, period line in the recorded list, both pickers capped at today),
  `lib/i18n/strings/en.ts` (5 new keys in `onboardingDocuments` + the reworded `ruleInvalidRange`;
  1314 -> 1319 messages, 123 -> 127 placeholders), `services/kyc/verify.ts` (1877 -> 1916 checks),
  `app/(dashboard)/README.md` (the documents bullet names the period rule).

## Behaviour

- **Bank statement (server, authoritative):** both dates required - `issued_at` is where the
  covered period starts, `expires_at` where it ends. With both present and ordered, the period
  end must be within the last month (`expires_at >= today - 1 month`, else `{ field: "expires_at",
  rule: "invalid_range" }` - stale) and the covered length must be at least the required period
  (`monthsBetweenDates` < required -> `invalid_range` - short). At NOW 2026-11-02: 2026-08-01 to
  2026-11-01 is accepted; 2026-08-01 to 2026-10-31 is refused as short; 2026-07-01 to 2026-10-01 is
  refused as stale. The required period arrives as the `bankStatementPeriodMonths` parameter
  (default 3) - section 5 gives that criterion to the compliance team, so it is not hard-coded
  into a per-type rule table; the office settings STEP will feed it later.
- **Source of funds:** uploads with no date rule - a letter or deed may be undated; the generic
  future-issue-date refusal still applies if a date is sent.
- **Client (early answer only):** same rules pre-checked with the shared helpers before any
  fetch; the pickers are capped at today; per-type labels ("Statement covers from/to") and the
  templated rule line; every 422 detail still renders beside its field. The recorded list shows
  "Covers {from} to {to}" for statements and "Issued {date}" for other dated documents.
- Upload route, audit, key-and-hash record, wizard sync: unchanged from STEP 084.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 1916 checks: helper units, missing-period refusal on both
  dates, boundary acceptance, short and stale refusals, the parameter (6 required vs 3 covered),
  a full save recording both period ends, save refusals writing and querying nothing, source
  probes. (The 084-era bank-statement save fixture now carries a valid period.)
- `node lib/auth/verify.ts` - 2483 checks, baselines unchanged (12 keepers / 25 mutation files /
  29 call sites; still two POST sites, one awaited CSRF spread each).
- `npm run -s check:i18n` - 1319 messages / 127 placeholders; `npm run -s lint` clean;
  `npm run -s typecheck` clean; `npm run -s verify` exit 0 (structure, shell, errors, config,
  lint, migrations 3057/105/78, security, logger, jobs + production build listing
  `/onboarding/documents` and `/api/onboarding/kyc-document`).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `GET
  /onboarding/documents` -> 200 signed-out; POST `/api/onboarding/kyc-document` without a token
  -> 422 `csrf_token_invalid`; GET on the route -> 405.

## Notes for the next STEP

- STEP 087 (KYC submission summary and status screen) reads the same pack; the pack's documents
  already carry `issuedAt`/`expiresAt`, so the summary can show the statement period without a
  service change.
- When the office underwriting settings land, feed `bankStatementPeriodMonths` from there
  instead of the default - the parser already takes it as a parameter, and the gate proves both
  directions.
- Do not generalize the date rules into a per-type table yet; the two rules (utility bill window,
  statement period) are deliberately separate until more types need them.
