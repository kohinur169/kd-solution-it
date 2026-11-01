-- path: migrations/0070_tenant_policies_batch_one.down.sql
-- STEP 033 - the rollback of batch one: the 22 tenant policies and the two indexes, in one
-- transaction, before the functions they read are dropped by the rollback of `0069`.

begin;

drop policy if exists support_ticket_messages_tenant_isolation
  on public.support_ticket_messages;

drop policy if exists support_tickets_tenant_isolation on public.support_tickets;

drop policy if exists files_tenant_isolation on public.files;

drop policy if exists submerchant_provisions_tenant_isolation
  on public.submerchant_provisions;

drop policy if exists review_decisions_tenant_isolation on public.review_decisions;

drop policy if exists sanctions_screenings_tenant_isolation on public.sanctions_screenings;

drop policy if exists ubo_records_tenant_isolation on public.ubo_records;

drop policy if exists kyc_documents_tenant_isolation on public.kyc_documents;

drop policy if exists kyc_submissions_tenant_isolation on public.kyc_submissions;

drop policy if exists policy_acceptances_tenant_isolation on public.policy_acceptances;

drop policy if exists recurring_schedules_tenant_isolation on public.recurring_schedules;

drop policy if exists estimate_signatures_tenant_isolation on public.estimate_signatures;

drop policy if exists estimate_items_tenant_isolation on public.estimate_items;

drop policy if exists estimates_tenant_isolation on public.estimates;

drop policy if exists invoice_events_tenant_isolation on public.invoice_events;

drop policy if exists invoice_items_tenant_isolation on public.invoice_items;

drop policy if exists invoices_tenant_isolation on public.invoices;

drop policy if exists services_tenant_isolation on public.services;

drop policy if exists products_tenant_isolation on public.products;

drop policy if exists clients_tenant_isolation on public.clients;

drop policy if exists users_tenant_isolation on public.users;

drop policy if exists companies_tenant_isolation on public.companies;

drop index if exists public.ubo_records_company_idx;

drop index if exists public.support_ticket_messages_company_idx;

commit;
