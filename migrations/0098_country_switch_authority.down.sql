-- path: migrations/0098_country_switch_authority.down.sql
-- STEP 073 rollback of 0098: the switch keeps its state, the two records beside it go.
--
-- No country changes state when this runs: `is_enabled` is what a merchant or a payment sees, and the
-- column was already carrying it before STEP 073. The file drops the operator's sentence for a closed
-- market, the spend record of a decision, and the index the switch reads. Each fact survives in the
-- audit chain for every change made after this STEP, which is why dropping the columns is a loss of
-- convenience and not a loss of accountability - and the screen and the route that read them are
-- removed in the same commit, so nothing is left asking for a column that is not there.
--
-- The `countries_disabled_reason_check` constraint goes before the column it mentions, and the index
-- goes before the columns its predicate names, because PostgreSQL refuses both in the other order.

begin;

drop index if exists public.approval_requests_consumable_idx;

alter table public.approval_requests
  drop constraint if exists approval_requests_consumed_check;

alter table public.approval_requests
  drop constraint if exists approval_requests_consumed_by_fkey;

alter table public.approval_requests
  drop column if exists consumed_by;

alter table public.approval_requests
  drop column if exists consumed_at;

alter table public.countries
  drop constraint if exists countries_disabled_reason_check;

alter table public.countries
  drop column if exists disabled_reason;

commit;
