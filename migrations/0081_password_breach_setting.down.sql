-- path: migrations/0081_password_breach_setting.down.sql
-- STEP 040 rollback of 0081: closes and retires the breached password switch.
--
-- The row is data rather than schema, and `0080` makes the registry append-only: its guard trigger
-- refuses a delete with "a platform setting is disabled, never removed". The rollback respects that
-- rule instead of disabling the trigger for one statement, so the switch is closed (`false`) and
-- stamped `deleted_at`, which is what "this build no longer has this switch" means in this table.
--
-- The forward file is safe to apply again afterwards: `platform_settings_key_key` is a partial
-- unique index over live rows, so a retired row does not block the new one, and `breach-check.ts`
-- reads through `deleted_at is null` and therefore sees the switch that is live.

begin;

update public.platform_settings
   set value = 'false'::jsonb,
       deleted_at = now()
 where setting_key = 'password.breach_check.enabled'
   and deleted_at is null;

commit;
