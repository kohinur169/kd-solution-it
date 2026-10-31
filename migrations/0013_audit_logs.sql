-- path: migrations/0013_audit_logs.sql
-- STEP 017 - the append-only hash chain behind every audit entry.
--
-- Section 1 requires an "audit log entry on every mutation", and section 1 also requires it to be a
-- "hash-chained append-only audit log with Ed25519 signing". This table is that log.
--
-- Three properties make it evidence rather than a diary:
--
--   1. Append-only. A before-update and before-delete trigger raises, so no role, including the
--      table owner, can rewrite or remove a row. `deleted_at` exists because every table carries
--      the six audit columns, and it is deliberately unreachable.
--   2. Hash-chained. Each row carries `prev_hash`, the hash of the row before it in its chain, and
--      `hash`, computed by the service over a canonical string. A before-insert trigger refuses a
--      row that does not sit on the current head of its chain, so a fork or a gap cannot be written
--      in the first place.
--   3. Signed. `signature` is the base64url Ed25519 signature of the 32 byte `hash`, and
--      `signing_key_id` names the key, so rotating the signing key does not invalidate history.
--
-- Chains are per tenant. `chain_id` is a generated column equal to `company_id`, or to the zero
-- uuid for platform events (company_id null), so a merchant's chain never depends on another
-- merchant's writes and platform events share one chain. A single global chain would serialise
-- every audit write in the platform behind one head.
--
-- The hash is computed by the service over this exact canonical string, versioned as "v1":
--
--   v1|chain_id|sequence|created_at (ISO 8601 UTC, microseconds)|actor_user_id|action|
--   entity_type|entity_id|payload (canonical json, keys sorted)|prev_hash
--
-- digested with SHA-256 and written as 64 lower case hex characters. The definition lives here once
-- because a second, slightly different definition would make every later verification meaningless.
-- The database cannot recompute it; it guarantees the shape, the link to the previous row, and the
-- refusal of any later edit.
--
-- Merkle roots (sections 27 and 31) are derived from `chain_id`, `sequence` and `hash` by the export
-- job; this table holds the leaves and deliberately no roots of its own.

begin;

create table public.audit_logs (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  chain_id uuid generated always as (
    coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) stored not null,
  sequence bigint not null,
  actor_user_id uuid,
  action text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  session_id uuid,
  ip_address inet,
  user_agent text,
  prev_hash text not null,
  hash text not null,
  signature text not null,
  signing_key_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint audit_logs_pkey primary key (id),
  constraint audit_logs_company_fkey foreign key (company_id) references public.companies (id),
  constraint audit_logs_actor_fkey foreign key (actor_user_id) references public.users (id),
  constraint audit_logs_session_fkey foreign key (session_id) references public.sessions (id),
  constraint audit_logs_sequence_positive_check check (sequence > 0),
  constraint audit_logs_action_check check (
    action ~ '^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$' and char_length(action) <= 64
  ),
  constraint audit_logs_entity_type_check check (
    entity_type is null
    or (entity_type ~ '^[a-z][a-z0-9_]*$' and char_length(entity_type) <= 48)
  ),
  constraint audit_logs_entity_pair_check check ((entity_type is null) = (entity_id is null)),
  constraint audit_logs_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 8192
  ),
  constraint audit_logs_prev_hash_check check (prev_hash ~ '^[0-9a-f]{64}$'),
  constraint audit_logs_hash_check check (hash ~ '^[0-9a-f]{64}$'),
  constraint audit_logs_hash_differs_check check (hash <> prev_hash),
  constraint audit_logs_signature_check check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  constraint audit_logs_signing_key_check check (signing_key_id ~ '^[a-z0-9][a-z0-9-]{2,47}$'),
  constraint audit_logs_ip_address_check check (ip_address is null or family(ip_address) in (4, 6)),
  constraint audit_logs_user_agent_check check (
    user_agent is null or char_length(user_agent) between 1 and 512
  ),
  constraint audit_logs_version_positive_check check (version > 0),
  constraint audit_logs_updated_after_creation_check check (updated_at >= created_at),
  constraint audit_logs_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.audit_logs is
  'Append-only, hash-chained, Ed25519 signed audit log. One row per mutation, one chain per tenant.';

comment on column public.audit_logs.company_id is
  'Tenant of the event, or null for a platform event; the chain is derived from this column.';

comment on column public.audit_logs.chain_id is
  'Generated: company_id, or the zero uuid for platform events. Every row is chained within one chain_id.';

comment on column public.audit_logs.sequence is
  'Position in the chain, starting at 1 and gapless. The trigger refuses anything but the head plus one.';

comment on column public.audit_logs.actor_user_id is
  'Who acted, or null when the platform acted on its own, such as a scheduled job or a webhook.';

comment on column public.audit_logs.action is
  'Dotted key such as session.revoked or payout.released. The catalog of actions lives in code.';

comment on column public.audit_logs.entity_type is
  'Type of the subject of the action, lower snake case, set together with entity_id.';

comment on column public.audit_logs.entity_id is
  'Identifier of the subject. Not a foreign key, because the log outlives every row it describes.';

comment on column public.audit_logs.payload is
  'Before and after values and other context. A JSON object, at most 8192 bytes, never a secret.';

comment on column public.audit_logs.session_id is
  'Session that caused the event, when there was one. Background jobs have none.';

comment on column public.audit_logs.ip_address is
  'Origin of the request, when the event came from one.';

comment on column public.audit_logs.user_agent is
  'Client user agent, at most 512 characters, for the events that carry one.';

comment on column public.audit_logs.prev_hash is
  'The previous row hash in this chain, or sixty-four zeros for the first row of a chain.';

comment on column public.audit_logs.hash is
  'SHA-256 of the canonical string documented in this file, lower case hex and unique.';

comment on column public.audit_logs.signature is
  'Base64url Ed25519 signature over the 32 byte hash, eighty-six characters.';

comment on column public.audit_logs.signing_key_id is
  'Which signing key produced the signature, so a rotation does not invalidate older rows.';

comment on column public.audit_logs.created_at is
  'The event instant, and an input of the hash.';

comment on column public.audit_logs.deleted_at is
  'Present because every table carries the audit columns. Unreachable: the append-only guard refuses removal.';

-- One position per chain, so two writers cannot take the same slot.
create unique index audit_logs_chain_key on public.audit_logs (chain_id, sequence);

-- One hash per row, so a copied hash is refused.
create unique index audit_logs_hash_key on public.audit_logs (hash);

-- "What happened in this tenant, most recent first".
create index audit_logs_company_idx on public.audit_logs (company_id, created_at desc)
  where deleted_at is null;

-- "What did this person do".
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, created_at desc)
  where actor_user_id is not null and deleted_at is null;

-- "Every session.revoked, every unlock".
create index audit_logs_action_idx on public.audit_logs (action, created_at desc)
  where deleted_at is null;

-- "The history of this invoice".
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id)
  where entity_id is not null and deleted_at is null;

-- "Everything that happened in this session".
create index audit_logs_session_idx on public.audit_logs (session_id)
  where session_id is not null and deleted_at is null;

-- The guard that makes the table append-only.
create function public.audit_logs_reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'restrict_violation',
    message = format('public.audit_logs is append-only: %s is not permitted', tg_op);
end;
$$;

comment on function public.audit_logs_reject_mutation() is
  'Refuses every update and every removal on public.audit_logs, whatever role asks.';

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row
  execute function public.audit_logs_reject_mutation();

-- The guard that keeps one chain per tenant gapless and linked.
create function public.audit_logs_guard_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chain uuid := coalesce(new.company_id, '00000000-0000-0000-0000-000000000000'::uuid);
  head_sequence bigint;
  head_hash text;
begin
  -- The stored generated column is filled after the before-insert triggers run, so the chain is
  -- derived here from company_id exactly as the column will derive it.
  select a.sequence, a.hash
    into head_sequence, head_hash
    from public.audit_logs a
   where a.chain_id = chain
   order by a.sequence desc
   limit 1;

  if head_sequence is null then
    if new.sequence <> 1 then
      raise exception using
        errcode = 'check_violation',
        message = format('audit chain %s starts at sequence 1, not %s', chain, new.sequence);
    end if;

    if new.prev_hash <> repeat('0', 64) then
      raise exception using
        errcode = 'check_violation',
        message = format('the first row of audit chain %s must link to the genesis hash', chain);
    end if;

    return new;
  end if;

  if new.sequence <> head_sequence + 1 then
    raise exception using
      errcode = 'check_violation',
      message = format('audit chain %s expects sequence %s, got %s',
                       chain, head_sequence + 1, new.sequence);
  end if;

  if new.prev_hash <> head_hash then
    raise exception using
      errcode = 'check_violation',
      message = format('audit row at sequence %s of chain %s does not link to the current head',
                       new.sequence, chain);
  end if;

  return new;
end;
$$;

comment on function public.audit_logs_guard_chain() is
  'Refuses an audit row whose sequence or prev_hash does not extend the current head of its chain.';

create trigger audit_logs_chain_guard
  before insert on public.audit_logs
  for each row
  execute function public.audit_logs_guard_chain();

alter table public.audit_logs enable row level security;

create policy audit_logs_default_deny
  on public.audit_logs
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
