-- path: migrations/0094_seed_payment_providers.sql
-- STEP 069 - the five section 6 providers exist before the gateway page can show them.
--
-- `0029` created `payment_providers` and froze the vocabulary to the five adapters section 6 names,
-- but it seeded nothing: the table is a catalogue with no entries until a later file fills it, which
-- is what this file does. The super admin page of section 6 lists providers, tests their connections,
-- enables and disables them, and adds keys to them; a page over an empty catalogue can do none of
-- those things, and inserting the rows from a route handler would have made a read a write.
--
-- ## Why a migration and not a service
--
-- The five rows are a fact about this build, not a decision an operator takes: section 6 names the
-- five, `0029` closed the vocabulary to them, and a provider is either supported by this code or it
-- is not. A migration is the only place that ships a fact with the build, it runs once per database,
-- and it leaves an audit trail of its own in the migration log.
--
-- ## The capability matrix is section 6's sentence, one row each
--
--   - NMI: card acceptance through Collect.js hosted fields, and sub-merchant creation through the
--     NMI gateway;
--   - Payoneer: payouts, and a merchant bank account is pushed to it automatically;
--   - Rainforest: payment acceptance and sub-merchant creation;
--   - Stripe Connect: connected sub-merchant creation, charges and payouts;
--   - Airwallex: connected account creation, payment acceptance and payouts.
--
-- `payment_providers_capability_check` refuses a row that supports nothing, so every row below says
-- at least one true.
--
-- ## Idempotent by construction
--
-- `payment_providers_key_key` is a *partial* unique index, so there is no constraint to name in an
-- `on conflict` clause: PostgreSQL can only infer an index that is not partial. The insert therefore
-- selects from the rows that are not already there, which is the same guarantee in a shape that
-- works with the index the table has. A second run inserts nothing.
--
-- Every row lands disabled with no test result, which is the only honest state: no adapter is
-- installed yet (the adapters are STEPs 147-169), and `payment_providers_test_check` forbids an
-- enabled provider that has never passed a connection test. `display_order` 1 to 5 is unique among
-- live rows, as `payment_providers_order_key` requires.

begin;

insert into public.payment_providers (
  provider_key,
  display_name,
  supports_acceptance,
  supports_payouts,
  supports_submerchant,
  display_order
)
select
  seed.provider_key,
  seed.display_name,
  seed.acceptance,
  seed.payouts,
  seed.submerchant,
  seed.display_order
from (values
  ('nmi', 'NMI', true, false, true, 1),
  ('payoneer', 'Payoneer', false, true, false, 2),
  ('rainforest', 'Rainforest', true, false, true, 3),
  ('stripe_connect', 'Stripe Connect', true, true, true, 4),
  ('airwallex', 'Airwallex', true, true, true, 5)
) as seed (provider_key, display_name, acceptance, payouts, submerchant, display_order)
where not exists (
  select 1
    from public.payment_providers existing
   where existing.company_id is null
     and existing.provider_key = seed.provider_key
);

commit;
