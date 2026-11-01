-- path: migrations/0080_platform_settings.down.sql
-- STEP 038 rollback of 0080: removes the platform settings table with its seed, its indexes, its
-- triggers, its guard function and its policies.
--
-- `drop table` removes the seeded `turnstile.enabled` row, which is the point of the pair: the
-- forward file creates the registry and closes the switch, the rollback returns the database to one
-- with no registry and no switch. No other table points at a setting by foreign key - a reader asks
-- for a key by name - so dropping this table cannot break a row that already exists.

begin;

drop table if exists public.platform_settings;

drop function if exists public.platform_settings_guard_state();

commit;
