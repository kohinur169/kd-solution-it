// path: docs/planning/STEP_072_SUBSTEP_BREAKDOWN.md
# STEP 072 - Sub-step breakdown

STEP 072: **CEO confirmation step for large payout release, platform fee change, reserve release and
country enable actions** (`docs/final/STEP_PLAN_250.md` lines 931-941), from
`docs/final/FEATURE_LIST.md` section 2 - "large actions such as large payout release and platform fee
change require CEO confirmation step", "confirmation of large super_admin actions" - and the approval
chain "requester, then CEO, then super_admin".

## What already exists, and what is missing

- `migrations/0095_approval_requests.sql` (STEP 070) - the whole state machine already: six statuses,
  the CEO's decision pair, the super administrator's confirmation pair, both notes, three day expiry,
  the checks that keep "approved needs both signatures" and "a decision is a pair or neither", and the
  partial unique key that stops a subject being queued twice.
- `lib/approvals/registry.ts`, `service.ts`, `runtime.ts`, `verify.ts` (STEP 070) - the four actions,
  the requester matrix, `requestApproval`, `listApprovalQueue`, `readPlatformDecisions`, and the gate.
- `app/(admin)/ceo/page.tsx` (STEP 070) - both desks, the raise form, the two summaries. It says in its
  own comment that no row carries a button yet, because the decisions were this STEP's.
- `lib/auth/step-up.ts` (STEP 053), `lib/auth/request-proof.ts` and `lib/security/csrf.ts` (STEPs
  050-057) - the fresh proof, the device proof and the CSRF guard.
- `migrations/0001_companies.sql` - `set_row_metadata()`, the trigger that owns `version` and
  `updated_at` on every update.

What was missing: the act of deciding. A queue that nobody can empty is a record, not a workflow, and
the two decision column pairs were constrained but written by nothing.

## The decisions this STEP makes

1. **A decision moves the row; it does not perform the action.** An approved row is the *authority* for
   a payout release, a reserve release, a fee change or a country switch, and each of those is moved by
   the module that owns it. Nothing in this STEP moves money or flips a country, and the handoff says so
   rather than letting a reader assume otherwise.
2. **The desk decides the verb.** The CEO's `approve` hands the request to the last signature; the super
   administrator's `approve` makes it approved; either desk may reject, and a rejection is final. One
   vocabulary of two verbs, one status table, one audit name per case.
3. **Three people rules, in the registry, used by both the service and the page.** The row is signed by
   the role that owns the desk it is on; the requester never takes the first signature; the account that
   approved as the CEO never takes the last one - even when it holds both roles. The page renders a
   button only where `signatureProblemOf` returns null, so the screen cannot offer a signature the
   service would refuse.
4. **A requester may take the last signature.** Deliberate: the property the chain protects is that no
   single person completes a large action alone, and the CEO's independent approval already stands
   between the request and the release. Section 2's own example - a fee change the super administrator
   proposes and the CEO co-decides - is exactly that shape.
5. **A lapsed request is not revived by a late signature.** A decision past `expires_at` answers
   `CONFLICT expired`; the sweep owns the status change. Otherwise a slow signature would be a way to
   reopen a window the platform had closed.
6. **Expiry is now a function, not a promise.** `expireLapsedApprovals` closes what lapsed, one audit
   entry each, idempotent, bounded, and race-safe against a signer. The *timer* that calls it belongs to
   the deployment that owns background work, and the handoff records the exact wiring.
7. **The trigger owns the counter.** The update payload never names `version`; a read-back that sees an
   unchanged counter is a conflict. This STEP also fixed STEP 071's withdrawal, which wrote the counter
   itself and therefore skipped a version on every revoke.

## The sub-steps

1. **Read the sources.** FEATURE_LIST section 2, the STEP plan lines 931-941, the STEP 070 and 071
   handoffs, `0095`, and `set_row_metadata`.
2. **Owned paths.** `migrations/` (append only), `lib/approvals/` (the module 070 opened),
   `app/api/office/` (the route 070 opened), `app/(admin)/ceo/` (the page 070 opened), and the one
   string catalog rule 1 requires.
3. **Database.** `0097_approval_decision_indexes.sql` and its rollback: the sweep index over the two
   pending statuses and the history index over the four closed ones. No table, no column - the state
   machine was 070's.
4. **Registry.** `ApprovalDecision`, `decisionRolesOf`, `signatureProblemOf`, `statusAfterDecision`,
   `decisionAuditAction`, `CLOSED_APPROVAL_STATUSES`, `ApprovalStage` with `stageLabelKey` - so a page
   never spells an office role's name.
5. **Service.** `decideApproval` and `expireLapsedApprovals`, the view extended with both signatures and
   their notes, and the queue read extended with the closed history.
6. **Route.** The `decide` action on `POST /api/office/approvals`, behind the five guards STEP 070 wrote.
7. **Screens.** Decision forms on the rows a reader may sign, the CEO's note shown to the last desk, and
   a "decided recently" section that shows the outcome of a signature already given.
8. **Proof and handoff.** The gate extended over the vocabulary, the three people rules, every refusal,
   the sweep and its race, plus the copy; then every gate in `npm run verify`, the handoff and the
   commit.
