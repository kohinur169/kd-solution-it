-- path: migrations/0107_merchant_transaction_limits.down.sql
-- STEP 091 rollback of 0107: removes the merchant limit table with its index, its triggers, its
-- guard function and its policies.
--
-- `drop table` removes every merchant's limit row, which is the point of the pair: the forward file
-- creates the per-merchant limit state, the rollback returns the database to one with no such table.
-- No other table points at it by foreign key, so dropping it cannot break a row that exists.

begin;

drop table if exists public.merchant_transaction_limits;

drop function if exists public.merchant_transaction_limits_guard_state();

commit;
