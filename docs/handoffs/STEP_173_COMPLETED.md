// path: docs/handoffs/STEP_173_COMPLETED.md
# STEP 173 — Sumsub supplementary identity/liveness adapter with encrypted configuration and verification session

**Status: COMPLETED**

## STEP

- Number and title: STEP 173 — Sumsub supplementary identity/liveness adapter with encrypted configuration and verification session.
- Category: Optional supplementary identity verification adapters (Jumio, Didit, Sumsub), STEPs 170-175. This is the third and last vendor under STEP 170's port: 171 was Jumio, 172 was Didit, this STEP is Sumsub. STEP 174 verifies and deduplicates the deliveries all three send; STEP 175 lets a super administrator activate at most one of them and defines the manual fallback.
- Depends on: STEP 170 (`lib/kyc/adapters/supplementary-idv.ts` — the three-member port, the five result words, the sealed configuration, the session store and the forward-only recorder), STEP 172 (`lib/kyc/adapters/didit.ts` and its gate — the shape this STEP follows for the last vendor), STEP 056 (`lib/security/encryption.ts` — the keyring that seals the app token, the secret and the delivery secret), and STEPs 147-169 for the adapter conventions (an allowlisted surface, a transport port, bracketed HTTP classes, a gate that runs with plain `node`).

## Provider documentation read in this session

Every fact in `lib/kyc/adapters/sumsub.ts` traces to one of these pages, read before the file was written. The `.md` versions are Sumsub's own agent-readable renderings of the same pages.

| Page | What it established |
|---|---|
| https://docs.sumsub.com/llms.txt | The documentation map, used to find the reference pages below. |
| https://docs.sumsub.com/reference/authentication | Three headers on every call: `X-App-Token`, `X-App-Access-Sig` (lower-case hex), `X-App-Access-Ts` (Unix seconds). The signature is `HMAC-SHA256(secret, ts + METHOD + uri + body)`, the uri **includes every query parameter**, the body is signed exactly as sent and omitted when there is none, the timestamp must be within **one minute** of server time, and plain HTTP is refused. |
| https://docs.sumsub.com/reference/create-applicant.md | `POST /resources/applicants?levelName={level}` creates an applicant and needs the **Create applicants** permission. Sandbox allows 500 applicants per 24 hours. The individual answer carries `id` (24 characters), `createdAt`, `clientId`, `inspectionId`, `externalUserId`, `requiredIdDocs.docSets[]`, `review.reviewStatus` and `type`. |
| https://docs.sumsub.com/reference/get-applicant-review-status.md | `GET /resources/applicants/{applicantId}/status` returns `reviewStatus` (`init`, `pending`, `prechecked`, `queued`, `completed`, `onHold`, `awaitingService`, `awaitingUser`), `reviewResult.reviewAnswer` (`GREEN` approved / `RED` declined), `rejectLabels[]`, `reviewRejectType`, `levelName`, `attemptId` and the review dates. |
| https://docs.sumsub.com/reference/get-status-of-verification-steps.md | `GET /resources/applicants/{applicantId}/requiredIdDocsStatus` breaks the result down per required step (`IDENTITY`, `IDENTITY2..4`, `SELFIE`, `SELFIE2`, `PROOF_OF_RESIDENCE`, `QUESTIONNAIRE`, `APPLICANT_DATA`, `COMPANY`), each with its own `reviewResult` and the `idDocType`/`country` it was approved for. |
| https://docs.sumsub.com/reference/get-applicant-data-via-externaluserid.md | An applicant id is **24 digits and lower-case Latin characters**, not a UUID, and `externalUserId` supports up to 512 characters. |
| https://docs.sumsub.com/reference/check-applicant-existence-by-externaluserid.md | `GET /resources/applicants/-/byExternalUserId/{externalUserId}` answers `{"exists": true, "applicant": {...}}` or `{"exists": false}`, which is the documented way to find an applicant whose id is not known. |
| https://docs.sumsub.com/reference/generate-access-token.md | `POST /resources/accessTokens/sdk` with `{userId, levelName, ttlInSecs?}` answers `{token, userId}`; the token's life is `ttlInSecs` (default 600) and it is bound to one applicant. Failures come back as `{description, code, correlationId, errorCode, errorName}`. A Sandbox run uses an app token and secret pair created in Sandbox mode, on the same host. |
| https://docs.sumsub.com/docs/test-in-sandbox.md | Sandbox is an isolated environment with no approval algorithms and no billing, capped at 500 applicants per 24 hours, driven by verification presets. |
| https://docs.sumsub.com/reference/get-id-verification-results.md | `idDocType` is the document type named in the level (for example `PASSPORT`) and it appears per document alongside its recognition result. |
| https://docs.sumsub.com/reference/error-codes.md | The `91xx` codes are applicant-facing verification errors; the transport's own failures are the HTTP status plus `{description, code, errorName}`. |

## Files

- `lib/kyc/adapters/sumsub.ts` — 1378 lines. The host, the five documented paths and the allowlist, the HMAC-SHA256 signing, the encrypted configuration and its activation probe, the applicant create with duplicate reconciliation, the SDK access token, the review-status and step reads, the neutral decision mapping, the STEP 170 port adapter, the office summary, and the transport.
- `lib/kyc/adapters/sumsub-verify.ts` — 1608 lines, **1165 checks**. The gate, in the eleven sections STEPs 170-172 established. It runs with plain `node` and with `node --experimental-strip-types`, reaches no network, and scans its own adapter's source.
- `docs/handoffs/STEP_173_COMPLETED.md` — this file.

No other file was touched: `package.json`, `config/structure.json`, `migrations/`, `app/`, `services/kyc/`, `lib/payments/`, `lib/security/`, `lib/i18n/` and `docs/final/PROVIDER_DOCS.md` are unchanged, per the ownership rule at `docs/final/STEP_PLAN_250.md:118`.

## Database

None. This STEP adds no table, column or migration: STEP 170 owns the configuration and session shapes, and the stores here are the in-memory implementations STEP 170 ships. A migration would be a different STEP's work.

## Environment

No variable is read and none is added. A Sumsub configuration arrives through `createSumsubConfiguration` (company, environment, app token, secret, optional delivery secret), is validated in memory, and is sealed by STEP 170's `sealSupplementaryIdvConfig` under `kyc-idv:sumsub:credential:{company}` and `kyc-idv:sumsub:webhook:{company}`. The plaintext exists only inside `openSupplementaryIdvConfig`'s answer for the length of one call.

## Packages

None. `node:crypto` provides `createHmac` and `randomUUID`; nothing was installed and `package.json` is untouched.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| Sumsub is one vendor under STEP 170's port | `sumsubAdapterOf` returns exactly `vendorKey`, `createSession`, `readSession`; the gate asserts `isSupplementaryIdvAdapter(...)` and the sorted member list. |
| Every request is signed as the documentation says | `sumsubSignaturePayloadOf` builds `ts + METHOD + path + body`, the gate compares its example byte for byte with the documentation's string, and compares the digest with an independently computed `createHmac` value. |
| The query string is signed | The create path carries `?levelName=`, and the gate asserts that a different query is a different signature and that the signed uri contains the query. |
| One host, and the mode is declared rather than inferred | `SUMSUB_API_HOST` is the only host; `activateSumsubConfiguration` and every call read `config.environment`. No code reads a prefix: the gate proves that `sbx:`- and `prd:`-shaped app tokens are carried verbatim and that no mode word is written into the sealed text. |
| Five calls, and nothing else | `SUMSUB_ALLOWED_CALLS` holds the create, the SDK token, the review status, the step results and the existence lookup. The gate refuses 25 other method/path pairs by name, including the applicant-data read, `/reset`, `/deactivate` and `accessTokens/app`, and the transport refuses anything outside the list **before** `fetch` is reached (proved by the thrown message, not merely by a throw). |
| Connecting Sumsub is inert until it is proved | A new configuration is stored `pending_activation`; activation is a signed `GET` of the documented existence endpoint with a `kd-probe-<uuid>` identifier, so it returns `{"exists": false}` and creates no applicant, no session and no bill. `401`/`403`/`429`/`5XX`/a redirect/a throw/an unreadable answer all leave the row waiting; the gate scripts every one of those nine answers. |
| One active vendor per company and mode | Activation refuses when another vendor is already active in the same environment, and the gate also proves that a live configuration does not block a sandbox one. |
| A session row exists before Sumsub is called | `openSumsubSession` reads the STEP 170 row first and refuses a session that ended, that belongs to another vendor, that already holds a reference, or whose configuration disagrees about the mode; the applicant id is recorded only afterwards. |
| Our own identifier is the reconciliation key | The create body is exactly `{"externalUserId": "<session id>"}`; the gate asserts the body has one field and carries no name, date of birth, document, address, e-mail or phone. |
| A duplicate creates nothing new | A `409` is reconciled through the documented existence lookup, and the found applicant is adopted (`reconciled: true`). A duplicate the lookup cannot find, or a lookup that does not answer, leaves the row untouched and asks for reconciliation. |
| Eight review statuses, matched exactly | `SUMSUB_REVIEW_STATUSES` is the documentation's eight values in its order; `parseSumsubStatus` does not trim, so `"completed "`, `"Completed"` and `"onHold "` stay unknown, and the gate asserts that a padded or re-cased approval is not a pass. |
| `GREEN`/`RED` mean what the documentation says | `completed` + `GREEN` is `passed`; `completed` + `RED` is `failed`; a `GREEN` on any other status is still `in_progress`. A completed review with no readable answer is `unknown`. |
| `onHold` is not a verdict | It maps to `in_progress`, because Sumsub hands that decision to a compliance expert; STEP 170's record also forbids moving a running session to `unknown`. Sumsub's own `onHold` is preserved for the office in `sumsubSessionSummaryOf`. |
| Liveness is read, not guessed | The `SELFIE`/`SELFIE2` step's own answer: `GREEN` passed, `RED` failed, present but unanswered `in_progress`, absent `unknown` (a check the level never configured did not pass). |
| The document kind is read, not guessed | The `IDENTITY`/`IDENTITY2..4` step's `idDocType`, mapped only for the three codes the pages read here name (`PASSPORT`, `ID_CARD`, `RESIDENCE_PERMIT`); every other code, including a utility bill, states nothing. |
| Reasons come from documented labels only | `UNSATISFACTORY_PHOTOS` is `document_unreadable`; `FORGERY` and `GRAPHIC_EDITOR` stay labels in the office view because the neutral vocabulary has no word for fraud. With no documented label, the failed step decides: a red selfie is `liveness_failed`, a red identity step is `document_unreadable`, and anything else states nothing. |
| The SDK token is answered once and stored nowhere | `createSumsubAccessToken` returns the token to the caller; the body it sends is exactly `{userId, levelName, ttlInSecs}`; the gate proves the token never appears in the configuration row or the session row. The life defaults to the documented 600 seconds and is bounded at both ends. |
| A late answer cannot rewrite a decided one | Refreshing after a recorded pass with a running review is refused by STEP 170's forward-only recorder, and the gate asserts the row keeps its pass and its version. |
| The status answer outranks a failed step read | A steps read that returns `5XX` or throws leaves the decision intact and states liveness and the document kind as unknown. |
| A supplementary pass is never a processor status | Every answer goes through `recordSupplementaryIdvAnswer`; the gate walks all eight statuses times three answers times three step shapes and asserts each output is in STEP 170's five words, never in the processor's five, and that the adapter's source never spells `verified`, `action_required`, `restricted` or `rejected`, and writes no `processorKybStatus`. |

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/kyc/adapters/sumsub.ts lib/kyc/adapters/sumsub-verify.ts` — clean, no warnings.
- `node lib/kyc/adapters/sumsub-verify.ts` — `sumsub adapter gate passed: 1165 checks`.
- `node --experimental-strip-types lib/kyc/adapters/sumsub-verify.ts` — the same 1165 checks.
- `npm run check:structure` — 17 directories, 14 root files, **579** source files.
- `npm run verify` — **exit 0** at the committed tree: audit **3260** checks, structure 579 source files, lint **77** checks (26 error rules, 11 failure probes).
- Gate mutation proof: **17 of 17** mutations were caught, from a `/tmp` backup restored in the same command and the honest gate re-run afterwards. The mutations included a `RED` review read as a pass, the allowlist check removed, the signature payload reordered, `onHold` dropped from the catalogue, a green selfie read as a failed liveness, the token ceiling removed, a duplicate refused instead of reconciled, activation proved by any answer, the review status trimmed, the document map stretched, the external-id bound removed, the audit trail dropped, the signature guard removed, the redirect guard removed, the timeout removed and a quoted processor word reintroduced.

## Not Run / Open

- **Deliveries are STEP 174's.** Sumsub signs its webhooks with its own digest header over the raw body; no delivery verifier exists here, so this adapter trusts no delivery and reads the review status and the steps instead. The sealed `webhookSecret` is carried for that STEP to use.
- **The settings screen is STEP 175's.** Nothing here is wired to a route, a job or a page: `createSumsubConfiguration` and `activateSumsubConfiguration` are called by whichever STEP builds the super administrator's screen.
- **No live call was made.** Every scripted answer in the gate is a fixture shaped from the documentation; no sandbox and no production app token exists in this environment, and creating a sandbox applicant would spend the 500-a-day allowance for no proof.
- **The level name is configuration.** Sumsub verifies against a level that exists in the same environment and whose name is case-sensitive; this adapter validates the shape of the name and never invents one. Choosing it belongs to STEP 175.
- **The applicant-data read was not implemented.** `GET /resources/applicants/{id}` and the `-;externalUserId` variant return personal data and documents. This adapter does not need them, and they are refused by name so a later change has to say why.
- **Only three `idDocType` codes are mapped.** The pages read here name `PASSPORT`, `ID_CARD` and `RESIDENCE_PERMIT`; a driving licence or another code stays unstated until a page states it.
- **`reviewRejectType` is carried but not interpreted.** `FINAL` and `RETRY` both leave this attempt `failed` when the answer is `RED`; a resubmission is a new session, which is STEP 175's decision.
