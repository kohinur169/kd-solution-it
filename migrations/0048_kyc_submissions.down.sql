-- path: migrations/0048_kyc_submissions.down.sql
-- STEP 028 - rollback for 0048_kyc_submissions.sql.
--
-- Drops the submission table with its constraints, indexes, policy and two triggers, then the guard
-- this file created. It runs after the document and owner rollbacks, because both point at a
-- submission.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.kyc_submissions;

drop function if exists public.kyc_submissions_guard_state();

commit;
