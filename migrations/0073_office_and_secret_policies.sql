-- path: migrations/0073_office_and_secret_policies.sql
-- STEP 035 - the office, the person and the merchant's own credentials.
--
-- The 13 tables of this file are the first half of the 32 that `0070` and `0071` left on the
-- deny alone. They are the tables the office works, the tables about one person, and the tables
-- that hold a merchant's own API key, store connection and tax connection.
--
-- The reader is the role of `0072`, never a claim and never a Postgres role. Each policy is
-- `as permissive` and `to public`, with the test inside `using`, because `migrations/README.md`
-- rule 9 forbids creating a role object and the owner of the table still has to migrate and run
-- the jobs.
--
--   * `super_admin` is full control of everything (FEATURE_LIST section 2), so each of these
--     tables carries one `<table>_super_admin_all` policy and nothing else is needed for it.
--   * the person reads its own rows: a session, a device key, a login attempt, an account lock,
--     an announcement it dismissed, its own assignment and its own delegations. `sessions` is the
--     one row a browser session may write, and only to revoke itself: the policy's `with check`
--     requires `revoked_at`, so an update that leaves the session live is refused.
--   * `delegations` is the one table two people read, the delegator and the delegate.
--   * `announcements` is read by the audience the row names: `all` for every signed-in person,
--     `owners` for a merchant, `office` for anyone holding one of the six office roles, and only
--     while it is published and not expired, and only for the company the row names when it
--     names one.
--   * `provider_keys` is the platform's own key material and grants `super_admin` only.
--   * `merchant_api_credentials`, `store_connections` and `taxcloud_connections` are the three
--     rows section 20 has a merchant create and revoke, so each grants the owner its company's
--     rows and a write pinned to the state a merchant may reach alone: an inserted credential is
--     not yet revoked, an inserted store is not yet revoked, an inserted tax connection is not
--     yet verified, an updated credential or store must carry a `revoked_at`, and an updated tax
--     connection may only change while it is unverified. Everything else about them is the
--     service's, which reaches the table as its owner.
--
-- No policy in this file grants an insert, an update or a delete on `device_proof_keys`,
-- `login_attempts` or `account_locks`; the service creates a device key, records an attempt and
-- locks an account, and a browser session has no business writing any of them.
--
-- Three plain indexes are added at the end for the three tables whose only index was the primary
-- key, so the `company_id` predicate these policies apply has an index it can use.

begin;

create policy role_assignments_super_admin_all
  on public.role_assignments
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy role_assignments_self_select
  on public.role_assignments
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy office_permissions_super_admin_all
  on public.office_permissions
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy office_permissions_self_select
  on public.office_permissions
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy delegations_super_admin_all
  on public.delegations
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy delegations_self_select
  on public.delegations
  as permissive
  for select
  to public
  using (
    delegator_user_id = public.current_actor_id()
    or delegate_user_id = public.current_actor_id()
  );

create policy announcements_super_admin_all
  on public.announcements
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy announcements_audience_select
  on public.announcements
  as permissive
  for select
  to public
  using (
    published_at is not null
    and (expires_at is null or expires_at > now())
    and (company_id is null or company_id = public.current_actor_company_id())
    and (
      audience = 'all'
      or (audience = 'owners' and public.current_actor_company_id() is not null)
      or (
        audience = 'office'
        and public.current_actor_roles() && array[
          'super_admin', 'ceo', 'compliance_kyc', 'finance_ops', 'support', 'blogger'
        ]::text[]
      )
    )
  );

create policy announcement_dismissals_super_admin_all
  on public.announcement_dismissals
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy announcement_dismissals_self_select
  on public.announcement_dismissals
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy announcement_dismissals_self_insert
  on public.announcement_dismissals
  as permissive
  for insert
  to public
  with check (user_id = public.current_actor_id());

create policy sessions_super_admin_all
  on public.sessions
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy sessions_self_select
  on public.sessions
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy sessions_self_update
  on public.sessions
  as permissive
  for update
  to public
  using (user_id = public.current_actor_id())
  with check (user_id = public.current_actor_id() and revoked_at is not null);

create policy device_proof_keys_super_admin_all
  on public.device_proof_keys
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy device_proof_keys_self_select
  on public.device_proof_keys
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy login_attempts_super_admin_all
  on public.login_attempts
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy login_attempts_self_select
  on public.login_attempts
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy account_locks_super_admin_all
  on public.account_locks
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy account_locks_self_select
  on public.account_locks
  as permissive
  for select
  to public
  using (user_id = public.current_actor_id());

create policy provider_keys_super_admin_all
  on public.provider_keys
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy merchant_api_credentials_super_admin_all
  on public.merchant_api_credentials
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy merchant_api_credentials_merchant_select
  on public.merchant_api_credentials
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy merchant_api_credentials_merchant_insert
  on public.merchant_api_credentials
  as permissive
  for insert
  to public
  with check (
    company_id = public.current_actor_company_id()
    and revoked_at is null
  );

create policy merchant_api_credentials_merchant_update
  on public.merchant_api_credentials
  as permissive
  for update
  to public
  using (company_id = public.current_actor_company_id())
  with check (
    company_id = public.current_actor_company_id()
    and revoked_at is not null
  );

create policy store_connections_super_admin_all
  on public.store_connections
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy store_connections_merchant_select
  on public.store_connections
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy store_connections_merchant_insert
  on public.store_connections
  as permissive
  for insert
  to public
  with check (
    company_id = public.current_actor_company_id()
    and revoked_at is null
  );

create policy store_connections_merchant_update
  on public.store_connections
  as permissive
  for update
  to public
  using (company_id = public.current_actor_company_id())
  with check (
    company_id = public.current_actor_company_id()
    and revoked_at is not null
  );

create policy taxcloud_connections_super_admin_all
  on public.taxcloud_connections
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy taxcloud_connections_merchant_select
  on public.taxcloud_connections
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy taxcloud_connections_merchant_insert
  on public.taxcloud_connections
  as permissive
  for insert
  to public
  with check (
    company_id = public.current_actor_company_id()
    and verified_at is null
  );

create policy taxcloud_connections_merchant_update
  on public.taxcloud_connections
  as permissive
  for update
  to public
  using (company_id = public.current_actor_company_id())
  with check (
    company_id = public.current_actor_company_id()
    and verified_at is null
  );

create index merchant_api_credentials_tenant_idx on public.merchant_api_credentials (company_id);

create index store_connections_tenant_idx on public.store_connections (company_id);

create index taxcloud_connections_tenant_idx on public.taxcloud_connections (company_id);

commit;
