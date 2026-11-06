-- path: migrations/0115_invoice_documents.down.sql
-- STEP 117 - rollback for 0115_invoice_documents.sql.
--
-- Drops the document table with its constraints, its three indexes, the policy and both triggers,
-- then the guard this file created. The `0057` file rows a render produced stay where they are:
-- they are files, and section 13 keeps them for seven years whether or not the row that asked for
-- them still exists.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.invoice_documents;

drop function if exists public.invoice_documents_guard_state();

commit;
