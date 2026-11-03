// path: docs/planning/STEP_099_SUBSTEP_BREAKDOWN.md
# STEP 099 - Merchant suspension, reactivation and account closure flow with saved card token deletion and chargeback-period fund hold: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 099.1 - The database part: `0111_merchant_account_events.sql` plus its rollback

- FEATURE_LIST section 13: a suspended merchant submits the required documents and returns to active
  after compliance review; on closure the remaining money goes to the bank after the hold period and
  the chargeback-liability funds stay held until the chargeback period ends; saved card tokens are
  deleted at once when the merchant leaves; closed and suspended data and sub-merchant records are
  retained for 7 years.
- `0111` is the append-only event log those rules write to: one row per lifecycle event of one
  merchant - `suspended` (closed reason vocabulary `risk` / `chargeback_program` / `billing` /
  `manual`, plus the `required_documents` JSON array), `reactivation_requested` (naming the
  `kyc_submission_id` the merchant answered with, through the composite tenant key),
  `reactivated`, `closure_requested`, `closed` (verified `payout_bank_account_id`,
  `hold_release_at`, `chargeback_hold_release_at`, with the check that the chargeback instant is
  strictly after the payout instant), and `card_tokens_deleted` (system event, null actor). The
  guard refuses every update, delete and soft delete - that is the 7 year retention - and the checks
  make each event honest about which columns it may carry. Indexes: per-company history and the
  office queue (the three open states, oldest first). RLS default-deny.
- The same file seeds the chargeback period itself: `chargeback.hold_days` = 180 in
  `platform_settings` (the card network chargeback window; super_admin changes it on the settings
  screen of the settings block). The closure flow reads it; a setting is data, this file only seeds
  the default.
- `npm run -s check:migrations`: 3229 -> 3261 checks, **110 -> 111 migrations, 84 -> 85 tables**.

## 099.2 - The lifecycle service (`services/kyc/account-lifecycle.ts`)

- Constants: `MERCHANT_ACCOUNT_EVENTS_TABLE`, the event vocabulary, `SUSPENSION_REASONS`,
  `ACCOUNT_MANAGE_ROLES` (super_admin, ceo, compliance_kyc, finance_ops), table names, the
  `CLOSURE_PAYOUT_JOB` and the audit actions (`merchant_account.<event>`,
  `merchant_account.read_by_office`, `merchant_account.closure_payout_requested`).
- The current state is derived from the latest state-bearing event (`card_tokens_deleted` does not
  change it); a company with no events is `active`.
- `suspendMerchant` (office roles): requires active, records `suspended`, then sets every live owner
  user of the company to `suspended` with one conditional update per user (id + company + current
  status + version) and counts the movers from a re-read - a PostgREST update that matches no row
  answers success with zero rows, so the count comes from the read, not the write. `0003`'s status
  column is what `lib/auth/session.ts` reads on every request, so the lock is real from the next
  request on.
- `requestReactivation` (owner): requires `suspended` with no request pending and a submission in the
  review pipeline (submitted / in_review / approved - the normal STEP 087 flow is the upload path),
  records `reactivation_requested` naming it.
- `decideReactivation` (office roles): requires `reactivation_requested`, the named submission
  `approved` and none of its documents rejected; records `reactivated` and sets the owners back to
  `active`.
- `requestAccountClosure` (owner): requires active, records `closure_requested` with the note.
- `closeMerchantAccount` (office roles): requires `closure_requested` or `suspended`; resolves the
  payout destination (the named account or the company's verified one - refused otherwise); reads
  the hold terms from the merchant's risk tier (`mcc_code` -> `mcc_codes.risk_tier` ->
  `underwriting_risk_tiers.hold_days` / `extra_reserve_percent`, 0 when unassigned) and the chargeback
  period from the setting (default 180, bounds 30..365); reads the remaining balance as the credit
  sum of the `merchant_payable` ledger account's entries; records `closed` with the two instants;
  places the reserve part (`extra_reserve_percent`) of the balance as a `0043` `holds` row of reason
  `closure` with `release_due_at` = the chargeback instant; enqueues the delayed
  `merchant_account.closure_payout` job (idempotent per closure event, `delayMs` = hold period)
  carrying the remainder; sets the owners to `closed`; restricts every verified `0054` provision
  (conditional update to `restricted` with both flags off, counted from a re-read) and enqueues
  `submerchant.delete_card_tokens` per provision at once. Every write is audited.
- `runClosurePayout` (the delayed job's handler, exported for the gate): idempotent per closure
  event, writes the `0045` payout row (`requested`, destination snapshot from the verified bank,
  `is_remainder` when below the section 10 floor, `requested_by` = the closing actor) and audits.
  The approval and processing of that row belong to the finance flow of the payment STEPs.

## 099.3 - The saved card token deletion job (`services/submerchant/card-tokens.ts`)

- Section 13 line 155: when a merchant leaves, saved card tokens are deleted at once. The tokens
  live at the processor under `provider_submerchant_id`, so the provider call belongs to the adapter
  STEPs; this block owns the flow: the job `submerchant.delete_card_tokens` (payload company +
  provision, idempotency key per provision row) whose handler requires the provision to be
  `restricted` (closure is what restricts it), appends the `card_tokens_deleted` event to `0111`
  (null actor - a system event; idempotent per provision via the detail string) and audits
  `submerchant_provision.card_tokens_deleted`. Registered in `registerSubmerchantJobs` beside the
  provision and sync jobs.

## 099.4 - Routes, CSRF list, screens and copy

- Five block-owned routes under `app/api/onboarding/`: `account-suspend`,
  `account-reactivate-request` (empty body), `account-reactivate-decide`, `account-close-request`,
  `account-close` (passes `getJobRuntime()` as the service's `jobs`). All follow the house order:
  CSRF first, then the declared length, then the session, then the JSON parse, then the service. All
  five paths added to `CSRF_PROTECTED_PATHS` in `lib/security/csrf.ts`.
- Merchant screen `/onboarding/account` (page + `account-form.tsx`): the state, the suspension
  reason, the required documents, the reactivation button (enabled only when a submission is in the
  pipeline) and the closure request button; a closed account shows the payout instant, the
  chargeback hold instant and the token deletion line. Linked from the status screen's nav.
- Office queue `/onboarding/account-review` (page + `account-review-queue.tsx`): every account in an
  open state, with accept-reactivation and close-account actions per row and a suspend form (company
  id, reason, comma-separated required documents).
- `lib/i18n/strings/en.ts` gained `onboardingAccount` (merchant) and `onboardingAccountReview`
  (office) blocks, plus `onboardingStatus.accountLink`; i18n gate 1523 -> 1608 messages.
- `lib/auth/verify.ts` gate counts moved with the two new mutation files and two new SessionKeeper
  pages: browser mutation files 29 -> 31, call sites 33 -> 35, keepers 16 -> 18 (the routes themselves
  are discovered dynamically, so the CSRF list check stayed exact).

## 099.5 - The gate (`services/kyc/verify.ts`)

- The fake store learned the `merchant_account_events`, `holds`, `payouts`, `ledger_accounts`,
  `ledger_entries` and `platform_settings` reads (generic eq filters, created_at ordering with an
  insertion-order tie-break, limit, defaults), the three insert branches, a `users` update branch
  (conditional on id + company + status + version, no error on no-match like PostgREST), a `status`
  filter on the provision read and update branches, `status`/`version` defaults on the users read,
  and the extended bank account shape. `checkMigrationSet` now expects 0111 and max 111.
- `checkAccountLifecycleGate()` (3773 -> 4142 checks): vocabulary and role refusals; active read on
  a fresh company; suspend (event + reason + documents + audit + owner user suspended, second
  suspend conflicts); merchant read and office queue of the suspended account; reactivation request
  (needs a submission in review, names it, repeat conflicts, active account conflicts); decisions
  refused on a non-approved submission and on a rejected document; accepted decision (owners back
  to active, repeat conflicts); closure request; closure (schedule = 30d tier hold and 180d
  chargeback setting, reserve 10% of the 80 USD balance = 8 USD held as a `closure` hold until the
  chargeback instant, 72 USD scheduled, owner closed, provision restricted with flags off, token
  deletion queued with no delay under its idempotency key, payout job delayed to the hold end, both
  audits, double-close conflicts); the payout job writes one `0045` row and converges on re-run and
  refuses a non-closed event; the token job writes the event with a null actor, converges, refuses a
  non-restricted provision.
- `checkAccountLifecycleSources()` scans the service, the routes (CSRF once, before the session), the
  CSRF list, the migration pair and the status-screen link. `checkAccountCatalog()` /
  `checkAccountReviewCatalog()` bind each copy block to its screens, templated lines through
  `formatMessage` only.
