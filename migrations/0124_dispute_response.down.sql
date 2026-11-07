-- path: migrations/0124_dispute_response.down.sql
-- STEP 195's rollback: the instant the merchant answered, its check, its trigger and its index.
--
-- The order is the reverse of the forward file and matters in one place: the trigger goes before the
-- function it calls, so no window exists in which a live trigger points at a dropped function.
--
-- Rolling this back loses *when* each merchant answered. It does not lose the answer itself:
-- `response_text` is `0039`'s column and survives, so a database that reverses this file still says what
-- the merchant wrote and only forgets whether it beat the deadline. That is the whole cost of the
-- rollback, it is deliberate, and the service that reads the pair says so when the column is absent
-- rather than inventing an instant.

begin;

drop index if exists public.disputes_response_idx;

drop trigger if exists disputes_guard_response on public.disputes;

drop function if exists public.disputes_guard_response();

alter table public.disputes drop column if exists response_saved_at;

commit;
