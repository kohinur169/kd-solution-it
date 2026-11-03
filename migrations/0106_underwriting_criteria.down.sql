-- path: migrations/0106_underwriting_criteria.down.sql
-- STEP 090 rollback of 0106: removes the underwriting criteria tables with their seeds, their
-- indexes, their triggers, their guard functions, their policies and the one policy the file added
-- to `business_profiles`.
--
-- `drop table` removes the seeded rows, which is the point of the pair: the forward file creates
-- the criteria and their defaults, the rollback returns the database to one with no criteria table
-- at all. No other table points at either table by foreign key, so dropping them cannot break a
-- row that already exists.

begin;

drop policy if exists business_profiles_underwriting_read on public.business_profiles;

drop table if exists public.underwriting_criteria;

drop table if exists public.underwriting_risk_tiers;

drop function if exists public.underwriting_criteria_guard_state();

drop function if exists public.underwriting_risk_tiers_guard_state();

commit;
