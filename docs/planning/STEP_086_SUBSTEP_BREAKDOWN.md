// path: docs/planning/STEP_086_SUBSTEP_BREAKDOWN.md
# STEP 086 - Bank statement and source of funds upload: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 086.1 - Confirm there is no migration

- `0049` already stores `issued_at`/`expires_at` on every kyc_documents row and already enforces
  their ordering (`expires_at > issued_at` when both are present). A bank statement's covered
  period maps onto exactly those two columns - period start and period end - so the table needs
  nothing new. The required period length is an underwriting criterion, evaluated at upload time.
- **Proof:** `npm run -s check:migrations` stays at 105 migrations / 78 tables.

## 086.2 - Date helpers in the client-safe module (`services/kyc/kyc-document-types.ts`)

- Refactored `utilityBillIssueWindow` onto two shared helpers: `dateStringOf(nowMs)` and
  `dateStringMinusMonths(dateIso, months)` (UTC calendar-month arithmetic, date-only strings so
  comparisons stay lexical). Added `monthsBetweenDates(startIso, endIso)` (full calendar months,
  day-of-month aware) and the two policy constants `BANK_STATEMENT_DEFAULT_PERIOD_MONTHS = 3` and
  `BANK_STATEMENT_MAX_AGE_MONTHS = 1`. All client-safe, so the form pre-checks with the same code
  the server runs; `kyc-capture.ts` re-exports them.
- Per the STEP 085 handoff note, the required period is **a parameter, not a per-type window
  table**: `BANK_STATEMENT_DEFAULT_PERIOD_MONTHS` is only the platform default until the office
  settings STEP stores the compliance team's criterion.

## 086.3 - The server rule (`services/kyc/kyc-capture.ts`)

- `KycCaptureDependencies` gains `bankStatementPeriodMonths?: number | undefined` (the
  compliance-set criterion, arriving as a parameter); `parseKycDocumentInput` options gain the
  same field, and `saveKycDocument` passes both `now` and the period through.
- For `bank_statement`: both dates are required (`required` on each missing one - a statement
  without a period is not evidence); if both parse and are ordered, the period end must be within
  the last month (`expires_at < today - BANK_STATEMENT_MAX_AGE_MONTHS` -> `invalid_range`, stale)
  and the covered length must be at least the required months
  (`monthsBetweenDates(issuedAt, expiresAt) < requiredMonths` -> `invalid_range`, short). The
  ordering refusal (`invalid_format`) and the range rules are else-if chained so one field is
  never reported twice. `source_of_funds` carries no date rule - a letter or deed may be undated.
- The utility bill rule from STEP 085 is untouched; the future-date rule still applies to every
  type.

## 086.4 - The form

- Preflight for `bank_statement`: both dates required, then recency cutoff and period length via
  the shared helpers - no fetch happens on a bad period. The date pickers stay capped at
  `issueWindow.latest` (now on both inputs).
- Per-type copy: for a bank statement the two date fields are labelled "Statement covers
  from/to" and the hint is the templated `bankStatementRuleLine` ("...must end within the last
  month and cover at least {months} months"); for a utility bill the 085 line; otherwise the
  generic optional hint.
- The recorded-documents list now shows the period: `docPeriodLine` ("Covers {from} to {to}") for
  a bank statement, `docIssuedLine` ("Issued {date}") for any other dated document.
- New copy in the `onboardingDocuments` block: `docIssuedLine`, `docPeriodLine`,
  `statementFromLabel`, `statementToLabel`, `bankStatementRuleLine`; `ruleInvalidRange` reworded
  to cover both rules. 1314 -> 1319 messages, 123 -> 127 placeholders.
- Still exactly two `method: "POST"` sites with one awaited CSRF spread each, so the auth gate
  baselines hold unchanged.

## 086.5 - Verification

- `services/kyc/verify.ts`: 1877 -> 1916 checks. New: helper units (cutoff, month counting incl.
  the day-short boundary), statement without period refused on both dates, three-month statement
  ending this month accepted, two-month statement refused as short, three-month statement ending
  over a month ago refused as stale, the period parameter (6 required refuses 3 months, accepts 6),
  a full save recording both period ends, three new save refusals writing nothing, and source
  probes on service, types module and form. The 084-era "second save" fixture (a bank statement)
  now carries a valid period.
- `node lib/auth/verify.ts` 2483 unchanged; `npm run -s check:i18n` 1319/127; `npm run -s lint`
  and `npm run -s typecheck` clean; `npm run -s verify` exit 0 (all gates + production build).
- Dev smoke on port 3107: `GET /onboarding/documents` 200 signed-out; POST `/api/onboarding/kyc-document`
  without a token -> 422 `csrf_token_invalid`; GET on the route -> 405.
