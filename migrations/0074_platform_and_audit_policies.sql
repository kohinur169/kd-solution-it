-- path: migrations/0074_platform_and_audit_policies.sql
-- STEP 035 - the platform's own book, the public content, the machinery and the audit chain.
--
-- This file closes the layer. After it, 66 of the 67 tables answer a caller and `job_queue` is
-- the one table that answers nobody, because the service works it and no role reads it.
--
-- The readers are the roles of `0072`, tested with the array overlap operator so one policy can
-- name a group: `public.current_actor_roles() && array['ceo', 'finance_ops']::text[]`. Every
-- policy is `as permissive` and `to public`, per `migrations/README.md` rule 9.
--
--   * the platform book belongs to the role that works it: `company_transactions` and
--     `processor_bills` give `finance_ops` the writes and `ceo` the read; `compliance_items` and
--     `card_blacklist` give `compliance_kyc` the writes and `ceo` the read; `webhook_events`
--     gives `finance_ops` the read; `idempotency_keys` and `velocity_counters` give
--     `compliance_kyc` the read. `super_admin` keeps full control of all seven.
--   * the configuration is read by the people who decide it: `plans`, `pricing_versions`,
--     `payment_providers` and `routing_rules` are readable by `ceo` and `finance_ops` and written
--     by `super_admin`.
--   * `plan_entitlements` is the merchant's own subscription content, so it grants the owner its
--     company's rows beside `super_admin`.
--   * the three email tables stay with `super_admin`, and `email_send_logs` also lets a merchant
--     read the sends addressed to its own people, because section 23 tells a merchant when an
--     email failed.
--   * `cms_pages` and `blog_posts` belong to `blogger` and `super_admin`; `ceo` and `support` read
--     a published row. No anonymous policy exists: the public site is rendered by the server,
--     which reaches these tables as their owner.
--   * `audit_logs` is the one table of this STEP that grants no write at all. Its select is the
--     three office roles that answer for it plus the merchant for its own company's rows, because
--     a merchant asking who changed its bank account is answered from this table. Inserts arrive
--     from the audit function of STEP 013 and the service; updates and deletes are refused by
--     `<table>_default_deny` and again by `audit_logs_append_only`, which refuses every role
--     including the owner of the table. This file therefore must never gain an insert, update or
--     delete policy on it, and the proof shows both gates.
--   * `job_queue` gets no policy. The service claims and completes jobs; an office role reading
--     the queue would learn nothing it can act on and a merchant would learn about other work.
--
-- One plain index is added for `plan_entitlements`, whose only index was the primary key, so the
-- `company_id` predicate its merchant policy applies has an index it can use.

begin;

create policy plans_super_admin_all
  on public.plans
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy plans_office_select
  on public.plans
  as permissive
  for select
  to public
  using (public.current_actor_roles() && array['ceo', 'finance_ops']::text[]);

create policy pricing_versions_super_admin_all
  on public.pricing_versions
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy pricing_versions_office_select
  on public.pricing_versions
  as permissive
  for select
  to public
  using (public.current_actor_roles() && array['ceo', 'finance_ops']::text[]);

create policy plan_entitlements_super_admin_all
  on public.plan_entitlements
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy plan_entitlements_merchant_select
  on public.plan_entitlements
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy payment_providers_super_admin_all
  on public.payment_providers
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy payment_providers_office_select
  on public.payment_providers
  as permissive
  for select
  to public
  using (public.current_actor_roles() && array['ceo', 'finance_ops']::text[]);

create policy routing_rules_super_admin_all
  on public.routing_rules
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy routing_rules_office_select
  on public.routing_rules
  as permissive
  for select
  to public
  using (public.current_actor_roles() && array['ceo', 'finance_ops']::text[]);

create policy company_transactions_finance_ops_all
  on public.company_transactions
  as permissive
  for all
  to public
  using (public.current_actor_has_role('finance_ops'))
  with check (public.current_actor_has_role('finance_ops'));

create policy company_transactions_ceo_select
  on public.company_transactions
  as permissive
  for select
  to public
  using (public.current_actor_has_role('ceo'));

create policy processor_bills_finance_ops_all
  on public.processor_bills
  as permissive
  for all
  to public
  using (public.current_actor_has_role('finance_ops'))
  with check (public.current_actor_has_role('finance_ops'));

create policy processor_bills_ceo_select
  on public.processor_bills
  as permissive
  for select
  to public
  using (public.current_actor_has_role('ceo'));

create policy compliance_items_compliance_kyc_all
  on public.compliance_items
  as permissive
  for all
  to public
  using (public.current_actor_has_role('compliance_kyc'))
  with check (public.current_actor_has_role('compliance_kyc'));

create policy compliance_items_ceo_select
  on public.compliance_items
  as permissive
  for select
  to public
  using (public.current_actor_has_role('ceo'));

create policy card_blacklist_compliance_kyc_all
  on public.card_blacklist
  as permissive
  for all
  to public
  using (public.current_actor_has_role('compliance_kyc'))
  with check (public.current_actor_has_role('compliance_kyc'));

create policy card_blacklist_ceo_select
  on public.card_blacklist
  as permissive
  for select
  to public
  using (public.current_actor_has_role('ceo'));

create policy email_settings_super_admin_all
  on public.email_settings
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy email_templates_super_admin_all
  on public.email_templates
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy email_send_logs_super_admin_all
  on public.email_send_logs
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy email_send_logs_merchant_select
  on public.email_send_logs
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create policy cms_pages_super_admin_all
  on public.cms_pages
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy cms_pages_blogger_all
  on public.cms_pages
  as permissive
  for all
  to public
  using (public.current_actor_has_role('blogger'))
  with check (public.current_actor_has_role('blogger'));

create policy cms_pages_published_select
  on public.cms_pages
  as permissive
  for select
  to public
  using (
    published_at is not null
    and public.current_actor_roles() && array['ceo', 'support']::text[]
  );

create policy blog_posts_super_admin_all
  on public.blog_posts
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy blog_posts_blogger_all
  on public.blog_posts
  as permissive
  for all
  to public
  using (public.current_actor_has_role('blogger'))
  with check (public.current_actor_has_role('blogger'));

create policy blog_posts_published_select
  on public.blog_posts
  as permissive
  for select
  to public
  using (
    published_at is not null
    and public.current_actor_roles() && array['ceo', 'support']::text[]
  );

create policy idempotency_keys_super_admin_all
  on public.idempotency_keys
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy idempotency_keys_compliance_kyc_select
  on public.idempotency_keys
  as permissive
  for select
  to public
  using (public.current_actor_has_role('compliance_kyc'));

create policy webhook_events_super_admin_all
  on public.webhook_events
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy webhook_events_finance_ops_select
  on public.webhook_events
  as permissive
  for select
  to public
  using (public.current_actor_has_role('finance_ops'));

create policy velocity_counters_super_admin_all
  on public.velocity_counters
  as permissive
  for all
  to public
  using (public.current_actor_has_role('super_admin'))
  with check (public.current_actor_has_role('super_admin'));

create policy velocity_counters_compliance_kyc_select
  on public.velocity_counters
  as permissive
  for select
  to public
  using (public.current_actor_has_role('compliance_kyc'));

create policy audit_logs_office_select
  on public.audit_logs
  as permissive
  for select
  to public
  using (public.current_actor_roles() && array[
    'super_admin', 'ceo', 'compliance_kyc'
  ]::text[]);

create policy audit_logs_merchant_select
  on public.audit_logs
  as permissive
  for select
  to public
  using (company_id = public.current_actor_company_id());

create index plan_entitlements_tenant_idx on public.plan_entitlements (company_id);

commit;
