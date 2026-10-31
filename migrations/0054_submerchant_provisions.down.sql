-- path: migrations/0054_submerchant_provisions.down.sql
-- STEP 029 - rollback for 0054_submerchant_provisions.sql.
--
-- Drops the provisioning table with its constraints, indexes, policy and five triggers, then the
-- four guards this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.submerchant_provisions;

drop function if exists public.submerchant_provisions_guard_sync();

drop function if exists public.submerchant_provisions_guard_state();

drop function if exists public.submerchant_provisions_guard_source();

drop function if exists public.submerchant_provisions_guard_identity();

commit;
