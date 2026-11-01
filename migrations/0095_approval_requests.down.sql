-- path: migrations/0095_approval_requests.down.sql
-- STEP 070 rollback of 0095: removes the approval queue table and everything that hung off it.
--
-- The rollback drops nothing that belongs to another file: the table, its two partial indexes, its
-- queue index, its metadata trigger and its default-deny policy are all this file's, and the four
-- subjects it points at (a payout, a reserve, a plan, a country) are other migrations' rows and are
-- untouched.
--
-- A rollback here means "the platform no longer keeps a queue of approvals". It does not mean the
-- decisions already taken never happened: those are in the audit chain, which no rollback touches.
-- A deployment that had rows loses them, which is why this file is run last and never on a database
-- holding a request somebody is still waiting on.

begin;

drop policy if exists approval_requests_default_deny on public.approval_requests;

drop trigger if exists approval_requests_set_row_metadata on public.approval_requests;

drop index if exists public.approval_requests_requester_idx;
drop index if exists public.approval_requests_queue_idx;
drop index if exists public.approval_requests_live_key;

drop table if exists public.approval_requests;

commit;
