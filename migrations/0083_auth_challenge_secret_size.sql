-- path: migrations/0083_auth_challenge_secret_size.sql
-- STEP 043 - widens the sealed challenge column to the size its own reader accepts.
--
-- `0082` bounded `secret_ciphertext` at 4096 characters, which is the bound `0020`'s token columns
-- use and reads like a sensible number. It is not: what is stored is the AES-256-GCM box of a JSON
-- document holding an access token of up to `MAXIMUM_ACCESS_TOKEN_LENGTH` (4096) and a refresh token
-- of up to 2048, so base64 of the ciphertext plus the IV and the tag of a pair at those limits is
-- about 8400 characters. A provider that returned a large pair would have made an enrolled account
-- unable to sign in at all: the insert would fail the check, the route would answer
-- `VALIDATION_FAILED`, and no code would ever have been asked for.
--
-- The size is measured, not guessed: the gate seals a pair at the documented maxima and asserts both
-- that it exceeds the old bound and that it fits the new one. 16384 leaves room for a longer IV or
-- tag later without another migration, and it is still far below anything that would make a row
-- expensive.
--
-- `0082` is append-only and stays as it was written, which is why this is a new file rather than an
-- edit: a database that has already applied `0082` has rows, and a migration that only ever moves
-- forward can widen a constraint over them without guessing what they hold.

begin;

alter table public.auth_challenges
  drop constraint auth_challenges_secret_check;

alter table public.auth_challenges
  add constraint auth_challenges_secret_check check (
    char_length(secret_ciphertext) between 32 and 16384
  );

commit;
