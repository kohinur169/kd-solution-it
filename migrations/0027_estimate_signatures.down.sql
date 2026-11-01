-- path: migrations/0027_estimate_signatures.down.sql
-- STEP 022 - rollback for 0027_estimate_signatures.sql.
--
-- Drops the signature table and everything it owns: fifteen constraints, three indexes, the policy
-- and the two guard triggers, then the two guard functions this file created. It must run before the
-- quote rollback, because the evidence points at a quote.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.estimate_signatures;

drop function if exists public.estimate_signatures_guard_append_only();
drop function if exists public.estimate_signatures_guard_decision();

commit;
