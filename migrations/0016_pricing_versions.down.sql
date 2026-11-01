-- path: migrations/0016_pricing_versions.down.sql
-- STEP 018 - rollback for 0016_pricing_versions.sql.
--
-- Drops the price list table and everything it owns: twenty constraints, four indexes, the policy
-- and the row metadata trigger. It references `companies` only, so it can run in any position among
-- this STEP's three rollbacks; tables from earlier STEPs stay untouched.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.pricing_versions;

commit;
