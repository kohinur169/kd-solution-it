-- path: migrations/0094_seed_payment_providers.down.sql
-- STEP 069 rollback of 0094: removes the five catalogue rows this file seeded, and nothing else.
--
-- The table is `0029`'s, so the rollback of this file means "the catalogue is empty again" and not
-- "the table is gone". The delete is guarded three ways, because a rollback must never destroy a
-- decision an operator has since taken:
--
--   - only platform rows (`company_id is null`), which is every row the seed wrote;
--   - only rows that are still disabled, so an enabled provider keeps its row and its evidence;
--   - only rows that hold no key, because a key is a secret an operator entered and deleting the
--     provider would cascade a `provider_keys_provider_fkey` failure rather than a clean removal.
--
-- A database that has been used therefore keeps its rows and this rollback removes nothing, which is
-- the right order of operations: a rollback undoes a deployment, not a person's work.

begin;

delete from public.payment_providers
 where company_id is null
   and provider_key in ('nmi', 'payoneer', 'rainforest', 'stripe_connect', 'airwallex')
   and status = 'disabled'
   and not exists (
     select 1
       from public.provider_keys held
      where held.provider_id = payment_providers.id
   );

commit;
