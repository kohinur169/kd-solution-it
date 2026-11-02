-- path: migrations/0097_approval_decision_indexes.down.sql
-- STEP 072 rollback of 0097: the two indexes go, every decision stays.
--
-- Running this loses no fact. `approval_requests` keeps every request, the CEO's decision pair, the
-- super administrator's confirmation pair, the two notes and the status each row reached, so a
-- deployment that rolls STEP 072 back still answers "who signed what" - it just scans to do it. The
-- sweep and the history read, both of which this STEP's code owns, are removed in the same commit.

begin;

drop index if exists public.approval_requests_decided_idx;
drop index if exists public.approval_requests_expiry_idx;

commit;
