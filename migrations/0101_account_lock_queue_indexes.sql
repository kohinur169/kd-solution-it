-- path: migrations/0101_account_lock_queue_indexes.sql
-- STEP 078 - the two access paths the account unlock screen takes that `0012` did not index.
--
-- `0012_account_locks.sql` created two indexes and one of them is a rule rather than a way in:
--
--   - `account_locks_live_key` is a unique partial index on `(user_id)` for the open rows. It answers
--     "is this account locked", which is the question `lib/auth/locks.ts` asks on every sign-in, and
--     it is exactly the index that cannot answer "which accounts are locked".
--   - `account_locks_expiry_idx` is on `(expires_at)` for the sweep that closes locks whose two hours
--     ran out, which is the clock's question and not a person's.
--
-- The unlock screen of section 22 asks two questions neither index can serve without a sequential
-- scan of every lock the platform has ever recorded:
--
--   1. "every open lock, the one that has waited longest first" - the queue an officer works. The
--      rows are the partial set `unlocked_at is null and expired_at is null`, ordered by
--      `locked_at`; `account_lock_queue_idx` is that pair. A btree is read in either direction, so
--      the one index serves the queue and a newest-first read of the same rows.
--   2. "what the office closed most recently" - the record beside the queue, so an officer can see
--      that a colleague already ended a lock rather than discovering it after writing a note.
--      `account_lock_recent_idx` is `(unlocked_at desc)` over the rows that have been unlocked, which
--      is the partial set `unlocked_at is not null`.
--
-- Both are partial on `deleted_at is null`, like the two they join, because a soft closed lock is not
-- part of either answer.
--
-- Nothing about the locks changes. The table keeps its fourteen checks, its one open lock per account,
-- its two mutually exclusive closures and its `default_deny` policy: an index is a second copy of
-- keys, not a second copy of the truth. No policy is added, because the screen reads through the
-- service role client of the authentication block exactly as STEP 047's unlock writes through it, and
-- the role rule is the service's - `ACCOUNT_UNLOCK_OFFICE_ROLES` and a satisfied second factor.

begin;

-- "Every open lock, oldest first": the queue an officer works.
create index account_lock_queue_idx
  on public.account_locks (locked_at)
  where unlocked_at is null and expired_at is null and deleted_at is null;

-- "What the office closed most recently": the record beside the queue.
create index account_lock_recent_idx
  on public.account_locks (unlocked_at desc)
  where unlocked_at is not null and deleted_at is null;

commit;
