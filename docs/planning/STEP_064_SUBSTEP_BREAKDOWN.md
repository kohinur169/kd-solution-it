// path: docs/planning/STEP_064_SUBSTEP_BREAKDOWN.md
# STEP 064 - Sub-step breakdown

STEP 064: **Encryption service AES-256-GCM for secrets and files** (`docs/final/STEP_PLAN_250.md` line
835), from `docs/final/FEATURE_LIST.md` line 91 ("Keys are AES-256-GCM encrypted before storage. The
encryption key exists only in environment variables"), line 225 ("Every file is AES-256-GCM encrypted
before upload"), line 302 (provider keys, email secrets and TaxCloud credentials encrypted at rest and
shown masked only), line 38 (the master key's custodian is the CEO, and key material lives only in
environment variables) and `docs/final/MASTER_PROMPT.md` lines 14-15, inside the security block 056-067.

## What already exists, and what is missing

- `lib/auth/secrets.ts` (STEP 045) - AES-256-GCM over the `v1.<iv>.<tag>.<ciphertext>` shape, for the
  Turnstile secret and the TOTP seeds. It works, and it is the reason this STEP does not invent a second
  cipher primitive.
- `lib/env/manifest.ts` - `ENCRYPTION_MASTER_KEY`, `base64Key`, exactly 32 bytes, described as the key
  that encrypts provider keys, email secrets and stored files.
- `migrations/0057_files.sql` - the `files` row, with a plaintext `byte_size` between 1 and 52 428 800.

Three gaps:

1. The `v1` envelope names no key, so a master-key rotation makes every stored value unopenable with no
   way to tell which values the new key wrote.
2. There is no file encryption at all, and files are the half of this STEP that a single GCM record
   cannot serve: the storage STEPs will stream a 50 MB scan to object storage.
3. Redaction, sizes and context are decisions, not accidents: nothing binds a ciphertext to the tenant
   and the setting it belongs to before this STEP.

## The decisions this STEP makes

1. **A key id travels in the envelope.** `kd1.<keyId>.<iv>.<tag>.<ciphertext>` for a secret, a header
   with a magic and a key id for a file, and a keyring with `primary` and `previous`. A rotation is a
   deploy, and the data says which key it needs.
2. **Two keys with one id is refused.** Which of them wins would decide whether the data is readable
   after a rotation, so the ring cannot contain the ambiguity.
3. **The context is authenticated.** The additional data is `kd-aad-v1|<purpose>|<scope>`, so a value
   moved between tenants, purposes or rows fails instead of opening as somebody else's.
4. **A file is a header and 64 KiB records.** Each record is its own AEAD value; the nonce carries the
   position and the association data carries the whole header. Reordering, truncation, a truncation with
   the size edited to match, an appended chunk and an edited header all fail.
5. **The size in the header is the anti-truncation device.** A length comparison alone cannot see a file
   whose last chunk was dropped *and* whose header was edited; authenticating the header can.
6. **Canonical base64url, for keys and envelopes.** A base64url decoder ignores the spare bits of a last
   character, so without a canonical check four different tag spellings decode to the same tag, and one
   key has two spellings. Both are refused, because "almost the right key" must fail at use time rather
   than open a value nobody can explain.
7. **Nothing secret leaves the function.** The key is decoded, used and zeroed in a `finally`; it is
   never read from the environment here, never cached, and never written into an error, and neither is
   the plaintext. Every failure is `INTERNAL_ERROR` with one machine reason.
8. **One reason for every decryption failure.** A wrong key, an edited byte, a moved envelope and a
   foreign file all say `authentication_failed` (or `envelope_invalid` when the shape itself is wrong),
   because the difference is what an attacker would like to know.
9. **The old format is left alone and named.** `lib/auth/secrets.ts` keeps its `v1` shape; this module
   neither reads nor writes it, and the gate asserts both.

## Owned paths

New: `lib/security/encryption.ts`, `docs/planning/STEP_064_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_064_COMPLETED.md`.

Edited: `lib/security/verify.ts` (the corpus and the wiring), `lib/security/README.md`.

STEPs 056-067 own `lib/security/`, so nothing outside it is touched - including `lib/auth/secrets.ts`,
which is read by the gate and not changed. No migration is added and `package.json` is not edited.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_063_COMPLETED.md` (committed `3f1c538`), `STEP_PLAN_250.md` line 835, feature list lines 38, 91,
103, 225, 250, 302, 308, master prompt lines 14-15, the ownership rules at line 45,
`lib/auth/secrets.ts`, the env manifest and `0057_files.sql`.

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

None. Two settings tables already store a box as text and `0057` already states the plaintext ceiling the
files row allows; the envelope carries its own key id, so no column has to know which key sealed what.
The gate compares `ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES` with the `files_size_check` literal and
`ENCRYPTION_KEY_BYTES` with the manifest's `bytes: 32`, so neither number can drift from the schema or the
deployment without the build saying so.

## Sub-step 4 - The core logic

`lib/security/encryption.ts`:

- `ENCRYPTION_KEY_BYTES`, `ENCRYPTION_IV_BYTES`, `ENCRYPTION_TAG_BYTES`, `ENCRYPTION_KEY_ID_PATTERN`,
  `ENCRYPTION_SECRET_PREFIX`, `ENCRYPTION_FILE_MAGIC`, `ENCRYPTION_FILE_VERSION`,
  `ENCRYPTION_AAD_PREFIX`, `ENCRYPTION_PURPOSES`, `ENCRYPTION_CHUNK_BYTES`,
  `ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES`, `ENCRYPTION_MAXIMUM_SECRET_BYTES`,
  `ENCRYPTION_MAXIMUM_ENVELOPE_BYTES` - the format, as constants;
- `EncryptionKey`, `EncryptionKeyring`, `EncryptionContext`, `FileEnvelopeInfo` - the inputs and what a
  header says about itself;
- `isEncryptionKeyId`, `isEncryptionKey`, `encryptionAad` - the checks and the binding;
- `sealSecret`, `openSecret`, `isSecretEnvelope`, `secretEnvelopeKeyId` - the text half;
- `encryptFile`, `decryptFile`, `isFileEnvelope`, `readFileEnvelopeInfo` - the byte half.

## Sub-step 5 - Routes and jobs

There is no route to connect, and this STEP is the clearest case of why: the callers do not exist yet by
design. `sealSecret` is what the provider-key, SMTP-secret and TaxCloud screens of section 17 will call
when they exist (STEPs 176-180 and the office settings of 068-078), and `encryptFile` is what the storage
adapters of STEPs 100-105 call *before* the upload, which is exactly what master prompt lines 14-15
require. The gate proves the module is complete, that it is the only new cipher in the tree, and that its
ceiling is the one the files table states, so those STEPs wire a function rather than a decision.

## Sub-step 6 - UI

Not applicable: nothing renders plaintext yet. The screens that will show a provider key masked read the
ciphertext through a service that opens it here; the sentence that says a key is stored is the screen's,
not this module's. No string was added to the catalogue, because a secret that is shown masked is shown
by a screen that already has its own wording.

## Sub-step 7 - Security proof

`checkEncryptionKeys`, `checkEncryptionSecrets`, `checkEncryptionFiles` and `checkEncryptionWiring` in
`lib/security/verify.ts`: the constants against the schema and the manifest, a key corpus including the
second base64 spelling of a valid key, the key ring (duplicate ids, an oversized ring, an unknown key, a
short key), five secret round trips including an empty and a maximum-length value, twenty seals of one
plaintext producing twenty envelopes, the context binding, eight envelope shape refusals, three part
tampers, an envelope relabelled with another key of the ring, the rotation, six context refusals, six file
sizes across the chunk boundaries, the exact envelope length formula, four header edits, five body edits,
truncation, a dropped chunk, a dropped chunk with an edited size, an appended byte, two whole records
swapped, a moved scope, an unknown key, a header claiming more than the ceiling allows, and the wiring
(one cipher module pair, the manifest, the files table, the old `v1` shape untouched).

Fifteen mutation controls, all caught: a key of any length, a key with many spellings, a non-canonical
envelope part, an unbound context, two keys sharing an id, a missing key reported as edited bytes, an
empty file with zero chunks, an envelope length not compared, an unauthenticated header, a nonce without
the position, an unchecked format version, an unchecked magic, a key that is not zeroed, a rotation that
seals with the oldest key, and a ceiling one byte above the table's.

Two things the corpus itself changed, and they are worth recording:

- the first version of the file tamper list edited the header and expected a decryption failure, but the
  header is part of every chunk's association data, so *any* header edit failed for the same reason and
  the version and magic checks could be removed without a failure. Header edits are now asserted as parse
  refusals, which is the answer the caller actually gets;
- the final-chunk flag that the first draft put in the association data turned out to be redundant, since
  the header carries the size and the header is authenticated: a truncation attack has to edit the size,
  and that edit is what fails. The flag was removed rather than kept as a mechanism the corpus could not
  distinguish, and the truncation-with-edited-size test is what proves the remaining mechanism.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, `npm run build`, one commit
`STEP 064: Encryption service AES-256-GCM for secrets and files` on `arena/1dc51ec3-kd-solution-it`,
pushed, with `docs/handoffs/STEP_064_COMPLETED.md`.
