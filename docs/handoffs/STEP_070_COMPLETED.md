// path: docs/handoffs/STEP_070_COMPLETED.md
# STEP 070 - CEO dashboard home with approval queues: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_069_COMPLETED.md`
(commit `b780107`).

## STEP

- **Number and title:** STEP 070 - CEO dashboard home with approval queues
  (`docs/final/STEP_PLAN_250.md` lines 908-919).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. This is the third STEP of the block
  and the first one that builds a screen for a role other than the super administrator.
- **Depends on:** STEP 013 (`0004_role_assignments.sql`, the seven roles), STEP 014
  (`0005_office_permissions.sql`), STEP 021 (`0048_kyc_submissions.sql`), STEP 050 (the device proof),
  STEP 052 (trusted devices), STEP 053 (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`),
  STEP 057 (`lib/security/csrf.ts`), STEP 063 (the audit trail), STEP 064
  (`0076_reference_countries.sql`) and STEP 068 (the shell, `readOfficeActor`, `OFFICE_NAVIGATION`).

## Files

- **Created:** `migrations/0095_approval_requests.sql`, `migrations/0095_approval_requests.down.sql`,
  `lib/approvals/registry.ts`, `lib/approvals/service.ts`, `lib/approvals/runtime.ts`,
  `lib/approvals/verify.ts`, `app/api/office/approvals/route.ts`, `app/(admin)/ceo/page.tsx`,
  `app/(admin)/ceo/approval-request-form.tsx`, `docs/planning/STEP_070_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_070_COMPLETED.md`.
- **Modified:** `components/office/navigation.ts` (one entry and the role constant it imports),
  `components/office/verify.ts` (six screens instead of five, the new orders and the four-section
  `ceo` view), `app/(admin)/README.md` (the address table), `lib/i18n/strings/en.ts` (one block,
  53 messages, plus the two `office.sectionCeo` keys), `lib/auth/request-proof.ts` (one endpoint on
  `SENSITIVE_ENDPOINTS`), `lib/security/csrf.ts` (one path on `CSRF_PROTECTED_PATHS`),
  `lib/auth/verify.ts` (two baselines: twelve browser files that mutate, fourteen call sites).
- **Owned paths touched:** `app/(admin)/` (STEPs 068-078), `app/api/office/` (an office route),
  `migrations/` (append only), `lib/approvals/` (this STEP's module), the two office components the
  navigation owns, and the one string catalog rule 1 requires. Nothing else.

## Database

- **New file:** `0095_approval_requests.sql` and its rollback, the ninety-fifth migration, contiguous
  after `0094_seed_payment_providers.sql`.
- **Table:** `public.approval_requests` - one row per request, with the subject named by a type and an
  identifier instead of four tables with four shapes: `action_type`, `subject_type`, `subject_id`,
  `subject_label` (1 to 160 characters, trimmed), `amount_minor` and `currency`, `request_note` (10 to
  1000 characters, trimmed), `requested_by`, `requested_by_role`, `requested_at`, `expires_at`,
  `status`, the CEO decision pair and note, the super administrator confirmation pair and note, plus
  the house columns (`created_at`, `updated_at`, `deleted_at`, `version`).
- **Checks:** `action_type` in the four actions; `subject_type` pinned per action, so a payout release
  can never point at a plan; label and note lengths; money as a pair that is never zero and a currency
  as three capitals; `requested_by_role` in the six office roles; `expires_at > requested_at`; the six
  statuses; "a decision is a pair or neither" in both directions; `pending_super_admin` without a CEO
  signature refused and `approved` without both refused.
- **Indexes:** `approval_requests_queue_idx` (status, expires_at), `approval_requests_requester_idx`
  (requested_by), and the partial unique `approval_requests_live_key` on (action_type, subject_id)
  where the row is still pending, so the same decision cannot be queued twice.
- **Policy and trigger:** RLS enabled with one default-deny policy (`approval_requests_default_deny`),
  the pattern `0084` set for a request table, and `set_row_metadata` for `updated_at` and `version`.
- **Rollback:** `0095_approval_requests.down.sql` drops, in order, the default-deny policy, the
  metadata trigger, the three indexes and the table, every statement with an `if exists` guard, and
  touches nothing another migration owns - the four subjects the rows pointed at are other files'
  rows, and the decisions already taken live in the audit chain, which no rollback touches.

## Environment

- No new variable. The route reads the session and the device proof through what STEPs 050-057 built.

## Packages

- **No dependency added, removed or changed.** `package.json` is untouched.
- **Package request for the owner (open):** add to `scripts` in `package.json`:
  `"check:approvals": "node lib/approvals/verify.ts"`, so the STEP 070 gate joins `npm run verify`
  beside `check:auth`, `check:security`, `check:office` and `check:gateways`. Until then the gate is
  run by hand: `node lib/approvals/verify.ts`.

## What was built

- **`lib/approvals/registry.ts`** - the vocabulary in one place: four action types, their four subject
  types, the requester matrix (`payout_release` and `reserve_release` for finance operations and the
  super administrator, `platform_fee_change` and `country_enable` for the super administrator alone),
  `APPROVAL_QUEUE_ROLES` (the CEO and the super administrator - the two desks), `APPROVAL_CEO_ROLES`,
  `APPROVAL_FINAL_ROLES`, the six statuses plus `PENDING_APPROVAL_STATUSES`, `stageOf`, the four
  limits (160, 10, 1000 characters, `APPROVAL_EXPIRY_MS` of three days, `APPROVAL_QUEUE_LIMIT` of 100
  rows, `APPROVAL_AMOUNT_MAXIMUM_MINOR`), `amountProblemOf` returning one of
  `amount_currency_pair | amount_invalid | amount_too_large | currency_invalid`, and
  `approvalActionLabelKey` typing each action's copy path so a new action cannot compile without copy.
- **`lib/approvals/service.ts`** - `requestApproval`, `listApprovalQueue`, `readPlatformDecisions`,
  `requesterRoleFor`, `mayRequestAnything`, `normalizeCurrency`. `requestApproval` checks, in order:
  the action is one of the four, the caller's roles may raise that action, the second factor is fresh,
  the subject identifier and label and note and money are valid, no live request already covers the
  subject, and only then inserts. `listApprovalQueue` requires `APPROVAL_QUEUE_ROLES`, reads the live
  rows newest first up to the cap, and marks each with its stage and whether it is past `expires_at`
  from the runtime clock. `readPlatformDecisions` returns the country counts (enabled, disabled,
  sanctioned) and the number of KYC submissions in `in_review`.
- **`lib/approvals/runtime.ts`** - `getApprovalRuntime()`, the STEP 056 `getAuthRuntime()` projected to
  `{ store, audit, now }`, so the service never builds a client and never reads a clock itself.
- **`app/api/office/approvals/route.ts`** - one POST, one action (`request`), no GET. CSRF first, a
  4 KiB content-length ceiling second, the session through `readRequestActor` third, the device proof
  through `verifySensitiveRequest` plus `requireTrustedDevice` fourth, `JSON.parse` last, and a 201
  with `no-store` and an `ApprovalRequestView` body.
- **`app/(admin)/ceo/page.tsx`** - the CEO home, inside the STEP 068 shell and without its own
  `<main>`: the desk the caller is at in words, the two queue sections (`pending_ceo` - "waiting for
  you", `pending_super_admin` - "waiting for the final signature"), each row showing the action, the
  subject, the money when there is money, the requester, when it was raised and when it lapses, with a
  `expired` badge once past its window; the raise form, rendered only for the roles that may raise
  something; and the two counts the chain carries (countries on/off/sanctioned, KYC in review). A
  signed-out visitor, a role that may not be here and an unreadable store each get their own sentence
  rather than an empty page.
- **`app/(admin)/ceo/approval-request-form.tsx`** - the client form: action select, subject identifier,
  subject label, amount and currency, note; signs the body with `deviceProofHeaders("POST",
  "/api/office/approvals", body)` and sends `csrfHeaders()`; maps the route's refusals to copy
  (`duplicateRequest`, `amountPairProblem`, `amountInvalid`, `unknownAction`, `reauthRequired`,
  `forbidden`, `unavailable`, `failed`) instead of printing a status code.
- **`components/office/navigation.ts`** - the `ceo` entry between `dashboard` and `gateways`, carrying
  `APPROVAL_QUEUE_ROLES`, so the sidebar and the service cannot disagree about who may enter.
- **`lib/i18n/strings/en.ts`** - the `officeApprovals` block (53 messages) and `office.sectionCeo` with
  its description, so every sentence the screen shows is in the catalog.
- **`lib/approvals/verify.ts`** - the STEP gate: the registry's four actions, four subject types, six
  statuses, the requester matrix, `stageOf`, the limits and the money rules; the migration text
  (table, four checks, the partial unique index, the default-deny policy, the trigger); the service
  driven over an in-memory PostgREST - a finance operations payout release accepted, a support request
  refused, the CEO refused as a requester, a fee change accepted only for the super administrator, the
  duplicate refused with `duplicate` as the rule, a stale second factor refused, the amount and
  currency rules, the queue read by both desks and refused to finance operations, the expiry mark, the
  cap, and the two summaries; the route and both screens' source contracts; and 53 copy paths.

## Behaviour Proof (acceptance checklist)

- **A CEO who signs in sees a home instead of the dashboard:** `/ceo` is in the navigation for
  `ceo` and `super_admin`, and `decideOfficeAccess` decides it from the same role list the service
  uses (the office gate asserts the six screens and each role's order).
- **The queue says whose desk a row is on:** `stageOf("pending_ceo")` is `ceo`,
  `stageOf("pending_super_admin")` is `super_admin`, and the closed four are `closed`; the page splits
  the rows on exactly that and no other status is rendered as waiting.
- **The finance team can raise a payout release and cannot read the queue:** `requestApproval` accepts
  `finance_ops` for `payout_release`, and `listApprovalQueue` refuses the same roles with
  `PERMISSION_DENIED` (both exercised in the gate).
- **A CEO cannot raise what a CEO then approves:** `canRequestApproval("ceo", "payout_release")` is
  false and the gate asserts the refusal through the service.
- **Nobody raises the same decision twice:** a second live request for the same (action, subject) is
  refused with `CONFLICT` and the rule `duplicate`, before the insert, and the partial unique index
  refuses it again at the database.
- **A stale second factor cannot raise a request:** without a fresh proof the service answers
  `PERMISSION_DENIED`, which the form renders as "prove the second factor again".
- **Money is either a pair or absent:** amount without currency and currency without amount are both
  refused with `amount_currency_pair`; a zero, a negative, a float and an amount past the ceiling are
  refused with `amount_invalid` or `amount_too_large`; a lowercase or four-letter currency is refused
  with `currency_invalid`.
- **A request that nobody decides is visible as lapsed:** the row keeps the `pending_ceo` status, and
  the read marks it with `expired` once the runtime clock passes `expires_at`, which the page renders
  as a badge rather than hiding.
- **The home answers the two other questions the role has:** the country counts (enabled, disabled,
  sanctioned) and the KYC submissions in review are read in the same snapshot, and each carries its own
  sentence explaining what happens next.
- **Nothing is decided from this screen:** STEP 072 owns the decisions; no button on the page writes a
  signature, and the handoff records the seam instead of implying it works.
- **Desktop and mobile:** the queue rows and the form are built from the STEP 068 shell's primitives
  (no fixed width, no `<main>`, no page-level horizontal overflow), and the class contracts are the
  ones `components/office/verify.ts` already asserts.

## Security proof

- **Authentication:** the page reads `readOfficeActor()` and the route reads `readRequestActor()`; an
  unknown or missing session never reaches the service.
- **Authorisation:** two separate matrices, checked where the action happens - `requesterRolesOf` for
  raising, `APPROVAL_QUEUE_ROLES` for reading the queue, both from the registry the navigation
  imports.
- **Fresh second factor:** `verifySensitiveRequest` plus `requireTrustedDevice` before the body is
  parsed, and `requireFreshReauthentication` inside the service, so a route edited to skip the check
  still cannot write.
- **CSRF:** `/api/office/approvals` is on `CSRF_PROTECTED_PATHS` and the form sends `csrfHeaders()`;
  the endpoint is on `SENSITIVE_ENDPOINTS` so the device proof covers it.
- **Input validation:** every field is length-checked and trimmed against the same constants the
  column checks use, money is validated as a pair, the currency is normalized to capitals and the
  subject is a UUID; the body is capped at 4 KiB before parsing.
- **Row level security:** default deny - no browser role may read or write `approval_requests`;
  every access is through the service role, so a stolen user token cannot enumerate a queue of money
  decisions.
- **Audit:** one `approval.requested` entry per request with
  `{ action_type, subject_type, subject_id, subject_label, amount_minor, currency, expires_at,
  note_length }` - the note text itself is never copied into the trail, only its length, so sensitive
  reasoning does not leak into an immutable log.
- **No secret is echoed:** the queue view carries the subject label and the money, never a key, a token
  or a person's full record.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `npm run build` - compiled; `/ceo` and `/api/office/approvals` are dynamic.
- `node lib/approvals/verify.ts` - **approval gate passed: 326 checks, 4 actions, 6 statuses,
  2 signer roles**.
- `node lib/auth/verify.ts` - **2405 checks** (was 2395: twelve browser files that mutate, fourteen
  call sites, seventeen POST routes, sixteen CSRF paths).
- `node lib/security/verify.ts` - **2376 checks**.
- `node lib/gateways/verify.ts` - **467 checks**.
- `node components/office/verify.ts` - **427 checks, 6 office roles, 6 screens, 7 roles decided**
  (was 413 / 5 screens).
- `npm run check:structure` - 17 directories, 14 root files, **200 source files** (was 193).
- `npm run check:migrations` - **2818 checks, 95 migrations, 76 tables** (was 2786 / 94 / 75), every
  forward file transactional and default deny.
- `npm run check:i18n` - **460 messages, 24 placeholders, 1 locale** (was 405 / 20).
- `npm run check:shell` - 282 checks, 69 files.
- `npm run verify` - the whole chain above, green.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders), `/ceo`,
  `/dashboard` and `/admin` each answered `307` to `/signin` for an anonymous visitor, and
  `POST /api/office/approvals` answered `422 VALIDATION_FAILED` with the CSRF field on the details
  list, which is the guard refusing the call before the body is read.

## Known limitation, recorded rather than hidden

- **The decisions are STEP 072's.** `approval_requests` already carries the two signatures, the
  statuses and the constraints that keep them honest, and `stageOf` already names the desk, but this
  STEP writes no signature: the queue shows what waits and nothing on the screen decides it.
- **Expiry is derived, not swept.** The read marks a lapsed row, and the status stays `pending_ceo`
  until the job that moves it to `expired` exists (STEP 072's, with the rest of the chain).
- **A `PERMISSION_DENIED` refusal arrives without its details.** The platform error envelope keeps
  `details` only for `VALIDATION_FAILED`, so a step-up refusal reaches the form as a bare `403`. The
  form therefore treats `403` and `reauthRequired` the same way - "prove the second factor again" -
  which is correct for every path the service can take today, and is the same limitation STEP 069
  recorded.

## Deployment checks a person runs

1. Apply `0095_approval_requests.sql` and confirm `select count(*) from pg_policies where tablename =
   'approval_requests'` is one, default deny.
2. Confirm `approval_requests_live_key` exists and is partial
   (`where status in ('pending_ceo','pending_super_admin')`).
3. Sign in as the CEO: `/ceo` opens with two empty queues and the two platform counts.
4. Sign in as finance operations: `/ceo` refuses, and the dashboard still opens the screens that role
   holds.
5. Sign in as the super administrator: `/ceo` opens and the raise form offers the fee change and the
   country switch; a payout release is not offered, because the matrix says the finance team raises
   that one.
6. Raise a fee change, then raise it again: the second attempt is refused as a duplicate rather than
   queued twice.
7. Read `audit_logs` and confirm one `approval.requested` row whose payload holds the note's length
   and not the note.

## Next

STEP 071 - delegation. Its sub-step breakdown belongs in
`docs/planning/STEP_071_SUBSTEP_BREAKDOWN.md`, and the seam is fixed: the delegation table grants a
role's powers for a window to another person, and both `lib/approvals/service.ts` and the office
navigation must read the delegated roles rather than the assigned ones when it lands.
