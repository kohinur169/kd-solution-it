// path: docs/handoffs/STEP_065_COMPLETED.md
# STEP 065 - Signed token service for client portal links with expiry and revocation: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_064_COMPLETED.md`
(commit `32cd393`).

## What was asked

`docs/final/STEP_PLAN_250.md` line 848: a signed token service for client portal links with expiry and
revocation, the twelfth STEP of the security block 056-067. `docs/final/FEATURE_LIST.md` line 26 makes a
client's access "tokenized link access only under i/[token] and e/[token], no login"; line 179 makes
tokenized links the way an invoice and an estimate open; line 177 makes an accepted estimate generate a
payment link; line 180 makes a fully paid link stop accepting payment. Everything a client can do, and
everything a client can reach, starts with one of these links.

## What already existed

- `lib/security/encryption.ts` (STEP 064) - the AES-256-GCM service, the keyring, and the canonical
  base64url rule that a signed envelope also needs;
- `lib/auth/cookies.ts` (STEP 037) - the established pattern of deriving a purpose-specific key from
  `ENCRYPTION_MASTER_KEY` with HKDF-SHA-256 and an info string, so one environment secret serves several
  purposes and no new secret has to be deployed;
- `lib/env/manifest.ts` - `ENCRYPTION_MASTER_KEY`, `base64Key`, exactly 32 bytes, custodian the CEO;
- no portal table and no portal route in the tree yet: the portal STEPs are 181-190.

## What was built

`lib/security/portal-token.ts`, one module with three operations and one vocabulary.

- **The link.** `kdpt1.<payload>.<signature>`, where the payload is the base64url of one canonical JSON
  claim - `version`, `kind`, `companyId`, `resourceId`, `capability`, `tokenId`, `issuedAt`, `expiresAt` -
  and the signature is HMAC-SHA-256 over the exact header and payload with a key derived from
  `ENCRYPTION_MASTER_KEY` under `kd-portal-token:v1`. Signed, not encrypted: an invoice id is not a
  password, and the signature is what stops a client inventing a claim.
- **Mint.** `mintPortalToken(request, { keys, now, tokenId? })` takes a **lifetime in seconds**, never an
  expiry date, between 300 seconds and 30 days. It refuses an unknown kind, a capability the kind does
  not carry, a uuid that is not a uuid, a lifetime out of range, a clock that is not a whole second, an
  expiry past the range of a timestamp, and a link id that is not the canonical spelling of 16 bytes.
  A caller that must write the portal row first passes its own `tokenId`, and `randomBytes` produces one
  otherwise.
- **Open.** `openPortalToken(token, { keys, now, expect?, revocations? })` verifies in this order: the key
  ring, the clock argument, the shape, the signature, the claim, the lifetime, the issue and expiry
  instants, then the revocation predicate, then the expectation. Nothing a client sent is believed before
  the HMAC verifies, and the revocation lookup runs last so a public route is not a query oracle.
- **Digest.** `portalTokenDigest(token)` is `kdpd1.<sha256 base64url>`; a store that revokes or logs a link
  keeps the digest and never the token.

Six properties are worth stating:

- **Expiry is bounded twice.** The reader re-checks the signed lifespan against the same floor and ceiling
  it mints with, so a caller with a different copy of the rule cannot widen it by signing a longer link.
- **The clock is an argument.** The module has no `Date.now()`; the gate stands on the last second a link
  opens and on the instant it stops, and a job can be exercised without waiting.
- **One payload, one spelling.** The claim is rebuilt in the schema's field order and compared with the
  bytes that arrived, so a reordered payload, whitespace or `1e3` for `1000` is not a second token for one
  link - which is what lets a digest name exactly one credential.
- **Every refusal of an open is a 404.** One `RESOURCE_NOT_FOUND` for every reason, with the machine reason
  in `cause`, because a visitor who can tell a wrong signature from an expired link has a probe. A bad key
  ring or a bad clock is `INTERNAL_ERROR`: that is this platform's mistake, not the visitor's.
- **The kind owns the capability.** Invoice: view and pay. Estimate: view and sign. Payment link: view and
  pay. A token pairing one kind with another kind's capability is refused when minted and again when read.
- **Rotation without a new secret.** The ring accepts retired master keys, so a link minted a minute before
  a key change still opens; a link is stored nowhere, so nothing has to be re-signed afterwards.

## The canonical-base64 finding, again

STEP 064 learned that a base64url decoder ignores the spare bits of the last character. The same rule is
needed three times here - the signature, the payload and the 22 character link id - so the helper it wrote
is now exported from `lib/security/encryption.ts` (`decodeCanonicalBase64Url`) and imported. One canonical
rule, not two copies. The link id is the case that bites: 22 characters carry four spare bits, so one id
has sixteen spellings, and a revocation row keyed on a link id would be a row that one spelling finds and
another does not. Both the minter and the reader refuse a non-canonical id.

## What was deliberately not connected

No route, no page and no job: STEPs 181-190 own `app/(client-portal)/`, and a link that renders before
those pages exist would be a second implementation of a page. No migration: database STEPs 012-036 own
`migrations/`, and the only row this STEP needs is the revocation record, whose table and lifecycle belong
to the STEP that owns the document being revoked. No i18n string: the page that says a link has expired is
the portal STEP's page, and its copy is written there. `package.json` is untouched.

## Database

None. No migration, no rollback to prove, no table read: the gate asserts the module mentions no supabase
client and imports nothing from the authentication tree, so the revocation store cannot become a query
hidden inside the token service.

## Environment

None added. The signing key is HKDF-SHA-256 of the existing `ENCRYPTION_MASTER_KEY` under
`kd-portal-token:v1`; no value is written into code, the gate or this file.

## Behaviour proof

The three behaviours in the title, exercised:

| behaviour | exercised by | observed result |
| --- | --- | --- |
| a signed link is unforgeable | an edited payload character, a second spelling of the signature, a signature taken from another link, a signature that does not cover the header, a claim the gate signs itself with the real derivation | `signature_invalid`; only the writer's exact header and payload verify |
| expiry | a link at `expiresAt - 1`, at `expiresAt`, after it, an issue instant one second past the skew, and a signed lifespan below the floor or above the ceiling | the last second opens, the expiry instant returns `token_expired`, one minute of skew is tolerated, a lifespan out of range is `lifetime_invalid` |
| revocation | a predicate that revokes one id of two, and a call counter behind an edited, an expired and a foreign-signature link | a revoked link returns `token_revoked`, an unrevoked one opens, and the store is never called for a link that the signature or the clock already refused |

UI: not applicable, nothing renders a link yet (see above). API: not applicable in this STEP, no route
exists; the gate exercises the service's success, refusal and cross-tenant (audience) paths directly.
Money: not applicable.

## Security proof

`node lib/security/verify.ts` - **1763 checks** (1491 before this STEP; +272), still 200 code point name
ceiling, 15 allowed tags. `checkPortalTokenKeys`, `checkPortalTokenMint`, `checkPortalTokenOpen`,
`checkPortalTokenRevocation` and `checkPortalTokenWiring`:

- Constants and vocabularies: twelve refusals, three kinds, three capabilities and the kind-to-capability
  table, all frozen; the derivation compared with one the gate computes for itself from the same info
  string, and with a second master key.
- Keys: a short master key, a second base64 spelling of a master key, a ring with a duplicate, a ring of
  five, a retired key that still verifies, and a foreign key that does not.
- Mint: six kind and capability pairs; seven impossible requests; four impossible link ids; lifetimes at
  the floor, at the ceiling, and seven refused values; a bad clock; an expiry past the range of a
  timestamp; the primary key as the only minter.
- Open: the last second and the expiry instant; skew on both sides; the edited payload, the second
  signature spelling, the foreign signature and the payload-only signature; a later version, a version
  with a leading zero and an upper case header; ten malformed strings; two signature lengths; sixteen
  signed claims a writer would never produce; a reordered payload, a padded payload and an oversized
  payload; four expectations that do not match, and the one that does.
- Revocation: the exact id the caller minted, the id of a link that was not revoked, and a counter that
  proves the lookup is not called for an edited, an expired or a foreign-signature link.
- Digest: deterministic, one per link, a prefix and 43 characters, and it does not carry the link.
- Wiring: one module derives the portal signing key, one module writes a link, the HMAC is compared in
  constant time, every derived key is zeroed, the payload schema is strict, the clock is an argument, and
  the module reads no environment variable, logs nothing, makes no request, opens no database and sets no
  cookie.

**Thirty mutation controls, all caught:** a retired key that no longer verifies; a signature that does not
cover the header; a comparison that is not constant time; an unchecked version; any header shape; a
non-canonical payload; a claim with an extra field; the capability table skipped on read and on mint; an
off-by-one expiry; an hour of skew; the lifetime ceiling and the floor skipped on read and on mint; the
revocation list ignored; the lookup asked about another id; an expectation not compared; a digest that
carries the link; a digest computed for anything; the link-id canonical rule skipped on mint and on read;
a ring that repeats a key; a ring of any size; a master key of any length; a payload ceiling of ten
kilobytes; a short signature accepted; a derived key not wiped; a fractional clock; an expiry past the
range of a timestamp.

One guard was removed *because* the corpus could not tell it apart, and one reason was split:

1. The first draft bounded the whole token at 1 024 characters as well as the payload at 512 bytes. A
   token of that length cannot exist - a header, a bounded payload of at most 683 base64url characters
   and a 43 character signature is 732 - so deleting the guard changed no answer. The payload ceiling is
   the bound that bites, and the total-length constant is gone.
2. The oversized payload used to fall through to the claim parser and report `token_invalid`, the same
   answer a malformed claim gives. It now reports `payload_too_large`, because "this is not a link" and
   "this link is too big to read" are different facts and a caller can act on the second.
3. `Number.isSafeInteger` on the minted expiry was removed for the same reason as the total length: the
   clock and the lifetime are already bounded below `maximumEpochSeconds`, so the sum cannot leave the
   safe range and the check could never fire.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 1763 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |

`npm run verify` components: structure 17 directories, 14 root files, **175** sources (174 before);
config 10 checks / 28 keys, i18n 294, logger 117, errors 202 checks / 15 codes, lint 77 checks, shell 237,
jobs 110, migrations 2746 checks / 92 migrations / 75 tables - all unchanged.

## Files

New: `lib/security/portal-token.ts`, `docs/planning/STEP_065_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_065_COMPLETED.md`.
Edited: `lib/security/verify.ts`, `lib/security/README.md` (a new section, "What a portal link is, and why
it is signed", a row in the module table and two rows in the ceilings table), and
`lib/security/encryption.ts` (one helper exported: `decodeCanonicalBase64Url`, so the canonical rule is
one rule).
No migration, no `package.json` change, no new dependency, no new root file, no test file, no i18n string.

## Package requests

Unchanged from STEP 064: `check:auth` and `check:security` are still not part of `npm run verify`; a
`minimatch` bump for the moderate advisory on the default branch; DOMPurify for the rich text allowlist; a
pinned-address dispatcher for the SSRF rule.

## Next

STEP 066 of `docs/final/STEP_PLAN_250.md`, the next entry of the security block. Nothing in this STEP is
pending. The seam for later STEPs: the portal pages of 181-190 mint with `mintPortalToken`, open with
`openPortalToken` and pass the expectation of the page they are rendering - kind, company, resource and
capability - and store a revocation row keyed on `portalTokenDigest` and the link id. This module decides
whether a link is genuine, in date and not revoked; it never decides what the link may show.
