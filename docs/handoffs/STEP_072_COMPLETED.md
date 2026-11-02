// path: docs/handoffs/STEP_072_COMPLETED.md
# STEP 072 - CEO confirmation step for large payout release, platform fee change, reserve release and country enable: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_071_COMPLETED.md`.

## STEP

- **Number and title:** STEP 072 - CEO confirmation step for large payout release, platform fee change,
  reserve release and country enable actions (`docs/final/STEP_PLAN_250.md` lines 931-941).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Fifth STEP of the block, and the one
  that turns the queue of 070 into a chain nobody can leave half-finished.
- **Depends on:** STEP 011 (the job runtime, and why a timer is *not* here), STEP 050 (the device proof),
  STEP 052 (trusted devices), STEP 053 (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`),
  STEP 057 (`lib/security/csrf.ts`), STEP 063 (the audit trail), STEP 070 (the queue, the table and the
  route), STEP 071 (the office screens pattern) and `set_row_metadata()` from `0001 companies`.

## Files

- **Created:** `migrations/0097_approval_decision_indexes.sql`,
  `migrations/0097_approval_decision_indexes.down.sql`,
  `app/(admin)/ceo/approval-decision-form.tsx`, `docs/planning/STEP_072_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_072_COMPLETED.md`.
- **Modified:** `lib/approvals/registry.ts` (the decision vocabulary, the three people rules, the audit
  names, `ApprovalStage` and its label key), `lib/approvals/service.ts` (`decideApproval`,
  `expireLapsedApprovals`, the view's two signatures, the queue's `recent` list),
  `app/api/office/approvals/route.ts` (the `decide` action), `app/(admin)/ceo/page.tsx` (the forms, the
  decision record and the history), `lib/i18n/strings/en.ts` (27 messages), `app/(admin)/README.md`,
  `lib/auth/verify.ts` (two baselines: fourteen browser files, sixteen call sites),
  **and one defect fix outside the STEP**: `lib/permissions/service.ts` no longer writes `version` on a
  withdrawal, and `lib/permissions/verify.ts`'s in-memory store now models the trigger that does.
- **Owned paths touched:** `migrations/` (append only), `lib/approvals/` (070's module),
  `app/api/office/` (070's route), `app/(admin)/ceo/` (070's page), and the one string catalog rule 1
  requires. The `lib/permissions` edit is the defect fix recorded below, not a new feature there.

## Database

- **New file:** `0097_approval_decision_indexes.sql` and its rollback, the ninety-seventh migration,
  contiguous after `0096_office_permission_revoked_by.sql`.
- **Indexes, no table and no column.** `0095` already carried the state machine, so this STEP adds only
  the two reads the decision step makes:
  - `approval_requests_expiry_idx` on `(expires_at)` where `deleted_at is null and status in
    ('pending_ceo', 'pending_super_admin')` - the sweep's query;
  - `approval_requests_decided_idx` on `(updated_at desc)` where `deleted_at is null and status in
    ('approved', 'rejected', 'expired', 'cancelled')` - the history the CEO home shows.
- **Why `updated_at` for the history:** `set_row_metadata()` writes it on every update, so it already
  holds the instant a row closed. A second column would be a second truth.
- **Rollback:** `0097_approval_decision_indexes.down.sql` drops the two indexes and nothing else; every
  request, signature and audit entry survives, and only the speed is lost.

## Environment

- No new variable.

## Packages

- **No dependency added, removed or changed.** `package.json` is untouched.
- **Package requests still open for the owner:** `check:approvals` (`node lib/approvals/verify.ts`),
  `check:permissions`, `check:office`, `check:auth`, `check:security`, `check:gateways`.

## What was built

- **`lib/approvals/registry.ts`** - `ApprovalDecision` (two verbs), `decisionRolesOf`,
  `statusAfterDecision` (approve at the first desk hands the row on, approve last approves it),
  `decisionAuditAction` (`approval.ceo_approved`, `approval.ceo_rejected`, `approval.confirmed`,
  `approval.final_rejected`), `CLOSED_APPROVAL_STATUSES`, `APPROVAL_HISTORY_LIMIT`, `ApprovalStage` with
  `stageLabelKey`, and `signatureProblemOf` - the three people rules in one function that both the
  service and the page call.
- **`lib/approvals/service.ts`** - `decideApproval`: the verb, the row, the desk, the two people rules,
  the fresh second factor, the clock, the note (a rejection needs one, an approval may carry one), then
  a conditional update on the version and status read, a read-back, the audit entry and the updated
  view. `expireLapsedApprovals`: the bounded, idempotent sweep that moves lapsed pending rows to
  `expired`, one `approval.expired` entry each, counting what it skipped when a signer moved first. The
  view now carries both signatures (who, when, what they wrote) and the queue carries `recent`.
- **`app/api/office/approvals/route.ts`** - the `decide` action beside `request`, behind the same five
  guards: CSRF, the 4 KiB ceiling, the session, the device proof over the exact bytes, then the parse.
  `request` still answers 201 because it creates; `decide` answers 200 because it settles.
- **`app/(admin)/ceo/approval-decision-form.tsx`** - one note field and two buttons per row, signing the
  body with `deviceProofHeaders` and `csrfHeaders`, mapping each refusal's rule to a sentence (not
  pending, lapsed, the requester's own signature, the first signer's, a missing reason, a lost race).
- **`app/(admin)/ceo/page.tsx`** - a form on exactly the rows the reader may sign, the CEO's note shown
  at the last desk, both notes on a closed row, and a "decided recently" section with each closed status
  named in words. The page writes no office role name: it takes `ApprovalStage` and asks the registry.
- **`lib/i18n/strings/en.ts`** - 27 messages for the decisions, the four closed statuses and the six
  refusals the form can show.

## Behaviour Proof (acceptance checklist)

- **The chain can be walked end to end.** The gate raises a request, approves it as the CEO, confirms it
  as the super administrator, and asserts the status, the two signatures and the three audit entries in
  order.
- **The desks are separate.** `finance_ops` cannot sign; the super administrator cannot take the first
  signature; the CEO's role cannot take the last one. All three are refused with `PERMISSION_DENIED`.
- **The requester never signs first.** A request raised by the account that tries to approve it answers
  `requester_signature`.
- **The first signer never signs last.** An account holding both roles that approved as the CEO is
  refused the confirmation with `signer_signature` - one person cannot take both signatures.
- **A requester may take the last signature**, and the gate asserts it: the independent CEO approval is
  what the chain protects, not the number of accounts.
- **A rejection is final and needs a reason.** A note shorter than ten characters answers
  `invalid_length`; a rejection writes `rejected`, keeps the note and appends `approval.ceo_rejected` or
  `approval.final_rejected`.
- **A decided request is not decided twice.** The second attempt answers `CONFLICT not_pending`.
- **A lapsed request is not revived.** A signature past `expires_at` answers `CONFLICT expired`, and the
  sweep is what closes the row.
- **The sweep closes only what lapsed.** Two lapsed rows close, one live row is untouched, each lapse is
  audited once, a second sweep finds nothing, a limit bounds one sweep, and a row that moved under the
  sweep is counted as a skip rather than overwritten.
- **A signature that lost the race is not a success.** If the update matched no row and the row is
  unchanged, the answer is `CONFLICT changed`.
- **The history tells the truth.** After the confirmation the row leaves both desks and appears in
  `recent` as approved, with the last signer named.
- **Nothing outside the chain happens.** No payment moves, no country flips: an approved row is the
  authority for one, and the modules that own those actions arrive in later STEPs.
- **Desktop and mobile:** the forms are single-column blocks inside the row cards, inside the STEP 068
  shell - no fixed width, no `<main>`, no page-level horizontal overflow.

## Security proof

- **Authentication:** the route reads `readRequestActor()`; the page reads `readOfficeActor()`.
- **Authorisation:** the desk's role list comes from the registry and is checked in `decideApproval`
  before anything is written; the page only renders a form where the same function returns null.
- **Fresh second factor:** `requireFreshReauthentication` inside the service, and the route's device
  proof plus trusted-device check before the body is parsed.
- **CSRF:** the endpoint is already on `CSRF_PROTECTED_PATHS` and the new form sends `csrfHeaders()`.
- **Input validation:** the verb, the id, the note's length and the actor's identity are all checked
  against the same constants the columns use; the body stays capped at 4 KiB.
- **Optimistic locking:** every decision is `where id = ... and version = ... and status = ...`, with a
  read-back, so two signers and the sweep cannot both win. The payload never writes `version`:
  `set_row_metadata()` owns it.
- **Row level security:** unchanged - `approval_requests` is default deny since `0095`, and every read
  and write goes through the service role.
- **Audit:** one entry per signature, with the action, the subject, the decision, the stage, both
  statuses and the note's length - never the note's text, because a note about money is as private as
  the money.

## Defect found and fixed in this STEP

`lib/permissions/service.ts` (STEP 071) wrote `version: row.version + 1` into its withdrawal update while
`set_row_metadata()` also increments the counter in the trigger. In a real deployment every withdrawal
would have skipped a version number, and any read that compared `version + 1` exactly would have seen a
conflict. The payload no longer names `version`, the permissions gate's in-memory store now models the
trigger, and this STEP's own writes follow the same rule. The migration of `0096` and the guarantees of
071 are unaffected: a withdrawal still filters on the version it read.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node lib/approvals/verify.ts` - **approval gate passed: 536 checks, 4 actions, 6 statuses,
  2 signer roles** (was 326).
- `node lib/permissions/verify.ts` - **425 checks, 16 permissions, 13 delegable, 3 reserved**.
- `node lib/auth/verify.ts` - **2415 checks** (fourteen browser files that mutate, sixteen call sites).
- `node lib/security/verify.ts` - **2376 checks**.
- `node lib/gateways/verify.ts` - **467 checks**.
- `node components/office/verify.ts` - **441 checks, 6 office roles, 7 screens, 7 roles decided**.
- `npm run check:structure` - 17 directories, 14 root files, **208 source files** (was 207).
- `npm run check:migrations` - **2859 checks, 97 migrations, 76 tables** (was 2839 / 96 / 76).
- `npm run check:i18n` - **582 messages, 26 placeholders, 1 locale** (was 555 / 26).
- `npm run check:shell` - 300 checks, 73 files.
- `npm run check:env` - `.env.example` matches 16 manifest variables.
- `npm run verify` - the whole chain above, green.
- `npm run build` - compiles; `/ceo` stays dynamic.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders), `/ceo` answered
  `307` to `/signin` for an anonymous visitor, and `POST /api/office/approvals` with
  `{"action":"decide"}` answered `422 VALIDATION_FAILED` with the CSRF field on the details list - the
  guard refusing before the body is read.

## Known limitation, recorded rather than hidden

- **The sweep has no timer.** `expireLapsedApprovals` is written, bounded, idempotent, race-safe and
  gated, but nothing calls it on a schedule. The job runtime of STEP 011 has no database store yet, so a
  schedule wired here would be a timer over memory that finds nothing and looks healthy. The function's
  shape is the contract: `expireLapsedApprovals({ limit?: number }, { store, audit, now })` returns
  `{ examined, expired, skipped, sweptAtEpochMs }`. It belongs with whatever owns background work - the
  deployment STEP or the STEP that gives `lib/jobs` a durable store - and until it runs, a lapsed request
  is still visible as lapsed on the screen and refused as expired by every decision.
- **An approved row does not move anything.** The payout release, the reserve release, the fee change
  and the country switch are performed by the modules that own those subjects (payments, plans,
  countries). This STEP makes the approval the authority for them; wiring each consumer is those STEPs'.
- **No amount threshold lives here.** "Large" is a fact about the subject - a payout over a ceiling, a fee
  change - and the module that raises it decides whether the chain is required. The queue decides
  whatever is queued.
- **A `PERMISSION_DENIED` refusal arrives without its details.** The envelope keeps `details` only for
  `VALIDATION_FAILED`, so a step-up refusal reaches the form as a bare `403`, which the form words as
  "prove the second factor again". Same limitation STEPs 069-071 recorded; the identity refusals this
  STEP adds are `VALIDATION_FAILED` precisely so their rules reach the screen.

## Deployment checks a person runs

1. Apply `0097_approval_decision_indexes.sql` and confirm both partial indexes exist
   (`select indexname from pg_indexes where tablename = 'approval_requests'`).
2. Raise a payout release as finance operations, then sign in as the CEO: `/ceo` shows the row with a
   note field and two buttons.
3. Approve it: the row moves to "waiting for the super administrator", `audit_logs` gains one
   `approval.ceo_approved`, and the row still carries the requester's note.
4. Sign in as the super administrator and confirm: the row leaves both desks, appears under "decided
   recently" as approved, and `audit_logs` gains `approval.confirmed`.
5. Sign in as the CEO again and try to confirm a request the same account raised (super administrators
   who also hold the CEO role): the refusal says the first signer cannot sign last.
6. Reject a fresh request with one character: the form answers that a rejection needs a reason.
7. Leave a request for three days, then confirm it is refused as lapsed and that the sweep's next run
   closes it.

## Next

STEP 073 - the country enable and disable management screen. It is the first consumer of this chain: a
country switch is a `country_enable` request whose approval is the authority for the flip, so 073 reads
an approved row rather than asking for a signature itself. The seam: `signatureProblemOf` and
`statusAfterDecision` are the two functions to call rather than re-deriving a stage; and
`expireLapsedApprovals` still needs its timer.
