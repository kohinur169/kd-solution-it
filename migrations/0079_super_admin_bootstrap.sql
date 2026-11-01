-- path: migrations/0079_super_admin_bootstrap.sql
-- STEP 036 - the first account, and the only way the platform can be opened.
--
-- Sections 2 and 33 require a super_admin from the first day, and section 33 makes the first
-- super_admin account with enforced two factor authentication one of the go live gates. Until an
-- account exists nobody can sign in, so nothing in the dashboard can create one: the first account
-- has to come from the database itself. This file is that path, and it is deliberately the only
-- one.
--
-- What one run does, in one transaction:
--
--   1. creates one `users` row, verified, with the password hash the operator supplies;
--   2. grants it `super_admin` with `granted_by` null, which is the bootstrap grant `0004` names;
--   3. publishes the twelve policy pages of section 3 that `0078` seeded as drafts, with this
--      person as the publisher, because a page a merchant must accept at signup cannot stay a
--      draft and no editor exists yet;
--   4. writes one audit row for the whole action on the platform chain.
--
-- It runs once. A live super_admin, an account that already uses the address, or a second run in
-- the same session all fail, and the failure is a refusal rather than a quiet second administrator.
--
-- ## Why the caller supplies four of the audit values
--
-- `0013` requires every audit row to carry an Ed25519 signature over its hash, and rule 9 forbids a
-- migration from creating an extension, so PostgreSQL cannot sign. The service that holds
-- `AUDIT_SIGNING_KEY` signs instead, which means the operator signs *before* the row exists and
-- must therefore know the hash before calling. So the caller chooses the account id and the
-- instant, asks the database for the current head of the platform chain and for the hash of the row
-- it is about to write, signs that hash, and passes both back. This function then recomputes the
-- hash from the same inputs and refuses when the two disagree, so a caller can neither forge a
-- sequence, nor move the head between reading and writing, nor write a row whose hash is not the
-- canonical one. The signature is the operator's proof; the hash is the database's.
--
-- The preparation query is therefore exactly this, and the runbook in the handoff file repeats it:
--
--   select head.next_sequence, head.prev_hash,
--          public.audit_hash_v1(
--            public.audit_platform_chain(), head.next_sequence, :instant, null,
--            'platform.super_admin_bootstrapped', 'user', :user_id, :payload, head.prev_hash
--          ) as hash
--     from public.audit_next_link(public.audit_platform_chain()) as head;
--
-- ## What it does not do
--
-- It does not create a TOTP secret, a session, a company or a plan. Two factor authentication is
-- enrolled at first sign in, and section 22 keeps that mandatory: `users.totp_confirmed_at` is the
-- gate the authentication STEP reads, and it is null here because no human has enrolled yet. The
-- account is verified because the operator who holds the database credential has proved the address
-- more strongly than an email link does, and that choice is recorded here rather than assumed.

begin;

create function public.audit_platform_chain()
returns uuid
language sql
immutable
set search_path = ''
as $$
  select '00000000-0000-0000-0000-000000000000'::uuid;
$$;

comment on function public.audit_platform_chain() is
  'The chain_id of platform events: the zero uuid, which is what the generated chain_id of a null company_id is.';

create function public.bootstrap_super_admin(
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_password_hash text,
  p_bootstrapped_at timestamptz,
  p_payload jsonb,
  p_hash text,
  p_signature text,
  p_signing_key_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  chain uuid := public.audit_platform_chain();
  next_sequence bigint;
  head_hash text;
  computed_hash text;
  published_pages integer;
begin
  if exists (
    select 1
      from public.role_assignments assignment
     where assignment.role = 'super_admin'
       and assignment.revoked_at is null
       and assignment.deleted_at is null
  ) then
    raise exception using
      errcode = 'unique_violation',
      message = 'a live super_admin already exists: the bootstrap runs once per database';
  end if;

  if p_user_id is null then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the bootstrap needs the id of the account it creates';
  end if;

  if p_email is null
     or char_length(p_email) not between 5 and 254
     or p_email <> lower(btrim(p_email))
     or p_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the email must be a lower case address of 5 to 254 characters, with no padding';
  end if;

  if p_full_name is null
     or char_length(p_full_name) not between 1 and 120
     or p_full_name <> btrim(p_full_name) then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the full name must be 1 to 120 characters, trimmed';
  end if;

  if p_password_hash is null or char_length(p_password_hash) not between 20 and 255 then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the password hash must be the stored hash of a password, 20 to 255 characters';
  end if;

  if p_bootstrapped_at is null
     or p_bootstrapped_at > clock_timestamp()
     or p_bootstrapped_at < clock_timestamp() - interval '5 minutes' then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the bootstrap instant must be within the last five minutes and never in the future';
  end if;

  if p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 8192 then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the audit payload must be a json object of at most 8192 bytes';
  end if;

  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the audit hash must be 64 lower case hexadecimal characters';
  end if;

  if p_signature is null or p_signature !~ '^[A-Za-z0-9_-]{86}$' then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the audit signature must be 86 base64url characters';
  end if;

  if p_signing_key_id is null or p_signing_key_id !~ '^[a-z0-9][a-z0-9-]{2,47}$' then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'the signing key id must be 3 to 48 lower case characters, digits and hyphens';
  end if;

  if exists (select 1 from public.users existing where existing.email = p_email) then
    raise exception using
      errcode = 'unique_violation',
      message = 'an account already uses this email address';
  end if;

  select link.next_sequence, link.prev_hash
    into next_sequence, head_hash
    from public.audit_next_link(chain) as link;

  computed_hash := public.audit_hash_v1(
    chain,
    next_sequence,
    p_bootstrapped_at,
    null,
    'platform.super_admin_bootstrapped',
    'user',
    p_user_id,
    p_payload,
    head_hash
  );

  if computed_hash <> p_hash then
    raise exception using
      errcode = 'check_violation',
      message = 'the audit hash does not match the current head of the platform chain: prepare and sign again';
  end if;

  insert into public.users (
    id, email, full_name, password_hash, email_verified_at, status, created_at
  ) values (
    p_user_id, p_email, p_full_name, p_password_hash, p_bootstrapped_at, 'active', p_bootstrapped_at
  );

  insert into public.role_assignments (
    user_id, role, granted_by, granted_at, created_at
  ) values (
    p_user_id, 'super_admin', null, p_bootstrapped_at, p_bootstrapped_at
  );

  update public.cms_pages
     set status = 'published',
         published_at = p_bootstrapped_at,
         published_by = p_user_id
   where policy_key is not null
     and status = 'draft'
     and deleted_at is null;

  get diagnostics published_pages = row_count;

  if published_pages <> 12 then
    raise exception using
      errcode = 'check_violation',
      message = format('the twelve policy pages of section 3 must be present as drafts, found %s',
                       published_pages);
  end if;

  insert into public.audit_logs (
    company_id, sequence, actor_user_id, action, entity_type, entity_id, payload,
    prev_hash, hash, signature, signing_key_id, created_at
  ) values (
    null, next_sequence, null, 'platform.super_admin_bootstrapped', 'user', p_user_id, p_payload,
    head_hash, computed_hash, p_signature, p_signing_key_id, p_bootstrapped_at
  );

  return p_user_id;
end;
$$;

comment on function public.bootstrap_super_admin(uuid, text, text, text, timestamptz, jsonb, text, text, text) is
  'Creates the first super_admin, grants the role, publishes the twelve policy pages and audits it, once per database.';

-- The bootstrap is the operator's action, not an application endpoint. The default grant would let
-- every role call it, including a signed in merchant session, so it is taken away.
revoke all on function public.bootstrap_super_admin(uuid, text, text, text, timestamptz, jsonb, text, text, text) from public;

commit;
