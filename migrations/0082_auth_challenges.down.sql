-- path: migrations/0082_auth_challenges.down.sql
-- STEP 042 rollback of 0082: removes the pending challenge table and nothing else.
--
-- The table holds no history worth keeping: it is the waiting room between a password and a
-- session, and a challenge that a rollback destroys was either already spent or about to expire.
-- The trigger goes with the table; the function it calls belongs to `0001` and stays.
--
-- A database that reverses this file can apply the forward file again unchanged, because the only
-- objects it creates are the table, its two indexes, its trigger and its policy.

begin;

drop table if exists public.auth_challenges;

commit;
