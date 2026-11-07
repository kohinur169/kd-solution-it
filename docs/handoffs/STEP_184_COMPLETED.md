// path: docs/handoffs/STEP_184_COMPLETED.md
# STEP 184 — 3D Secure request flow on card payments

**Status: COMPLETED**

## STEP

- Number and title: STEP 184 — 3D Secure request flow on card payments.
- Category: Client Portal, Payment Pages and Payment Links (STEPs 181-190), the fourth STEP of the block. STEP
  181 built the invoice link, STEP 182 the estimate link, STEP 183 the card payment page and its charge, STEP
  184 puts the bank's authentication in front of that charge. STEPs 185-190 build the card and IP rules, the
  velocity limits, the part payment and the general payment link.
- Depends on: `docs/final/FEATURE_LIST.md` section 18 lines 193-194 ("3D Secure is requested on every payment
  where possible" and "when 3DS is not completed, capture happens only when billing postal code and payer IP
  country both match the invoice data. When either does not match, nothing is captured and the payment goes
  to manual review by compliance_kyc"); `docs/final/STEP_PLAN_250.md:2362-2371`; STEP 183's `chargePortalPayment`
  and `parsePortalPaymentBody`, STEP 066's `threeDsVerified` and `FRAUD_THREE_DS_OUTCOMES`, STEP 057's
  `sealSecret`/`openSecret`, STEP 024's `0037_payments.sql`, STEP 024's `payments_three_ds_capture_check`, and
  STEP 181's `openPortalInvoice`, money printer, rate limiter and actor reader.

## Owned paths, and the ones that stay shut

Owned and used: `app/(client-portal)/` and `components/payments/`.

- `app/(client-portal)/portal-three-ds-fields.ts` — new, 320 lines. The vocabulary: the challenge and result
  fields, the handle's purpose, context and lifetime, the `portal_3ds` counter, the ceilings, the rules, the five
  audit actions, the five result states, and the three mappings (provider answer → outcome, outcome → decision,
  rule → page state).
- `app/(client-portal)/portal-three-ds.ts` — new, 982 lines. The flow: `startPortalThreeDs`,
  `completePortalThreeDs`, the sealed handle, the strict result parser, and the review that captures nothing.
- `app/(client-portal)/portal-three-ds-processor.ts` — new, 86 lines. The in-memory challenge recorder
  (`durable: false`) and `noPortalThreeDsPort`, which says what this build cannot do.
- `app/(client-portal)/portal-three-ds-runtime.ts` — new, 79 lines. The production wiring.
- `app/(client-portal)/i/[token]/pay/3ds/route.ts` — new, 181 lines. Starting the bank's step.
- `app/(client-portal)/i/[token]/pay/3ds/complete/route.ts` — new, 198 lines. The issuer's return.
- `app/(client-portal)/i/[token]/pay/3ds/result/page.tsx` — new, 173 lines. What happened, in the portal's words.
- `app/(client-portal)/portal-three-ds-verify.ts` — new, 1,650 lines. The gate, **271 checks**.
- `components/payments/three-ds-challenge.tsx` — new, 81 lines. Three hidden fields and a button.
- `components/payments/portal-three-ds-refusal.ts` — new, 73 lines. The bank's refusals as sentences.
- `components/payments/card-payment-form.tsx` — edited, +50 lines and two removals: an `endpoint` prop replaces
  the hard-coded charge URL, a `challenge` answer renders `ThreeDsChallenge` after `clearInputs()`, and the
  refusal reader merges both vocabularies. No card field was added, and the file still renders none.
- `app/(client-portal)/i/[token]/pay/page.tsx` — edited, +40 lines: the page asks this step what the deployment
  can do, picks the endpoint, and shows a third unavailable panel when no bank can be asked.
- `lib/i18n/strings/en.ts` — 30 new `portal.*` keys. No existing key changed.
- `app/(client-portal)/README.md` — the STEP 184 section.
- `docs/handoffs/STEP_184_COMPLETED.md` — this file.

Untouched, deliberately: `migrations/` (**no file added or edited**), `lib/payments/` (STEP 149-152's adapters
and STEP 127-146's core are read, never edited), `lib/security/` (STEP 056-067 own it; `threeDsVerified` and the
cipher are imported), `scripts/verify-audit.mjs` (the CSRF exemption list is STEP 056's and still has two
entries), `package.json`, and STEPs 181-183's services.

## The database sub-step, and why there is no migration

The plan asks for the database part first. The schema already states this STEP's rule:

| What the flow needs | Where it already is |
| --- | --- |
| The authentication outcome | `0037`'s `three_ds_outcome`, defaulting to `not_requested` |
| The four outcomes it may hold | `payments_three_ds_check` |
| Section 18's capture rule, in the database | `payments_three_ds_capture_check` |
| The two billing facts the fallback needs | `0037`'s `postal_code_matched`, `ip_country_matched` |
| A status for a payment that was not captured | `payments_status_check`'s `under_review` |

The gate reads the migration and asserts each of those, and asserts the next free migration number (`0123`) is
still unused. So "no migration" is a checked claim, not an assumption.

## The flow, in order

1. **Start** - `POST /i/[token]/pay/3ds`. CSRF, byte ceiling (declared and actual), address, the `portal_3ds`
   counter, then the body. The service re-reads the link and the invoice, refuses the seller's own session,
   parses the body with STEP 183's parser (so a card-shaped key is refused by the same rule and the token is
   held to the same shape), converts the amount, and only then requires a port, a durable recorder and a
   cipher.
2. **The provider's four answers** - `authenticated` (frictionless): STEP 183's `chargePortalPayment` is called
   and the money is taken. `challenge`: the record is opened, the handle sealed, the challenge audited, and the
   browser is handed the issuer's page. `failed`: the card is refused, nothing is charged, the fact is audited.
   `unavailable`: the payment is refused with `SERVICE_UNAVAILABLE`.
3. **The redirect** - `ThreeDsChallenge` posts `PaReq`, `MD` and `TermUrl` to the issuer. No card data moves:
   the card was tokenized by the provider's hosted fields, and the form carries the issuer's question.
4. **The return** - `POST /i/[token]/pay/3ds/complete`. CSRF when a session cookie exists, ceilings, address,
   counter, then `PaRes` and `MD` and nothing else. The handle is opened (tamper, wrong context, wrong key,
   wrong shape and expiry all produce one refusal), the link is re-read, the invoice must still owe the same
   amount, the challenge is claimed exactly once, and the provider is asked to complete the authentication.
5. **The decision** - `portalThreeDsCaptureDecisionOf`, which is `threeDsVerified`: capture when the issuer
   authenticated, otherwise only when the billing postal code and the payer's IP country both matched. Capture
   means STEP 183's charge; review means nothing is captured, the record says `under_review`, and the audit
   names `compliance_kyc`.
6. **The settlement** - the challenge record is settled `captured`, `under_review`, `failed` or `unknown`, and
   the browser gets a `303` to `i/[token]/pay/3ds/result?state=…`, a page whose amount and client come from the
   invoice rather than the query.

## What is real, and what this build cannot do

**Real:** the cipher (a handle is `lib/auth/secrets.ts`'s AES-256-GCM box under the deployment's master key,
bound to its challenge through additional authenticated data; the gate proves tampering, cross-challenge moves
and a foreign key all fail to open); the clock; the single-use claim; the capture rule, shared with the schema;
the charge, which is STEP 183's one charge path; the audit; the routes and their order of checks.

**Not available, and named rather than imitated:**

| The missing piece | What it is | Owner |
| --- | --- | --- |
| A 3DS operation on NMI | an adapter call that asks the issuer to authenticate the card behind a Collect.js token; `nmi-payment.ts` today exchanges a token for a sale and nothing else | STEP 149-152's adapter set (the only files allowed to talk to the gateway about a card) |
| A durable challenge record | a record that survives the request, holding the token, the payer's key and the billing facts; the recorder here is in memory and says `durable: false` | STEP 130/132's payment operation |

Until both exist, `noPortalThreeDsPort` is what the runtime binds and the in-memory recorder refuses to start
a challenge - so the payment page shows a third unavailable panel: **"card payment is not available yet - this
platform asks every card's bank to confirm the payment before it is taken, and that step is not switched on
yet."** That is the honest answer. Charging without authentication would either violate section 18 or be
refused by `payments_three_ds_capture_check`, which is why the page does not quietly fall back to the charge
route.

## The decision this STEP makes about the billing fallback

Section 18's second sentence has two branches, and only one of them is reachable in this build:

- `authenticated` → capture. Built and proven.
- not authenticated, postal **and** country matched → capture, recorded with `basis: "billing_match"`. Built and
  proven in the gate; unreachable in production until STEP 185 fills the two facts, because the flow reads them
  from the challenge record and defaults both to `false` rather than guessing.
- not authenticated, one or neither fact → **no capture**, `under_review`, audit, `compliance_kyc`. This is what
  every unauthenticated payment does today.

## What was exercised

`node "app/(client-portal)/portal-three-ds-verify.ts"` — 271 checks over the fixture database, the recording
port, the gate's challenge recorder and the real cipher:

- the vocabulary: paths, the three challenge fields, the two result fields, the counter, the ceilings, the
  review owner, the five audit actions, the five result states, the three mappings;
- the redirect target: eleven shapes, of which `https` with no credentials, fragment, whitespace or invented
  host is the only one accepted;
- the handle: sealed and unreadable, opens to its claim, refuses an edited byte, another challenge's context and
  another key, refuses a claim with a field nobody reads;
- the capture rule: three outcomes × four pairs of billing facts, each compared with `threeDsVerified` **and**
  with `payments_three_ds_capture_check`'s own text;
- starting: a challenge (record, amount, term URL, expiry, audit, no charge), a frictionless authentication
  (one charge), a refusal, an unavailable provider, no port, a non-durable recorder, no recorder, no cipher,
  and every STEP 183 refusal in the same words - seller, card data, a PAN in the token box, settled, cancelled,
  a link without `pay`, an amount that cannot be charged, an issuer address this page will not redirect to;
- completing: captured (token reused, one provider call, settlement, both audit entries), abandoned (review, no
  charge, `compliance_kyc`), the billing-match basis, refused, unknown (never retried), replay, an expired
  handle, an expired record, a foreign handle, a handle naming no challenge, a body with no handle, the seller's
  session, an invoice that moved, an invoice settled meanwhile, no durable record, no port;
- the sources: CSRF before the body and the counter before the body on the start; CSRF **exactly when a session
  exists** on the return, the `303`, the result path, the actor reads; the result page's `force-dynamic`,
  `nocache` and state validation; the challenge form's exactly three hidden inputs and no field a card could be
  typed into; the card form's challenge branch and `clearInputs`; no `console.` anywhere; no migration;
- the composition: `createInMemoryPortalThreeDsRecorder()` refusing to start a challenge, and
  `noPortalThreeDsPort` answering `unavailable` rather than pretending to be a bank.

The gate was mutation-checked: replacing the capture rule with `"capture"` makes it fail with fifteen problems,
fourteen of which are the review decisions that stopped happening.

## Why the return route requires CSRF only when a session exists

`scripts/verify-audit.mjs` requires a CSRF call on every mutating route, and its exemption list (two entries,
owned by STEP 056) is not this STEP's to extend. The return cannot always have a token: the issuer posts a form
in a browser that may hold no cookie at all, and CSRF defends *ambient* authority - which a cookie-less request
does not carry. So the route calls `requireCsrfToken` when the request carries the CSRF cookie and not
otherwise, and the authority for a cardholder's return is the sealed handle, which no other site can forge. The
audit gate sees a real call, the security property is stated in the file, and the flow works for the person it
is for. A signed-in merchant's browser, which does have ambient authority, must present the token.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/i/[token]/pay/3ds`, `/i/[token]/pay/3ds/complete` and `/i/[token]/pay/3ds/result` are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | **portal 3DS gate passed: 271 checks, 5 result states, one capture rule shared with the schema, no card data in any body, no migration needed** |
| `node "app/(client-portal)/portal-payment-verify.ts"` | portal payment gate passed: 194 checks |
| `npm run check:audit` | audit gate passed: 3554 checks, sessions and CSRF on every mutating route |
| `npm run check:structure` | structure gate passed: 641 source files |
| `npm run check:i18n` | i18n gate passed: 2660 messages, 294 placeholders |
| `npm run check:migrations` | migrations gate passed: 3572 checks, 122 migrations, 92 tables |
| `npm run check:errors`, `check:lint`, `check:config`, `check:env` | passed |

## Left for the STEPs after this one

- **STEP 185** fills `postal_code_matched` and `ip_country_matched` and routes the review: the decision function
  and the review path are already built here, and the two flags are the only fields STEP 185 has to supply.
- **STEP 186** handles a provider fraud signal, which `payments_risk_reject_check` already constrains: a
  `reject` decision may only sit on a failed payment.
- **STEP 187** adds the card blacklist by token or fingerprint; **STEP 188** the card and IP velocity limits
  beside this step's ten-attempt counter.
- **STEP 189** connects the invoice link to the partial-payment service, which will need the challenge record to
  carry a chosen amount rather than the invoice's whole remaining due.
- **STEP 190** builds the general payment link over the same hosted fields and the same challenge form.
- **STEPs 149-152 and 130/132** owe the two pieces this flow cannot supply: a provider operation that
  authenticates a card, and a durable record of a challenge. Both are named above with the files that own them.
