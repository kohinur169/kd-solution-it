-- path: migrations/0002_job_queue.sql
-- STEP 012 - the background jobs queue.
--
-- This table is the durable form of the `JobRecord` contract that STEP 011 defines in
-- `lib/jobs/queue.ts`: a named job, a validated payload, an attempt counter against a ceiling, an
-- optional idempotency key, the trace id of the request that caused it, a time it becomes
-- eligible, the lease held by the worker that claimed it, and the last error code. A row walks
-- pending -> running -> completed, or running -> retrying -> running, or running -> failed.
--
-- `company_id` is nullable on purpose. Platform work - the audit hash root, a cross tenant
-- reconciliation, the compliance calendar - has no tenant, and forcing a fake company row to hold
-- it would be a lie that outlives whoever wrote it. A tenant job sets the column and the
-- foreign key keeps it honest.
--
-- The two hot queries a worker runs are "the next eligible job" and "which lease expired", so
-- each has a partial index that holds only the rows it can return. The store STEP adds the
-- `for update skip locked` clause; this migration makes that clause cheap.
--
-- One transaction, like every migration here.

begin;

create table public.job_queue (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  name text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt integer not null default 0,
  max_attempts integer not null default 5,
  idempotency_key text,
  trace_id text not null,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint job_queue_pkey primary key (id),
  constraint job_queue_company_fkey foreign key (company_id) references public.companies (id),
  constraint job_queue_name_format_check check (
    char_length(name) between 1 and 120
    and name ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*$'
  ),
  constraint job_queue_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint job_queue_status_check check (
    status in ('pending', 'running', 'retrying', 'completed', 'failed')
  ),
  constraint job_queue_max_attempts_check check (max_attempts between 1 and 20),
  constraint job_queue_attempt_check check (attempt >= 0 and attempt <= max_attempts),
  constraint job_queue_lease_check check (
    (status = 'running') = (lease_expires_at is not null)
  ),
  constraint job_queue_idempotency_key_check check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 200
  ),
  constraint job_queue_trace_id_check check (trace_id ~ '^req_[A-Za-z0-9._-]{8,128}$'),
  constraint job_queue_last_error_code_check check (
    last_error_code is null or char_length(last_error_code) between 1 and 64
  ),
  constraint job_queue_version_positive_check check (version > 0),
  constraint job_queue_updated_after_creation_check check (updated_at >= created_at),
  constraint job_queue_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.job_queue is
  'Background work. One row per unit of work; claimed with a lease and settled by the worker.';

comment on column public.job_queue.company_id is
  'Tenant that owns the work, or null for platform wide jobs. References companies(id).';

comment on column public.job_queue.name is
  'Registered job name, lower case and dot separated, for example invoice.recurring.generate.';

comment on column public.job_queue.payload is
  'Validated job input. Always a jsonb object; the shape is enforced by the job schema in code.';

comment on column public.job_queue.status is
  'pending, running, retrying, completed or failed. The same five values the worker handles.';

comment on column public.job_queue.attempt is
  'Attempts started so far. Never above max_attempts, so a job cannot retry for ever.';

comment on column public.job_queue.max_attempts is
  'Attempt ceiling for this row, taken from the job definition when it was enqueued.';

comment on column public.job_queue.idempotency_key is
  'Optional caller key. Unique per tenant while the row is not deleted, so a retried request enqueues once.';

comment on column public.job_queue.trace_id is
  'Request id of the caller or schedule that produced the job, so its log lines correlate.';

comment on column public.job_queue.available_at is
  'Earliest instant the job may be claimed. Backoff moves this forward.';

comment on column public.job_queue.lease_expires_at is
  'Set exactly while the row is running. An expired lease returns the job to the queue.';

comment on column public.job_queue.last_error_code is
  'Catalog code of the last failure, or LEASE_EXPIRED. Never a message.';

comment on column public.job_queue.deleted_at is
  'Soft delete marker. Work is retained for audit; it is never removed by a request.';

-- The claim path: only waiting rows, in the order they become eligible.
create index job_queue_claim_idx
  on public.job_queue (available_at, created_at)
  where deleted_at is null and status in ('pending', 'retrying');

-- The stall path: only claimed rows, so an expired lease is found without reading the table.
create index job_queue_lease_idx
  on public.job_queue (lease_expires_at)
  where deleted_at is null and status = 'running';

-- Health counts per status, without scanning the finished rows.
create index job_queue_status_idx
  on public.job_queue (status)
  where deleted_at is null;

-- Idempotency for tenant work and for platform work, without a sentinel company row.
create unique index job_queue_idempotency_company_key
  on public.job_queue (company_id, idempotency_key)
  where idempotency_key is not null and company_id is not null and deleted_at is null;

create unique index job_queue_idempotency_platform_key
  on public.job_queue (idempotency_key)
  where idempotency_key is not null and company_id is null and deleted_at is null;

-- A tenant's job history, newest first.
create index job_queue_company_created_idx
  on public.job_queue (company_id, created_at desc)
  where deleted_at is null;

create trigger job_queue_set_row_metadata
  before update on public.job_queue
  for each row
  execute function public.set_row_metadata();

alter table public.job_queue enable row level security;

create policy job_queue_default_deny
  on public.job_queue
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
