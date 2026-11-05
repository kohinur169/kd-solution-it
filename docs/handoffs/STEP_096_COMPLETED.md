// path: docs/handoffs/STEP_096_COMPLETED.md
# STEP 096 - Provisioning queue and office alert when no master account is connected: completed

Branch `arena/17762737-kd-solution-it`. This handoff and the STEP 096 code are in one commit, the
one whose message is "STEP 096: Provisioning queue and office alert when no master account is
connected" (`git log -1` on the branch shows its hash). Previous handoff:
`docs/handoffs/STEP_095_COMPLETED.md`.

## STEP

- **Number and title:** STEP 096 - Provisioning queue and office alert when no master account is
  connected (`docs/final/STEP_PLAN_250.md`, the STEP 096 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs 079-099.
  Eighteenth STEP of the block.
- **Owned paths (File Ownership Rules):** "Onboarding and KYC STEPs 079-099 own
  `app/(dashboard)/onboarding/`, `services/kyc/` and `services/submerchant/`". This STEP used
  `services/submerchant/` for the queue vocabulary and the read/acknowledge service, and the office
  screen surface the block extends: `app/(admin)/provisioning-alerts/`,
  `app/api/office/provisioning/acknowledge/`, the one entry in `components/office/navigation.ts`,
  the `officeProvisioning` block and two `office.section*` keys in `lib/i18n/strings/en.ts`, and the
  known-gap list in `scripts/verify-audit.mjs` (the gate named this STEP as the gap it closed).
- **Feature list:** section 5 line 70 - "If no master platform account is connected, provisioning
  stays queued and the office is alerted". The first half (stays queued) is STEP 095's
  `enqueueProvisioningAfterApproval` writing the `pending` row with `master_account_ref = null`;
  this STEP is the second half (the office is alerted) - the reader of
  `0054_submerchant_provisions.sql`'s `submerchant_provisions_queue_idx`, whose comment is "The
  queue the office alert reads".
- **Depends on:** STEP 095 (the queued rows and the only writer of them), STEP 029/054 (the table,
  the queue index, the attempt constraints, the default-deny policy), the auth primitives
  (`requireAnyRole`, `hasSatisfiedTwoFactor`, `readRequestActor`, the device proof and the
  fresh-reauthentication guard, `requireCsrfToken`), `audit_logs` (`0013`) as the store for the
  acknowledgement.

## Migration added, and the rollback proof

- **None.** `0054` already holds the table, the queue index, `submerchant_provisions_attempt_check`
  (which ties `attempt_count` to `attempted_at` and forbids an attempt without a master account) and
  `queue_check` (which forbids `next_attempt_at` outside `pending`). The acknowledgement
  deliberately writes **no column**: it is not a state of the provision (the row is still `pending`
  afterwards, because the merchant is still stuck), and `0054`'s state vocabulary is guarded -
  inventing an "acknowledged" state would mean editing a table this STEP does not own. The
  "a human looked at this" fact is one append-only `audit_logs` entry, which the read resolves back
  with one bounded query. `npm run -s check:migrations` passed unchanged.

## Files

- **Created:** `services/submerchant/provisioning-queue-fields.ts`,
  `services/submerchant/provisioning-queue.ts`, `app/(admin)/provisioning-alerts/page.tsx`,
  `app/(admin)/provisioning-alerts/provisioning-console.tsx`,
  `app/api/office/provisioning/acknowledge/route.ts`, `docs/handoffs/STEP_096_COMPLETED.md`.
- **Modified:** `components/office/navigation.ts` (one section entry, importing the roles constant
  it already enforces), `lib/i18n/strings/en.ts` (the `officeProvisioning` block, two
  `office.section*` keys), `scripts/verify-audit.mjs` (`096` removed from the known gaps).

## Behaviour

- **The read** (`listProvisioningQueue`): asks `PROVISIONING_ALERT_OFFICE_ROLES` (`super_admin`,
  `ceo`, `compliance_kyc`, `support` - the same four the account-unlock screen asks) and the second
  factor **before its first query**, reads the queue with the index's exact predicate
  (`status = 'pending' and deleted_at is null`, ordered by `requested_at`, capped at 100), resolves
  company names for display, and splits the rows by `provisioningWaitReasonOf`:
  - `no_master_account` - `master_account_ref` is null. Blocked on the platform; nothing will move
    it until a master account is connected. These are the alert.
  - `awaiting_provider` - a master account exists and attempts are under the ceiling of five.
    Ordinary in-flight work; shown so a stuck row can be told apart from a busy one.
  - `attempts_exhausted` - five refusals; a different conversation with the merchant.
  - `overdue` is true only for platform-caused blocks older than 24 hours, and `truncated` is true
    when the 100-row cap was hit, so the screen never implies completeness it does not have.
  - No read is scoped to one company: the office question is "which merchants are stuck across the
    platform". The safety is the role check first, the second factor, the cap, and the explicit
    column list (`provider_submerchant_id`, `action_required_detail` and `rejection_reason` are
    deliberately not selected).
- **The acknowledgement** (`acknowledgeProvisioningAlert`): the same two guards, then the row is
  read by id (404 if unknown, `CONFLICT` if it has left the queue), and one `audit_logs` entry is
  appended under `submerchant_provision.alert_acknowledged` with the note and `resolved: false`
  - a "seen" fact, never readable later as "fixed". Two officers acknowledging at once produce two
  entries rather than a write conflict: the trail is append-only and a duplicate is harmless, and
  the alternative would be a column on a table this STEP does not own.
- **The screen** (`/provisioning-alerts`, in the office navigation under the same four roles): the
  header states the blocked/overdue/in-flight counts and the read instant; the blocked list is a
  card per row with the reason, the provider, the mode, the attempts, how long somebody has waited
  and whether an officer has seen it, each with one action; the in-flight list is a read-only
  table. The three refusals are told apart: signed out, forbidden, and the queue not readable
  (which must not look like an empty queue). The acknowledgement form posts through the route with
  the CSRF token, the device proof and the fresh reauthentication; refusals are told apart the way
  the unlock screen tells them apart (401, 403 with/without `reauth_required`, 409/404, 422, 429).
- **The route** (`POST /api/office/provisioning/acknowledge`): a boundary only - the CSRF check
  first, a 4 KiB body ceiling, the actor from the session cookie, the device proof, the fresh
  reauthentication, the shape of two fields, one service call. Its answer carries the provision id
  and the instant and nothing else, and the log line carries ids but not the note.

## Security verification

Checked by `scripts/verify-audit.mjs` (the cross-cutting gate) plus the focused assertions below;
the gate's known-gap list no longer names this STEP, and `npm run verify` is green end to end.

1. **Validation** - the note is a trimmed string of 1..280 characters (422 `note/length` otherwise),
   the provision id is 32..64 characters (422 `id/invalid_format`), the body is 4 KiB at most
   (413), and the JSON parse failure refuses before any query.
2. **RLS** - the office read goes through the same PostgREST credential every office read uses, and
   `0054`'s policy is default-deny: no other role's credential can read the queue, and there is no
   merchant-facing path to `listProvisioningQueue` or its route.
3. **Audit entry** - the only mutation this STEP performs is the acknowledgement, and it appends
   `submerchant_provision.alert_acknowledged` before it returns; the entry names the actor, the
   company, the provision and the note, and `resolved: false` keeps it from being read as a fix.
4. **Permission** - role from the session (never the body), the same four roles as the unlock
   screen, asked before the first query in both the read and the write; the navigation imports the
   same constant, so the sidebar cannot offer the screen its service would refuse.
5. **Second factor** - `hasSatisfiedTwoFactor` in both services: a support account that has not
   proved its second factor sees the refusal, not the queue; the route additionally requires a
   trusted device and a fresh reauthentication for the write, the same three the unlock route asks.
6. **No client data in logs** - the route's log line carries the provision id and the actor id only;
   the note and the company name are never logged.

## Gates

- `npm run verify`: all gates green, exit 0, with this file present.
- The cross-cutting gate: **2819 checks** (2784 before this STEP), the known gaps now name only
  `116`.
- The structure gate: **17 directories, 14 root files, 464 source files** (459 before; the five new
  files are the two services, the page, the console and the route).
- The i18n gate: **2365 messages, 260 placeholders** (the `officeProvisioning` block and the two
  `office.section*` keys).
- `tsc --noEmit`, `eslint` on every touched file, and the production build all clean; the build
  lists `/provisioning-alerts`.

## What the next STEP should know

- The queue read and the acknowledgement are the only two functions the screen needs; a later STEP
  that changes `0054`'s states must keep `PROVISIONING_QUEUE_STATUS` honest with the index's
  predicate.
- The acknowledgement mark is read back from `audit_logs` (`submerchant_provision.alert_acknowledged`
  under entity `submerchant_provision`), newest per row; there is no `acknowledged_at` column, and
  adding one would require deciding what it means to a row that is still `pending`.
- The office roles for the alert are the four of `PROVISIONING_ALERT_OFFICE_ROLES`; changing them
  changes the screen, the route and the navigation at once, because all three import the constant.
