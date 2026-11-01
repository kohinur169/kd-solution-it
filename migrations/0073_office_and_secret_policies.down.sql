-- path: migrations/0073_office_and_secret_policies.down.sql
-- STEP 035 - the rollback of the 33 policies and the 3 indexes of the office, per-person and
-- credential tables, in one transaction, before the helpers they read are dropped by `0072`.

begin;

drop policy if exists taxcloud_connections_merchant_update on public.taxcloud_connections;
drop policy if exists taxcloud_connections_merchant_insert on public.taxcloud_connections;
drop policy if exists taxcloud_connections_merchant_select on public.taxcloud_connections;
drop policy if exists taxcloud_connections_super_admin_all on public.taxcloud_connections;

drop policy if exists store_connections_merchant_update on public.store_connections;
drop policy if exists store_connections_merchant_insert on public.store_connections;
drop policy if exists store_connections_merchant_select on public.store_connections;
drop policy if exists store_connections_super_admin_all on public.store_connections;

drop policy if exists merchant_api_credentials_merchant_update on public.merchant_api_credentials;
drop policy if exists merchant_api_credentials_merchant_insert on public.merchant_api_credentials;
drop policy if exists merchant_api_credentials_merchant_select on public.merchant_api_credentials;
drop policy if exists merchant_api_credentials_super_admin_all on public.merchant_api_credentials;

drop policy if exists provider_keys_super_admin_all on public.provider_keys;

drop policy if exists account_locks_self_select on public.account_locks;
drop policy if exists account_locks_super_admin_all on public.account_locks;

drop policy if exists login_attempts_self_select on public.login_attempts;
drop policy if exists login_attempts_super_admin_all on public.login_attempts;

drop policy if exists device_proof_keys_self_select on public.device_proof_keys;
drop policy if exists device_proof_keys_super_admin_all on public.device_proof_keys;

drop policy if exists sessions_self_update on public.sessions;
drop policy if exists sessions_self_select on public.sessions;
drop policy if exists sessions_super_admin_all on public.sessions;

drop policy if exists announcement_dismissals_self_insert on public.announcement_dismissals;
drop policy if exists announcement_dismissals_self_select on public.announcement_dismissals;
drop policy if exists announcement_dismissals_super_admin_all on public.announcement_dismissals;

drop policy if exists announcements_audience_select on public.announcements;
drop policy if exists announcements_super_admin_all on public.announcements;

drop policy if exists delegations_self_select on public.delegations;
drop policy if exists delegations_super_admin_all on public.delegations;

drop policy if exists office_permissions_self_select on public.office_permissions;
drop policy if exists office_permissions_super_admin_all on public.office_permissions;

drop policy if exists role_assignments_self_select on public.role_assignments;
drop policy if exists role_assignments_super_admin_all on public.role_assignments;

drop index if exists public.merchant_api_credentials_tenant_idx;
drop index if exists public.store_connections_tenant_idx;
drop index if exists public.taxcloud_connections_tenant_idx;

commit;
