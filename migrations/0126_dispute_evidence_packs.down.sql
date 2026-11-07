-- path: migrations/0126_dispute_evidence_packs.down.sql
-- STEP 197 - the rollback of the evidence pack, its records and its documents.
--
-- Reverses the forward file in the only order that works: the triggers on `disputes` go first, because that
-- trigger's function reads the packs table; then the three tables' own triggers, then the tables themselves
-- from the child up, then the functions they called. One transaction, so a failed rollback leaves the
-- database as it found it.
--
-- What the rollback costs, stated rather than hidden: the packs, the assembled records and the document
-- references go, and so does the `evidence_ready` flag's meaning - the column stays on `disputes` (it is
-- `0039`'s, and this STEP never writes onto it except through the flag) but nothing then enforces that a
-- dispute marked ready holds a frozen pack. A database rolled back to 0125 keeps its disputes, its
-- responses, its deadlines and its warnings; it loses the evidence that section 19 asks a submission to
-- carry, which is exactly what STEP 198 depends on.
--
-- The supplied files themselves are not this file's: no bytes, no bucket and no storage key are touched,
-- because the object store is not in the database. What is dropped is the reference to them.

begin;

drop trigger if exists disputes_guard_evidence on public.disputes;
drop function if exists public.disputes_guard_evidence();

drop trigger if exists dispute_evidence_documents_set_row_metadata on public.dispute_evidence_documents;
drop trigger if exists dispute_evidence_documents_guard on public.dispute_evidence_documents;
drop trigger if exists dispute_evidence_items_set_row_metadata on public.dispute_evidence_items;
drop trigger if exists dispute_evidence_items_guard on public.dispute_evidence_items;
drop trigger if exists dispute_evidence_packs_set_row_metadata on public.dispute_evidence_packs;
drop trigger if exists dispute_evidence_packs_guard on public.dispute_evidence_packs;

drop table if exists public.dispute_evidence_documents;
drop table if exists public.dispute_evidence_items;
drop table if exists public.dispute_evidence_packs;

drop function if exists public.dispute_evidence_documents_guard();
drop function if exists public.dispute_evidence_items_guard();
drop function if exists public.dispute_evidence_packs_guard();

commit;
