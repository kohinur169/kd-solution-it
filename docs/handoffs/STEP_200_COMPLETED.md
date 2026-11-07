# STEP 200 — Merchant API credential creation with masked display

Status: **complete**. Commit `STEP 200: Merchant API credential creation with masked display` (`2343124`), then this
handoff, on `arena/ca936761-kd-solution-it`, branched from STEP 199's `d294a88`. Typecheck, lint and build are
clean, `npm run verify` is exit 0 over **71 gate lines**, and the STEP's own gate is
`lib/api/verify-credentials.ts` at **206 checks**, mutation-checked with **18 distinct mutations, all red**.

## STEP

From `docs/final/STEP_PLAN_250.md:2558`:

> **STEP 200: Merchant API credential creation with masked display**
> Chat line: Implement STEP 200 only: Merchant API credential creation with masked display.

FEATURE_LIST §20 (`:213`), the sentences this STEP owns: *"A public API exists for online store payments only.
Merchants create, revoke and regenerate API credentials. Full API keys and secrets are never displayed. After
creation they are shown masked only and never appear in UI, logs or error messages."* The revoke and regenerate
half of that sentence is STEP 201's; *"Every API call requires authentication and is rate limited and audit
logged"* is STEP 202's. This STEP is the creation and the mask.

The eight sub-steps, as walked: read §20 / §8 / MASTER_PROMPT / the STEP 199 handoff; confirm the owned paths;
**the database part, which turned out to need no migration**; the service; the route; the screen at two widths; the
security slice; then the gate, the mutations, the smoke, one commit, the push and this file.

STEP 201 was **not** started, and STEP 199 was not reopened.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `lib/api/credential-fields.ts` | new | 176 | The browser-safe vocabulary: two modes, two statuses, the key pattern, the handle and tail patterns, the 80/10/50/1024 bounds, the five rules, the one audit action, `maskedKeyOf`, `maskedSigningSecretOf`, `credentialSecretContext`, the two view types |
| `lib/api/credentials.ts` | new | 353 | `parseCreateCredentialBody`, `readMerchantCredentials`, `createMerchantCredential`, `hashOfPresentedKey` and the two shape predicates a STEP 202 verifier will want - over a `CredentialDependencies` of rest, chain, clock, seal and randomness |
| `lib/api/credential-runtime.ts` | new | 30 | `getCredentialRuntime()`: a projection of `getAuthRuntime()` plus the environment's encryption key and `randomBytes` |
| `lib/api/verify-credentials.ts` | new | 1 037 | The gate, 206 checks, over an in-memory PostgREST carrying `0034`'s twelve checks, its frozen-identity guard and its three unique indexes |
| `app/api/developers/api-credentials/route.ts` | new | 97 | `POST` - CSRF, the 1024-byte ceiling, the session, the parse, one service call, a `no-store` 201 and a log line that names no key material |
| `app/(dashboard)/developers/api-credentials/page.tsx` | new | 123 | The merchant screen: four states (ready, signed out, forbidden, unavailable) and the panel |
| `app/(dashboard)/developers/api-credentials/credential-panel.tsx` | new | 301 | The browser form: a label and a mode, the mask of what was made, the list of what stands, and no way to reveal anything |
| `lib/security/csrf.ts` | edited | +1 | `/api/developers/api-credentials` on `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | 58→59 files, 87→88 calls | The browser mutation inventory, with the reason beside it |
| `lib/i18n/strings/en.ts` | edited | +38 | The `api.*` block |
| `package.json` | edited | +1 link | `check:api-credentials`, one link in the `verify` chain |
| `migrations/` | **untouched** | - | See below: this STEP writes none |

## Why there is no migration

Section 20's storage already exists. `migrations/0034_merchant_api_credentials.sql` was written by STEP 023, which
owns the schema for section 20, and it is complete for creation: `key_prefix`, `key_last_four` and a `key_hash`
that is never unhashed; the webhook signing secret as AES-256-GCM ciphertext, its iv, its tag and a key version;
`status`; `revoked_at` and `revoke_reason` for STEP 201; `rotated_from_id` with a unique index so regeneration is a
link rather than an edit; twelve checks; a guard trigger that freezes a credential's identity; three unique
indexes; RLS with a default-deny policy.

`0034` also had **no TypeScript at all** before this STEP: nothing in the repository named the table. So the STEP's
work is the layer above the schema, and the ownership rules are obeyed rather than bent - *"No completed migration
is edited"*, and STEP 200's block grants no migration exception. The chain therefore still ends at **0128 / 128
migrations / 99 tables**, and the seven gates that pin the chain head needed no edit this time.

The one rule the schema does not carry is a **count** limit, and that belongs in the service: `0034` bounds nothing
about how many credentials a merchant holds, because that is a product decision that should be changeable without
a migration. `CREDENTIAL_ACTIVE_LIMIT = 10` per mode is this STEP's, counted before the insert.

## The create, in one paragraph

**A key is made to be hashed and dropped.** `createMerchantCredential` applies the `owner` role, takes the company
from the session (`requireCompanyId`, never the body), parses `{ label, mode }` as a strict object, counts the live
credentials in that mode with a `limit`-bounded read and refuses the eleventh, then draws 32 random bytes: those
become `kd_<mode>_<handle>_<64 hex>`, and the row keeps their SHA-256, the handle and the last four characters. A
second 32-byte draw is the **webhook signing secret**, sealed through the platform's own AES-256-GCM
(`sealSecret`) under associated data that names the merchant - so a ciphertext copied into another merchant's row
does not open - and only its last four characters are kept in the clear. The row is inserted and read back through
`insertReturning`, a duplicate label is translated from `0034`'s partial unique index into
`credential_label_taken`, and the chain gets one `api.credential_created` entry naming the mode, the handle and the
tail. Then the key is out of scope, and it went nowhere: not into the response, not into a column, not into the
audit payload, not into the log line.

**What comes back is a mask.** `CredentialView` has a label, a mode, a status, a handle, the last four characters,
`maskedKey` (`kd_test_shop_••••••••4f2a`) and `maskedSigningSecret`. There is no property on it that can hold a key
or a secret, which is a shape the gate asserts rather than a promise in prose.

**The screen is the same list.** `/developers/api-credentials` reads the merchant's own rows, newest first, with
the counts per mode and the room left; the form makes another; each card shows the two masks, the mode, the state,
the date made and when it was last used. No reveal control exists anywhere in the file, because section 20 says a
key is never displayed - and the gate refuses the file if one appears.

## What the gate proves (11 sections, 206 checks)

| Section | What it pins |
| --- | --- |
| 1 | That this STEP added **no** migration (the chain still ends at 0128, 128 files), that `0034` carries the twelve checks, the guard, the three unique indexes and the default-deny policy, and that every column the service writes is a column the table has |
| 2 | The words: two modes, the mask character, the 80/10/50/1024 bounds, five machine-word rules, and an audit action that fits the chain's own pattern |
| 3 | **The key, and its absence.** The gate supplies the randomness, so it knows the exact key: the row's hash equals the SHA-256 the gate recomputes, the handle and tail are cut from the key, hashing a presented key finds the row, the ciphertext opens to the signing secret under the merchant's associated data and **fails under another merchant's** - and then every column, the view, the serialised view and the audit payload are searched for the key: absent from all of them |
| 4 | The display: the mask is built from the handle and the tail, has eight mask characters, and contains no run long enough to be part of a key; the secret's mask carries no part of the secret |
| 5 | The body: trimming, and eight malformed bodies refused (unknown mode, empty, blank, 81 characters, a body that names a company, either field missing, not an object) |
| 6 | Who may create: support, the finance desk, a platform administrator and an owner without a company are all refused, nothing is written by a refusal, and a crafted body cannot move the row to another merchant |
| 7 | The two rules the table has: a duplicate live label in either mode is refused **as the rule the screen knows**, and the eleventh credential in a mode is refused while the other mode still has room |
| 8 | The read: scoped to the merchant, newest first, per-mode counts, the limit, `canCreate`, no hash in what the screen holds, a role that may not read refused, a revoked row still listed with its reason and no longer counted, and `0034`'s frozen identity entered directly (a moved hash refused) |
| 9 | The route: token before session, ceiling before body, the service call, the envelope, `no-store`, `201`, no `console`, and a log line that names no key, secret, hash, prefix or tail |
| 10 | The screen: the owner's session, the service read, a forbidden state of its own, the mask rendered, the token spread once, one mutation, `role="alert"`, a disabled button, a bounded label, a re-read after the act, a two-column form from the tablet breakpoint, and **no reveal, show, copy or clipboard anywhere** |
| 11 | Every message the page and the panel name exists, and the limit's sentence takes both numbers |

### The mutations

All 18 red, each restored immediately:

1. the owner role → support
2. the body validated → cast
3. the limit counted → `if (false)`
4. the label conflict translated → rethrown raw
5. SHA-256 → MD5
6. the tail cut to four → cut to sixty-four
7. the secret sealed to its merchant → sealed to another
8. the read scoped to the merchant → unscoped
9. the audit's entity id → null
10. the mask width 8 → 0
11. the handle's initial `k` → `K`
12. the route's token check → removed
13. the route's `no-store` → removed
14. the log line gains the key prefix
15. the panel prints the handle instead of the mask
16. the panel gains a reveal control
17. the CSRF list loses the path
18. the read's role list widened to support

Two were caught only after the gate was made to look at the right thing: the handle mutation lives in
`credentials.ts` (not in the fields module), and the "no reveal" check was first defeated by the word *reveal*
appearing in the panel's own prose - it now names controls (`revealKey`, `showKey`, `copyKey`,
`navigator.clipboard`).

## Security

- **Validation.** `{ label, mode }` is a strict object validated twice: the Zod schema for shape and the service for
  the trimmed label's length. The label is trimmed before it is compared, because `0034` refuses a label that is not
  already trimmed.
- **Body ceiling.** 1024 bytes, refused on `content-length` and again on the decoded length.
- **RLS.** `0034` already enables row level security with a default-deny policy and no role named; this STEP adds no
  policy and reads through the service role, as every service in this repository does.
- **Audit.** `api.credential_created` on the merchant's chain: the actor, the company, the credential's id, and a
  payload of `{ mode, key_prefix, key_last_four }`. The key, its hash and the signing secret are not in it, and the
  gate proves that by searching the payload for the key it issued.
- **Permissions.** `owner` only, and the company always from the session. A platform role - including
  `super_admin` - holds no company and is refused by the same two guards, which is deliberate: an administrator who
  could mint a merchant's key could sign as that merchant.
- **Never displayed, never logged.** The route's log line carries `credentialId`, `mode` and `labelLength`. The
  response is `no-store` and holds a mask. The panel has no reveal control. The gate asserts all three.
- **Cross-tenant.** The signing secret's ciphertext is sealed under `kd-aad-v1|merchant_api_credential|<company>`,
  so a row moved to another merchant cannot be opened - proved by attempting the open with the wrong company.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean
npm run check:api-credentials     206 checks
npm run verify                    exit 0, 71 gate lines
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables (unchanged: no migration)
node lib/i18n/verify.ts           3199 messages, 342 placeholders
node lib/auth/verify.ts           59 files / 88 call sites (one pre-existing failure, unchanged)
node scripts/verify-structure.mjs 764 source files
node scripts/verify-audit.mjs     4352 checks
```

The pre-existing red set is unchanged and was not absorbed: `lib/auth/verify.ts` 1 (`auth/device-proof-store`),
`lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3404 with the placeholder environment STEP 199 recorded (`SUPABASE_URL` must be `https`, or
every request fails with a 500 that reads like a handler bug).

| Request | Answer |
| --- | --- |
| `GET /signin` | `200` |
| `GET /developers/api-credentials` signed out | `200`, rendering the section's own signed-out sentence - the same answer `/invoices/new` gives, because the merchant shell renders a refusal rather than redirecting |
| `POST /api/developers/api-credentials` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` |
| the same with a header that does not match its cookie | the same `422` |
| the same with a body that is not JSON | the same `422` - the token is checked before the body is |
| `GET` on the route | `405` |
| `next build` | `/api/developers/api-credentials` and `/developers/api-credentials` listed as dynamic function routes |

The authenticated paths cannot be walked here: `GET /api/auth/csrf` answers `503 DEPENDENCY_FAILED` without a
Supabase project, so no token can be minted and no session exists. Those paths are exercised end to end against the
fixture in the gate, which carries `0034`'s twelve checks, its guard and its three unique indexes, and a real
AES-256-GCM seal with a fixed master key. `.env.local` was deleted again (checked: absent).

**Desktop and mobile widths** - the form is two fields in `grid-cols-1` on a phone and `sm:grid-cols-2` from the
tablet breakpoint; each credential is a stacked card with its two masks in `overflow-x-auto` monospace blocks, so a
long mask scrolls inside its own box rather than pushing the page sideways. The list is a `<ul>`, not a table, so
nothing scrolls horizontally at 360 px.

**Keyboard and themes** - one text input, one select, one button: tab order is the browser's own, the button is
focus-visible through `focus-visible:ring-2`, and every colour is a theme token (`bg-background`, `text-foreground`,
`border-border`, `bg-muted/60`), so light and dark follow the shell.

## A conflict with FEATURE_LIST §20, and how it was resolved

Section 20 says, twice, that a full key is **never displayed** - *"Full API keys and secrets are never displayed. After
creation they are shown masked only."* Taken literally, a merchant can never obtain a key, and a credential nobody
can present is not usable. The industry reading is one reveal at the moment of creation; the section's own words
exclude it.

This STEP follows the section, because the rules say FEATURE_LIST wins and the conflict must be written down:
**the key is generated, hashed, and shown only as a mask.** The delivery a working integration needs is named in
gap 1 below rather than invented here.

## Carried gaps (named rather than hidden)

1. **A key is never shown, so a merchant cannot yet hold one.** This is section 20 obeyed literally, and it is the
   one place where obeying it costs function. Two honest resolutions exist, and both are a decision for the owner:
   (a) amend §20 to allow the key to be displayed **once**, in the creation response only, never stored and never
   logged; or (b) deliver it out of band, server to server, when the Shopify app install (STEP 204) and the
   WooCommerce plugin (STEP 205) exchange credentials. Until one happens the credential exists, is scoped, is
   audited and is masked - and cannot sign a request.
2. **The creation does not email the merchant a key either.** Section 23's sender is the only outbound channel, and
   putting key material through it would be the same disclosure §20 forbids.
3. **No revocation and no regeneration.** `0034` has `revoked_at`, `revoke_reason` and `rotated_from_id` ready, the
   panel already renders the revoked state, and this STEP writes neither - STEP 201 owns both.
4. **No authentication, no rate limit, no per-call audit.** Nothing yet verifies a presented key.
   `hashOfPresentedKey`, `isWellFormedHash` and `hasWellFormedTails` are exported for that verifier, which is
   STEP 202's.
5. **No last-used write.** `last_used_at` is displayed and never set, because setting it is the authenticator's act
   (STEP 202).
6. **The store connections are not built.** §20's Shopify app, WooCommerce plugin and the automatic activation
   of both are STEPs 204 and 205; no `app/api/public/` route exists yet, which is why this STEP's one route lives
   under `app/api/developers/`.
7. **Ten per mode is this STEP's number, not a policy document's.** §20 states no limit; the constant is exported,
   the panel prints it, and changing it is a one-line edit rather than a migration.
8. **The gate drives the service, not the route's HTTP body.** The route's guards are pinned in source and exercised
   against a running server for the signed-out and CSRF paths; a request that clears CSRF and fails validation
   cannot be produced here without a session, which is the same limit every STEP since 191 has recorded.
