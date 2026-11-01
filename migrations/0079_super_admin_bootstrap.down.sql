-- path: migrations/0079_super_admin_bootstrap.down.sql
-- STEP 036 rollback of 0079: removes the bootstrap and the platform chain helper.
--
-- No account, no role and no page is touched. A rollback removes the ability to bootstrap, which
-- is the right order of operations: the account it created stays, because an account is a fact
-- about the platform, not part of the function that wrote it.

begin;

drop function if exists public.bootstrap_super_admin(uuid, text, text, text, timestamptz, jsonb, text, text, text);
drop function if exists public.audit_platform_chain();

commit;
