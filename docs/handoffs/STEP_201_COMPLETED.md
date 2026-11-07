# STEP 201 — API credential revocation and regeneration

Status: **complete**. Commit `STEP 201: API credential revocation and regeneration` (`da07079`), then this handoff,
on `arena/ca936761-kd-solution-it`, branched from STEP 200's `63be53a`. Typecheck, lint and build are clean,
`npm run verify` is exit 0 over **72 gate lines**, and this STEP's gate is `lib/api/verify-credential-rotation.ts`
at **190 checks**, mutation-checked with **16 mutations, 15 red and one shown to be equivalent**.

## STEP

From `docs/final/STEP_PLAN_250.md:2570`:

> **STEP 201: API credential revocation and regeneration**

FEATURE_LIST §20 (`:215`), the sentence this STEP owns: *"Merchants create, revoke and regenerate API
credentials."* The create was STEP 200's; *"Every API call requires authentication and is rate limited and audit
logged"* is STEP 202's.

The eight sub-steps, as walked: read §20 / §8 / MASTER_PROMPT / the STEP 200 handoff; confirm the owned paths; the
database part, which again needed **no migration**; the service; the two routes; the panel's two new acts at two
widths; the security slice; then the gate, the mutations, the smoke, one commit, the push and this file.

STEP 202 was **not** started, and STEP 200 was not reopened beyond the three additions this STEP's own feature needs
from the shared module.

## Owned paths

| Path | State | Lines | What it holds |
| --- | --- | --- | --- |
| `app/api/developers/api-credentials/[id]/revoke/route.ts` | new | 106 | `POST` — CSRF, the 1024-byte ceiling, the session, the parse, one guarded write, and a log line that names the reason's *length* |
| `app/api/developers/api-credentials/[id]/regenerate/route.ts` | new | 117 | `POST` — the same five guards, an empty body that is refused if it carries anything, and both views in the answer |
| `lib/api/verify-credential-rotation.ts` | new | 1 026 | The gate, 190 checks, over an in-memory PostgREST with `0034`'s checks, its guard, its three unique indexes, and two switches for the two failure modes |
| `lib/api/credentials.ts` | edited | +304 (353 → 657) | `issueMaterial` and `insertCredential` factored out of the create, then `credentialIdOf`, `readOne`, `updateCredential`, `parseRevokeBody`, `revokeCredential`, `regenerateCredential` |
| `lib/api/credential-fields.ts` | edited | +66 | The reason ceiling, the platform's rotation sentence, `supersededLabelOf`, five rules, two audit actions |
| `app/(dashboard)/developers/api-credentials/credential-panel.tsx` | edited | +217 (301 → 518) | The two acts on a live card: a reason field that opens in place, a revoke, a regenerate, and a busy state across all three |
| `lib/api/verify-credentials.ts` | edited | 2 assertions | The panel's mutation count moves from one to three, because STEP 201 adds two to the same file |
| `lib/security/csrf.ts` | edited | +2 | Both new paths on `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | 88→90 call sites | Two new calls in an existing browser file |
| `lib/i18n/strings/en.ts` | edited | +19 | The revoke and regenerate sentences and their five refusal rules |
| `package.json` | edited | +1 link | `check:api-rotation`, one link in the `verify` chain |
| `migrations/` | **untouched** | - | `0034` already models both acts |

## Why there is no migration, again

`0034` was written for exactly these two acts even though STEP 023 had no code to use them: `revoked_at`,
`revoke_reason` with a check that couples them to `status`, a guard that makes a revocation final, and
`rotated_from_id` with a unique index that says a credential replaces **at most one** predecessor. STEP 201 is the
first code to touch any of it. The chain therefore still ends at **0128 / 128 migrations / 99 tables**, and no gate
that pins it needed an edit.

One detail of `0034` decided the entire rotation design. The label is unique per merchant among live rows
(`(company_id, lower(label)) where deleted_at is null`), and the identity guard freezes the key material but **not**
the label - a deliberate separation in STEP 023's own comment, which says a credential keeps its *identity* rather
than its *name*. So a rotation can hand the merchant's name to the successor without touching a frozen column, and
the predecessor keeps a name that says what happened to it.

## Revocation, in one paragraph

**One guarded write, and its landing is read back.** `revokeCredential` applies the `owner` role, takes the company
from the session, decodes the path id into a uuid-or-not-found, parses `{ reason }` as a strict object with a
trimmed 1–280 sentence, reads the row **scoped to that company** (another merchant's id is a plain
`RESOURCE_NOT_FOUND`, never a 403 that confirms the row exists), refuses a credential that is already revoked, and
then writes `status`, `revoked_at` and `revoke_reason` through a query that carries `version=eq.<the version it
read>`. PostgREST answers success to an update that matched nothing, so the service reads the row back and compares
every value it wrote: a race becomes `credential_write_not_applied` rather than a screen that tells a merchant a
live key is dead. The chain gets `api.credential_revoked` with `revoked_by: "merchant"`, the mode, the handle and the
tail — never the merchant's sentence, which stays on the row. `0034` refuses any later status change, so a
revocation cannot be undone here, by a later STEP, or by a mistake.

## Regeneration, in one paragraph

**Three writes in the order that fails safest.** `regenerateCredential` applies the same guards, refuses a revoked
credential (`credential_not_active`), refuses a predecessor that already has a successor (the rotation-link rule, and
`0034` enforces it too), and then: **(1)** renames the predecessor to `Main store (superseded a1b2)` — four
characters of its own id, so two rotations of one name cannot collide — which frees the label and changes nothing
else, because the key is still live and still the merchant's; **(2)** inserts the successor under the original label
with fresh 32-byte key material, a fresh sealed signing secret and `rotated_from_id` naming its predecessor; **(3)**
revokes the predecessor with the platform's own sentence. Both rows are readable afterwards — the successor under the
name the merchant knows, the predecessor as history — and the chain gets two entries, the retirement
(`revoked_by: "rotated"`) and the rotation naming both rows.

The two failure modes are chosen rather than hoped for, and both are walked by the gate:

- **The successor cannot be written.** The compensation puts the original name back, so the merchant holds exactly
  one live credential under the name they know, and the error is the database's.
- **The retirement cannot be written.** The successor exists and the predecessor is still live, so the merchant holds
  **two** keys rather than none — a state a person sees in the list and ends with the revoke button. The service says
  `rotation_incomplete` instead of answering "regenerated", and a second press of regenerate on that predecessor is
  refused by the rotation link rather than writing a second successor.

## What the gate proves (10 sections, 190 checks)

| Section | What it pins |
| --- | --- |
| 1 | That this STEP added **no** migration, that `0034` carries `revoked_at`, `revoke_reason`, `rotated_from_id`, the one-successor index, the reason/status coupling and the make-it-final guard - and that the guard freezes the hash while leaving the label free, which is what makes a rotation possible at all |
| 2 | The revocation body: trimming, the 280 ceiling, and six malformed bodies refused |
| 3 | Revocation behaviour: the three columns written, **the key material untouched**, the version bumped by exactly one, the chain entry with `revoked_by` and *not* the sentence, the row still listed and no longer counted, a second revocation refused with the rule the screen knows, four roles refused or scoped away, a non-uuid id and an unknown id both plain not-founds, and a concurrent write turned into `credential_write_not_applied` with the credential still live |
| 4 | Rotation behaviour: the successor under the original name with a different key, handle and sealed secret; the predecessor renamed and revoked with the platform's sentence and its hash untouched; exactly one live credential; both chain entries; the two issued keys absent from every row, entry and view; a second rotation refused; the successor itself rotatable onward; a three-credential chain each naming the one before; and support and another merchant refused |
| 5 | Both failure modes: the insert failure restores the name and leaves one live credential, the retirement failure leaves two live keys and reports `rotation_incomplete`, and a second rotation in that state is refused by the link rule |
| 6 | The predecessor's name: bounded to the column's 80, closed, saying "superseded", carrying four characters of its own id, and two predecessors of one name never colliding |
| 7 | The two routes: token before session, ceiling, session, service, envelope, `no-store`, no `console`, the reason's length logged rather than the reason, the empty-body rule, both views answered, both paths on the CSRF list |
| 8 | The panel: the reason bounded at 280, one card's field open at a time, a revoke disabled until a sentence exists, both paths built from the id, three mutations and three token spreads, `role="alert"`, and still no reveal anywhere |
| 9 | Every message the panel names exists, plus the twelve sentences this STEP added |
| 10 | The two new audit actions fit the chain's pattern, every rule is a machine word, and the platform's own rotation sentence fits the column it goes in |

### The mutations

Sixteen, each restored immediately. Fifteen red:

1. the already-revoked guard → `if (false)`
2. the version guard removed from the revocation's query
3. the reason not trimmed
4. `revoked_at` written as null
5. the rename skipped, so the successor collides with the predecessor's label
6. the failed insert no longer restoring the name
7. the failed retirement reported as something else
8. the successor's `rotated_from_id` nulled
9. the successor taking a superseded name instead of the merchant's
10. the one-successor pre-check removed
11. the retirement's reason weakened to a different sentence
12. the superseded name allowed past the column's room
13. the revoke path off the CSRF list
14. the rotation's empty-body rule disabled
15. the revoke button no longer requiring a sentence
16. the landed-write comparison replaced by `true` (caught on the second pass)

**The sixteenth is equivalent, and that is written down rather than hidden**: replacing
`z.string().uuid().safeParse` with `z.string().safeParse` in `credentialIdOf` changes nothing observable, because a
non-uuid reaches the same scoped read and misses it, and both paths answer `RESOURCE_NOT_FOUND`. The guard is kept
because it keeps a malformed id out of the query string, and the mutation is recorded as equivalent instead of
being dressed up as a kill.

Two mutations were **missed on the first pass** and the gate was made stronger rather than the mutation dropped:
the version guard is now proved by a *concurrent writer* that moves the row's version out from under the service
(the earlier test lost the update at the fixture level, which proved the read-back but not the guard), and the
compensation mutation was rewritten to delete the restoring write rather than change the object it is passed.

## Security

- **Validation.** `{ reason }` is a strict object, trimmed and bounded at 280 both in Zod and again in the service;
  the rotation body must be empty, and anything in it is a refusal. The path id is a uuid or a not-found.
- **Body ceilings.** 1024 bytes on both routes, declared and decoded.
- **RLS.** Unchanged: `0034`'s default-deny policy, and both routes write through the service role.
- **Audit.** `api.credential_revoked` (with `revoked_by: merchant | rotated`) and `api.credential_regenerated`
  (naming both rows). Neither carries the merchant's sentence, the key, the hash or the signing secret; the gate
  searches the payloads for the two keys it issued.
- **Permissions.** `owner` only, and the company always from the session. Another merchant's credential is a
  not-found rather than "exists but forbidden", so the API cannot be used to enumerate ids.
- **Optimistic locking.** Both acts read the version and guard on it, and both prove the write by reading the row
  back - the `RestClient` has no transactions, so this is the discipline every service in this codebase uses.

## Verification

```
npx tsc --noEmit                  clean
npx eslint .                      clean
next build                        clean
npm run check:api-credentials     225 checks (unchanged behaviour, two counts updated to three)
npm run check:api-rotation        190 checks
npm run verify                    exit 0, 72 gate lines
node migrations/verify.ts         3778 checks, 128 migrations, 99 tables (unchanged: no migration)
node lib/i18n/verify.ts           3218 messages, 342 placeholders
node lib/auth/verify.ts           59 files / 90 call sites (one pre-existing failure, unchanged)
node scripts/verify-structure.mjs 767 source files
```

The pre-existing red set is unchanged and was not absorbed: `lib/auth/verify.ts` 1 (`auth/device-proof-store`),
`lib/security/verify.ts` 3, `components/office/verify.ts` 13.

### Exercised on a running server

`next start` on port 3404 with the placeholder environment STEP 199 recorded.

| Request | Answer |
| --- | --- |
| `POST /api/developers/api-credentials/<id>/revoke` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` |
| `POST .../<id>/regenerate` (no token) | the same `422`, the same rule |
| both, with a header that does not match its cookie | the same `422` |
| both, with `<id>` replaced by `not-a-uuid` | the same `422` - the token is checked before the id |
| `GET` on both | `405` |
| `GET /developers/api-credentials` | `200`, the screen's own signed-out state |
| `next build` | `/api/developers/api-credentials/[id]/revoke` and `/api/developers/api-credentials/[id]/regenerate` listed as dynamic function routes |

The authenticated paths cannot be walked here - no session can be issued without a Supabase project - and are
exercised end to end against the gate's fixture, which carries `0034`'s checks, its guard and its three unique
indexes, plus the two failure switches. `.env.local` was deleted again (checked: absent).

**Desktop and mobile widths** - the two acts sit in a wrapping `actionsClasses` row inside each card, so on a phone
they stack under the masks and from the tablet breakpoint they sit side by side. Opening a revocation swaps the row
for a labelled field and two buttons in the same `grid-cols-1` column, so nothing is pushed sideways at 360 px. The
reason field is a text input with the 280 ceiling, focus-visible through the shared field classes, and all colours
are theme tokens.

## Carried gaps (named rather than hidden)

1. **A rotated credential is still never displayed.** STEP 200's gap 1 stands, unchanged and by design: §20 says a
   full key is never displayed, so regeneration produces a new key that nobody receives either. Rotation is
   therefore, today, a way to **kill** a key and mint an unusable one. It becomes useful the moment §20 is amended
   for a single reveal or a server-to-server exchange lands (STEPs 204-205) - and the service already returns the
   successor's mask, the shape such a delivery would carry.
2. **A half-rotation needs a person.** If the retirement fails, two keys are live and the panel says so, but
   nothing retries in the background and no alert is raised; the merchant must press revoke. A retry job is
   STEP 202's or a later STEP's, and would need a claim column this STEP does not add.
3. **No confirmation dialog on regenerate.** The button acts on one press because the act is reversible in the only
   sense that matters (the merchant can revoke the successor and make another); a modal would be a component this
   repository does not have. The revoke, which is final, does require a typed sentence first.
4. **No bulk revoke and no per-credential history screen.** One credential, one press. The chain has every entry and
   the row carries its instant and sentence, but no screen reads them back.
5. **`last_used_at` is still never written.** Unchanged from STEP 200: setting it is the authenticator's act.
6. **Revocation is not communicated.** The merchant's own screen shows it; nobody is emailed, and the reason is not
   sent anywhere. §20 asks for neither.
7. **No rate limit on the two routes beyond the platform's generic guard.** Per-route limits for credential acts are
   §20's "every API call is rate limited" - STEP 202's sentence, about the public API rather than these forms.
8. **The label quarantine is this STEP's invention.** §20 says nothing about what happens to a predecessor's name.
   Renaming was chosen over soft-deleting the row (which would have hidden the history an acquirer asks for) and
   over refusing the rotation (which would have made the feature useless); the suffix format is documented in
   `supersededLabelOf` and asserted by the gate, so a later STEP can change it deliberately.
