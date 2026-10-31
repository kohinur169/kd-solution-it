-- path: migrations/0068_compliance_items.down.sql
-- STEP 032 - the rollback of the compliance items table: the guard function and the table, in one
-- transaction.

begin;

drop table if exists public.compliance_items;

drop function if exists public.compliance_items_guard_state();

commit;
