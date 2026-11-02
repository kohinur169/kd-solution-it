-- path: migrations/0076_reference_countries.down.sql
-- STEP 036 rollback of 0076: removes the country reference table with its seed, its indexes, its
-- triggers, its function and its policies.
--
-- `drop table` removes the rows the forward file seeded, which is the whole point of the pair: the
-- forward file creates the list, the rollback removes the list. No other table is touched, and no
-- row of another table points at a country by foreign key, because the codes on clients, payments
-- and payouts are text, so dropping this table cannot break a row that already exists.

begin;

drop table if exists public.countries;

drop function if exists public.countries_guard_state();

commit;
