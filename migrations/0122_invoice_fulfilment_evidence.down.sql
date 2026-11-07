-- path: migrations/0122_invoice_fulfilment_evidence.down.sql
-- STEP 181 - rollback for 0122_invoice_fulfilment_evidence.sql.
--
-- Drops the two evidence tables and everything they own, then the four functions this file created.
-- The order is the reverse of the forward file: the confirmations point at the fulfilment records
-- through a composite foreign key, so they go first, and the release question goes after both
-- because it reads them.
--
-- Nothing here touches `invoices`, `invoice_items` or `payments`: this STEP appended evidence beside
-- them and never wrote onto them, so a rollback leaves every document and every payment exactly as it
-- was. One transaction, so a failed rollback leaves the database as it found it.

begin;

drop table if exists public.invoice_acceptances;
drop table if exists public.invoice_fulfilment_evidence;

drop function if exists public.invoice_release_evidence_ok(uuid, uuid);
drop function if exists public.invoice_acceptances_guard_append_only();
drop function if exists public.invoice_acceptances_guard_evidence();
drop function if exists public.invoice_fulfilment_evidence_guard();

commit;
