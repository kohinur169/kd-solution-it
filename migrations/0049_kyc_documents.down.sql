-- path: migrations/0049_kyc_documents.down.sql
-- STEP 028 - rollback for 0049_kyc_documents.sql.
--
-- Drops the document table with its constraints, indexes, policy and two triggers, then the guard this
-- file created. It runs before the submission rollback, because every document names a submission.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.kyc_documents;

drop function if exists public.kyc_documents_guard_state();

commit;
