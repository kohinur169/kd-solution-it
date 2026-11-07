-- path: migrations/0128_chargeback_actions.down.sql
-- The rollback of STEP 199.
--
-- The order is the order the forward file built things: the policies, then the triggers, then the guard
-- function, then the three indexes and the table. The table is dropped with its indexes, so the explicit
-- `drop index` statements come first to keep this file readable as the forward file read backwards.
--
-- Nothing else is touched. `0044`'s reserves, `0111`'s lifecycle events, `0061`'s email log and `0080`'s
-- platform settings all outlive this file: a deployment that reverses STEP 199 stops recording chargeback
-- steps, and the reserve it started, the suspension it wrote and the notice it queued stay exactly where the
-- merchant can still read them. A rollback that removed a merchant's suspension would be a rollback that
-- silently reactivated an account, which is not a schema change.

begin;

drop policy if exists chargeback_actions_default_deny on public.chargeback_actions;

drop trigger if exists chargeback_actions_set_row_metadata on public.chargeback_actions;
drop trigger if exists chargeback_actions_guard on public.chargeback_actions;

drop function if exists public.chargeback_actions_guard();

drop index if exists public.chargeback_actions_open_idx;
drop index if exists public.chargeback_actions_company_idx;
drop index if exists public.chargeback_actions_live_key;

drop table if exists public.chargeback_actions;

commit;
