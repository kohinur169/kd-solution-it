-- path: migrations/0084_two_factor_reset_requests.down.sql
-- STEP 044 rollback of 0084: removes the reset request table and nothing else.
--
-- The rows are process records rather than history worth preserving: an approved request describes a
-- reset that the audit chain already holds as `user.two_factor_reset`, and a pending one describes
-- nothing that happened. `users` is untouched by this file - a rollback must not restore a second
-- factor that was cleared, because the encrypted secret was never kept anywhere to restore it from.
--
-- A database that reverses this file can apply the forward file again unchanged: the table, its
-- three indexes, its trigger and its policy are the only objects it creates.

begin;

drop table if exists public.two_factor_reset_requests;

commit;
