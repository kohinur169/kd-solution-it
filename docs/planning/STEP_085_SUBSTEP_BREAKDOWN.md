// path: docs/planning/STEP_085_SUBSTEP_BREAKDOWN.md
# STEP 085 - Address proof upload: utility bill with 3 month issue rule: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 085.1 - Confirm there is no migration

- `0049` already stores `issued_at`/`expires_at` and already refuses a missing issue date on a
  utility bill, an expiry before the issue date, and an issue date after the row's creation
  (`issued_at <= created_at`). The three month window is a business rule evaluated at upload
  time, where "today" is known and the refusal is auditable; it is not a row constraint, because
  the office must be able to accept a re-issued bill and the same bill is not re-uploaded late.
- **Proof:** `npm run -s check:migrations` stays at 105 migrations / 78 tables.

## 085.2 - The window helper in the client-safe module (`services/kyc/kyc-document-types.ts`)

- `UTILITY_BILL_MAX_AGE_MONTHS = 3` and `utilityBillIssueWindow(nowMs)` returning
  `{ earliest, latest }` as YYYY-MM-DD strings (date-only strings compare lexically, so both the
  parser and the form compare without parsing). `latest` is today UTC - mirroring `0049`'s
  no-future-dates check - and `earliest` is today minus three calendar months via
  `setUTCMonth(-3)`, which crosses year boundaries correctly. The module keeps no server imports,
  so the client form can use the helper; `kyc-capture.ts` re-exports both.

## 085.3 - The server rule (`services/kyc/kyc-capture.ts`)

- `parseKycDocumentInput(input, options?: { now })`: with a parseable `issued_at`, a date after
  `window.latest` is refused as `invalid_date` for **every** type (that is `0049`'s check, refused
  earlier with the field named); a utility bill dated before `window.earliest` is refused as
  `invalid_range`. The rule binds the utility bill only - an old bank statement date still parses.
- Also fixed here: a utility bill whose `issued_at` was sent but does not parse is now reported
  once (`invalid_format`), never double-reported as `required` - the required rule keys off the
  field being absent, not off the parse result.
- `saveKycDocument` pins the parser's clock with `{ now: nowOf(dependencies) }`, so the rule is
  evaluated against the request's time, and the gate can pin `NOW`.

## 085.4 - The form

- The page (server component) computes the window once at module load and passes it down as the
  `issueWindow` prop - the react-hooks purity rule forbids `Date.now()` during render, in the
  client form and in the page alike.
- The form caps the date picker with `max={issueWindow.latest}`, pre-checks a utility bill's
  issue date against the window before sending anything (no fetch on a stale/future date), and
  now surfaces every 422 detail by field (`document_type`, `file`, `issued_at`, `expires_at`)
  instead of only the file one. When the type is utility bill, the date hint is replaced by the
  templated `utilityBillRuleLine` ("...within the last {months} months...").
- New copy: `docTypeHint`, `utilityBillRuleLine`, `ruleInvalidDate`, `ruleInvalidRange` in the
  `onboardingDocuments` block (1310 -> 1314 messages); `RULE_MESSAGES` maps the two new rules.
- The two POST sites and their two awaited CSRF spreads are unchanged, so the auth gate's
  baselines (12 keepers / 25 mutation files / 29 call sites) still hold.

## 085.5 - Verification

- `services/kyc/verify.ts`: 1844 -> 1877 checks. New: the window helper (boundary and year
  crossing), boundary-accepted bill (2026-08-02 at NOW 2026-11-02), one-day-stale refusal
  (`invalid_range`), future refusal (`invalid_date`) for a bill and for a non-bill type, old
  bank statement accepted, single-report of an unparseable date, a full save at the boundary
  recording `issued_at`, two new save refusals, and source probes on both sides.
- `npm run -s check:i18n` 1314/123; `node lib/auth/verify.ts` 2483 unchanged; `npm run -s lint`
  and `npm run -s typecheck` clean; `npm run -s verify` exit 0 (all gates + production build).
- Dev smoke on port 3107: `GET /onboarding/documents` 200 signed-out; POST `/api/onboarding/kyc-document`
  without a token -> 422 `csrf_token_invalid`; GET on the route -> 405.
