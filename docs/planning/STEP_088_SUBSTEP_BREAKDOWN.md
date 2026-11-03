// path: docs/planning/STEP_088_SUBSTEP_BREAKDOWN.md
# STEP 088 - Compliance KYC review queue with document viewer: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 088.1 - Confirm there is no migration

- `0048`-`0051` already carry everything the queue reads and the two writes change: submission
  statuses (submitted -> in_review with first_reviewer_id), document status/reviewed_at/
  reviewed_by/rejection_reason/version. Both writes are conditional UPDATEs of existing rows.
- **Proof:** `npm run -s check:migrations` stays at 105 migrations / 78 tables.

## 088.2 - Placement under the owned paths

- STEPs 079-099 own `app/(dashboard)/onboarding/`, `services/kyc/`, `services/submerchant/` (plus
  the `app/api/onboarding/` routes this block has used since 083), so the queue screen lives at
  `app/(dashboard)/onboarding/kyc-review/` even though its audience is the office: the page makes no
  role decision of its own - the service refuses any actor outside `KYC_REVIEW_OFFICE_ROLES`
  (super_admin, ceo, compliance_kyc) before a query runs, and the page maps that refusal to the
  forbidden panel. When the office area (068-078) grows its own KYC screens, this page can move.

## 088.3 - The service (`services/kyc/kyc-review.ts`)

- `readKycReviewQueue`: office roles only; one submissions select with `status=in.(submitted,
  in_review)` plus three bounded count selects (documents/ubos by submission_id, screenings by
  company_id - `0051` has no submission column), counts assembled in memory, so no query runs in
  a loop. Queue reads are deliberately NOT company-scoped; the gate asserts no queue query carries
  a company filter.
- `readKycReviewDetail`: uuid-validated `submission_id` before any query (non-uuid -> 422 with zero
  queries, unknown -> RESOURCE_NOT_FOUND); lookup by id, then every later query scoped to the
  submission's own company. The office sees method, provider_reference, storage keys, hashes and
  screening results - the merchant (087) never does. One `kyc_review.read_by_office` audit entry
  per read, sink failure tolerated. The viewer shows the record (key + sha256 bind the row to the
  bytes) because the storage layer is STEPs 100-105 and does not exist yet.
- `openKycReview`: submitted -> in_review with first_reviewer_id, conditional update
  (`id`+`company_id`+`status=eq.submitted`) with version+1, re-read race check (409 stale),
  re-open by the same reviewer is idempotent, audit `kyc_review.opened`.
- `reviewKycDocument`: body `{document_id uuid, decision accept|reject, reason?}`; reason required
  on reject (0049's own check), trimmed 1..280; conditional update on `status=eq.uploaded`;
  re-read race check; audit `kyc_document.reviewed`. Never writes approved/rejected on the
  submission - that is STEP 093.

## 088.4 - Routes and screen

- `GET /api/onboarding/kyc-review` (queue, no params), `GET /api/onboarding/kyc-review-submission?id=`
  (detail by submission id, never a company), `POST /api/onboarding/kyc-review-open`,
  `POST /api/onboarding/kyc-document-review` (CSRF first, body ceiling, actor, JSON parse, service,
  no-store; the two POST paths added to `lib/security/csrf.ts`).
- `kyc-review/page.tsx` (server): `readOwnerActor` + `readKycReviewQueue` + `SessionKeeper`, four
  states; renders the queue rows and hands them to the panel.
- `kyc-review-queue.tsx` ("use client"): detail loaded by one GET; open + decide share one
  `postJson` helper - a single POST literal and one awaited CSRF spread (the auth gate's 1:1 rule).
  Reject requires the reason locally before sending. Baselines moved: 14 keepers / 27 mutation
  files / 31 call sites.
- Copy: new `onboardingKycReview` block (~48 keys; 1357 -> 1417 messages, 134 -> 162 placeholders),
  with its own catalog check wired into the onboarding gate.

## 088.5 - Verification

- `services/kyc/verify.ts`: 2115 -> 2439 checks. The fake store grew: queue-wide KYC reads (no
  company filter) while profile/progress reads still refuse to be unscoped, `status=in.()` filters,
  `submitted_at` ordering, submission/document column defaults, and an update branch for
  kyc_documents. New checks: queue refusals (owner/finance/support/blogger/nobody read nothing),
  queue contents and per-row counts, detail (roles, uuid-before-query, not-found, office-visible
  fields, audit entry, lookup-by-id then company-scoped queries, legal name), open (happy path,
  idempotent re-open, draft conflict, conditional update, audit), document decision (accept,
  reject-without-reason refusal, reject with trimmed reason, already-decided conflict, malformed
  body with zero queries), source probes for all routes/page/panel/service, and the catalog check.
- `node lib/auth/verify.ts` 2487 -> 2495; `npm run -s check:i18n` 1417/162; `npm run -s lint` and
  `npm run -s typecheck` clean; `npm run -s verify` exit 0 (all gates + production build listing
  the five new routes and `/onboarding/kyc-review`).
- Dev smoke on port 3107: `GET /onboarding/kyc-review` 200 signed-out; POST to both mutation routes
  without a token -> 422 `csrf_token_invalid`; GET queue/detail without a session -> 401.
