-- path: migrations/0123_refund_fee_rule.down.sql
-- STEP 193's rollback: the section 18 switch, the queue index and the instant that records an answer.
--
-- The order matters in one place. The setting row goes first, so a deployment that rolls this file
-- back while the service still runs finds a closed switch (a missing row is the closed side, exactly
-- as `lib/auth/breach-check.ts` reads a missing switch) rather than an open one whose reader has lost
-- the columns it writes. Then the index, then the column: the column carries the two constraints
-- added beside it, so dropping it is what removes them and nothing has to be named twice.
--
-- Rolling this back loses the record of *when* the rule was applied to a refund. It does not lose the
-- answer: `platform_fee_returned` and `platform_fee_returned_minor` are `0038`'s columns and survive,
-- so a database that reverses this file still knows which fees went back, and only forgets which
-- refunds had been asked. That is the whole cost of the rollback and it is deliberate.

begin;

delete from public.platform_settings where setting_key = 'refunds.platform_fee_returned';

drop index if exists public.refunds_fee_settle_idx;

alter table public.refunds drop column if exists platform_fee_settled_at;

commit;
