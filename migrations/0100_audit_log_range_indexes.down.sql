-- path: migrations/0100_audit_log_range_indexes.down.sql
-- STEP 076 - the rollback of the two range indexes.
--
-- It drops exactly the two indexes the forward file created and nothing else. No row is read,
-- changed or removed: an index holds no data of its own, and the log's append-only guard of `0013`
-- would refuse a delete even if this file tried one. The four indexes `0013` created stay, so a
-- rollback returns the schema to the state STEP 075 shipped and no query becomes wrong - only the
-- two the viewer needed lose their index.

begin;

drop index if exists public.audit_logs_action_prefix_idx;

drop index if exists public.audit_logs_created_idx;

commit;
