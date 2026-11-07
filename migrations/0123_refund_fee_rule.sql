-- path: migrations/0123_refund_fee_rule.sql
-- STEP 193 - the platform fee on a refund, and the switch that decides it.
--
-- Section 18 gives the super administrator one sentence about refunds: "whether the platform fee is
-- returned on a refund is set by super_admin." Section 10 says the fee itself is a percentage of the
-- transaction which the platform keeps, and section 11 says the ledger covers a refund. `0038` already
-- built the two columns that record an answer - `platform_fee_returned` and
-- `platform_fee_returned_minor`, the second capped by `refunds_guard_amount` at the fee the payment
-- carried - but nothing has ever written them, and nothing records *whether the question was asked*.
--
-- This file adds the three things the answer needs and no more:
--
--   1. `refunds.platform_fee_settled_at` - when the section 18 rule was applied to this refund. It is
--      a separate fact from "the fee came back", because the rule has three answers and the two
--      existing columns can only hold one of them: the fee came back (returned, a positive amount),
--      the rule was open and there was nothing to return (a fee of zero, or a share that rounds to
--      zero), and the rule was closed, so the platform keeps its fee. Two booleans would carry that
--      and read badly; one instant - "the rule was applied here, at this moment" - carries it exactly,
--      and a null is the only state that means "not answered yet". Without it the sweep of section 18
--      could not tell an unsettled refund from one the rule already kept, and would re-read and
--      re-audit the same rows on every pass.
--   2. The two constraints that keep that instant honest. The rule only applies to a refund that
--      actually sent money back, so the column is null on every refund that is not `succeeded`; and a
--      fee can only be recorded as returned once the rule has been applied, so a row can never claim
--      money came back that no rule ever decided.
--   3. The setting itself, seeded on the side that keeps the fee. Section 18 makes this a deliberate
--      act of the super administrator, and the honest default is the one that returns no money the
--      platform did not decide to return: a switch that seeded open would quietly hand back fees on
--      every refund in a deployment where nobody had made that decision. `0081` seeded the breached
--      password check open for the opposite reason, and the two files are the same argument read from
--      opposite ends - whichever way the switch is easier to leave alone should be the safe side.
--
-- The index is the sweep's queue. A partly refunded payment is settled by one pass per refund, and
-- each pass looks for exactly one shape of row: succeeded, fee rule not applied, not removed. The
-- partial index holds only those rows, so the pass reads the work instead of the table.
--
-- Nothing here changes `payments`. The fee a payment carried is `payments.platform_fee_minor`, read by
-- the service; `refunds_sync_payment` owns the refunded total and `payments_guard_refund_state`
-- refuses any other writer of the refund state, exactly as `0037` says. Nothing here writes a ledger
-- entry either: `0041` already carries `source_type = 'refund'` with `refund_id`, and the service posts
-- the balanced group through the posting service of STEP 132.

begin;

alter table public.refunds add column platform_fee_settled_at timestamptz;

comment on column public.refunds.platform_fee_settled_at is
  'When the section 18 rule was applied to this refund: null until then, whatever the answer was.';

alter table public.refunds
  add constraint refunds_platform_fee_settled_check check (
    platform_fee_settled_at is null
    or (status = 'succeeded' and platform_fee_settled_at >= created_at)
  );

comment on constraint refunds_platform_fee_settled_check on public.refunds is
  'The fee rule applies to money that went back: a settled instant exists only on a succeeded refund, and not before the refund was asked for.';

alter table public.refunds
  add constraint refunds_platform_fee_answered_check check (
    not platform_fee_returned
    or (platform_fee_settled_at is not null and platform_fee_returned_minor > 0)
  );

comment on constraint refunds_platform_fee_answered_check on public.refunds is
  'A fee is only recorded as returned when the rule was applied and the amount that came back is positive.';

create index refunds_fee_settle_idx
  on public.refunds (processed_at)
  where status = 'succeeded' and platform_fee_settled_at is null and deleted_at is null;

comment on index public.refunds_fee_settle_idx is
  'The section 18 sweep: succeeded refunds whose fee rule has not been applied yet, oldest answer first.';

insert into public.platform_settings (setting_key, value, is_secret) values
  ('refunds.platform_fee_returned', 'false'::jsonb, false);

commit;
