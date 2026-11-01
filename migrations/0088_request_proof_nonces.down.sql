-- path: migrations/0088_request_proof_nonces.down.sql
-- STEP 050 rollback of 0088: removes the spent nonce table and nothing else.
--
-- The rows are single use records, not history worth keeping: a nonce that has been spent describes
-- a request whose action the audit chain already holds, and the table only exists to make the second
-- copy of that request worthless for two minutes. Dropping it re-opens nothing that is still
-- reachable - a signature captured during the gap before the rollback is stale by now.
--
-- A database that reverses this file can apply the forward file again unchanged: the table, its
-- three indexes, its trigger and its policy are the only objects it creates.

begin;

drop table if exists public.request_proof_nonces;

commit;
