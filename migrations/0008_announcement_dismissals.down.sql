-- path: migrations/0008_announcement_dismissals.down.sql
-- STEP 014 - rollback for 0008_announcement_dismissals.sql.
--
-- Drops the dismissal table and everything it owns. It must run before 0007 is rolled back,
-- because its foreign key points at `announcements`.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.announcement_dismissals;

commit;
