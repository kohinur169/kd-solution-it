-- path: migrations/0070_tenant_policies_batch_one.sql
-- STEP 033 - the tenant policy of batch one: a merchant sees its own rows and nothing else.
--
-- Every table below already carries `<table>_default_deny`, which refuses everything, and this
-- file adds a second permissive policy beside it, as rule 8 of this folder asks. Row level
-- security ORs permissive policies, so the deny contributes nothing and the tenant policy decides;
-- if the actor cannot be identified the helper returns null, the comparison matches no row, and
-- the deny is what a caller is left with.
--
-- The 22 tables are the merchant's own business record: the tenant row itself, the people, the
-- clients, products and services, the invoices and estimates with their lines and events, the
-- recurring schedules, the policy acceptances, the KYC and underwriting rows, the files and the
-- two support tables. The money tables are STEP 034's and the office, per-person and platform
-- tables are STEP 035's, because their rule is a role rule and this file states a tenant rule.
--
-- `companies` is the one table where the tenant is the row rather than a column, so its predicate
-- reads `id`. Every other table compares `company_id`, and every one of those comparisons is
-- backed by an index whose first column is `company_id`: 20 of the 22 tables already had one and
-- the two indexes at the end of this file give the last two the same property. A policy that
-- filters on a column with no index is a scan of the table on every request.
--
-- No role is named and no row is granted to `support` or `blogger` here: which of a company's
-- people may read a KYC document is the office permission model of STEP 005 and the role policies
-- of STEP 035. This layer answers "is this row my company's", and nothing more.

begin;

create policy companies_tenant_isolation
  on public.companies
  as permissive
  for all
  to public
  using (id = public.current_actor_company_id())
  with check (id = public.current_actor_company_id());

create policy users_tenant_isolation
  on public.users
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy clients_tenant_isolation
  on public.clients
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy products_tenant_isolation
  on public.products
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy services_tenant_isolation
  on public.services
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy invoices_tenant_isolation
  on public.invoices
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy invoice_items_tenant_isolation
  on public.invoice_items
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy invoice_events_tenant_isolation
  on public.invoice_events
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy estimates_tenant_isolation
  on public.estimates
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy estimate_items_tenant_isolation
  on public.estimate_items
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy estimate_signatures_tenant_isolation
  on public.estimate_signatures
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy recurring_schedules_tenant_isolation
  on public.recurring_schedules
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy policy_acceptances_tenant_isolation
  on public.policy_acceptances
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy kyc_submissions_tenant_isolation
  on public.kyc_submissions
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy kyc_documents_tenant_isolation
  on public.kyc_documents
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy ubo_records_tenant_isolation
  on public.ubo_records
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy sanctions_screenings_tenant_isolation
  on public.sanctions_screenings
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy review_decisions_tenant_isolation
  on public.review_decisions
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy submerchant_provisions_tenant_isolation
  on public.submerchant_provisions
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy files_tenant_isolation
  on public.files
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy support_tickets_tenant_isolation
  on public.support_tickets
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

create policy support_ticket_messages_tenant_isolation
  on public.support_ticket_messages
  as permissive
  for all
  to public
  using (company_id = public.current_actor_company_id())
  with check (company_id = public.current_actor_company_id());

-- The UBO list is read by company and has no such index yet.
create index ubo_records_company_idx
  on public.ubo_records (company_id)
  where deleted_at is null;

-- The support thread is read by company, and the ticket index starts with the ticket.
create index support_ticket_messages_company_idx
  on public.support_ticket_messages (company_id, created_at)
  where deleted_at is null;

commit;
