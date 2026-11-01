-- path: migrations/0083_auth_challenge_secret_size.down.sql
-- STEP 043 rollback of 0083: restores the 4096 character ceiling of `0082`.
--
-- The rollback is honest about one thing: a challenge row that is larger than 4096 characters
-- cannot survive it. `validating` refuses the narrower constraint while such a row exists, which is
-- the correct refusal - silently truncating a sealed session would be worse than failing - so a
-- database that reverses this file while a large challenge is pending must let that challenge expire
-- first, or delete it, and the error it raises says exactly which row is in the way.

begin;

alter table public.auth_challenges
  drop constraint auth_challenges_secret_check;

alter table public.auth_challenges
  add constraint auth_challenges_secret_check check (
    char_length(secret_ciphertext) between 32 and 4096
  );

commit;
