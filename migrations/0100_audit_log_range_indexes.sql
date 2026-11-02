-- path: migrations/0100_audit_log_range_indexes.sql
-- STEP 076 - the two access paths the audit log viewer takes that `0013` did not index.
--
-- `0013_audit_logs.sql` created four composite indexes, and every one of them is led by a filter
-- column: `(company_id, created_at desc)`, `(actor_user_id, created_at desc)`,
-- `(action, created_at desc)` and `(entity_type, entity_id)`. Those are the right shape for "what
-- happened in this tenant", "what did this person do", "every session.revoked" and "the history of
-- this invoice" - each asks one column for equality and then a date range.
--
-- A viewer asks two more questions that none of them can answer without a sequential scan:
--
--   1. "the newest rows of the platform, whatever their action or actor" - the page a person lands
--      on before typing anything into a filter. No leading equality column exists, so
--      `0013`'s indexes are all unusable. `audit_logs_created_idx` is `(created_at desc)`.
--   2. "every action in the `session.` family" - the filter a person types after seeing one entry.
--      `audit_logs_action_idx` is `(action, created_at desc)`, and a btree on `action` under the
--      default operator class cannot serve a `like 'session.%'` prefix: it can only serve equality
--      and range. `audit_logs_action_prefix_idx` is the same pair under `text_pattern_ops`, which is
--      the operator class a prefix pattern is written against. It is additive: the existing
--      equality index stays, because an exact action is still the cheaper lookup.
--
-- Both are partial on `deleted_at is null`, like their four predecessors, because the append-only
-- guard of `0013` refuses every delete and the viewer never reads a deleted row.
--
-- Nothing about the log's contents changes. `public.audit_logs` is append-only and hash-chained: an
-- index is a second copy of keys, not a second copy of the truth, and `audit_logs_append_only`
-- still refuses every update and every removal whatever role asks. No policy is added or removed:
-- `audit_logs_office_select` already gives the three office roles that answer for the log its read,
-- and `audit_logs_merchant_select` its own company's rows.

begin;

-- "The newest events, whatever they are": the viewer's landing page.
create index audit_logs_created_idx
  on public.audit_logs (created_at desc)
  where deleted_at is null;

-- "Every action in this family": the prefix filter, under the operator class a prefix uses.
create index audit_logs_action_prefix_idx
  on public.audit_logs (action text_pattern_ops, created_at desc)
  where deleted_at is null;

commit;
