// path: docs/handoffs/STEP_182_COMPLETED.md
# STEP 182 — Tokenized estimate page with signature approval, decline and expiry void handling

**Status: COMPLETED**

## STEP

- Number and title: STEP 182 — Tokenized estimate page with signature approval, decline and expiry void
  handling.
- Category: Client Portal, Payment Pages and Payment Links, STEPs 181-190, the second STEP of the block.
  STEP 181 built the invoice link beside it; STEP 183 builds the hosted payment page.
- Depends on: `docs/final/FEATURE_LIST.md` section 16 (“a client can approve an estimate digitally with a
  signature”, the evidence list — signer name, email, consent record, time, IP, geo and device
  fingerprint, document hash — “a client can decline”, “an estimate expires at its expiry time”, and
  “both decline and expiry set the estimate to void”, `void_reason` `declined` / `expired`), section 22
  line 238 and 242 (tokenized links, IP based rate limiting on surfaces that decide something);
  `docs/final/STEP_PLAN_250.md:2338-2350`; STEP 022's `0027_estimate_signatures.sql` and
  `services/estimates/estimate-signature.ts` (the evidence row, its append-only guard, its unique index
  and `captureEstimateSignature`), STEP 021's `0025_estimates.sql`, `0026_estimate_items.sql` and
  `services/estimates/estimates.ts` (`ESTIMATE_COLUMNS`, `estimateRowSchema`, `readEstimateLines`,
  `estimateSnapshotOf`), STEP 121's `0118_estimate_conversion_lock.sql` (the terminal guard a conversion
  depends on), STEP 055's counter table, STEP 056's `lib/security/portal-token.ts` (kinds `estimate` and
  `invoice`, capabilities per kind), STEP 037's CSRF pair, and STEP 181's page, runtime and refusal
  vocabulary this STEP composes with.

## Owned paths, and the ones that stay shut

Owned and used: `app/(client-portal)/` and `components/payments/`.

- `app/(client-portal)/portal-estimate-fields.ts` — new, 178 lines. The vocabulary: the three tables, the
  token kind and capability, the six client states folded from five statuses and three reasons, the two
  decisions borrowed from `0027`'s own list, the three void reasons, the limits borrowed from
  `ESTIMATE_SIGNATURE_LIMITS`, the eight refusal rules, the four audit actions, the four kilobyte body
  ceiling, the `portal_signature` policy (10 per address per 600 seconds) and the digest encoding.
- `app/(client-portal)/portal-estimate.ts` — new, 207 lines. The read model: token to claim to three
  tenant-scoped reads, the state fold, the digest (`hashEstimateDocument` over the same snapshot the
  merchant's screen prints), the computed expiry, and the `open` question the page and the form both ask.
- `app/(client-portal)/portal-estimate-decision.ts` — new, 524 lines. The three writes: the expiry void, the
  view, and the decision — STEP 022's `captureEstimateSignature` for the evidence, then the status this
  STEP applies (`accepted` + `accepted_at`, or `void` + `declined` + `voided_at`), then the audit entry.
  Plus the strict body schema and its per-field rules.
- `app/(client-portal)/portal-estimate-verify.ts` — new, 1355 lines, the gate, **232 checks**.
- `app/(client-portal)/e/[token]/page.tsx` — new, 344 lines. The page: header and state pill, prepared-for
  card, the offer as a table at `sm` and a card list below it, the decision card, the privacy note.
- `app/(client-portal)/e/[token]/signature/route.ts` — new, 152 lines. The decision: CSRF, declared length,
  address, rate limit, body, actor, service, answer.
- `components/payments/estimate-decision-card.tsx` — new, 205 lines. The five states, the form only while
  the offer is open, and the signature record printed field by field.
- `components/payments/estimate-decision-form.tsx` — new, 290 lines. Accept and decline, the consent
  sentence from the catalog, the device fingerprint derived and hashed in the browser, the time zone as
  the location.
- `app/(client-portal)/portal-rate-limit.ts` — new, the portal's one counter module, replacing
  `portal-invoice-rate-limit.ts` (deleted) so two surfaces on the same table do not keep two spellings of
  a policy.
- `app/(client-portal)/i/[token]/acceptance/route.ts` and `portal-invoice-verify.ts` — edited only to call
  the shared counter and to keep the 155 checks green.
- `components/payments/portal-form-refusal.ts` — extended with an optional rule-to-sentence map and with
  the six rules only a quote can refuse with; the invoice forms are unchanged.
- `lib/i18n/strings/en.ts` — extended with 61 `portal.*` keys. No existing key changed.
- `app/(client-portal)/README.md` — the STEP 182 section.
- `docs/handoffs/STEP_182_COMPLETED.md` — this file.

Untouched, deliberately: `services/` (read only — the estimate services are the merchant's, and a portal
surface that wrote them would be a second writer of the same document), `lib/security/portal-token.ts`
(read), `migrations/` (**not one file added or edited**, see below), `package.json` (so the gate is a
script, not a chain entry), and every STEP 181 component except the shared refusal helper.

## The database sub-step, and why STEP 182 adds no migration

The plan asks for the DB sub-step to be done first. The first thing this STEP did was read the schema
instead of writing one, and it found every column and every guard already in place:

| What the feature needs | Where it already is |
| --- | --- |
| The estimate's five statuses, `void_reason` (`declined`/`expired`/`withdrawn`), `voided_at`, `accepted_at`, `expires_at` | `0025_estimates.sql` |
| The lines, their ordering and their generated totals | `0026_estimate_items.sql` |
| Signer name, email, consent text, consent flag, signed time, IP, geo, device fingerprint, document hash, drawn signature path | `0027_estimate_signatures.sql` |
| One decision per estimate, as a hard stop rather than a check | `0027`'s `create unique index estimate_signatures_estimate_key on public.estimate_signatures (estimate_id)` |
| Evidence is append-only | `0027`'s `estimate_signatures_guard_append_only` |
| A decided quote is frozen | `0025`'s `estimates_guard_terminal` (freezes `accepted` and `void` except metadata and the conversion pointer) |
| An accepted quote converts once | `0118_estimate_conversion_lock.sql` |
| Default deny on every table | `0025`, `0026`, `0027` |

A `0123` would therefore have added a column nothing reads or a policy nothing needed. The gate asserts
those columns, the unique index, the append-only guard and the terminal guard by reading the three
migrations, so the decision is checked rather than claimed.

## The two voids, which are the STEP's acceptance criteria

Section 16: “a client can decline an estimate, and an estimate expires at its expiry time. Both paths set
the estimate to void.”

- **Decline.** `decidePortalEstimate` writes the evidence row first, then `status = 'void'`,
  `void_reason = 'declined'`, `voided_at = now`, scoped by `version=eq.N` and `status=in.(sent,viewed)`.
  The gate proves the stored row, the evidence row and the audit entry.
- **Expiry.** `openPortalEstimate` computes `expired` from `expires_at <= now` while the status is still
  open, so the fact does not wait for a sweep. `applyPortalEstimateExpiry` writes `status = 'void'`,
  `void_reason = 'expired'`, `voided_at = now` the moment a link is opened on such a quote — and the
  decision route applies the same void before it refuses, so a decision on an expired offer both fails and
  leaves the record correct. The gate proves the void, the reason, the instant, the version-scoped query,
  the single audit entry, and that a second visit writes nothing.

Both are idempotent in the way the database makes them: the update matches only an open, unchanged row, so
two visitors arriving at the passing second cannot both void it, and the loser re-reads and answers the
state the winner left (the gate simulates exactly that race).

## The evidence, and who writes what

`captureEstimateSignature` (STEP 022) writes the evidence and nothing else — it is called from the
merchant's own screens where the merchant records a decision their client gave in person. On a tokenized
link the direction is the other way, so the transition belongs to the surface that learned about it:

1. `captureEstimateSignature` parses and validates (it also demands the quote be `sent`/`viewed`, refuses a
   second row, and computes the digest from the document it just read),
2. this STEP applies the status the decision implies,
3. this STEP audits `portal.estimate_accepted` or `portal.estimate_declined` with the signature id, the
   digest and the reason — while carrying no signer name, because personal data belongs in `0027`'s table,
   not in the audit chain.

The gate asserts that order: two audit entries, the evidence first, the transition second.

## Security decisions

- **Zero trust in the body.** The client sends a decision, a name, an address, a consent tick and two
  device facts. It cannot send the quote, the company, the request's address, its user agent or the
  digest: the first two come from the token, the next two from the request, the last from the document as
  the request read it. A body carrying `document_hash` or `signature_path` is refused as an unknown field
  rather than ignored, because a caller who sends one believes it will be stored.
- **The consent sentence is the catalog's.** `portal.signatureConsent` is read on both sides, so the stored
  wording is the shown wording, and yesterday's record keeps the sentence it was given.
- **One decision per quote, enforced twice.** The service refuses a quote that is not open; the unique
  index refuses the row if the service were wrong.
- **A merchant cannot sign their own offer.** The route resolves whichever session the request carries and
  the service refuses it with `self_decision`, the same shape as STEP 181's `self_confirmation`.
- **Order of checks.** CSRF, then the declared length, then the address, then the counter, then the body's
  byte count, then the body: the only step that costs a statement is spent by attempts, not successes.
- **No drawn signature.** The page does not offer one, stores `signature_path = null`, and says so in the
  record: a typed name is the signature section 16 asks for, and a picture would be a ninth field with no
  weight this page could add.
- **What the page writes, and what it does not.** Every `rest.update` in this STEP targets `estimates`.
  Nothing writes `invoices`, `payments`, or a merchant-owned field; the gate counts the calls against the
  table name.
- **No login, no index.** `force-dynamic`, `noindex`, `nocache`; a link that does not verify answers one
  sentence whatever the cause, so an attacker cannot tell an expired token from a revoked one.

## What was exercised

`node "app/(client-portal)/portal-estimate-verify.ts"` — a fake PostgREST over arrays whose refusals are
transcribed from `0025`, `0026` and `0027`, with 232 checks:

- the six-state fold and the two values it refuses, `void` with no reason and a status outside the five;
- a link of the wrong kind, the wrong capability, an expired lifetime, and a quote that is missing,
  foreign or deleted — all one `RESOURCE_NOT_FOUND`;
- the read model: a sent quote opens as open, a draft is answered as not issued with no money, a quote
  past `expires_at` is expired while its status still says `sent`, and the digest is `0027`'s shape over
  the document the page prints;
- the expiry void and its single audit entry; a second visit writing nothing; an in-time quote writing
  nothing; an accepted quote never re-read as expired; and the lost race answering the winner's state;
- the view: `sent` to `viewed` once, nothing for a decided quote, and a database that throws tolerated
  because the client came to read an offer;
- the acceptance: every field of the evidence row, the digest equal to the page's, the two audit entries
  in order, and no personal data in the chain;
- the decline: `void` + `declined` + `voided_at`, the evidence, the audit, and `accepted_at` still null;
- the refusals: already accepted, already declined, withdrawn, not issued, expired (which also voids),
  self decision, an existing signature, a lost status race, and a link that does not verify;
- the body: an own digest, a drawn signature, an unticked consent, a malformed address, an oversized name,
  an empty name, a decision that is neither, a short fingerprint — and the trimming that stores a name
  without its padding and an empty location as absent;
- the counter: allowed, refused and audited once with a hash rather than an address, and a counter that
  cannot answer failing closed;
- the sources: the route's order, the double byte ceiling, the page's two tolerant writes in the right
  order, the form only while open, the consent key on both sides, and every write this STEP makes being
  onto `estimates`;
- the schema: `0025`'s four columns and its terminal guard, `0026`'s table, `0027`'s nine evidence columns,
  its unique index and its row level security, and `0118`'s terminal freeze — the proof that no migration
  is needed.

The gate was mutation-checked: writing `withdrawn` instead of `declined` on a decline makes it fail with
that one check and nothing else.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/e/[token]` and `/e/[token]/signature` are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-estimate-verify.ts"` | **portal estimate gate passed: 232 checks, 6 states folded, 2 voids (declined, expired), one signature per estimate, no migration needed** |
| `node "app/(client-portal)/portal-invoice-verify.ts"` | portal invoice gate passed: 155 checks, 7 statuses folded, 2 evidence tables, one confirmation per invoice |
| `npm run check:audit` | audit gate passed: 3449 checks |
| `npm run check:structure` | structure gate passed: 622 source files |
| `npm run check:i18n` | i18n gate passed: 2595 messages, 289 placeholders |
| `npm run check:migrations` | migrations gate passed: 3572 checks, 122 migrations, 92 tables |
| `npm run check:estimates` | estimate conversion gate passed: 147 checks |
| `npm run check:estimate-core` | estimate gate passed: 1583 checks |
| `npm run check:errors`, `check:config`, `check:env`, `check:logger`, `check:jobs`, `check:shell`, `check:lint` | all passed |

## Left for the STEPs after this one

- STEP 183's hosted payment page opens a `payment_link` token; the page, the runtime and the refusal
  vocabulary are now shared, so it composes rather than copies.
- A drawn signature (`signature_path`) is a field `0027` supports and this page does not offer; if a later
  STEP wants a canvas, only the form and one line of the service change, and the column is already there.
- The expiry sweep: this STEP voids lazily on open, which is correct but leaves a quote nobody opens
  `sent` past its date. A job that voids in the background would make the stored status catch up without
  a visitor — a `jobs/` STEP's work, not a portal page's.
- STEP 121's conversion already refuses a quote that is not accepted, so a declined or expired quote
  cannot be converted; the freeze `0118` applies is what makes that true regardless of who asks.
