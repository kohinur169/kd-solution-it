// path: docs/planning/STEP_070_SUBSTEP_BREAKDOWN.md
# STEP 070 - Sub-step breakdown

STEP 070: **CEO dashboard home with approval queues** (`docs/final/STEP_PLAN_250.md` lines 908-919),
from `docs/final/FEATURE_LIST.md` section 2 (the six office roles, the approval chain, the CEO's
duties) and section 36 (the country switch), the third STEP of the Office Dashboards and Permissions
block 068-078.

## What already exists, and what is missing

- `migrations/0004_role_assignments.sql`, `0005_office_permissions.sql` (STEPs 013-014) - the seven
  roles; `ceo` is one of the six office roles and holds no company.
- `migrations/0076_reference_countries.sql` (STEP 064) - `countries` with `is_enabled`,
  `is_sanctioned` and the constraint that a sanctioned country is never enabled.
- `migrations/0048_kyc_submissions.sql` (STEP 021) - the KYC states, where `in_review` is the state
  that waits for the final decision.
- `lib/auth/step-up.ts`, `lib/auth/request-proof.ts`, `lib/security/csrf.ts` (STEPs 050-057) - the
  device proof, the ten minute freshness window and the CSRF guard.
- `lib/auth/session-list.ts`, `lib/gateways/service.ts` (STEPs 062, 069) - the house shape of an
  office service: a role constant, `requireAnyRole`, `requireFreshReauthentication`, an audit entry
  per act, version filtered writes.
- `app/(admin)/` (STEPs 068-069) - the shell, `readOfficeActor`, `decideOfficeAccess` and
  `OFFICE_NAVIGATION`.

What was missing: the chain itself. Section 2 states it in one line and nothing in the database
recorded a request, a desk, a deadline or a signature, so there was no queue for a CEO home to show.

## The decisions this STEP makes

1. **One table for four actions.** A payout release, a reserve release, a platform fee change and the
   country switch live in four tables with four shapes; the question a home page answers - "what is
   waiting for me, in what order, for how long" - is one query over one shape. `approval_requests`
   names the subject by type and id, which `approval_requests_subject_check` pins to the action, so a
   payout release can never point at a plan.
2. **The whole state machine is in the table now, the decisions are STEP 072's.** `pending_ceo`,
   `pending_super_admin`, `approved`, `rejected`, `cancelled`, `expired` are constrained today,
   including "approved requires both signatures", because the queue has to be able to say whose desk a
   row is on before anybody can act on it. What 070 does not build is the act of deciding.
3. **The CEO is a signer and never a requester.** The requester matrix is finance operations for
   payouts and reserves, and the super administrator for the platform fee and the country switch. A
   CEO who could raise a request and then approve it would be the four-eyes rule signing its own form.
4. **The queue is for the two signers; the form is for whoever may raise.** They are different
   permissions and the service checks them separately: `finance_ops` may raise a payout release and may
   not read the queue it lands in.
5. **Three days, and expiry is a status.** A decision that needs two signatures needs to be taken
   promptly; a request nobody decides becomes `expired` rather than growing quietly, and the read
   derives "past its window" so a stale row is visible before the sweep exists.
6. **Default deny, and the service is the only door.** `0095` enables RLS and writes one default-deny
   policy, the pattern `0084` established for a request table: no browser role reads a queue of money
   decisions, and the role matrix lives beside the write in `lib/approvals/service.ts`.
7. **The home shows the two platform decisions the chain will carry.** Countries on, off and
   sanctioned, and the KYC submissions waiting for the final decision, both read as counts, because
   section 2 gives the CEO those two and a dashboard that showed only an empty queue would be
   answering a smaller question than the role has.

## The sub-steps

1. **Read the sources.** FEATURE_LIST sections 2, 36, 5 and 6, the STEP plan lines 908-919, the STEP
   069 handoff, `0084` (the request table this one is shaped after), `0076` and `0048`.
2. **Owned paths.** `migrations/` (append only), `lib/approvals/` (this STEP's module),
   `app/api/office/` (an office route), `app/(admin)/` (STEPs 068-078), the office navigation, and the
   one string catalog rule 1 requires.
3. **Database.** `0095_approval_requests.sql` and its rollback: the table, the four checks that keep
   the state machine honest, the partial unique index that stops a duplicate subject, the queue and
   requester indexes, the metadata trigger and a default-deny policy.
4. **Registry.** `lib/approvals/registry.ts`: the four actions, their subject types, the requester
   matrix, the two signer stages, the six statuses, the limits the columns impose and the money rules.
5. **Service.** `lib/approvals/service.ts`: `requestApproval`, `listApprovalQueue` and
   `readPlatformDecisions`, with the role matrix, the freshness check, the duplicate check and one
   audit entry per request.
6. **Runtime and route.** `lib/approvals/runtime.ts`, and `app/api/office/approvals/route.ts` with
   CSRF, the body bound, the session, the device proof and the parse in that order.
7. **Screens.** `app/(admin)/ceo/page.tsx` with its request form, inside the STEP 068 shell: both
   desks, the form for the roles that may raise, and the two platform summaries.
8. **Navigation.** The `ceo` entry in `OFFICE_NAVIGATION` carrying `APPROVAL_QUEUE_ROLES`, and the
   STEP 068 gate updated to six screens and to the new role assertions.
9. **Proof and handoff.** `lib/approvals/verify.ts` (326 checks over the real service and an in-memory
   PostgREST), the copy in the catalog, every gate in `npm run verify`, the handoff file and the
   commit.
