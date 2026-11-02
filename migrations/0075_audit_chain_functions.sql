-- path: migrations/0075_audit_chain_functions.sql
-- STEP 036 - the one implementation of the audit hash chain.
--
-- `0013_audit_logs.sql` states that the canonical string of an audit row is versioned "v1" and
-- composed of chain_id, sequence, created_at, actor_user_id, action, entity_type, entity_id,
-- payload and prev_hash, digested with SHA-256 and written as 64 lower case hex characters. That
-- file also says the definition lives there once because a second, slightly different definition
-- would make every later verification meaningless. Until now the definition existed only as that
-- comment, so every writer that arrived later could have read it slightly differently. This file
-- turns the comment into executable SQL: one function writes canonical JSON, one hashes a row, one
-- recomputes a stored row, one returns the link a writer must extend, one verifies a chain and names
-- its first break, one returns the genesis link, and one returns the Merkle root of a range.
--
-- What this file deliberately does not do is sign. Ed25519 is not in PostgreSQL core and rule 9
-- forbids a migration from creating an extension, so `signature` and `signing_key_id` are written
-- by the service that holds `AUDIT_SIGNING_KEY`. The database can therefore prove the shape of a
-- row, the link to its predecessor and the arithmetic of the hash, which is what makes tampering
-- detectable; the signature is the second, independent proof, and it is checked by the export job
-- of section 27 with the public half of the same key.
--
-- Three details are fixed here because the hash is only reproducible if they are:
--
--   1. A null field is the empty string. `actor_user_id`, `entity_type` and `entity_id` are
--      nullable in the table and each contributes an empty segment, so the segment count of the
--      string never depends on the values.
--   2. `created_at` is written as ISO 8601 in UTC with exactly six fractional digits, such as
--      2026-11-01T08:00:00.123456Z, which is the microsecond precision the column stores.
--   3. The payload is canonical JSON: keys sorted bytewise by their UTF-8 bytes, no whitespace,
--      arrays in their stored order, and every scalar written the way `jsonb` prints it. Key names
--      in this platform are lower snake case ASCII, which is why a bytewise order is unambiguous.
--
-- The canonical string is then these ten segments joined by a vertical bar:
--
--   v1 | chain_id | sequence | created_at | actor_user_id | action | entity_type | entity_id |
--   payload | prev_hash
--
-- The function returns the SHA-256 of the UTF-8 bytes of that string. A verification walks a
-- chain in sequence order, recomputes the hash of every row from its stored values, compares it
-- with the stored hash, and checks that each row's prev_hash is the hash of the row before it, so
-- a rewritten row, a swapped row, a removed row and an inserted row all leave a break with the
-- sequence number where it happened.
--
-- The Merkle root covers a range of the chain and is built from the stored row hashes, so an
-- export can publish one 64 character value for a day of the log and a holder can later check any
-- single row against it. Two constants make that root well defined: a leaf is
-- SHA-256(0x00 || hash bytes) and an internal node is SHA-256(0x01 || left || right), the domain
-- separation of RFC 6962, which stops a crafted intermediate node from being passed off as a
-- leaf; an odd node at the end of a level is paired with itself, so the root of a range with three
-- rows is the root of the two pairs (1,2) and (3,3).
--
-- None of these functions writes, and none of them can be tricked into signing: they are read
-- only, they take the values they are given, and the table itself still refuses every update and
-- every removal through `audit_logs_append_only`.

begin;

-- The link a first row of a chain carries: sixty-four zeros, per `0013`.
create function public.audit_genesis_hash()
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.repeat('0', 64);
$$;

comment on function public.audit_genesis_hash() is
  'The prev_hash of the first row of every audit chain: sixty-four zeros.';

-- Canonical JSON: keys sorted bytewise, no whitespace, arrays in order.
create function public.audit_canonical_json(payload jsonb)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  rendered text;
begin
  case pg_catalog.jsonb_typeof(payload)
    when 'object' then
      select coalesce(
               '{' || pg_catalog.string_agg(
                 pg_catalog.to_jsonb(member.key)::text || ':' ||
                 public.audit_canonical_json(member.value),
                 ',' order by member.key collate "C"
               ) || '}',
               '{}'
             )
        into rendered
        from pg_catalog.jsonb_each(payload) as member(key, value);

      return rendered;

    when 'array' then
      select coalesce(
               '[' || pg_catalog.string_agg(
                 public.audit_canonical_json(element.value),
                 ',' order by element.position
               ) || ']',
               '[]'
             )
        into rendered
        from pg_catalog.jsonb_array_elements(payload) with ordinality
             as element(value, position);

      return rendered;

    else
      -- A string, a number, a boolean or the null literal prints itself in JSON already.
      return payload::text;
  end case;
end;
$$;

comment on function public.audit_canonical_json(jsonb) is
  'Canonical JSON text of a payload: keys sorted bytewise, compact separators, arrays in order.';

-- The hash of one audit row, version 1 of the canonical string.
create function public.audit_hash_v1(
  chain uuid,
  sequence bigint,
  created_at timestamptz,
  actor_user_id uuid,
  action text,
  entity_type text,
  entity_id uuid,
  payload jsonb,
  prev_hash text
)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               pg_catalog.concat_ws(
                 '|',
                 'v1',
                 chain::text,
                 sequence::text,
                 pg_catalog.to_char(
                   created_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                 ),
                 coalesce(actor_user_id::text, ''),
                 action,
                 coalesce(entity_type, ''),
                 coalesce(entity_id::text, ''),
                 public.audit_canonical_json(payload),
                 prev_hash
               ),
               'UTF8'
             )
           ),
           'hex'
         );
$$;

comment on function public.audit_hash_v1(uuid, bigint, timestamptz, uuid, text, text, uuid, jsonb, text) is
  'SHA-256 of the canonical v1 string of one audit row, as 64 lower case hex characters.';

-- The hash of a stored row, recomputed from the columns that are covered by it.
create function public.audit_log_row_hash(entry public.audit_logs)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select public.audit_hash_v1(
           entry.chain_id,
           entry.sequence,
           entry.created_at,
           entry.actor_user_id,
           entry.action,
           entry.entity_type,
           entry.entity_id,
           entry.payload,
           entry.prev_hash
         );
$$;

comment on function public.audit_log_row_hash(public.audit_logs) is
  'Recomputes the v1 hash of a stored audit row, so verification never trusts the stored hash.';

-- The slot a writer must fill next: the sequence after the current head and the head hash.
create function public.audit_next_link(p_chain uuid)
returns table (next_sequence bigint, prev_hash text)
language plpgsql
stable
set search_path = ''
as $$
declare
  head_sequence bigint;
  head_hash text;
begin
  select entry.sequence, entry.hash
    into head_sequence, head_hash
    from public.audit_logs entry
   where entry.chain_id = p_chain
   order by entry.sequence desc
   limit 1;

  if head_sequence is null then
    return query select 1::bigint, public.audit_genesis_hash();
    return;
  end if;

  return query select head_sequence + 1, head_hash;
end;
$$;

comment on function public.audit_next_link(uuid) is
  'The sequence and prev_hash the next row of a chain must carry, read from the current head.';

-- A full verification of a range of one chain.
create function public.audit_verify_chain(
  p_chain uuid,
  p_from_sequence bigint default 1,
  p_to_sequence bigint default null
)
returns table (
  chain_id uuid,
  checked_rows bigint,
  is_valid boolean,
  first_broken_sequence bigint,
  broken_reason text,
  head_sequence bigint,
  head_hash text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  entry public.audit_logs;
  expected_prev text;
  expected_sequence bigint := p_from_sequence;
  checked bigint := 0;
  last_sequence bigint;
  last_hash text;
begin
  if p_from_sequence is null or p_from_sequence < 1 then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'a verification starts at sequence 1 or later';
  end if;

  if p_to_sequence is not null and p_to_sequence < p_from_sequence then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = format('the range ends at %s before it starts at %s',
                       p_to_sequence, p_from_sequence);
  end if;

  if p_from_sequence = 1 then
    expected_prev := public.audit_genesis_hash();
    last_sequence := 0;
  else
    select predecessor.hash
      into expected_prev
      from public.audit_logs predecessor
     where predecessor.chain_id = p_chain
       and predecessor.sequence = p_from_sequence - 1;

    if expected_prev is null then
      return query select p_chain, 0::bigint, false, p_from_sequence,
                          format('the row before sequence %s of the range is missing',
                                 p_from_sequence),
                          null::bigint, null::text;
      return;
    end if;

    last_sequence := p_from_sequence - 1;
  end if;

  last_hash := expected_prev;

  for entry in
    select stored.*
      from public.audit_logs stored
     where stored.chain_id = p_chain
       and stored.sequence >= p_from_sequence
       and (p_to_sequence is null or stored.sequence <= p_to_sequence)
     order by stored.sequence
  loop
    checked := checked + 1;

    if entry.sequence <> expected_sequence then
      return query select p_chain, checked, false, entry.sequence,
                          format('sequence %s follows %s, so a row is missing',
                                 entry.sequence, expected_sequence - 1),
                          last_sequence, last_hash;
      return;
    end if;

    if entry.prev_hash <> expected_prev then
      return query select p_chain, checked, false, entry.sequence,
                          format('the row does not link to the hash of sequence %s',
                                 entry.sequence - 1),
                          last_sequence, last_hash;
      return;
    end if;

    if public.audit_log_row_hash(entry) <> entry.hash then
      return query select p_chain, checked, false, entry.sequence,
                          'the stored hash does not match the canonical string of the row',
                          last_sequence, last_hash;
      return;
    end if;

    expected_prev := entry.hash;
    expected_sequence := expected_sequence + 1;
    last_sequence := entry.sequence;
    last_hash := entry.hash;
  end loop;

  return query select p_chain, checked, true, null::bigint, null::text,
                      last_sequence, last_hash;
end;
$$;

comment on function public.audit_verify_chain(uuid, bigint, bigint) is
  'Walks a range of one audit chain, recomputing every hash and link. Returns the first break.';

-- The Merkle root over a range of one chain, with RFC 6962 domain separation.
create function public.audit_merkle_root(
  p_chain uuid,
  p_from_sequence bigint default 1,
  p_to_sequence bigint default null
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  level bytea[];
  paired bytea[];
  node_count integer;
  position integer;
  left_node bytea;
  right_node bytea;
begin
  if p_from_sequence is null or p_from_sequence < 1 then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = 'a Merkle root starts at sequence 1 or later';
  end if;

  if p_to_sequence is not null and p_to_sequence < p_from_sequence then
    raise exception using
      errcode = 'invalid_parameter_value',
      message = format('the range ends at %s before it starts at %s',
                       p_to_sequence, p_from_sequence);
  end if;

  select pg_catalog.array_agg(
           pg_catalog.sha256('\x00'::bytea || pg_catalog.decode(stored.hash, 'hex'))
           order by stored.sequence
         )
    into level
    from public.audit_logs stored
   where stored.chain_id = p_chain
     and stored.sequence >= p_from_sequence
     and (p_to_sequence is null or stored.sequence <= p_to_sequence);

  if level is null then
    return null;
  end if;

  while pg_catalog.array_length(level, 1) > 1 loop
    node_count := pg_catalog.array_length(level, 1);
    paired := '{}'::bytea[];

    position := 1;

    while position <= node_count loop
      left_node := level[position];

      if position + 1 <= node_count then
        right_node := level[position + 1];
      else
        right_node := left_node;
      end if;

      paired := paired || pg_catalog.sha256('\x01'::bytea || left_node || right_node);
      position := position + 2;
    end loop;

    level := paired;
  end loop;

  return pg_catalog.encode(level[1], 'hex');
end;
$$;

comment on function public.audit_merkle_root(uuid, bigint, bigint) is
  'RFC 6962 Merkle root over the row hashes of a chain range, or null for an empty range.';

commit;
