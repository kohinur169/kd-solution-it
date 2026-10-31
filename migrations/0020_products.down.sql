-- path: migrations/0020_products.down.sql
-- STEP 020 - rollback for 0020_products.sql.
--
-- Drops the product table and everything it owns: eleven constraints, three indexes besides the
-- primary key, the policy and the row metadata trigger. Nothing references this table yet, so it may
-- run in any order with the client and service rollbacks; STEP 021 will make this one go last among
-- the catalogue.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.products;

commit;
