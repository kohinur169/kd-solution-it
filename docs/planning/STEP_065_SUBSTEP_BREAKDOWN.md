// path: docs/planning/STEP_065_SUBSTEP_BREAKDOWN.md
# STEP 065 - Sub-step breakdown

STEP 065: **Signed token service for client portal links with expiry and revocation**
(`docs/final/STEP_PLAN_250.md` line 848), from `docs/final/FEATURE_LIST.md` line 26 ("client: tokenized
link access only under i/[token] and e/[token], no login"), line 179 ("Tokenized links open invoices and
estimates for clients"), line 177 (an accepted estimate generates a payment link) and line 180 (a link
whose invoice is paid no longer accepts payment), inside the security block 056-067.

## What already exists, and what is missing

- `lib/security/encryption.ts` (STEP 064) - AES-256-GCM, a keyring with rotation, the canonical base64url
  rule and the `ENCRYPTION_MASTER_KEY` decode. It is the reason this STEP does not invent a second key
  format or a second canonical check.
- `lib/auth/cookies.ts` (STEP 037) - HKDF-SHA-256 of `ENCRYPTION_MASTER_KEY` under an info string, so one
  environment secret serves two purposes. The pattern is copied; the info string is not.
- `lib/env/manifest.ts` - `ENCRYPTION_MASTER_KEY`, `base64Key`, 32 bytes, custodian the CEO.
- No migration holds a portal link, and nothing in the tree mints one yet. The portal routes are STEPs
  181-190.

Three gaps:

1. Nothing in the tree can mint a link that a client may hold, so a portal route would have to invent the
   claims, the clock and the revocation rule on its own.
2. Expiry has no ceiling anywhere: a route that takes an expiry date from a merchant can mint a link that
   outlives the invoice it names.
3. There is no way to revoke a link, and no name for one: a revocation row would have to store the token
   itself, which is a second copy of the credential.

## The decisions this STEP makes

1. **The link is signed, not encrypted.** `kdpt1.<payload>.<signature>` carries a company id, a resource
   id and an expiry - none of them secret - and an HMAC-SHA-256 over the exact header and payload makes
   every claim unforgeable. A link is a credential, not a document.
2. **Expiry is a lifetime, bounded on both sides.** A caller asks for seconds, never a date, and the
   reader re-checks the signed span against the same 300 second floor and 30 day ceiling, so the rule
   survives a future caller that does not know it.
3. **The clock is an argument.** No `Date.now()` in the module, so the gate can stand on the last second
   the link opens and on the instant it stops, and a job can be exercised without waiting.
4. **Revocation is a predicate the caller owns, called last.** After the signature, after the clock, and
   after the claim is trusted. A forged, edited or expired link therefore never reaches a database, and a
   public route is not an oracle for which invoice ids exist.
5. **A digest, never the token.** `portalTokenDigest` returns `kdpd1.` and one SHA-256, so the store that
   revokes a link names it without keeping a copy that could be followed.
6. **One canonical payload.** Rebuilt in the schema's field order and compared with the bytes that
   arrived, so one set of claims has one spelling, one link and one digest.
7. **Every refusal of an open is a 404 with one reason.** A visitor who can tell a wrong signature from an
   expired link has a probe; the reason travels in `cause` for the log and for the page copy. A bad key
   ring or a bad clock is `INTERNAL_ERROR` instead, because that is this platform's mistake.
8. **The kind owns the capability.** An invoice is read and paid, an estimate is read and signed, a
   payment link is read and paid; a token that pairs one with another kind's capability is refused when
   minted and again when read.
9. **The key is derived from the existing secret.** HKDF-SHA-256 of `ENCRYPTION_MASTER_KEY` under
   `kd-portal-token:v1`, with retired master keys accepted during a rotation - no new environment
   variable, no new key to remember at deploy time.

## Owned paths

New: `lib/security/portal-token.ts`, `docs/planning/STEP_065_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_065_COMPLETED.md`.

Edited: `lib/security/verify.ts` (the corpus and the wiring), `lib/security/README.md`, and one export in
`lib/security/encryption.ts` (`decodeCanonicalBase64Url`) so the canonical base64url rule stays one rule
instead of two copies.

STEPs 056-067 own `lib/security/`, so nothing outside it is touched. No migration is added (database
STEPs 012-036 own `migrations/`), no route is added (portal STEPs 181-190 own `app/(client-portal)/`), and
`package.json` is not edited.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_064_COMPLETED.md` (committed `32cd393`), `STEP_PLAN_250.md` line 848, feature list lines 26, 177,
179 and 180, master prompt lines 8-16 and 30-40, the ownership rules at line 45,
`lib/security/encryption.ts`, `lib/auth/cookies.ts`, the env manifest and the migrations list (to confirm
that no portal table exists yet).

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

None. A link is not stored: its claims travel in the token, and the only row a later STEP needs is the
revocation record, whose store and table belong to the STEP that owns the document being revoked. The gate
asserts that this module holds no query and imports no client, so a test cannot pass by writing one.

## Sub-step 4 - The core logic

`lib/security/portal-token.ts`:

- `PORTAL_TOKEN_PREFIX`, `PORTAL_TOKEN_VERSION`, `PORTAL_TOKEN_SIGNATURE_BYTES`, `PORTAL_TOKEN_ID_BYTES`,
  `PORTAL_TOKEN_DIGEST_PREFIX`, `PORTAL_TOKEN_SIGNING_INFO`, `PORTAL_TOKEN_KEY_BYTES`,
  `PORTAL_TOKEN_MAXIMUM_PAYLOAD_BYTES`, `PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS`,
  `PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS`, `PORTAL_TOKEN_CLOCK_SKEW_SECONDS`,
  `PORTAL_TOKEN_MAXIMUM_KEYS`, `PORTAL_TOKEN_KINDS`, `PORTAL_TOKEN_CAPABILITIES`,
  `PORTAL_TOKEN_CAPABILITIES_BY_KIND`, `PORTAL_TOKEN_PROBLEMS` - the format, as constants;
- `PortalTokenKeys`, `PortalTokenRequest`, `PortalTokenMintOptions`, `PortalTokenExpectation`,
  `PortalTokenRevocations`, `PortalTokenOpenOptions`, `PortalTokenClaim` - the inputs and the claim;
- `isPortalTokenKind`, `isPortalTokenCapability` - the vocabularies;
- `mintPortalToken`, `openPortalToken`, `portalTokenDigest` - the three operations.

## Sub-step 5 - Routes and jobs

There is no route to connect, and this STEP is the second clear case of why: the portal routes do not
exist yet by design. STEPs 181-190 own `app/(client-portal)/`, and they will call `mintPortalToken` when a
merchant sends an invoice, `openPortalToken` with the expectation of the page they are rendering, and
`portalTokenDigest` when they store the revocation row. The gate proves the module is complete, that one
module in the tree writes a link, and that one module derives the signing key, so those STEPs wire a
function rather than a decision.

## Sub-step 6 - UI

Not applicable: nothing renders a link yet. The page that shows "this link has expired" is the portal
STEP's page, and its copy lives in `lib/i18n/strings/en.ts` under that STEP's ownership. No string was
added to the catalogue.

## Sub-step 7 - Security proof

`checkPortalTokenKeys`, `checkPortalTokenMint`, `checkPortalTokenOpen`, `checkPortalTokenRevocation` and
`checkPortalTokenWiring` in `lib/security/verify.ts`: the constants and the problem list; the kind and
capability tables; the derivation compared with one the gate computes for itself; a key corpus including
the second base64 spelling of a master key; the ring (duplicate, oversized, short key, retired key); six
mint combinations of kind and capability; seven refusals of an impossible request; four impossible link
ids; a link that opens until its last second and not on the instant it expires; the clock skew on both
sides of the boundary; an edited payload, a second spelling of the signature, a signature from another
link, a signature that does not cover the header, a later version, a version written with a leading zero,
an upper case header; ten malformed strings; two signature lengths; sixteen signed claims that a writer
would never produce (version, kind, capability, uuid, link id, a second link-id spelling, an extra field,
missing fields, a timestamp as a string, a fraction, and four lifetimes); a reordered payload, a padded
payload and an oversized payload; four expectations that do not match; four key-ring refusals; the two
error codes; the digest; and the revocation lookup, which is proved never to be called for an edited, an
expired or a foreign-signature link.

Thirty mutation controls, all caught: a retired key that no longer verifies, a signature that does not
cover the header, a comparison that is not constant time, an unchecked version, any header shape, a
non-canonical payload, a claim with an extra field, the capability table skipped on read and on mint, an
off-by-one expiry, an hour of skew, the lifetime ceiling and floor skipped on read and on mint, the
revocation list ignored, the lookup asked about another id, an expectation not compared, a digest that
carries the link, a digest computed for anything, the link-id canonical rule skipped on mint and on read,
a ring that repeats a key, a ring of any size, a master key of any length, a payload ceiling of ten
kilobytes, a short signature accepted, a derived key not wiped, a fractional clock, and an expiry past the
range of a timestamp.

One thing the corpus itself changed: the first draft bounded the whole token at 1 024 characters as well
as the payload at 512 bytes, and a token of that length cannot exist - a header, a bounded payload and a
43 character signature cannot exceed 732 characters - so deleting the total-length guard changed no
answer and the mutant would have survived. The bound that bites is the payload's, and it now says
`payload_too_large` rather than sharing `token_invalid`, so the two facts a caller can act on are
distinguishable. The same reason retired a `Number.isSafeInteger` check on the minted expiry: two bounded
integers cannot leave the safe range.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, `npm run build`, one commit
`STEP 065: Signed token service for client portal links with expiry and revocation` on
`arena/1dc51ec3-kd-solution-it`, pushed, with `docs/handoffs/STEP_065_COMPLETED.md`.
