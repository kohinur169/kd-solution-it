-- path: migrations/0081_password_breach_setting.sql
-- STEP 040 - the breached password check, and the switch that carries it.
--
-- Section 22 makes "strong password policy and breached password check" one requirement, and
-- section 22 line 245 turns Cloudflare Turnstile on for the same form. `0080` created the platform
-- setting registry and closed the Turnstile switch; this file opens the second switch, because the
-- two controls fail differently:
--
--   - Turnstile is seeded closed, because a token cannot be verified without a secret an operator
--     has to paste in, and a deployment that has not done that must not accept signups;
--   - the breached password corpus needs no account, no key and no domain, so the check works the
--     moment the deployment has outbound HTTPS. Seeding it open is the honest default, and closing
--     it becomes a deliberate act that production refuses rather than obeys: a control everyone
--     believes is on, and is not, is worse than no control at all.
--
-- The value is a JSON boolean, not a string, because `lib/auth/settings.ts` reads a setting through
-- a zod schema and a string "true" would be refused rather than coerced. The rollback removes the
-- row and nothing else, so a database that reverses this file is back to a registry whose only
-- switch is Turnstile.
--
-- No reader is broken by this file: `lib/auth/breach-check.ts` treats a missing row as a closed
-- switch, which is the same answer `readValue` gives for a key nobody has written.

begin;

insert into public.platform_settings (setting_key, value, is_secret) values
  ('password.breach_check.enabled', 'true'::jsonb, false);

commit;
