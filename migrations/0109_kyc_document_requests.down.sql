-- path: migrations/0109_kyc_document_requests.down.sql
-- STEP 097 rollback of 0109: removes the document request table with its indexes, its triggers,
-- its guard function and its policies.
--
-- `drop table` removes every request row, which is the point of the pair: the forward file creates
-- the provider's ask, the rollback returns the database to one with no request table. No other
-- table points at it by foreign key (the link runs the other way, `fulfilled_by` -> `kyc_documents`),
-- so dropping it cannot break a row that exists.

begin;

drop table if exists public.kyc_document_requests;

drop function if exists public.kyc_document_requests_guard_state();

commit;
