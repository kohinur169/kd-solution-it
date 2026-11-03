// path: docs/planning/STEP_087_SUBSTEP_BREAKDOWN.md
# STEP 087 - KYC submission summary and status screen for merchant: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 087.1 - Confirm there is no migration

- `0048` already carries everything the screen shows: status (draft/submitted/in_review/approved/
  rejected), submitted_at/submitted_by, decided_at, decision_reason ("a rejection carries its
  reason because the merchant reads it"), version. The submit is an UPDATE of the draft row, not a
  new table or column. **Proof:** `npm run -s check:migrations` stays at 105 migrations / 78
  tables.

## 087.2 - The merchant-safe summary read (`readKycSummary` in `services/kyc/kyc-capture.ts`)

- `0048`'s own header comment says "the merchant only ever reads `status`", so the summary's
  submission select (`submissionDetailRowSchema`) does not even fetch `verification_method` or the
  provider reference; the snapshot carries status, submitted/decided instants and the decision
  reason, plus document rows slimmed to type/status/rejection_reason/dates/size (no storage key,
  no hash) and counts for documents, owners (and significant owners) and screened subjects.
- The pack from STEP 084 stopped answering `method` too - same rule, one place enforced.
- `missing` lists what blocks a submit ("documents", "screening"); `canSubmit` = an open draft with
  nothing missing.

## 087.3 - The submit (`submitKyc`)

- Owner actor, company from the session. No submission -> VALIDATION_FAILED (documents required);
  status not draft -> CONFLICT `already_submitted`; missing documents or screening run ->
  VALIDATION_FAILED naming the field.
- The write is one conditional update (`id=eq...&company_id=eq...&status=eq.draft&deleted_at=is.null`)
  setting status/submitted_at/submitted_by/updated_at and bumping version (optimistic locking,
  rule 13), then a re-read - if the row did not move, CONFLICT `stale`. `0048`'s guard freezes
  submitted_at/submitted_by and locks decided rows, so the conditional update is the race-safe
  shape. One audit entry `kyc_submission.submitted`, audit-sink failure tolerated like the other
  saves. The answer is the fresh summary.

## 087.4 - Route, page, form

- `app/api/onboarding/kyc-submit/route.ts`: POST only, CSRF first, 1 KiB body ceiling, actor,
  JSON parse of the empty body, service, `no-store`; the path added to `lib/security/csrf.ts`.
- `app/(dashboard)/onboarding/status/page.tsx`: server component, `readOwnerActor` +
  `readKycSummary` + `SessionKeeper`, the same four states as the sibling pages; renders the
  status banner (per-status copy, green for approved, alert for rejected), the submitted/decided
  lines, the rejection reason, the counts, the missing list, and the form.
- `status-form.tsx` ("use client"): exactly one `method: "POST"` with one `...(await csrfHeaders())`
  spread, empty `{}` body, refusal handling (401/403/429/422 with per-rule sentences), renders only
  when `canSubmit`; on success `router.refresh()`. The documents page links here
  (`statusLink`), and this page links back to the documents step.
- The documents list now shows each document's review status (uploaded/accepted/rejected) and the
  rejection reason when the office sets one.
- Copy: a new `onboardingStatus` block (~34 keys) plus 4 keys in `onboardingDocuments`
  (1319 -> 1357 messages, 127 -> 134 placeholders). The auth gate baselines moved with the new
  screens: 13 session keepers, 26 mutation files, 30 call sites.

## 087.5 - Verification

- `services/kyc/verify.ts`: 1916 -> 2115 checks. The fake store grew submission columns (with
  migration defaults for older seeds), a `kyc_submissions` update branch, and rejection_reason on
  documents. New: summary role refusals, empty/seeded/decided summaries, merchant-safety probes
  (the serialized summary contains no method, provider reference, storage key or hash), the
  company scoping of every query, the pack no longer carrying `method`, submit refusals (no
  submission, no screening, foreign company, double submit), the happy path (status/submitted_at/
  submitted_by/version=2, conditional update query, audit entry, returned summary), source probes
  for route/page/form, and a full `onboardingStatus` catalog check wired into main().
- `node lib/auth/verify.ts` 2483 -> 2487; `npm run -s check:i18n` 1357/134; `npm run -s lint` and
  `npm run -s typecheck` clean; `npm run -s verify` exit 0 (all gates + production build listing
  `/onboarding/status` and `/api/onboarding/kyc-submit`).
- Dev smoke on port 3107: `GET /onboarding/status` 200 signed-out; POST `/api/onboarding/kyc-submit`
  without a token -> 422 `csrf_token_invalid`; GET on the route -> 405.
