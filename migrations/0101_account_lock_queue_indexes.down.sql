-- path: migrations/0101_account_lock_queue_indexes.down.sql
-- STEP 078 - the rollback of the two lock queue indexes.
--
-- It drops exactly the two indexes the forward file created and nothing else. No row is read,
-- changed or removed, and `0012`'s two indexes - the one that answers "is this account locked" and
-- the one the expiry sweep reads - stay, so a rollback returns the schema to the state STEP 076
-- shipped and no query becomes wrong: only the two the unlock screen needed lose their index.

begin;

drop index if exists public.account_lock_recent_idx;

drop index if exists public.account_lock_queue_idx;

commit;
