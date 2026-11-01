-- path: migrations/0075_audit_chain_functions.down.sql
-- STEP 036 rollback of 0075: removes the seven chain functions in reverse order.
--
-- A function that another function calls has to go last, so the order here is the reverse of the
-- order the forward file created them in. No table and no row is touched, which is why this
-- rollback is safe to run against a database that already holds audit rows: the rows and their
-- hashes stay exactly as they were written.

begin;

drop function if exists public.audit_merkle_root(uuid, bigint, bigint);
drop function if exists public.audit_verify_chain(uuid, bigint, bigint);
drop function if exists public.audit_next_link(uuid);
drop function if exists public.audit_log_row_hash(public.audit_logs);
drop function if exists public.audit_hash_v1(uuid, bigint, timestamptz, uuid, text, text, uuid, jsonb, text);
drop function if exists public.audit_canonical_json(jsonb);
drop function if exists public.audit_genesis_hash();

commit;
