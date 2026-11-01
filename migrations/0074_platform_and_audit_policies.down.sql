-- path: migrations/0074_platform_and_audit_policies.down.sql
-- STEP 035 - the rollback of the 36 policies and the single index of the platform, content,
-- machinery and audit tables. No policy in this file ever granted a write on `audit_logs`, so
-- dropping these two leaves the table append-only as it was.

begin;

drop policy if exists audit_logs_merchant_select on public.audit_logs;
drop policy if exists audit_logs_office_select on public.audit_logs;

drop policy if exists velocity_counters_compliance_kyc_select on public.velocity_counters;
drop policy if exists velocity_counters_super_admin_all on public.velocity_counters;

drop policy if exists webhook_events_finance_ops_select on public.webhook_events;
drop policy if exists webhook_events_super_admin_all on public.webhook_events;

drop policy if exists idempotency_keys_compliance_kyc_select on public.idempotency_keys;
drop policy if exists idempotency_keys_super_admin_all on public.idempotency_keys;

drop policy if exists blog_posts_published_select on public.blog_posts;
drop policy if exists blog_posts_blogger_all on public.blog_posts;
drop policy if exists blog_posts_super_admin_all on public.blog_posts;

drop policy if exists cms_pages_published_select on public.cms_pages;
drop policy if exists cms_pages_blogger_all on public.cms_pages;
drop policy if exists cms_pages_super_admin_all on public.cms_pages;

drop policy if exists email_send_logs_merchant_select on public.email_send_logs;
drop policy if exists email_send_logs_super_admin_all on public.email_send_logs;
drop policy if exists email_templates_super_admin_all on public.email_templates;
drop policy if exists email_settings_super_admin_all on public.email_settings;

drop policy if exists card_blacklist_ceo_select on public.card_blacklist;
drop policy if exists card_blacklist_compliance_kyc_all on public.card_blacklist;
drop policy if exists compliance_items_ceo_select on public.compliance_items;
drop policy if exists compliance_items_compliance_kyc_all on public.compliance_items;

drop policy if exists processor_bills_ceo_select on public.processor_bills;
drop policy if exists processor_bills_finance_ops_all on public.processor_bills;
drop policy if exists company_transactions_ceo_select on public.company_transactions;
drop policy if exists company_transactions_finance_ops_all on public.company_transactions;

drop policy if exists routing_rules_office_select on public.routing_rules;
drop policy if exists routing_rules_super_admin_all on public.routing_rules;
drop policy if exists payment_providers_office_select on public.payment_providers;
drop policy if exists payment_providers_super_admin_all on public.payment_providers;

drop policy if exists plan_entitlements_merchant_select on public.plan_entitlements;
drop policy if exists plan_entitlements_super_admin_all on public.plan_entitlements;
drop policy if exists pricing_versions_office_select on public.pricing_versions;
drop policy if exists pricing_versions_super_admin_all on public.pricing_versions;
drop policy if exists plans_office_select on public.plans;
drop policy if exists plans_super_admin_all on public.plans;

drop index if exists public.plan_entitlements_tenant_idx;

commit;
