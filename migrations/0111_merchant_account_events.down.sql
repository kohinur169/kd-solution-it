-- path: migrations/0111_merchant_account_events.down.sql
-- Rollback of 0111: drop the lifecycle event log and the chargeback period seed it added.

begin;

drop policy if exists merchant_account_events_default_deny on public.merchant_account_events;

drop trigger if exists merchant_account_events_guard_state on public.merchant_account_events;

drop index if exists public.merchant_account_events_open_idx;
drop index if exists public.merchant_account_events_company_idx;

drop table if exists public.merchant_account_events;

drop function if exists public.merchant_account_events_guard_state();

delete from public.platform_settings where setting_key = 'chargeback.hold_days';

commit;
