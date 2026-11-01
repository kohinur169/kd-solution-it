-- path: migrations/0090_device_trust_challenges.down.sql
-- STEP 052 - rollback for 0090_device_trust_challenges.sql.
--
-- Drops the challenge table and everything that belongs only to it: its two unique indexes, the two
-- lookup indexes, the metadata trigger and the default deny policy go with the table. Nothing else
-- is touched - `device_proof_keys.trusted_at` keeps the trust every confirmed device already earned,
-- and `email_send_logs` keeps the alerts that were sent, because a device that was confirmed by
-- second factor stays confirmed across a rollback of the screen that confirmed it.
--
-- One transaction, so a failed rollback leaves the database exactly as it was.

begin;

drop table if exists public.device_trust_challenges;

commit;
