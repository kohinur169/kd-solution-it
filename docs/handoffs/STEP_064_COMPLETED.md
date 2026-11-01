// path: docs/handoffs/STEP_064_COMPLETED.md
# STEP 064 - Encryption service AES-256-GCM for secrets and files: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_063_COMPLETED.md`
(commit `3f1c538`).

## What was asked

`docs/final/STEP_PLAN_250.md` line 835, the eleventh STEP of the security block 056-067:
AES-256-GCM for secrets and files. `docs/final/FEATURE_LIST.md` line 91 requires keys to be encrypted
before storage with the encryption key in the environment only; line 225 requires every file to be
AES-256-GCM encrypted before upload; line 302 requires provider keys, email secrets and TaxCloud
credentials to be encrypted at rest and shown masked; line 38 makes the CEO the key custodian. Master
prompt lines 14-15 state the file rule.

## What already existed

- `lib/auth/secrets.ts` (STEP 045) - AES-256-GCM in the `v1.<iv>.<tag>.<ciphertext>` shape for the
  Turnstile secret and the TOTP seeds, with `ENCRYPTION_MASTER_KEY` as the key;
- `lib/env/manifest.ts` - `ENCRYPTION_MASTER_KEY`, `base64Key`, `bytes: 32`;
- `migrations/0057_files.sql` - `files_size_check`: `byte_size between 1 and 52428800`.

Nothing encrypted a file, and the `v1` envelope names no key, so a rotation would have left every stored
value unopenable with no way to know which key wrote what.

## What was built

One new module, `lib/security/encryption.ts`, and no new dependency, no migration and no new table.

- **A keyring, and a key id in every envelope.** A secret is
  `kd1.<keyId>.<iv>.<tag>.<ciphertext>`, every part base64url; a file is a header (magic `KDF1`, version,
  key id, chunk size, plaintext size, 12 byte base vector) followed by records. `primary` seals, and
  `previous` still opens, so a rotation is "deploy, re-seal on the next write" rather than a migration
  window. Two keys with one id is refused, because which of them wins would decide whether the data is
  readable afterwards.

- **The context is authenticated.** The additional data is `kd-aad-v1|<purpose>|<scope>`, with the
  purpose one of `secret` or `file`, so a value moved to another tenant, another purpose or another row
  fails instead of opening as somebody else's.

- **A file is a header and 64 KiB records.** Each record is its own AEAD value; its nonce carries the
  position (so a record moved to another position fails) and its association data carries the whole
  header including the plaintext size (so a file cut short fails, and a file cut short *and* re-labelled
  with a smaller size fails as well, because the header the remaining chunks were sealed under is no
  longer the one in front of them). `readFileEnvelopeInfo` reports the key id, chunk count and plaintext
  size without a key, which is what the storage layer records beside a file.

- **Canonical base64url, for keys and for envelopes.** A base64url decoder ignores the spare bits of a
  final character, so sixteen bytes travel in twenty-two characters of which the last carries two useful
  bits: without a canonical check, four envelopes decode to the same tag, and one 32 byte key has two
  spellings. Both are refused. This came out of the gate, not out of review - the tamper corpus changed
  a tag's last character and the value still opened, which is exactly the kind of thing a corpus is for.

- **Nothing secret leaves the function.** The key is decoded, used and zeroed in a `finally`, never read
  from the environment here, never cached, never written into an error; the plaintext is never in an
  error either. Every failure is `INTERNAL_ERROR` with one machine reason: `key_invalid`,
  `key_id_invalid`, `key_unknown`, `keyring_invalid`, `context_invalid`, `envelope_invalid`,
  `plaintext_too_large`, `secret_too_large` or `authentication_failed`.

- **Bounds that are the schema's bounds.** The plaintext ceiling is 52 428 800, the `files_size_check`
  literal; a secret is at most 8 192 bytes, because a setting that needs more is a file. The gate
  compares both with the files table, and the key length with the manifest.

## The seam with STEP 045

`lib/auth/secrets.ts` keeps sealing the Turnstile secret and the TOTP seeds in the older `v1` shape. It
is not edited here, and this module neither reads nor writes that shape - the gate asserts both, and that
exactly two modules in `lib/` and `app/` contain a cipher at all. Migrating those values is a later STEP:
open with the auth function, re-seal here, write, and the key id makes the two halves distinguishable
while it happens.

## What was deliberately not connected

No route and no job, and the callers do not exist yet by design: `sealSecret` is what the provider-key,
SMTP and TaxCloud screens of section 17 will call (STEPs 176-180 and the office settings of 068-078), and
`encryptFile` is what the storage adapters of STEPs 100-105 call before the upload, which is exactly the
rule of master prompt lines 14-15. What this STEP leaves is a function those STEPs call - and a gate that
keeps its ceiling equal to the files table and its key length equal to the manifest, so wiring one is one
line rather than a decision about a format.

No i18n string was added: nothing renders a plaintext here, and a screen that shows a masked provider key
already owns its sentence.

## Security proof

`node lib/security/verify.ts` - **1491 checks** (1268 before this STEP; +223), still 200 code point name
ceiling, 15 allowed tags.

- Keys: the length, the canonical spelling, and a second base64 spelling of a valid key refused; key ids
  of five accepted shapes and eight refused ones; a ring with a duplicate id, an oversized ring, a short
  key and an unknown key.
- Secrets: five round trips (empty, ASCII, Bangla, multi-line, the maximum length), twenty seals of one
  plaintext producing twenty envelopes, an envelope that opens the same way every time, the key id
  stamped, the context binding in both directions, eight shape refusals including the `v1` shape of
  STEP 045, three part tampers, an envelope relabelled with another key of the ring, and the rotation.
- Files: six sizes across the chunk boundaries with the exact envelope length formula, the header fields,
  four header edits refused as envelopes, five body edits refused by the tag, truncation, a dropped
  chunk, a dropped chunk with the size edited to match, an appended byte, two whole records swapped, a
  moved scope, an unknown key, and a header claiming more than the ceiling allows.
- Hygiene: the module has no environment read, no log call, no hash, no file system and no request; every
  key buffer is zeroed; the manifest and the files table agree with the constants.

Fifteen mutation controls, all caught: a key of any length; a key with many spellings; a non-canonical
envelope part; an unbound context; two keys sharing an id; a missing key reported as edited bytes; an
empty file with zero chunks; an envelope length not compared; an unauthenticated header; a nonce without
the position; an unchecked format version; an unchecked magic; a key that is not zeroed; a rotation that
seals with the oldest key; a ceiling one byte above the table's.

Two mechanisms were changed *because* the corpus could not tell them apart, and both are worth recording:

1. Header edits were first asserted through decryption, but the header is part of every chunk's
   association data, so any header edit failed for the same reason and the version and magic checks could
   be deleted without a failure. They are now asserted as parse refusals, which is what a caller gets.
2. The `final` flag in the first draft's association data was redundant: the header carries the size and
   the header is authenticated, so a truncation attack has to edit the size and that edit is what fails.
   The flag was removed rather than kept as a mechanism nothing could distinguish; the
   truncation-with-edited-size test proves the mechanism that remains.

One guard was removed for the same reason: an early "envelope is larger than any envelope" comparison
inside the parser could never be observed, because a buffer that large cannot have a header consistent
with its own length. The exact length comparison is the bound, and the ceiling constant now describes
what the writer can produce instead of pretending to be a check.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 1491 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |

`npm run verify` components: structure 17 directories, 14 root files, **174** sources (173 before);
config 10 checks / 28 keys, i18n 294, logger 117, errors 202 checks / 15 codes, lint 77 checks, shell 237,
jobs 110, migrations 2746 checks / 92 migrations / 75 tables - all unchanged.

## Files

New: `lib/security/encryption.ts`, `docs/planning/STEP_064_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_064_COMPLETED.md`.
Edited: `lib/security/verify.ts`, `lib/security/README.md` (a new section, "What is encrypted, and with
what", and a row in the module table).
No migration, no `package.json` change, no new dependency, no new root file, no test file, no i18n string.

## Package requests

Unchanged from STEP 063: `check:auth` and `check:security` are still not part of `npm run verify`; a
`minimatch` bump for the moderate advisory on the default branch; DOMPurify for the rich text allowlist; a
pinned-address dispatcher for the SSRF rule.

## Next

STEP 065 of `docs/final/STEP_PLAN_250.md`, the signed token service for client portal links with expiry and
revocation, which is the next entry of the security block. Nothing in this STEP is pending. Two seams for
later STEPs: the storage adapters of 100-105 call `encryptFile` before the upload and record
`readFileEnvelopeInfo` beside the row, and the settings screens of 068-078 and 176-180 call `sealSecret` -
the provider keys, email secrets and TaxCloud credentials of section 17 all go through one function and
one keyring.
