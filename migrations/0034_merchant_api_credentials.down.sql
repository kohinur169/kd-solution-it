-- path: migrations/0034_merchant_api_credentials.down.sql
-- STEP 023 - rollback for 0034_merchant_api_credentials.sql.
--
-- Drops the credential table and everything it owns: nineteen constraints, four indexes, the policy
-- and the two triggers, then the secret guard function this file created.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.merchant_api_credentials;

drop function if exists public.merchant_api_credentials_guard_secret();

commit;
