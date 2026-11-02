-- path: migrations/0097_approval_decision_indexes.sql
-- STEP 072 - the two questions the decision step asks of the queue, and the indexes they need.
--
-- STEP 070 wrote `approval_requests` with the whole state machine: two pending statuses, the CEO's
-- decision pair, the super administrator's confirmation pair, and a three day window. STEP 072 is the
-- act of deciding, and deciding adds two reads the table did not have:
--
--   - "which pending requests have run past their window", which the expiry sweep asks on a schedule.
--     Without an index it is a sequential scan of every request the platform has ever raised.
--   - "what was decided recently", which the CEO home shows beside the queue so a signer can see the
--     outcome of their own signature. It orders the closed rows by the instant they closed, which the
--     metadata trigger already keeps in `updated_at`.
--
-- Neither index carries data of its own and neither changes a constraint: a decision is still the one
-- UPDATE `approval_requests_ceo_check` and `approval_requests_super_admin_check` describe, and a
-- lapsed row is still a status rather than a deletion. The two indexes are partial, so the pending
-- rows - the small, hot set - are not mixed with the history in one structure.
--
-- The rollback drops both and nothing else: a deployment that rolls this STEP back keeps every request,
-- every signature and every audit entry, and only loses the two indexes' speed.

begin;

-- The sweep: pending rows, soonest deadline first.
create index approval_requests_expiry_idx
  on public.approval_requests (expires_at)
  where deleted_at is null and status in ('pending_ceo', 'pending_super_admin');

-- The history: closed rows, most recently changed first.
create index approval_requests_decided_idx
  on public.approval_requests (updated_at desc)
  where deleted_at is null and status in ('approved', 'rejected', 'expired', 'cancelled');

comment on index public.approval_requests_expiry_idx is
  'STEP 072: the expiry sweep reads pending requests by deadline.';

comment on index public.approval_requests_decided_idx is
  'STEP 072: the CEO home reads the closed requests by the instant they closed.';

commit;
