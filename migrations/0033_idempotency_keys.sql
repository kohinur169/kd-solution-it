-- path: migrations/0033_idempotency_keys.sql
-- STEP 023 - the idempotency keys of MASTER_PROMPT rule 12.
--
-- "Every payment carries an idempotency key." The key arrives from the caller in a header, the
-- platform hashes it, and what is stored is the hash: a caller that retries a request because a
-- response was lost must get the first answer, not a second charge, and the row is what makes that
-- possible.
--
-- The key is scoped to its tenant and to what it protects. `(company_id, scope, key_hash)` is unique,
-- so the same string used by two merchants is two rows and a replay inside one merchant is one row,
-- and `scope` keeps a refund from being mistaken for the payment it refunds. `request_hash` records
-- what the first attempt asked for; a key reused with a different body is refused by the caller
-- comparing the two, which is the standard rule and not something a check can see.
--
-- The row has three states. `in_flight` means the first attempt is still running and a second
-- caller must wait rather than start a second charge. `completed` carries the status and the body
-- to replay, and `failed` carries the detail of the refusal. The guard below freezes the identity
-- of the key and refuses a row that goes back to `in_flight`, so a decided key cannot be reopened by
-- a later writer.
--
-- `expires_at` is the window the platform keeps an answer for, and the cleanup job of section 27
-- reads it through `idempotency_keys_expiry_idx`.

begin;

create function public.idempotency_keys_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id
     or new.scope is distinct from old.scope
     or new.key_hash is distinct from old.key_hash
     or new.request_hash is distinct from old.request_hash then
    raise exception 'an idempotency key keeps its identity'
      using errcode = 'check_violation';
  end if;

  if new.expires_at is distinct from old.expires_at then
    raise exception 'an idempotency key keeps its window'
      using errcode = 'check_violation';
  end if;

  if old.state = 'completed'
     and (new.state is distinct from old.state
          or new.response_status is distinct from old.response_status
          or new.response_body is distinct from old.response_body) then
    raise exception 'a completed idempotency key keeps its answer'
      using errcode = 'check_violation';
  end if;

  if old.state <> 'in_flight' and new.state = 'in_flight' then
    raise exception 'an idempotency key is decided once'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.idempotency_keys_guard_state() is
  'Freezes the identity of a key and refuses a decided key that returns to flight.';

create table public.idempotency_keys (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid not null,
  scope text not null default 'payment',
  key_hash text not null,
  request_hash text not null,
  state text not null default 'in_flight',
  response_status integer,
  response_body text,
  error_detail text,
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint idempotency_keys_pkey primary key (id),
  constraint idempotency_keys_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint idempotency_keys_scope_check check (scope in ('payment', 'refund', 'payout')),
  constraint idempotency_keys_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_keys_request_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_keys_state_check check (state in ('in_flight', 'completed', 'failed')),
  constraint idempotency_keys_completed_check check (
    (state = 'completed') = (completed_at is not null)
  ),
  constraint idempotency_keys_response_check check (
    (state = 'completed'
      and response_status is not null
      and response_status between 100 and 599
      and response_body is not null)
    or (state <> 'completed' and response_status is null and response_body is null)
  ),
  constraint idempotency_keys_body_check check (
    response_body is null or char_length(response_body) between 2 and 20000
  ),
  constraint idempotency_keys_error_check check (
    (state = 'failed'
      and error_detail is not null
      and char_length(error_detail) between 1 and 280
      and error_detail = btrim(error_detail))
    or (state <> 'failed' and error_detail is null)
  ),
  constraint idempotency_keys_expiry_check check (expires_at > created_at),
  constraint idempotency_keys_row_version_check check (version > 0),
  constraint idempotency_keys_updated_check check (updated_at >= created_at),
  constraint idempotency_keys_deleted_check check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.idempotency_keys is
  'One row per caller key per tenant and scope, holding the answer a retry must receive.';

comment on column public.idempotency_keys.id is
  'UUID v7 primary key. Time ordered, generated by public.uuid_generate_v7().';

comment on column public.idempotency_keys.company_id is
  'The merchant the request belongs to. The same key in another merchant is another row.';

comment on column public.idempotency_keys.scope is
  'payment, refund or payout: what the key protects, so a refund never replays a payment.';

comment on column public.idempotency_keys.key_hash is
  'SHA-256 of the caller key. The caller string is never stored.';

comment on column public.idempotency_keys.request_hash is
  'SHA-256 of the first request body, so a key reused for another body is refused.';

comment on column public.idempotency_keys.state is
  'in_flight while the first attempt runs, completed with its answer, failed with its reason.';

comment on column public.idempotency_keys.response_status is
  'The HTTP status to replay, present exactly when the state is completed.';

comment on column public.idempotency_keys.response_body is
  'The JSON body to replay, present exactly when the state is completed, at most 20000 characters.';

comment on column public.idempotency_keys.error_detail is
  'Why the attempt failed, at most 280 characters, present exactly on a failed key.';

comment on column public.idempotency_keys.completed_at is
  'Set exactly when the state is completed.';

comment on column public.idempotency_keys.expires_at is
  'The end of the replay window. The cleanup job of section 27 reads it.';

comment on column public.idempotency_keys.created_at is
  'When the first attempt registered the key.';

comment on column public.idempotency_keys.updated_at is
  'Set by the idempotency_keys_set_row_metadata trigger on every update.';

comment on column public.idempotency_keys.deleted_at is
  'Soft delete marker. A removed key stays readable for the payment it guarded.';

comment on column public.idempotency_keys.version is
  'Optimistic locking counter. Incremented by the idempotency_keys_set_row_metadata trigger.';

-- One key per tenant per scope: a replay finds its row, another merchant's row is elsewhere.
create unique index idempotency_keys_request_key
  on public.idempotency_keys (company_id, scope, key_hash);

-- The cleanup job: the windows that have passed.
create index idempotency_keys_expiry_idx
  on public.idempotency_keys (expires_at);

-- One merchant's keys, newest first, for support.
create index idempotency_keys_company_idx
  on public.idempotency_keys (company_id, created_at desc);

create trigger idempotency_keys_guard_state
  before update on public.idempotency_keys
  for each row
  execute function public.idempotency_keys_guard_state();

create trigger idempotency_keys_set_row_metadata
  before update on public.idempotency_keys
  for each row
  execute function public.set_row_metadata();

alter table public.idempotency_keys enable row level security;

create policy idempotency_keys_default_deny
  on public.idempotency_keys
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
