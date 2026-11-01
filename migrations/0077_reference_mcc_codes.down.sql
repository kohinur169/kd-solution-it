-- path: migrations/0077_reference_mcc_codes.down.sql
-- STEP 036 rollback of 0077: removes the merchant category code table with its seed, its indexes,
-- its triggers, its function and its policies.
--
-- The codes on a merchant profile are text, not a foreign key, so dropping the list cannot break a
-- row that already exists; the profile keeps the code it stored and the list is rebuilt by the
-- forward file.

begin;

drop table if exists public.mcc_codes;

drop function if exists public.mcc_codes_guard_state();

commit;
