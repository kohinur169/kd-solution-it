// path: docs/handoffs/STEP_061_COMPLETED.md
# STEP 061 - File upload validator with magic byte and size checks: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_060_COMPLETED.md`
(commit `d42965b`).

## What was asked

`docs/final/STEP_PLAN_250.md` line 800, the eighth STEP of the security block 056-067: a file upload
validator that checks magic bytes and size. `docs/final/FEATURE_LIST.md` lines 225-229 name the five file
purposes and require type plus magic byte verification and a size limit; rule 11 of
`docs/final/MASTER_PROMPT.md` requires the encryption that STEPs 100-105 own.

## What was built

One new module, `lib/security/upload.ts`, and no new dependency.

- **Purposes and policies.** `UPLOAD_PURPOSES` is the five names of migration `0057`: `kyc_document`,
  `company_logo`, `invoice_pdf`, `dispute_document`, `support_attachment`. `UPLOAD_POLICIES` gives each
  one an allowed type list and a maximum:

  | purpose | types | maximum bytes |
  | --- | --- | --- |
  | `kyc_document` | `application/pdf`, `image/jpeg`, `image/png` | 52 428 800 |
  | `company_logo` | `image/png`, `image/jpeg`, `image/webp` | 2 097 152 |
  | `invoice_pdf` | `application/pdf` | 26 214 400 |
  | `dispute_document` | `application/pdf`, `image/jpeg`, `image/png` | 52 428 800 |
  | `support_attachment` | `application/pdf`, `image/jpeg`, `image/png` | 10 485 760 |

  Every limit is at or under `UPLOAD_DATABASE_MAXIMUM_BYTES` (52 428 800), which is the literal in
  `files_byte_size_check`. All tables are frozen.

- **Signatures.** `MAGIC_SIGNATURES` matches at a fixed offset and nowhere else: `%PDF-`
  (`25 50 44 46 2D`), `FF D8 FF`, the eight byte PNG header `89 50 4E 47 0D 0A 1A 0A`, and WebP as
  `RIFF` at 0 with `WEBP` at 8 - a RIFF container is not a WebP until the second part says so.
  `detectContentType(head)` reads at most `UPLOAD_SNIFF_BYTES` (32) bytes and returns `null` for anything
  it does not recognise.

- **The decision.** `validateUpload(candidate, purpose)` returns one of three outcomes:

  | outcome | when | what the route does |
  | --- | --- | --- |
  | rejected | no declared type, unacceptable type, empty, over the purpose limit | `422`, no row |
  | quarantined | unknown signature, claim disagrees with bytes, markup or script where a document was claimed | row with `magic_byte_verified = false` and a reason |
  | verified | bytes prove the declared type | row with `magic_byte_verified = true`, `verified_at`, the digest |

  Quarantine rather than refusal for a lying file is the decision this STEP makes: a row with a reason is
  evidence an operator can read, and a refusal turns a probe into a retry. The three reasons live in
  `UPLOAD_QUARANTINE_REASONS` - unknown signature, type mismatch, active content - and they run 63,
  40 and 80 characters, well inside the 280 the column allows.

- **Names and digests.** The file name passes through `sanitizeFileName` from STEP 056 (no path segment,
  no NUL, no reserved device stem, 120 characters); it is a label, never a key - the storage key is
  generated and `files_tenant_path_check` already requires the merchant id prefix. `sha256Hex` produces
  the 64 hex characters `files_hash_check` requires.

- **Refusals.** `uploadRejection(reason, field)` builds `AppError("VALIDATION_FAILED", ...)` with
  `details: [{ field, rule: "file_not_acceptable" }]`; the internal reason travels in `cause` for the log
  and is never serialised. `requireValidUpload` throws it and narrows the type for callers.

## What was deliberately not connected

No route in this repository reads a file yet: `app/` has no `formData()` call and no upload endpoint. The
file surfaces arrive with the storage STEPs 100-105, the KYC STEPs 79-99 and the dispute STEPs 191-199,
and each owns its own handler. Connecting one here would have meant inventing a route outside the STEP's
ownership. What this STEP leaves:

- the two entry points (`validateUpload`, `requireValidUpload`) and the single code path every future
  handler calls;
- the gate asserting the module against `migrations/0057_files.sql` - the purpose names, the 52 428 800
  literal, the `^[a-z]+/[A-Za-z0-9.+-]+$` content type pattern and the reason limit - so a validator that
  drifts from its table fails `npm run verify` before it fails an insert in production;
- the serving rule in `lib/security/README.md`: whatever serves a stored file sends
  `content-disposition: attachment` and keeps `nosniff`. A magic byte check cannot stop a PDF from being
  rendered inline; only the disposition can.

No screen changes, so no i18n string was added: every refusal reaches an existing form through
`422 VALIDATION_FAILED`, which the catalogue already words.

## Security proof

`node lib/security/verify.ts` - **604 checks** (477 before this STEP; +127), still 200 code point name
ceiling, 15 allowed tags.

- Policy table: five purposes, frozen, every allowed type provable from bytes, every type matching the
  database pattern, no `image/svg+xml` and no archive type in any purpose, every limit an integer at or
  under the row check.
- Signature corpus: each type from its own bytes, `%PDF` without the hyphen, a truncated PNG, a JPEG
  signature at the wrong offset, a RIFF that is not WebP, an eight byte PNG read through the sniffer, and
  empty input.
- Decision matrix: verified for each accepted type, quarantine for a mismatch, for markup declared as an
  image and for an unknown signature, refusal for empty, oversized, missing type and unacceptable type,
  the exact-limit case accepted, a signature at the start of a long buffer, and the digest of `abc` equal
  to its published SHA-256.
- The refusal factory, the rule name, the field default, the throwing wrapper and the migration agreement.

Nine mutation controls, every one caught: a wrong PNG byte, a mismatch marked verified, the size check
removed, the purpose allowlist removed, the signature searched anywhere instead of at a fixed offset, a
quarantine reason longer than the column, a logo limit raised above the row check, the name sanitiser
bypassed, and the WebP `WEBP` part dropped. One control is worth recording: the first version of the
"reason too long" mutant used a 235 character string and was **not** caught, because it is still a legal
reason - the control only proves something when it actually breaks the 280 character bound, and the
rewritten 300 character mutant was caught.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 604 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |

`npm run verify` components: structure 17 directories, 14 root files, **171** sources (170 before);
env, config 10 checks / 28 keys, i18n 294, logger 117, errors 202 checks / 15 codes, lint 77 checks, shell
237, jobs 110, migrations 2746 checks / 92 migrations / 75 tables - all unchanged.

## Files

New: `lib/security/upload.ts`, `docs/planning/STEP_061_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_061_COMPLETED.md`.
Edited: `lib/security/verify.ts`, `lib/security/README.md` (a new section, "What a file must be", and a
row in the module table).
No migration, no `package.json` change, no new dependency, no new root file, no test file.

## Package requests

Unchanged from STEP 060: `check:auth` and `check:security` are still not part of `npm run verify` - they
are run by hand and the handoff records both numbers; DOMPurify for the rich text allowlist; a `minimatch`
bump for the moderate advisory on the default branch; a pinned-address dispatcher for the SSRF rule.

## Next

STEP 062 of `docs/final/STEP_PLAN_250.md`, the next entry of the security block. Nothing in this STEP is
pending. A future STEP that needs a sixth file purpose must add it to `UPLOAD_PURPOSES`, its policy, the
allowlist in `MAGIC_SIGNATURES` if it needs a new type, and a migration - the gate compares the two, so
half an edit fails.
