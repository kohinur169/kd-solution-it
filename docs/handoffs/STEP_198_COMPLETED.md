# STEP 198 — Compliance review and evidence submission to processor

Status: **complete**. Commit `STEP 198: Compliance review and evidence submission to processor` (`328b4d1`),
then this handoff, on `arena/ca936761-kd-solution-it`, branched from STEP 197's `17b6945`. Typecheck, lint and
build are clean, `npm run verify` is exit 0 over **69 gate lines**, and the STEP's own gate is
`services/disputes/dispute-submission-verify.ts` at **384 checks**, mutation-checked with **28 distinct mutations,
all red**.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 198: Compliance review and evidence submission to processor**
> Chat line: Implement STEP 198 only: Compliance review and evidence submission to processor.

FEATURE_LIST §19, the sentence this STEP owns: *"`compliance_kyc` reviews the evidence pack and sends it to the
processor."* The other sentence that binds it: *"every refund and dispute action is audit logged."*

The eight sub-steps, as walked: read §19 / MASTER_PROMPT / the STEP 197 handoff; confirm the owned paths; the
migration and its rollback; the service (review, claim, send, move, mail, audit); the two routes; the review
screen and the queue section; the security slice (validation, RLS, audit, permissions); then the gates, the
smoke, one commit, the push and this file.

STEP 199 (chargeback-rate monitoring) was **not** started, as instructed.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `migrations/0127_dispute_reviews_and_submissions.sql` | new | Two tables, four checks each, three trigger bodies, two partial unique indexes, RLS default-deny |
| `migrations/0127_dispute_reviews_and_submissions.down.sql` | new | The rollback: the status trigger, then the two guards, then the two tables, in one transaction |
| `services/disputes/dispute-submission-fields.ts` | new | The browser-safe vocabulary: two decisions, two channels, three statuses, the two roles, the note and reference ceilings, eleven rules, the template key |
| `services/disputes/dispute-submission-provider.ts` | new | The port: `DisputeSubmissionPort`, the target a processor would read, the four outcomes, and `SUBMITTING_PROVIDER_KEYS` — **empty** |
| `services/disputes/dispute-submission.ts` | new | `readDisputeReview`, `listReviewQueue`, `parseReviewBody`, `parseSubmissionBody`, `reviewDisputePack`, `submitDisputePack`, `providerChannelSupport`, and the view types |
| `services/disputes/dispute-submission-verify.ts` | new | The gate, 384 checks, over an in-memory PostgREST that carries `0127`'s guards, checks and both partial unique indexes |
| `services/disputes/dispute-runtime.ts` | edited | `getDisputeSubmissionRuntime`, and the guard that refuses to boot claiming a provider it has no adapter for |
| `services/disputes/dispute-fields.ts` | edited | Four audit actions: `dispute.review_decided`, `dispute.submission_claimed`, `dispute.evidence_submitted`, `dispute.submission_failed` |
| `app/api/office/disputes/[id]/review/route.ts` | new | `POST` — the decision: CSRF, the 2048-byte ceiling, the session, the device proof over these exact bytes, the parse, one service call |
| `app/api/office/disputes/[id]/submit/route.ts` | new | `POST` — the send, the same five guards, and a log line that carries the *length* of a reference and never the reference |
| `app/(admin)/office/disputes/[id]/page.tsx` | new | The review screen: the frozen pack part by part, the decisions so far, the two refusal states |
| `app/(admin)/office/disputes/[id]/review-panel.tsx` | new | The desk's two acts: approve or decline with a reason, then send on a channel |
| `app/(admin)/office/disputes/page.tsx` | edited | The review queue, read only for a role that may review, and mounted under the deadline queue |
| `lib/i18n/strings/en.ts` | edited | Forty-odd `disputes.review*` / `disputes.submission*` strings and `email.disputeSubmission.subject` |
| `lib/security/csrf.ts` | edited | The two office paths on `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | The browser mutation inventory: 56 files / 82 call sites → 57 / 84, with the reason beside it |
| `services/disputes/dispute-verify.ts`, `-response-`, `-warnings-`, `-evidence-` | edited | The migration-count assertions: the chain's head is 127 now |
| `services/payments/refund-verify.ts`, `-execution-`, `-fee-` | edited | The same 126 → 127 |
| `package.json` | edited | `check:dispute-submission`, and one link in the `verify` chain |

## The desk's two acts, in one paragraph

**A review is an append-only judgement with a name on it; a submission is a fact about the outside world.** One
`compliance_kyc` or `super_admin` officer with a satisfied second factor reads the frozen pack — the frozen digest,
its four parts, its items and its documents — and writes one row: `approved` or `declined`, a reason between one
and five hundred characters, the digest of the pack that was reviewed, and their own user id. `0127` refuses every
update and every delete on that table, so "the officer changed their mind" is two rows and the record keeps both;
the latest one, ordered `decided_at desc, id desc`, is the one that counts. **Only an `approved` latest decision
may be sent, and the database enforces that itself**: `dispute_submissions_guard` reads `dispute_reviews` and
refuses the claim, so a caller that skipped the service still cannot send unreviewed evidence.

The send then has two channels and one record. On the `provider` channel the row is claimed as `sending` *before*
the processor is called — the insert is what makes two officers pressing at once a refusal instead of two
submissions — and the port's answer settles it: `sent` writes the reference and the instant, `declined` and
`unanswered` write a `failed` row with the rule, which frees the pack (the partial unique index only covers
`sending` and `sent`) because a processor outage is not a reason to leave a merchant unanswered. On the `recorded`
channel the desk has already sent the evidence from the processor's portal, so the officer types the case number
and the platform records it; the row goes straight to `sent` with the reference the officer read off the portal.

Either way the dispute moves to `evidence_submitted` with the instant it went, **and `disputes_guard_submission`
makes that status honest**: it is true only while a `sent` submission of that same merchant's dispute exists, and
it never goes back to `under_review`. One `dispute_update` email is queued to the merchant's owner through
`0061`'s log — or no email at all when there is no owner or no active sender, rather than an invented one — and
the chain gets the digest, the counts, the reference and the channel, never the officer's sentence.

## What the gate proves (15 sections, 384 checks)

1. **The migration and its rollback** — both tables, both comments, the four checks on each, the three trigger
   bodies by their refusal sentences, both partial unique indexes, the index and the policy per table, the
   rollback dropping triggers before tables, the head at 127 with 127 files, and `0059`-`0061` unmentioned by it.
2. **The bodies, without a database** — the trim, and eighteen refusals: a decision that is not one of two, a
   reason of spaces, a reason over 500, an unknown key on either body, a recorded send with no case number, a case
   number over 120, a reference typed into the provider channel, a missing and a non-positive version.
3. **Who may act** — `finance_ops`, `support`, `ceo` and the merchant are refused the read, the review and the
   send; a session without a satisfied second factor is refused both acts; a `super_admin` may read and review.
4. **The screen's answer** — the digest, the instant, the counts, the four parts, the provider and the mode, and
   `mayReview` / `maySubmit` / `providerChannel` / `submission` in every state: no pack, a draft, a resolved
   dispute, a pack already sent, a bad id, another tenant's dispute.
5. **The review itself** — one row per press, the digest on it, the officer on it; a decline blocks the send and an
   approval unblocks it; a draft pack and a resolved dispute are refused with the rule the screen prints; the
   chain carries the decision, the digest and the *length* of the reason, and the reason itself is absent.
6. **Refusals before anything is claimed** — no approval, no frozen pack, no port, no provider: four sentences,
   and in each case zero attempt rows and an unmoved dispute.
7. **The recorded channel** — one `sent` row with the officer's reference, the provider, the mode, the digest and
   the counts; the dispute at `evidence_submitted` with its instant; the chain's claim and send entries; one
   `dispute_update` email to the merchant's owner through the active method; a second press answering
   `already_sent` with no second row; the no-owner and no-sender paths landing the send and skipping the mail.
8. **The provider channel against an injected port** — `sent` settles the row and moves the dispute; `declined`
   and `unanswered` are two different sentences with a `failed` row each and no movement; a port that refuses to
   make the call passes its own rule up; and a failure frees the pack so the retry is a second row that lands.
9. **The database's own rules, entered directly** — a review of another merchant's pack, a review naming a digest
   the pack does not have, a review after the pack was sent, a second live claim for one pack and for one dispute,
   `evidence_submitted` with no sent submission behind it, and a dispute going back to waiting: seven refusals the
   fixture raises from `0127`'s own bodies rather than from the service.
10. **The queue** — a frozen unsent pack is listed with its merchant, digest and counts; a declined pack stays with
    its decision; a sent pack leaves; the finance desk may not read it.
11. **The port, the registry and what a target carries** — `SUBMITTING_PROVIDER_KEYS` is empty, `submissionPortFor`
    answers null for a provider with none, the runtime refuses to boot claiming one; and the target a processor
    would receive carries the digest, the counts, the items and the documents — and **no storage key and no byte**.
12. **The two routes** — token, session, device proof, the ceiling, the platform's envelope, the runtime, a log
    line and no `console` in each; and the review route never touches a case number while the submission route logs
    its length; both paths on `CSRF_PROTECTED_PATHS`.
13. **The screen** — the panel is a client component, the page renders it, the queue links each row to its review,
    two mutations with one token spread each, the device proof on both, `role="alert"` for a refusal, both ceilings
    imported rather than typed twice, the send disabled until the pack is approved, the provider channel disabled
    without a port, and no panel before there is a pack.
14. **Every message exists** — every `getMessage`/`formatMessage` path in the two pages, the panel and the service
    is a key in `en.ts`; the email subject is inside `0061`'s ceiling.
15. **The words** — one field name, eleven rules, every rule a machine word rather than a sentence, and the
    template key is `dispute_update`, which is on `0061`'s closed list of twenty.

## Security

- **Validation** — both bodies are strict Zod objects: an unknown key is a refusal, not a default; the reason is
  trimmed and bounded at both ends, the reference at 120; the ceilings are the same in the browser, the route and
  the database. Both routes cap the body at 2048 bytes before parsing, from `content-length` and again from the
  bytes actually read.
- **RLS** — both tables are `enable row level security` with a `*_default_deny` policy: no merchant session, and
  no `anon` request, can read a decision or an attempt. The desk reaches them only through the service role.
- **Audit** — four actions, one per act, each carrying ids, the digest, the counts and the channel, and the
  reference only where a reference exists. The officer's reason is recorded as `note_length`; the metadata scan
  trips on `name`, `email`, `phone` and `address` keys in a payload, so the reason cannot arrive there by accident.
- **Permissions** — `compliance_kyc` and `super_admin` only, with `hasSatisfiedTwoFactor`, and the device proof
  over the exact bytes of both requests. The routes read the actor from the cookie themselves rather than
  trusting a header; the CSRF token is the first guard, ahead of the session, the role and any row read.

## Verification

| Gate | Result at this commit |
| --- | --- |
| `services/disputes/dispute-submission-verify.ts` (new) | **passed, 384 checks** — 28 distinct mutations, all red |
| `services/disputes/dispute-verify.ts` | passed, 279 checks |
| `services/disputes/dispute-response-verify.ts` | passed, 406 checks |
| `services/disputes/dispute-warnings-verify.ts` | passed, 276 checks |
| `services/disputes/dispute-evidence-verify.ts` | passed, 359 checks |
| `services/payments/refund-verify.ts` / `-execution-` / `-fee-` | passed, 259 / 141 / 213 checks |
| `migrations/verify.ts` | passed, 3746 checks, **127 migrations**, 98 tables, every forward file transactional and default-deny |
| `scripts/verify-audit.mjs` | passed, 4247 checks |
| `lib/i18n/verify.ts` | passed, 3100 messages, 336 placeholders, 1 locale |
| `scripts/verify-structure.mjs` | passed, 17 directories, 14 root files, 748 source files |
| `scripts/verify-shell.mjs` | passed, 1117 checks, 354 files |
| `scripts/verify-lint-rules.mjs` | passed, 77 checks, 26 rules as errors, 11 probes fired, 1 clean probe stayed clean |
| `lib/jobs/verify.ts` | passed, 110 checks |
| `npm run verify` (whole chain, ending in `tsc`, `eslint .`, `next build`) | **passed, exit 0, 69 gate lines** |
| **Pre-existing red (unchanged, same reasons)** | `lib/auth/verify.ts` 1 (a fourth module dials), `lib/security/verify.ts` 3 (sixty KYC action literals predate this STEP; the encryption-module and algorithm-name lists), `components/office/verify.ts` 13 (`provisioningQueue` is a screen the catalog does not name) |

Nothing in the three red gates moved because of this STEP. The sixty offending `action: "..."` literals are all
under `lib/kyc/adapters` and none of them is this STEP's; `components/office/verify.ts` compares a hand-written
catalog of twelve navigation sections (`OFFICE_NAVIGATION`) against the screens it finds, and the entry it is
missing is `provisioningQueue`, which still is; and `lib/auth/verify.ts`'s one failure is the fourth module that
dials a device proof, which this STEP did not add — the review panel dials through `lib/auth/device-proof.ts`,
which is one of the two allowed doors.

Two exact-count assertions moved because this STEP legitimately adds what they count: `lib/auth/verify.ts`
56→57 browser files and 82→84 mutation call sites (the review panel's two acts), with the reason written beside
them. The migration-count pins moved 126→127 in seven older gates (`dispute-verify`, `dispute-response-verify`,
`dispute-warnings-verify`, `dispute-evidence-verify`, `refund-verify`, `refund-execution-verify`,
`refund-fee-verify`).

### The mutations

Run in three passes. The first pass held 18 entries: 12 turned the gate red and six missed their needle (they were
re-expressed in the second pass with the file's real text, and are not counted twice). The second pass held 16
entries and, after four checks were added to close three survivors, **all 16 are red**. Re-running the first pass
shows 12/12 of its distinct entries red. **28 distinct mutations, all red:**

the service stopping the approval check; the service reading any decision rather than the latest; the service
leaving an attempt `sending` when the processor declines; the service moving the dispute without the instant; the
service never moving it; the service writing the officer's reason into the chain; the service skipping the mail;
the service accepting an unknown key; the service not trimming the reason; the service dropping the role check; the
service dropping the second factor; a third role added to the desk; the route dropping its CSRF token; the
submission route dropping the device proof; the review route logging the sentence; the panel dropping the device
proof; the panel offering the provider channel without a port; the panel dropping its two token spread; the queue
dropping its link; the registry claiming a provider it cannot call; a message key renamed; the review guard
allowing a rewrite; the send guard dropping the approval; the send guard reading the *oldest* decision; the status
guard requiring only a `sending` attempt; the status guard allowing a move back; a partial unique index made
non-unique; and the template key drifting to one `0061` does not know.

### Exercised on a running server

`next start` on port 3404 with a placeholder environment (no database, no Supabase project in this sandbox, so no
session can be issued). The environment needed five values beyond the Supabase pair to boot at all - `APP_URL`,
`DATABASE_URL`, `ENCRYPTION_MASTER_KEY`, `AUDIT_SIGNING_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` - and the two
Supabase keys must differ from each other; that is what the boot validator says, and it is worth writing down
because the STEP 197 handoff's shorter environment no longer boots in production mode.

| Request | Answer |
| --- | --- |
| `GET /signin` | `200` |
| `GET /office/disputes` signed out | `307` to `/signin` from the office layout, the same answer `/office/refunds` gives |
| `GET /office/disputes/[id]` signed out | the same `307` |
| `POST /api/office/disputes/[id]/review` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` |
| `POST /api/office/disputes/[id]/submit` (no token) | the same `422`, the same rule |
| both, with a header that does not match its cookie | the same `422`, so the guard compares rather than merely looks |
| both, with a `not-a-uuid` id | the same `422` — the token is checked before the id |
| `GET` on either route | `405` |
| `next build` | `/api/office/disputes/[id]/review`, `/api/office/disputes/[id]/submit` and `/office/disputes/[id]` listed as dynamic function routes |

The authenticated paths cannot be walked here: `GET /api/auth/csrf` answers `503 DEPENDENCY_FAILED` without a
Supabase project, so there is no token to sign a real request with and no session to read a real screen with.
Those paths are exercised end to end against the fixture in the gate, which carries `0127`'s three trigger bodies,
its checks and both partial unique indexes. The `.env.local` used for the smoke was deleted again (checked:
absent), and `git status` is the STEP's own file list.

**Desktop and mobile widths** — the review screen is one column at both widths: the pack's four parts are a
`grid-cols-1` stack on a phone and `sm:grid-cols-2` from the tablet breakpoint, each part's records are a `<ul>`
that wraps rather than scrolls, the digest is `break-all` because it is 64 characters, and the panel's two forms
sit under the history at every width with `flex-wrap` on their button rows and `sm:flex-row` on the pair of
decision buttons.

## Carried gaps (named rather than hidden)

1. **The `provider` channel is honestly unsupported.** No provider in `docs/final/PROVIDER_DOCS.md` documents a
   chargeback-evidence endpoint, so `SUBMITTING_PROVIDER_KEYS` is empty and a provider press is refused with
   `dispute_submission_unsupported` rather than pretending. The `recorded` channel — an officer sending from the
   processor's portal and typing its case number — is the working path, and it is a real act with a real audit
   trail. A later STEP that lands a documented endpoint adds one port to the runtime and one key to that list; no
   part of this STEP changes.
2. **Nothing uploads evidence bytes to a processor.** The port's target carries labels, sections, summaries,
   content types, sizes and SHA-256 digests - not the documents. A real API would want the bytes, and that is a
   storage-and-consent decision this STEP does not take; the bytes stay in the private bucket behind `0126`.
3. **Nothing ticks.** No scheduler refreshes anything: the queue is read when a person opens the page, and the
   email is *queued* through `0061` for section 23's sender, not sent here.
4. **The desk cannot un-send.** A `sent` row is final and `evidence_submitted` never returns to waiting. A wrong
   reference is corrected by the processor, not by the platform; there is no "withdraw" act.
5. **No per-officer reporting.** The decisions are rows, and the screen prints the history of one pack. There is
   no "who declined what this month" screen, and no chargeback-rate view — that is STEP 199, untouched.
6. **The review screen has no PDF or download.** It shows file names, types and sizes. There is no signed URL,
   for the same reason STEP 197 gave: a signed URL is a decision about who may see the file.
7. **One reviewer, one sentence.** The reason is bounded at 500 characters and there is no structured decline
   taxonomy, so two officers declining the same kind of pack may write two different things.
