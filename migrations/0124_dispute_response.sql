-- path: migrations/0124_dispute_response.sql
-- STEP 195 - when the merchant answered a dispute, and the window it had to answer in.
--
-- Section 19 gives the merchant 24 hours "in the merchant own time zone" to write the dispute response.
-- `0039` already carries the words (`response_text`, 1 to 20000 characters) and the deadline
-- (`response_due_at`, after `opened_at` and no later than `opened_at + response_window_hours`), but it
-- has no instant saying *when* the merchant wrote them. That instant is what this file adds, because it
-- is the fact the deadline case turns on: a response written at 23:59 of the window and a response
-- written after it are the same two columns without it.
--
-- ## The column
--
-- `response_saved_at` is the instant of the merchant's last save inside the window. It is not
-- `updated_at`: that moves on every write to the row - a status from a provider delivery, an extension of
-- the deadline - and would make "the merchant answered at 14:20" unreadable a day later.
--
-- ## The four rules, in the database
--
--   - the words and the instant arrive together: `(response_text is null) = (response_saved_at is null)`,
--     so a row can never claim a response with no instant and never an instant with no response;
--   - the instant is inside the window it belongs to: `response_saved_at >= opened_at` and
--     `response_saved_at <= response_due_at`. A response the platform accepted is therefore a response
--     that beat the deadline by the database's own arithmetic, not by the service's opinion;
--   - `disputes_guard_response` refuses any change to the pair once `submitted_at` is set, because the
--     words are in the pack the compliance desk sent to the processor (STEP 198) and a later edit would
--     make the row disagree with the evidence;
--   - and it refuses a change on a resolved row, which `0039`'s own trigger already does for the status
--     and the outcome - a decided dispute is history, and its response is part of that history.
--
-- ## Why the window itself is not widened here
--
-- Section 19 allows the super administrator to extend the window to 48 hours "when needed". The column
-- and its check already allow that: `disputes_window_check` permits 24 and 48, `disputes_due_check`
-- allows any deadline up to `opened_at + response_window_hours`, and `disputes_guard_deadline` refuses to
-- change the window only after a submission. So the extension needs no schema: STEP 195's service moves
-- the window and the deadline together, inside the bound this file's check also reads, and the chain
-- records who did it and why.
--
-- ## What this file does not do
--
-- It does not touch `evidence_ready` or `submitted_at` (STEP 197/198 assemble and send the pack), it
-- writes no document row (the upload half of section 19's dispute interface is STEP 197's), and it does
-- not change any status: a response is not a state of the dispute, it is something the merchant did
-- inside one.

begin;

alter table public.disputes add column response_saved_at timestamptz;

comment on column public.disputes.response_saved_at is
  'When the merchant last saved the response, inside the window. Null until there is a response; frozen once the pack is sent.';

-- The words and the instant arrive together, and the instant is inside the window it belongs to.
alter table public.disputes
  add constraint disputes_response_saved_check check (
    (response_text is null) = (response_saved_at is null)
    and (
      response_saved_at is null
      or (response_saved_at >= opened_at and response_saved_at <= response_due_at)
    )
  );

comment on constraint disputes_response_saved_check on public.disputes is
  'A response carries its instant, and the instant is inside the section 19 window.';

-- A response, once it has been sent to the processor, is part of the evidence pack: 0039's trigger
-- guards the status and the outcome, and this one guards the merchant's words.
create function public.disputes_guard_response()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.response_text is not distinct from old.response_text
     and new.response_saved_at is not distinct from old.response_saved_at then
    return new;
  end if;

  if old.submitted_at is not null then
    raise exception 'a response is fixed once it has been sent to the processor'
      using errcode = 'check_violation';
  end if;

  if old.resolved_at is not null then
    raise exception 'a decided dispute keeps the response it was decided on'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.disputes_guard_response() is
  'Refuses a change to the merchant response once the pack was sent or the dispute was decided.';

create trigger disputes_guard_response
  before update on public.disputes
  for each row
  execute function public.disputes_guard_response();

-- The evidence builder of STEP 197 reads "answered, and not yet packed", merchant by merchant, oldest
-- answer first; this is the index that read needs.
create index disputes_response_idx
  on public.disputes (company_id, response_saved_at)
  where response_saved_at is not null and deleted_at is null;

commit;
