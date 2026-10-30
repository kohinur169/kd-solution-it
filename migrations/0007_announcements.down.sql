-- path: migrations/0007_announcements.down.sql
-- STEP 014 - rollback for 0007_announcements.sql.
--
-- Drops the announcement table and everything it owns. The dismissals table of 0008 references
-- this one, so 0008 must be rolled back first; the foreign key is what makes that order mandatory
-- rather than a convention.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.announcements;

commit;
