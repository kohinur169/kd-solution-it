-- path: migrations/0013_audit_logs.down.sql
-- STEP 017 - rollback for 0013_audit_logs.sql.
--
-- Drops the audit table and everything it owns: nineteen constraints, seven indexes, the policy and
-- both guard triggers with the table, then the two guard functions that were created for it. No
-- earlier table is touched: the log references `companies`, `users` and `sessions`, it never owns
-- them.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.audit_logs;

drop function if exists public.audit_logs_guard_chain();
drop function if exists public.audit_logs_reject_mutation();

commit;
