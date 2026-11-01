-- path: migrations/0067_processor_bills.down.sql
-- STEP 032 - the rollback of the processor bills table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.processor_bills;

drop function if exists public.processor_bills_guard_state();

commit;
