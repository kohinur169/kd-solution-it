-- path: migrations/0116_invoice_branding.down.sql
-- Rollback of 0116: drop the branding table and its identity guard.
--
-- The order is the reverse of the forward file: the policy and the two triggers belong to the table, so they
-- go first, then the table, then the function that only its trigger used.
--
-- Nothing here touches `files` or `business_profiles`. A merchant's uploaded logos stay in storage under
-- their own keys with their own records, and their profile facts stay exactly as they were: what a rollback
-- removes is the ability to say which of them an invoice prints, not the facts themselves. Invoices already
-- rendered keep the branding they were drawn with, because a rendered PDF is an object in storage and not a
-- view of this row.

begin;

drop policy if exists invoice_branding_default_deny on public.invoice_branding;

drop trigger if exists invoice_branding_guard_identity on public.invoice_branding;
drop trigger if exists invoice_branding_set_row_metadata on public.invoice_branding;

drop table if exists public.invoice_branding;

drop function if exists public.invoice_branding_guard_identity();

commit;
