// path: docs/handoffs/STEP_174_COMPLETED.md
# STEP 174 — Supplementary IDV webhook verification and result handling without overriding processor KYB

**Status: COMPLETED**

## STEP

- Number and title: STEP 174 — Supplementary IDV webhook verification and result handling without overriding processor KYB.
- Category: Optional supplementary identity verification adapters (Jumio, Didit, Sumsub), STEPs 170-175. This STEP closes the loop the three adapters opened: 171, 172 and 173 each read a vendor's result when asked, this STEP hears the vendor's delivery, proves it is the vendor's, deduplicates it, and then asks the same read the adapter already implements before recording anything. STEP 175 lets a super administrator activate at most one of the three.
- Depends on: STEP 170 (`lib/kyc/adapters/supplementary-idv.ts` — the three-member port, the sealed configuration with its delivery secret, the session store and the forward-only `recordSupplementaryIdvAnswer`), STEPs 171-173 (`lib/kyc/adapters/jumio.ts`, `didit.ts`, `sumsub.ts` — the `readSession` implementations this STEP calls instead of trusting a body), STEP 056 (`lib/security/encryption.ts` — the keyring that opens the delivery secret), and STEPs 147-169 for the adapter conventions (documented vocabularies, a gate that runs with plain `node`, and no route or table of its own).

## Provider documentation read in this session

Every verification rule in `lib/kyc/adapters/deliveries.ts` traces to one of these pages, read before the file was written. The Jumio documentation's own index (`https://documentation.jumio.ai/llms.txt`) was used to find the callback page, because the older `docs/developer-resources/API/callbacks` path answers `NoSuchKey`.

| Page | What it established |
|---|---|
| https://docs.sumsub.com/docs/webhooks.md | Deliveries are an HTTPS endpoint, Slack, Telegram or email; every notification is logged and retried. |
| https://docs.sumsub.com/docs/webhook-manager.md | Each webhook has a **secret key**; the sender is verified by a digest in `x-payload-digest`, computed as `HMAC(secret, raw body)` in lower-case hex, over the body "without any alteration or conversion to JSON", with the algorithm named in `x-payload-digest-alg`: `HMAC_SHA256_HEX` (the dashboard default), `HMAC_SHA512_HEX`, or the **legacy, deprecated** `HMAC_SHA1_HEX`. The endpoint must accept within 1 second and answer within 10. Retries: five resends at 1 minute, 5 minutes, 1 hour, 5 hours and 18 hours; **`401`, `403`, `404` are permanent**, everything else is retried. A dashboard test carries `"testMode": true`, which is never sent in production. |
| https://docs.sumsub.com/docs/receive-and-interpret-results-via-api.md | `applicantReviewed` carries `applicantId`, `externalUserId`, `levelName`, `type`, `sandboxMode`, `reviewResult.reviewAnswer`, `reviewStatus`, `createdAt`/`createdAtMs`, `correlationId` and `clientId`, and the documented path to the result is the applicant, not the body. |
| https://docs.sumsub.com/docs/user-verification-webhooks.md | The event catalogue names `applicantCreated`, `applicantPending`, `applicantReviewed`, `applicantPrechecked` (deprecated), `applicantReset`, `applicantLevelChanged`, `applicantWorkflowCompleted`, `applicantWorkflowFailed` and more. Only `applicantReviewed` announces a decision. |
| https://docs.didit.me/integration/webhooks.md | Read the raw body before parsing. `X-Signature` is **HMAC-SHA256 over the exact raw bytes**; `X-Signature-V2` is over a canonical JSON the page does not specify; `X-Signature-Simple` is deprecated and authenticates **the envelope only**; `X-Timestamp` is Unix seconds and must be within **300 seconds**; each has a `-Previous` variant for the 24 hours after a secret rotation, and a match on either is accepted, compared in constant time. Retries: on `5xx`, `404`, timeout or connection failure, twice (about 1 minute, then about 4), re-signed with a fresh timestamp. The envelope carries `event_id`, `session_id`, `status`, `webhook_type`, `created_at`, `timestamp`, `environment`, `vendor_data` and `decision`; duplicates are to be keyed on `event_id`, and order is not guaranteed. |
| https://documentation.jumio.ai/docs/developer-resources/callback | The callback is a JSON **POST** with `callbackSentAt`, `userReference`, `workflowExecution{id, href, definitionKey, status}` and `account{id, href}`; `workflowExecution.status` is one of `INITIATED`, `PROCESSED`, `ACQUISITION_STARTED`, `ACQUIRED`, `SESSION_EXPIRED`, `TOKEN_EXPIRED`. **No signature and no shared secret are documented.** What is documented is a per-region IP allowlist (`callback.amer-1.jumio.ai`, `callback.emea-1.jumio.ai`, `callback.apac-1.jumio.ai`, six addresses each) and the instruction to save the callback, answer **200 OK**, and retrieve the authoritative transaction afterwards. |

## Files

- `lib/kyc/adapters/deliveries.ts` — 1021 lines. The outcome vocabulary and the per-vendor answer table, the documented header names, the signature primitives (SHA-256 body hash, HMAC-SHA256/512 in hex, constant-time compare), the three verification methods, the three parsers, the delivery store with its claim/settle/release lifecycle, the audit entry, the receiver, and the office summary.
- `lib/kyc/adapters/deliveries-verify.ts` — 1462 lines, **625 checks**. The gate, in the eleven-section shape STEPs 170-173 established, with twelve sections of work. It runs with plain `node` and with `node --experimental-strip-types`, reaches no network, injects the read, and scans its own module's source.
- `docs/handoffs/STEP_174_COMPLETED.md` — this file.

No other file was touched: `package.json`, `config/structure.json`, `migrations/`, `app/`, `services/kyc/`, `lib/payments/`, `lib/security/`, `lib/i18n/` and `docs/final/PROVIDER_DOCS.md` are unchanged, per the ownership rule at `docs/final/STEP_PLAN_250.md:118` (Supplementary IDV Adapter STEPs 170-175 own `lib/kyc/adapters/`).

## Database

None. The delivery store is `InMemorySupplementaryIdvDeliveryStore`, which carries the invariants a real table will need: one row per `(vendor, company, delivery key)`, a claim that cannot be taken twice, a settle that requires a claim, and a release that only un-settles an unsettled claim. A migration is a later STEP's work, not this one's.

## Environment

No variable is read and none is added. The delivery secret arrives inside the sealed configuration STEP 170 stores (`kyc-idv:{vendor}:webhook:{company}`) and is opened with the keyring for the length of one verification. Jumio's delivery secret is `null` in its configuration, because Jumio documents no signature to compute.

## Packages

None. `node:crypto` provides `createHash`, `createHmac` and `timingSafeEqual`; nothing was installed and `package.json` is untouched.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| A delivery is verified before anything in it is read | `receiveSupplementaryIdvDelivery` verifies the raw bytes, then parses. The gate asserts the source order of the two calls as well as the behaviour: an unverified delivery answers `401`, causes no read, moves no row and claims no key. |
| Sumsub is verified with its documented digest | `x-payload-digest` with `x-payload-digest-alg`, `HMAC_SHA256_HEX` or `HMAC_SHA512_HEX`, over the raw bytes in lower-case hex. The gate recomputes every digest independently, refuses a missing header, a missing algorithm, an unknown algorithm and the deprecated `HMAC_SHA1_HEX`, and proves that a body altered by one byte or one space fails. |
| Didit is verified with `X-Signature`, its clock and its rotation header | `X-Signature` over the exact bytes, `X-Timestamp` within 300 seconds on both sides of the boundary (the gate scripts 300 and 301), `X-Signature-Previous` accepted during a rotation, a current signature winning over a wrong previous one, and the whole thing constant-time. |
| Didit's weaker headers are refused rather than half-checked | A `V2`-only delivery is refused with `signature_only_canonical_json` because the canonical form the page read here does not specify, and an `X-Signature-Simple`-only delivery is refused with `signature_only_envelope` because Didit's own documentation says it authenticates the envelope and not the decision. A valid `X-Signature` still verifies when a `V2` header rides along. |
| Jumio's absence of a signature is recorded honestly | Jumio is verified by its documented **IP allowlist** when the transport supplies a peer address (`verified`, method `IP allowlist`), refused when the address is outside the eighteen documented ones, and `unsigned` when no address is available. An unsigned callback is still heard and still causes a read, and it can never set a result by itself. |
| A delivery cannot decide a result | The result always comes from the injected `readSession`, which is the vendor adapter's own read. The gate proves both directions: a body that shouts `RED` with a `FORGERY` label records the read's `passed`, and a body that says `GREEN` records the read's `failed` with the read's reason. |
| A delivery from the other environment is refused | Sumsub's `sandboxMode` and Didit's `environment` are compared with the configuration's sealed environment; a mismatch answers `500`, is never read and never recorded. Only the documented booleans count, so `"true"` as a string is a production delivery. |
| A test delivery is never a result | `testMode: true` answers `200` with outcome `test`, causes no read, records nothing and claims no key. The gate proves a test body that claims an approval leaves the row `in_progress`. |
| A duplicate changes nothing | The deduplication key is Didit's `event_id` when present and the SHA-256 of the raw body otherwise, because Sumsub and Jumio document no delivery id. The gate proves a re-sent identical body and a re-signed Didit retry both answer `200` as `duplicate` without a second read, and a different body still counts as its own delivery. |
| A claim is released when nothing was recorded | `release` runs when the session is unknown, the read fails or the row refuses the answer, so the vendor's retry is heard. The gate proves the exact sequence: a read that throws answers `500`, then the same body with a healthy read is accepted and recorded. |
| A company, a vendor and an environment are chosen by the route, never by the body | The configuration is resolved from `configId` + `companyId` + vendor given by the caller; a body claiming another vendor or company is refused `500`. A session is only ever found inside the route's own company and vendor, and a session of another company or another vendor is `unknown_session`. |
| A late delivery cannot rewrite a decided one | STEP 170's forward-only recorder refuses the move, and the receiver settles the delivery as `ignored` with `200` and audits `supplementary_idv.delivery_outranked`. The gate proves a recorded pass survives a late `pending` body with its version unchanged. |
| No payload is kept | The receiver stores the vendor's status word, the identifiers, the outcome and the **SHA-256 of the body**, never the body. The gate feeds a Didit decision containing `first_name`, `last_name`, `date_of_birth`, `document_number` and a passport type, then asserts none of those strings appears in the parsed delivery, the delivery store, the audit entry or the session row. |
| The answer tells each vendor what to do | `SUPPLEMENTARY_IDV_DELIVERY_ANSWERS` maps every outcome for every vendor: `200` for accepted, duplicate, ignored and test; `400` for malformed; `401` for unverified; `404` for an unknown session; `500` for refused and failed. The gate asserts all 27 cells and that `403` is never used. |
| A processor KYB status is never touched | The only write path is `recordSupplementaryIdvAnswer`; the gate asserts the processor snapshot is unchanged after a delivery, that `supplementaryIdvDeliverySummaryOf` says `changesProcessorKyb: false`, and that the source never writes `processorKybStatus` or a processor word as a result. |

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/kyc/adapters/deliveries.ts lib/kyc/adapters/deliveries-verify.ts` — clean, no warnings.
- `node lib/kyc/adapters/deliveries-verify.ts` — `deliveries gate passed: 625 checks`.
- `node --experimental-strip-types lib/kyc/adapters/deliveries-verify.ts` — the same 625 checks.
- `npm run check:structure` — 17 directories, 14 root files, **581** source files.
- `npm run verify` — **exit 0**: audit **3267** checks, structure 581 source files, lint 77 checks.
- Gate mutation proof: **14 of 14** mutations were caught, from a `/tmp` backup restored in the same command and the honest gate re-run afterwards. The mutations were: the deprecated SHA-1 algorithm accepted, the Sumsub digest taken over a trimmed body, the Didit clock window dropped, a V2-only delivery accepted, the rotation header ignored, a missing Jumio address treated as verified, every Sumsub type treated as a decision, the claim never released, the environment mismatch ignored, a test delivery recorded as a result, the reference mismatch ignored, the digest comparison made loose, the answer for an unverified delivery turned into `200`, and the raw body kept in the audit entry.

## Not Run / Open

- **No route and no job.** The receiver is a function a handler calls with the bytes it received; wiring `app/api/kyc/idv/{vendor}/delivery` belongs to a STEP that owns `app/`. Whoever builds it must read the body as text (`await request.text()`) and must never re-serialize it before the receiver sees it, because the Sumsub digest and Didit's `X-Signature` are both over the exact bytes.
- **The delivered body is not a decision.** All three vendors document a read as the authoritative path, and this module follows it, so every decision delivery costs one vendor call. A poller remains the fallback when a delivery is lost.
- **Didit's `X-Signature-V2` is not computed.** Its page describes it only as HMAC over "sorted, Unicode-preserved canonical JSON" and does not specify the canonicalisation, so a V2-only delivery is refused rather than guessed. If Didit stops sending `X-Signature`, those deliveries will be refused until a page states the canonical form.
- **Jumio has no signature to verify.** An unsigned callback is heard and can only cause a read. A deployment should also allowlist the eighteen documented callback addresses at the edge, where the peer address is actually trustworthy.
- **Sumsub's legacy `HMAC_SHA1_HEX` is refused.** The documentation calls it deprecated and explains that older webhooks fall back to it; the fix is to edit the webhook and choose SHA-256 or SHA-512.
- **No freshness window for Sumsub or Jumio.** Neither documents one, so none is invented. Replay is covered by deduplication rather than by a clock, and Sumsub's `createdAt`/`createdAtMs` and Jumio's `callbackSentAt` are formatted strings this file does not turn into an epoch.
- **Retry classes are the vendors' own.** Sumsub treats `401`, `403` and `404` as permanent; Didit retries `5xx`, `404`, timeouts and connection failures; Jumio documents only that `200` is expected. The answer table therefore uses classes every one of them documents rather than a single global rule.
- **The settings screen and the processor-KYB gate are STEP 175's.** Nothing here decides which vendor is on, and nothing here can lift a charge or payout flag.
