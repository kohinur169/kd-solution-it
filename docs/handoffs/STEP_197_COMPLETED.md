# STEP 197 — Structured evidence pack builder: invoice, delivery proof, communications

Status: **complete**. Commit `STEP 197: Structured evidence pack builder: invoice, delivery proof,
communications` (`21b819a`), then `STEP 197: a frozen pack offers no action, and a refusal is announced`
(the follow-up that finished the UI slice, described below), then this handoff, on
`arena/ca936761-kd-solution-it`, branched from
STEP 196's `2bd2eec`. Typecheck, lint and build are clean, and the STEP's own gate is
`services/disputes/dispute-evidence-verify.ts` at **359 checks**, mutation-checked with fifteen mutations in the
final run (twenty in the first), all red.

## Resumed after a re-initialised sandbox

The workspace's `.git` had fallen back to the branch's base commit while the files themselves were intact, so
the first act of the resumed session was to prove the tree was still STEP 197's: the local branch was moved to
the real head `74cc2ce` with `git reset --soft` followed by `git reset` (no file was written or removed), and
`git status` came back clean - every file on disk already matched the pushed head byte for byte. The preflight
inventory then re-ran every gate and walked the eight sub-steps; slices 1-5 and 7-8 were found complete, and
slice 6 (the UI) was found to have one wart left: on a **frozen** pack the panel still offered the
assemble/refresh button, an action the service is built to refuse. That is what the follow-up commit fixes,
together with two smaller things found in the same read.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 197: Structured evidence pack builder: invoice, delivery proof, communications**
> Sub-step 1: the merchant assembles the four-part pack and freezes it.

FEATURE_LIST §19, the sentence this STEP owns: *"A structured chargeback evidence pack is assembled - invoice,
delivery proof, client communication record and terms acceptance record."*

The pack is **copied, not joined**. Every one of the four parts is read once, at the moment it is added, and
stored as its own row: a label, a summary, the instant the source happened, and the id of the row it came from.
Nothing on this screen is a live query into another module's tables, which is what makes the frozen file a
snapshot rather than a view that changes when a payment is edited. The submission to the processor is STEP 198,
and the chargeback-rate monitoring is STEP 199; neither is here.

Eight sub-steps, all done.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `migrations/0126_dispute_evidence_packs.sql` | new | Three tables - `dispute_evidence_packs`, `dispute_evidence_items`, `dispute_evidence_documents` - three child guards, `disputes_guard_evidence`, RLS default-deny, and `file_id` pointing at `public.files` |
| `migrations/0126_dispute_evidence_packs.down.sql` | new | The rollback: policies, triggers, functions, then the three tables, in one transaction |
| `services/disputes/dispute-evidence-fields.ts` | new | The browser-safe vocabulary: four sections, seven source kinds, twelve rules, the content types, the byte, label, summary, caption and body ceilings. No `node:crypto` import, because the panel imports this file |
| `services/disputes/dispute-evidence-sources.ts` | new | `readEvidenceCandidates`: the per-section read of what the platform already holds - payments, invoices, `invoice_fulfilment_evidence`, `invoice_acceptances`, `policy_acceptances`, `email_send_logs` and `invoice_events` - with a twelve-mail cap and no client address anywhere |
| `services/disputes/dispute-evidence.ts` | new | `readDisputeEvidence`, `assembleEvidencePack`, `addEvidenceItem`, `removeEvidenceItem`, `attachEvidenceDocument`, `removeEvidenceDocument`, `freezeEvidencePack`, `parseEvidenceItemBody`, `evidenceDigestOf` |
| `services/disputes/dispute-evidence-storage.ts` | new | The storage port: `newStorageKey` → `uploadEncryptedObject` → `recordUploadedFile` → digest cross-check → `markFileVerified` |
| `services/disputes/dispute-evidence-verify.ts` | new | The gate, 356 checks, over an in-memory PostgREST that carries `0126`'s three unique keys, its checks and its five trigger bodies |
| `services/disputes/dispute-runtime.ts` | edited | `getDisputeEvidenceRuntime` - the PostgREST client, the audit trail, and the storage adapter resolved from `STORAGE_PROVIDER` |
| `services/disputes/dispute-fields.ts` | edited | The six `dispute.evidence*` audit actions |
| `app/api/payments/disputes/[id]/evidence/route.ts` | new | `POST` - assemble, or refresh from the records |
| `app/api/payments/disputes/[id]/evidence/items/route.ts` | new | `POST` a note, `DELETE` an item |
| `app/api/payments/disputes/[id]/evidence/documents/route.ts` | new | `POST` a multipart upload, `DELETE` a document |
| `app/api/payments/disputes/[id]/evidence/freeze/route.ts` | new | `POST` - freeze, with the version the page read |
| `app/api/payments/disputes/[id]/evidence/request.ts` | new | The three things all four routes do the same way: the id, the body ceiling, the session wiring |
| `app/(dashboard)/payments/disputes/[id]/dispute-evidence-panel.tsx` | new | The merchant's panel: assemble, add a note, upload, remove, freeze |
| `app/(dashboard)/payments/disputes/[id]/page.tsx` | edited | The page now reads `readDisputeEvidence` - one call for the dispute, the pack and the candidates - and mounts the panel between the response section and the outcome section |
| `lib/i18n/strings/en.ts` | edited | Sixty-five `disputes.evidence*` strings, and the note that used to say documents are collected elsewhere rewritten: the pack is where they now go |
| `lib/security/csrf.ts` | edited | The four evidence paths on `CSRF_PROTECTED_PATHS`, in sorted position |
| `lib/auth/verify.ts` | edited | The browser mutation inventory: 55 files / 75 call sites → 56 / 82, with the reason written beside it |
| `services/disputes/dispute-verify.ts`, `dispute-response-verify.ts`, `dispute-warnings-verify.ts` | edited | The migration-count assertions: the chain's head is 126 now, not 125 |
| `services/payments/refund-verify.ts`, `refund-execution-verify.ts`, `refund-fee-verify.ts` | edited | The same 125 → 126 |
| `package.json` | edited | `check:dispute-evidence`, and one link in the `verify` chain |

## The pack, in one paragraph

**A part is complete when it has at least one record or document, and the pack is complete when it has all four
parts and at least one document the merchant supplied.** The platform's own records fill the first three parts
from the invoice, the delivery evidence, the correspondence and the acceptances; the fourth - the terms - comes
from `policy_acceptances`. Assembling is **idempotent**: `0126`'s unique key is
`(pack, section, source_kind, source_id)` among live rows, so pressing the button twice adds nothing, and a
refresh adds only what appeared since - which is why the button is labelled "refresh from my records" after the
first press. The correspondence is capped at **twelve** mails: a pack is a summary for a reviewer, not a mailbox
export. Nothing is ever deleted - removal is `deleted_at`, so the key frees up and the rows stay; there is no
`DELETE` in the service, and the gate asserts the port has no `delete` at all.

The freeze writes one 64-hex digest over the whole pack - **SHA-256 of canonical JSON, ordered by section, then
captured instant, then source kind, then row id, and excluding storage keys** - then raises
`disputes.evidence_ready`, then re-reads and checks both landed. If the flag write is lost, the merchant is told
the pack moved rather than being congratulated on a freeze that a submission would refuse. `0126`'s trigger
refuses a second freeze, refuses an update to a frozen row, refuses an item or document written into a frozen
pack, refuses a digest rewrite, and refuses `evidence_ready = true` on a dispute with no frozen pack. A frozen
pack is immovable: the service's own check is the second lock, not the only one.

## What the gate proves

356 checks in nineteen sections, over an in-memory PostgREST that carries `0126`'s keys, checks and trigger
bodies, so a service that skipped its own check would still fail:

1. **The migration** - three tables, the four sections, the seven source kinds, the content types, the digest
   shape, the count defaults, the unique keys (including the *partial* live-pack index), `file_id` → `public.files`,
   and that `0059`-`0061` gain nothing.
2. **The rollback** - reverse order, one transaction, nothing left behind.
3. **The read** - a dispute with no pack answers `pack: null` and still lists every candidate; a merchant who may
   not see this dispute gets a not-found rather than a hint.
4. **The assemble** - every record the platform holds copied in (seven), a second press adds nothing (the key is
   the guard, not a check in the service), a refresh copies what appeared since (eight), a documents-only pack
   never throws even though `payments.invoice_id` is nullable, and a decided dispute is not packed.
5. **The four parts and the freeze** - a pack without the merchant's paper is not complete, one document under
   all four parts completes it, and the digest changes when a label, a summary or a document does.
6. **The digest's own discipline** - order-independent (two records captured at one instant are ordered by their
   part, not by the read), 64 lowercase hex characters, and it never contains a storage key.
7. **The freeze** - frozen once, the counts are the ones the trigger wrote from the rows, `frozen_at` is set, the
   dispute is evidence ready, and the chain gets `evidence_frozen` with the fingerprint and the counts and
   nothing else. A second freeze is refused, a frozen pack is never refreshed, nothing is added to it and nothing
   is removed from it, and a page that read another version is told the pack moved.
8. **The database's own rules through the fixture** - an item written into a frozen pack is refused even when the
   service is bypassed, so is a digest rewrite, so is un-readying a dispute whose pack is frozen.
9. **The removal** - a note and a document are both soft-deleted, a removal that removed nothing is refused, an id
   that is not one is refused before the write, and a removal the database drops is reported.
10. **The documents** - a file whose bytes disagree with its name is refused before anything is stored, the same
    bytes twice in one pack is reported as a duplicate, and a storage key the column cannot hold is refused at the
    boundary.
11. **The note** - trimmed, filed under the part the merchant chose, its label the same sentence, its summary
    whole, and an over-long note is a validation refusal that names the field.
12. **Who may act** - the owner assembles and freezes; the compliance desk, `finance_ops`, `support` and a
    non-owner are refused; another company's dispute is a not-found.
13. **The four routes** - CSRF before the session, the identity read named in each route file, the body ceiling,
    one service call, the version read from the body on the freeze and left out when absent, and the two-verb
    routes checking the token on both verbs.
14. **The panel** - seven acts, each a `MutationVerb` with its own token spread, the freeze button disabled until
    the pack is complete, **no action offered on a frozen pack** (the service would refuse every one of them),
    a refusal announced with `role="alert"` rather than printed quietly, and a captioned document still saying
    how many bytes it is.
15. **Every message exists** - a path scan, so a screen cannot ask for a string that was never added.
16. **The browser boundary** - the fields file pulls no hash into the bundle, and the panel imports nothing from
    `node:`.
17. **The service's own discipline** - no `any`, no printing, no money.

## Security

- **Validation** - every body is strictly parsed with zod and capped at `DISPUTE_EVIDENCE_MAXIMUM_BODY_BYTES`;
  the upload has two ceilings, the route's own and the file's, checked before and after the bytes are held. Every
  row read back from PostgREST goes through a schema before it is used.
- **RLS / tenancy** - all three tables carry RLS with a default-deny policy and no grant to a browser role; only
  the server-side client reads or writes them. Each child guard re-checks the pack's own `dispute_id` and the
  dispute's `company_id`, so a service that passed the wrong company still cannot write.
- **Frozen means frozen** - the digest is over rows that cannot be updated, the trigger refuses every edit, and
  the service refuses before the second write as well. A submission in STEP 198 can therefore state exactly what
  was sent.
- **No delete** - removal is `deleted_at` on the row and an audit entry; the storage object is not removed, so a
  pack that is already in a reviewer's hands cannot change under them.
- **Audit** - six actions, one per act, carrying the pack, the counts and the digest - never the file's bytes,
  never a storage key, never a client address.
- **Permissions** - the `owner` role only, for every act, resolved from the cookie in each route file.

## Verification

| Gate | Result at this commit |
| --- | --- |
| `services/disputes/dispute-evidence-verify.ts` | **passed, 359 checks** (fifteen mutations re-run in the resumed sandbox, all red; twenty in the first run) |
| `services/disputes/dispute-verify.ts` | passed, 271 checks |
| `services/disputes/dispute-response-verify.ts` | passed, 398 checks |
| `services/disputes/dispute-warnings-verify.ts` | passed, 268 checks |
| `services/payments/refund-verify.ts` / `-execution-` / `-fee-` | passed, 259 / 141 / 213 checks |
| `migrations/verify.ts` | passed, 3702 checks, **126 migrations**, 96 tables |
| `scripts/verify-audit.mjs` | passed, 4198 checks |
| `lib/i18n/verify.ts` | passed, 3030 messages, 328 placeholders |
| `scripts/verify-structure.mjs` | passed, 17 directories, 14 root files, 740 source files |
| `scripts/verify-shell.mjs` | passed, 1104 checks, 350 files |
| `scripts/verify-lint.mjs` | passed, 77 checks, 26 rules as errors, 11 probes fired |
| `lib/jobs/verify.ts` | passed, 110 checks |
| `npm run verify` (whole chain, ending in `tsc`, `eslint .`, `next build`) | passed, compiled in 12.3 s |
| **Pre-existing red (unchanged, unchanged reasons)** | `lib/auth/verify.ts` 1 (a fourth module dials), `lib/security/verify.ts` 3 (a probe's own literals, `nmi-client.ts` naming the algorithm), `components/office/verify.ts` 13 (`provisioningQueue` unaccounted for) |

The mutations, each of which the gate catches by name: the freeze accepting a pack missing a part; the
freeze accepting a pack with no document; the flag raised without a pack; a frozen pack updatable; the service
freezing an incomplete pack; the digest ignoring labels; the digest depending on row order; a note landing under
the wrong part; a quarantined file attached anyway; the same bytes attaching twice; the storage key unchecked; the
flag never raised; a removal not checking that it removed; a decided dispute packed; the correspondence not
capped; the delivery record losing its reference; the document never verified; the panel freezing an incomplete
pack; a route dropping its token; the freeze route forgetting the version; and, added when slice 6 was finished,
the panel offering a refresh on a frozen pack, printing a refusal quietly as a status line, and dropping a
captioned document's size.

Two exact-count assertions moved because this STEP legitimately adds what they count: `lib/auth/verify.ts`
55→56 browser files and 75→82 mutation call sites (the panel's seven acts), with the reason written beside them.
The migration-count assertions in four older gates moved 125→126 for `0126`, which is this STEP's.

### Exercised on a running server

`next start` on port 3404 with the placeholder environment (no database in this sandbox):

| Request | Answer |
| --- | --- |
| `GET /payments/disputes/[id]` | `200` - the page renders, with the panel in its "no pack has been started" state |
| `POST /api/payments/disputes/[id]/evidence` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` - the same answer the response route gives, byte for byte |
| `POST /api/payments/disputes/[id]/evidence/items` (no token) | the same `422`, the same rule |
| `POST /api/payments/disputes/[id]/evidence/freeze` (no token) | the same `422`, the same rule |
| `DELETE /api/payments/disputes/[id]/evidence/documents` (no token) | the same `422` - the token is checked before the id is looked at |
| `POST /api/payments/disputes/not-a-uuid/evidence` | the same `422`, so a malformed id cannot be used to probe the guard's order |
| `next build` | the four evidence routes listed as dynamic function routes |

The authenticated paths cannot be walked here because there is no Supabase project to issue a session, and no
storage bucket to upload into; they are exercised end to end against the fixture in the gate, which carries
`0126`'s keys, checks and trigger bodies. The `.env.local` used for the smoke was deleted again (checked: absent),
and `git status` is the STEP's own file list.

**Desktop and mobile widths** - the panel is one column at both widths, `p-4` on a phone and `sm:p-5` from the
tablet breakpoint; the four parts stack, each part's records are a `<ul>` that wraps rather than scrolls, and the
two forms sit under the parts at every width.

## Carried gaps (not this STEP's, and named rather than hidden)

1. **Nothing submits to a processor.** A frozen pack is the input to STEP 198's compliance review and submission;
   this STEP stops at `disputes.evidence_ready = true`. There is no processor API call and no review screen here.
2. **Nothing ticks.** The pack is built by a person pressing a button. There is no scheduler in this build, so
   nothing refreshes a draft on its own; a merchant who wants the newest correspondence presses "refresh".
3. **Storage must be configured.** `getDisputeEvidenceRuntime` resolves the adapter from `STORAGE_PROVIDER`; with
   no provider configured an upload is a dependency failure, not a silent no-op. The bucket must exist and be
   private - `recordUploadedFile` and `markFileVerified` are the only record of it.
4. **No download link yet.** The panel lists a document by its caption, section, type and size. There is no signed
   URL in this STEP, because a signed URL is a decision about who may see the file and that decision belongs with
   the submission screen that shows it to a reviewer.
5. **Twelve mails is a cap, not a choice.** A dispute with a hundred messages in it gets the newest twelve, and the
   pack does not say it truncated. A reviewer who needs the rest reads the thread in STEP 198's screen.
6. **The three older dispute screens still have no navigation.** `/payments/disputes` and `/office/disputes` are
   reachable by URL and not linked from the app shell - carried from STEP 194, unchanged here.
