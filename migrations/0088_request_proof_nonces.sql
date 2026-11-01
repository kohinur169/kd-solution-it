-- path: migrations/0088_request_proof_nonces.sql
-- STEP 050 - a signed request cannot be played twice.
--
-- Section 22 asks for a per-device proof key and for a cookie that "works only inside its own
-- session". STEP 049 gave every browser that key; this STEP makes the sensitive endpoints require a
-- signature made with it. A signature carries a timestamp and a nonce, and the timestamp is what
-- bounds how long a captured request is worth anything - but a bound is not a refusal: inside those
-- two minutes the very same bytes are still a valid signature, and a network position that can read
-- one request can repeat it. The nonce is what makes the second copy worthless.
--
-- The row is the record of one spent nonce, not of one request: it holds the device, the nonce, the
-- method and the path that were signed, and the instant the nonce stops mattering. The unique index
-- on `(device_proof_key_id, nonce)` is the whole mechanism - the insert either takes the nonce or
-- collides, and a collision is a replay the service reports and audits.
--
-- Why the nonce is never renewed and the row is never updated: a spent nonce has to stay spent for
-- as long as its timestamp is inside the window, and a row that is rewritten is a row that could
-- accidentally free one. The cleanup job of a later STEP deletes rows whose `expires_at` has passed,
-- which is safe by construction because the window check refuses the request before the nonce is
-- looked at.
--
-- The path is stored without a query string, because a proof is refused when the URL carries one:
-- a parameter the signature does not cover is a parameter an attacker can change, so the platform
-- will not sign a request it cannot sign completely.

begin;

create table public.request_proof_nonces (
  id uuid not null default public.uuid_generate_v7(),
  company_id uuid,
  user_id uuid not null,
  device_proof_key_id uuid not null,
  nonce text not null,
  method text not null,
  path text not null,
  signed_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version integer not null default 1,
  constraint request_proof_nonces_pkey primary key (id),
  constraint request_proof_nonces_company_fkey foreign key (company_id)
    references public.companies (id),
  constraint request_proof_nonces_user_fkey foreign key (user_id)
    references public.users (id),
  constraint request_proof_nonces_user_device_fkey foreign key (user_id, device_proof_key_id)
    references public.device_proof_keys (user_id, id),
  constraint request_proof_nonces_nonce_check check (
    nonce ~ '^[A-Za-z0-9_-]{16,64}$'
  ),
  constraint request_proof_nonces_method_check check (
    method in ('POST', 'PATCH', 'PUT', 'DELETE')
  ),
  constraint request_proof_nonces_path_check check (
    path ~ '^/[A-Za-z0-9/_.-]{1,200}$'
  ),
  constraint request_proof_nonces_window_check check (
    expires_at > signed_at and expires_at <= signed_at + interval '10 minutes'
  ),
  constraint request_proof_nonces_version_positive_check check (version > 0),
  constraint request_proof_nonces_updated_after_creation_check check (updated_at >= created_at),
  constraint request_proof_nonces_deleted_after_creation_check
    check (deleted_at is null or deleted_at >= created_at)
);

comment on table public.request_proof_nonces is
  'One spent device proof nonce. The unique pair with the device is the replay guard.';

comment on column public.request_proof_nonces.user_id is
  'The account whose device signed the request. Paired with the device by the composite foreign key.';

comment on column public.request_proof_nonces.device_proof_key_id is
  'The enrolled key that signed. A nonce is unique per device, not per account.';

comment on column public.request_proof_nonces.nonce is
  'The random value the client signed, base64url. Never reused by a correct client.';

comment on column public.request_proof_nonces.method is
  'The request method that was signed. Only methods that mutate are signed.';

comment on column public.request_proof_nonces.path is
  'The pathname that was signed, without a query string: a query is refused, not covered.';

comment on column public.request_proof_nonces.signed_at is
  'The client instant the signature named, which the window check already bounded.';

comment on column public.request_proof_nonces.expires_at is
  'When the signature itself stops being acceptable. The cleanup job deletes rows past it.';

-- The replay guard: one nonce per device, ever.
create unique index request_proof_nonces_device_nonce_key
  on public.request_proof_nonces (device_proof_key_id, nonce);

-- The cleanup job of a later STEP: rows whose signature has expired.
create index request_proof_nonces_expiry_idx
  on public.request_proof_nonces (expires_at);

-- The account's own trail, if the session screen of STEP 054 ever shows it.
create index request_proof_nonces_user_idx
  on public.request_proof_nonces (user_id, signed_at desc);

create trigger request_proof_nonces_set_row_metadata
  before update on public.request_proof_nonces
  for each row
  execute function public.set_row_metadata();

alter table public.request_proof_nonces enable row level security;

create policy request_proof_nonces_default_deny
  on public.request_proof_nonces
  as permissive
  for all
  to public
  using (false)
  with check (false);

commit;
