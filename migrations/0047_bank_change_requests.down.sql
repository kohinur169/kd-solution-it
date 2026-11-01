-- path: migrations/0047_bank_change_requests.down.sql
-- STEP 027 - rollback for 0047_bank_change_requests.sql.
--
-- Drops the change request table with its four indexes, its two triggers and its policy, then the
-- guard this file created. It runs before the bank account rollback, because every request points at
-- an account.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.bank_change_requests;

drop function if exists public.bank_change_requests_guard_state();

commit;
