-- path: migrations/0093_velocity_counter_consume.sql
-- STEP 067 - the atomic counter behind the card and IP velocity limits of section 18.
--
-- `0056` created `velocity_counters` and froze it: a counter keeps its subject, its window and the
-- limit that applied, it only counts up, a breach is written once, and it is never soft deleted.
-- What that table does not have is a way to move a counter without a read-modify-write in the
-- service, and that shape loses increments under exactly the burst the limit exists for: two
-- payments read nine hits, both write ten, and the eleventh goes through. This file adds the one
-- statement that counts a hit and answers the state after it, the way `0092` did for rate limiting.
--
-- ## One subject, one window, one row
--
-- The window is fixed and aligned to the epoch: `window_start` is `floor(epoch / window_seconds) *
-- window_seconds`, so two attempts in the same window name the same row and a lapsed window is a
-- new row rather than a rewrite. That is why `0056`'s unique keys are `(subject, window_start,
-- window_seconds)` over a partial index: the conflicting row is the counter, and the row lock
-- Postgres takes on it is the serialisation point.
--
-- ## Why the insert is written twice
--
-- A table with two partial unique indexes has no single conflict target: `on conflict
-- (card_fingerprint, ...) where card_fingerprint is not null` infers the card index, and an address
-- insert would find no conflict there and then violate the address index instead. So the function
-- branches once, on the subject it validated, and each branch is one complete insert. The two are
-- the same statement with a different key, and neither can be reached with the other's field,
-- because the subject and the fields are checked against each other above.
--
-- ## What is written, and what is never rewritten
--
-- The update moves `hit_count` by one, moves `last_hit_at` forward only, and writes `exceeded_at`
-- once, on the hit that reaches the limit. The guard trigger of `0056` refuses anything else, so a
-- limit or a window changed by an operator does not rewrite a window that already happened.
--
-- `created_at` is written as the instant the caller passed rather than the transaction's `now()`,
-- because `velocity_counters_start_check` requires `window_start <= created_at` and a caller whose
-- clock is a second ahead would otherwise fail the insert. The value is the same instant the window
-- was computed from, so the two cannot disagree.
--
-- ## The answer
--
--   counter_hits, counter_limit        - the count after this hit and the limit that applied;
--   counter_window_start, ..._seconds  - the window the hit fell in;
--   counter_exceeded                   - the count has reached the limit;
--   counter_first_breach               - this is the hit that reached it, which is when the service
--                                        writes the audit entry rather than one per attempt.
--
-- `first_breach` is `hit_count = limit_value` and not a second stored column: the count rises by
-- one from one and the limit is frozen, so a row passes through that equality exactly once.

begin;

create function public.consume_velocity(
  p_subject text,
  p_card_fingerprint text,
  p_ip_address inet,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz
)
returns table (
  counter_hits integer,
  counter_limit integer,
  counter_window_start timestamptz,
  counter_window_seconds integer,
  counter_exceeded boolean,
  counter_first_breach boolean
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_hits integer;
  v_limit integer;
  v_window_seconds integer;
  v_window_start_written timestamptz;
begin
  if p_subject is null or p_subject not in ('card', 'ip') then
    raise exception 'a velocity subject is a card or an address'
      using errcode = 'check_violation';
  end if;

  if p_limit is null or p_limit < 1 then
    raise exception 'a velocity limit is at least one'
      using errcode = 'check_violation';
  end if;

  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 2592000 then
    raise exception 'a velocity window is between one second and thirty days'
      using errcode = 'check_violation';
  end if;

  if p_now is null then
    raise exception 'a velocity hit needs an instant'
      using errcode = 'check_violation';
  end if;

  if p_subject = 'card' then
    if p_card_fingerprint is null or p_card_fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception 'a card counter needs the 64 hex fingerprint of the card'
        using errcode = 'check_violation';
    end if;

    if p_ip_address is not null then
      raise exception 'a card counter carries no address'
        using errcode = 'check_violation';
    end if;
  else
    if p_ip_address is null then
      raise exception 'an address counter needs the address'
        using errcode = 'check_violation';
    end if;

    if p_card_fingerprint is not null then
      raise exception 'an address counter carries no card'
        using errcode = 'check_violation';
    end if;
  end if;

  v_window_start := pg_catalog.to_timestamp(
    pg_catalog.floor(
      pg_catalog.date_part('epoch', p_now) / p_window_seconds
    ) * p_window_seconds
  );

  if p_subject = 'card' then
    insert into public.velocity_counters as counter_row (
      card_fingerprint,
      ip_address,
      window_start,
      window_seconds,
      hit_count,
      limit_value,
      last_hit_at,
      created_at,
      updated_at
    )
    values (
      p_card_fingerprint,
      null,
      v_window_start,
      p_window_seconds,
      1,
      p_limit,
      p_now,
      p_now,
      p_now
    )
    on conflict (card_fingerprint, window_start, window_seconds)
      where card_fingerprint is not null and deleted_at is null
    do update set
      hit_count = counter_row.hit_count + 1,
      last_hit_at = greatest(counter_row.last_hit_at, excluded.last_hit_at),
      exceeded_at = case
                      when counter_row.exceeded_at is null
                       and counter_row.hit_count + 1 >= counter_row.limit_value
                      then excluded.last_hit_at
                      else counter_row.exceeded_at
                    end
    returning
      counter_row.hit_count,
      counter_row.limit_value,
      counter_row.window_start,
      counter_row.window_seconds
    into v_hits, v_limit, v_window_start_written, v_window_seconds;
  else
    insert into public.velocity_counters as counter_row (
      card_fingerprint,
      ip_address,
      window_start,
      window_seconds,
      hit_count,
      limit_value,
      last_hit_at,
      created_at,
      updated_at
    )
    values (
      null,
      p_ip_address,
      v_window_start,
      p_window_seconds,
      1,
      p_limit,
      p_now,
      p_now,
      p_now
    )
    on conflict (ip_address, window_start, window_seconds)
      where ip_address is not null and deleted_at is null
    do update set
      hit_count = counter_row.hit_count + 1,
      last_hit_at = greatest(counter_row.last_hit_at, excluded.last_hit_at),
      exceeded_at = case
                      when counter_row.exceeded_at is null
                       and counter_row.hit_count + 1 >= counter_row.limit_value
                      then excluded.last_hit_at
                      else counter_row.exceeded_at
                    end
    returning
      counter_row.hit_count,
      counter_row.limit_value,
      counter_row.window_start,
      counter_row.window_seconds
    into v_hits, v_limit, v_window_start_written, v_window_seconds;
  end if;

  return query
    select
      v_hits,
      v_limit,
      v_window_start_written,
      v_window_seconds,
      v_hits >= v_limit,
      v_hits = v_limit;
end;
$$;

comment on function public.consume_velocity(text, text, inet, integer, integer, timestamptz) is
  'Counts one card or address hit in its window and answers the count, the limit and whether this hit first reached it. The single writer of public.velocity_counters.';

commit;
