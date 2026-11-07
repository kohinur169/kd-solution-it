-- path: migrations/0127_dispute_reviews_and_submissions.down.sql
-- STEP 198 - the rollback of the compliance review and the submission to the processor.
--
-- Reverses the forward file in the only order that works: the trigger on `disputes` first, because its function
-- reads the submissions table; then the two tables' own triggers, then the tables, then the functions they
-- called. One transaction, so a failed rollback leaves the database as it found it.
--
-- What the rollback costs, stated rather than hidden: the decisions and the attempts go, and `evidence_submitted`
-- loses its proof - the status stays in `0039`'s six and `submitted_at` stays on the row (both are `0039`'s), but
-- nothing then requires a sent submission behind them. A database rolled back to 0126 keeps its disputes, its
-- responses, its deadlines, its warnings and its frozen evidence packs; it loses the record of who reviewed them
-- and where they were sent, which is exactly what STEP 199's monitoring reads.
--
-- Nothing on the processor's side is touched, and nothing could be: the evidence was sent by an officer and the
-- processor's own case file is not in this database.

begin;

drop trigger if exists disputes_guard_submission on public.disputes;
drop function if exists public.disputes_guard_submission();

drop trigger if exists dispute_submissions_set_row_metadata on public.dispute_submissions;
drop trigger if exists dispute_submissions_guard on public.dispute_submissions;
drop trigger if exists dispute_reviews_set_row_metadata on public.dispute_reviews;
drop trigger if exists dispute_reviews_guard on public.dispute_reviews;

drop table if exists public.dispute_submissions;
drop table if exists public.dispute_reviews;

drop function if exists public.dispute_submissions_guard();
drop function if exists public.dispute_reviews_guard();

commit;
