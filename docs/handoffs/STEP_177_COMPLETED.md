// path: docs/handoffs/STEP_177_COMPLETED.md
# STEP 177 — Merchant TaxCloud account connect flow with masked credentials

**Status: COMPLETED**

## STEP

- Number and title: STEP 177 — Merchant TaxCloud account connect flow with masked credentials.
- Category: Sales Tax Collection With TaxCloud, STEPs 176-180. STEP 176 read TaxCloud's pages and designed the connection; this STEP implements the connect flow against the table that already exists: a merchant's owner enters the two values the TaxCloud dashboard shows, both are sealed with AES-256-GCM, and a ping decides whether the connection may be used at all. STEP 178 is the on and off switch, STEP 179 the invoice calculation, STEP 180 the stored tax lines.
- Depends on: `docs/final/FEATURE_LIST.md` section 7 ("Every merchant can connect a personal TaxCloud account", "TaxCloud credentials are encrypted and only shown masked") and section 29 ("Provider keys, email secrets and TaxCloud credentials entered in admin screens are AES-256-GCM encrypted at rest and shown only masked"); STEP 023's `migrations/0036_taxcloud_connections.sql` and its rollback (the table, its check constraints, its guard trigger and its partial unique index); STEP 0073's `office_and_secret_policies.sql` (the RLS policies that split what a merchant's session may write from what only the server may); the AES-256-GCM cipher in `lib/auth/secrets.ts` (the three-part box `lib/gateways/` stores provider keys in) and STEP 064's envelope and keyring discipline; STEP 008's `AppError` and code catalogue; STEP 037's session helpers (`requireAnyRole`, `requireCompanyId` and `hasSatisfiedTwoFactor`) for the permission; STEP 176's record (`lib/tax/taxcloud.ts`) for the base URL, the ping outcomes, the key header, the adapter's request builder and every documented sentence this STEP reuses.

## Provider documentation

The TaxCloud pages were read in this session: STEP 176 read sixteen pages earlier today and recorded each with the fact it settled in `lib/tax/taxcloud.ts` (see `TAXCLOUD_DOCUMENTATION_SOURCES`, read on 2026-11-07). This STEP re-read the one page its behaviour rests on, so the ping's semantics in the code are the page's own words:

| Page | What this STEP takes from it |
|---|---|
| https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/utilities/ping (re-read today; the `.md` form answers the same facts) | `GET https://api.v3.taxcloud.com/tax/connections/{connectionId}/ping` "verifies your authentication is working for the given connectionID"; a `200` answers `message`; `X-API-KEY` is the header the setup guide prescribes, and the bearer token in `Authorization` is the alternative this platform does not use; errors are problem bodies with `title`, `detail`, `status`, `type`, `instance` and `errors[{location,message,value}]`; the documented statuses are `400`, `401`, `403`, `404`, `422`, `429` and `500`. |

No new URL claim is made in this STEP beyond the one above; the setup page's two sentences about `401` (wrong `X-API-KEY`) and `404` (mistyped or foreign `connectionId`) are the ones the two rejection sentences in `lib/tax/taxcloud-connect.ts` repeat, and they are recorded with the page in STEP 176.

## Owned paths, and the ones that stay shut

Owned and used: `lib/tax/` only, per `docs/final/STEP_PLAN_250.md:119` ("TaxCloud STEPs 176-180 own `lib/tax/` and tax settings").

- `lib/tax/taxcloud-connect.ts` — new, 1343 lines. The permission, the two sealing scopes, the row and its invariants, the insert columns, the store port with an in-memory reference implementation and a PostgREST implementation, the transport port with the production transport, the audit vocabulary, the masked views, and the three operations: connect, verify, disconnect.
- `lib/tax/taxcloud-connect-runtime.ts` — new, 43 lines. The one place the four dependencies are wired: the platform's REST client, the AES-256-GCM sealer reading `ENCRYPTION_MASTER_KEY` from the environment, the audit trail, and the transport.
- `lib/tax/taxcloud-connect-verify.ts` — new, 1353 lines, the gate, **346 checks** (two checks were added by STEP 179, which needs the `Retry-After` header the transport answer now carries beside its status and body).
- `docs/handoffs/STEP_177_COMPLETED.md` — this file.

Untouched, deliberately: `package.json` (the gate runs by path, as every STEP since 170 does), `config/structure.json`, `migrations/` (STEP 023 already created every column this STEP needs and this block was granted no migration exception), `app/` (a connect screen and its route belong to STEP 178, which owns the tax settings surfaces and the switch the screen shows), `lib/security/` (the cipher is STEP 064's and is used, not changed), `lib/auth/` and `docs/final/PROVIDER_DOCS.md` (created by STEP 147 and extended only by adapter STEPs 147-169).

## Database

**No migration.** The table this STEP writes was created by STEP 023 and hardened by STEP 0073, and every column the flow needs is already there. Inspection of `migrations/0036_taxcloud_connections.sql` is part of the gate: it reads the file and proves the constants here are the migration's own words rather than a second vocabulary.

What is written and read:

| Column | What this STEP does with it |
|---|---|
| `id`, `created_at`, `updated_at`, `version` | The table's defaults and its `set_row_metadata` trigger own all four; the insert never names them, and every write filters on the version it read. |
| `company_id` | The tenant, from `requireCompanyId(actor)`, never from the body. |
| `api_id_last_four`, `api_key_last_four` | The connection ID's and the API key's last four characters: the only parts a screen may show, and the only parts in an audit payload. |
| `api_id_ciphertext`/`_iv`/`_tag`, `api_key_*` | One AES-256-GCM box per value, one column per part. |
| `encryption_key_version` | `TAXCLOUD_ENCRYPTION_KEY_VERSION = 1`, inside the column's 1..999. |
| `status` | `pending`, `active`, `disabled`: the three the check constraint allows. |
| `verified_at` | Set exactly when the row is `active`, which the table checks as `(status = 'active') = (verified_at is not null)`. |
| `collection_enabled` | Written `false` on connect; cleared whenever a connection loses its verification. STEP 178 owns turning it on. |
| `last_error` | One sentence of one to 280 characters for the last failure, trimmed and stripped of control characters. |

The invariants the table enforces, restated once in `taxCloudRowProblemOf` so the in-memory store, the REST mapping and a reader agree: two four-character masks, two boxes, a key version in range, one of three statuses, `verified_at` set exactly when active, collection only on an active row, an error inside the column's bounds, a positive version, and timestamps that run forwards.

## Environment

No variable is added. The sealer reads `ENCRYPTION_MASTER_KEY`, which the environment block requires and `.env.example` already lists; nothing else is read, and no secret is placed in a dependency object.

## Packages

None. `package.json` is unchanged: the module uses `node:crypto` for row ids, `zod` for the row shape it reads back, and the platform's own cipher, error catalogue and auth helpers.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| A merchant's owner connects their own TaxCloud account | `connectTaxCloudAccount` takes the actor, the connection ID and the key, and writes one row for `requireCompanyId(actor)`. The gate proves a `200`-shaped view is returned, the row is the merchant's, and a second merchant connecting the same TaxCloud account gets its own row. |
| Only the merchant's owner, and only with a second factor | `requireTaxCloudConnectActor` requires the `owner` role and `hasSatisfiedTwoFactor`. The gate proves an `aal1` session, an actor that still owes a factor and each of the six office roles are refused with `PERMISSION_DENIED`, that the refusal names `actor.twoFactorSatisfied`, and that `canManageTaxCloudConnection` gives a screen the same answer without throwing. |
| Both credentials are AES-256-GCM encrypted at rest | Two boxes are sealed by the injected sealer before the insert; the production sealer is `lib/auth/secrets.ts`. The gate proves the row's JSON holds neither plaintext, that each box opens only under its own scope, that a box sealed for another company fails to open, and that neither ciphertext contains any part of the plaintext. |
| The additional data binds a box to its row | The scopes are `taxcloud:connection-id:<companyId>` and `taxcloud:api-key:<companyId>`. The gate proves the two scopes differ, that both name the company, and that swapping them (or the company) fails with `INTERNAL_ERROR`. |
| Credentials are only shown masked | `taxCloudConnectionViewOf` carries `connectionIdHint` and `apiKeyHint`, each twelve stars and four characters, and no field that could carry a box. The gate proves a hint is sixteen characters, keeps the last four, equals STEP 176's mask, and that the serialised view holds neither the key, the connection ID, nor either ciphertext. |
| A value the table cannot mask is refused rather than truncated | `taxcloud_connections_*_last_four_check` accepts four letters and digits only, so a key ending in a symbol has no mask this schema can store. The gate proves such a key is refused with `VALIDATION_FAILED` before anything is sealed or stored, and that nothing was written. |
| One usable connection per merchant | A second connect while a usable row exists is refused with a sentence that says what to do, before the partial unique index has to raise. The gate proves the refusal, that it stored nothing and audited nothing, that the in-memory store raises `CONFLICT` if two writers race, and that a merchant whose only row is `disabled` may connect again with history kept. |
| The ping is the only proof, and it uses the documented call | `verifyTaxCloudConnection` opens the two boxes, builds the request with STEP 176's `taxCloudRequestOf` and sends it through the transport. The gate proves the call is a `GET` to `https://api.v3.taxcloud.com/tax/connections/<id>/ping` with no body, the stored key in `X-API-KEY`, `Accept: application/json`, no `Content-Type`, no `Authorization` header and no key in the URL, and that a key stored under another connection pings with that connection's key. |
| A verified connection is the only one that can be used | A `200` alone makes the row `active`, records the instant and moves the version. The gate proves the write, the audit entry, the message, and that a second `200` refreshes the instant rather than keeping the first one. |
| The two rejections are two answers | A `401` leaves the row `pending` with a sentence naming `X-API-KEY`; a `404` leaves it `pending` with a sentence naming the connection ID. The gate proves both, that the two sentences differ, and that TaxCloud's own `detail` is kept, stripped of control characters and cut to the column's 280 characters. |
| A temporary failure decides nothing | `429`, `500`, `503` and an undocumented status (and a thrown transport) end as `unanswered`: the row keeps its status and its instant, and only `last_error` records that the server could not be reached. The gate proves each status, the thrown-transport case, that an `active` connection stays `active` and keeps its instant through an outage, and that the audit action is `taxcloud.connection_unanswered`. |
| A key TaxCloud refuses stops collecting | A `401` for an `active` row demotes it to `pending`, clears `verified_at` and turns `collection_enabled` off in the same write, which is what the table's own check requires. The gate proves the demotion, the cleared instant, the cleared switch, and that the audit entry records `status_before: active`. |
| A race cannot overwrite a decision | Every write filters on the version it read and the store answers whether it matched. The gate proves a stale expected version is refused, a version that jumps is refused, a lost race ends as `CONFLICT`, and that the REST store's update names the row, the version and `deleted_at=is.null` and writes exactly four columns. |
| Disconnecting keeps history | `disconnectTaxCloudConnection` sets `disabled`, clears `verified_at` (the table forbids an instant on a non-active row), turns the switch off, clears the error and audits once. The gate proves the write, the audit, that a repeat answers `unchanged` with no second write and no second entry, and that a disconnected connection cannot be verified again. |
| Cross-tenant access is a not-found | The row is resolved by id *and* compared with `requireCompanyId(actor)`. The gate proves another merchant's row is `RESOURCE_NOT_FOUND` for verify and disconnect, an unknown id is the same answer, and that a disabled row's box failure is a sentence rather than a crash. |
| Every mutation writes one audit entry | Five actions: `taxcloud.connection_connected`, `_verified`, `_rejected`, `_unanswered`, `_disconnected`. The gate proves each action appears, that the connect entry names the row, the company and the actor, that its payload holds two masks, the status before and after, the outcome word and the key version, and that it holds neither credential, neither connection ID, nor any sealed value. |
| Nothing leaves for the wrong host | `taxCloudFetchTransport` refuses any origin other than `https://api.v3.taxcloud.com`, any path outside `/tax/`, an undocumented method, the `Authorization` header by name, any header the request builder does not write, and a call with no key; it refuses redirects, bounds the wait at fifteen seconds and reads at most 64 KiB. The gate calls the real transport with each of those and proves the refusal, including a v2 host that copies the documented path. |
| Sealing never half-writes | A sealer that throws ends as a refusal with a sentence and stores nothing. The gate proves the refusal, the sentence, the empty store and the empty audit trail. |

## Security review for this STEP

- **Validation**: the connection ID is STEP 176's UUID check; the key is STEP 176's length, whitespace and control-character checks; the mask rule adds the table's own four-character pattern; the company id is checked before it can reach a query string; the actor's company comes from `requireCompanyId`, never from the body.
- **RLS**: STEP 0073's merchant policies let a merchant session select their row, insert one with `verified_at is null` and update one while `verified_at is null`. So a merchant can enter credentials and cannot mark them verified or disable a verified row; the verification write is the server's, which is what `getTaxCloudConnectRuntime()` wires with the service role key. The gate reads the policy file and proves both facts still hold in the migration.
- **Audit log entries**: one per mutation, with a dotted action name in the platform's vocabulary, the actor, the session, the entity and the company, and a payload of masks only.
- **Permission checks**: `owner` plus a satisfied second factor for every operation; office roles refused; platform accounts with no company refused.
- **Secrets**: the plaintext key exists between the sealer's `open` and the transport's answer; it is never returned, never logged, never put in an audit payload and never in a URL. The module has no `console` call, which the gate proves by scanning its own source with assembled needles.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/tax/` — clean, no warnings.
- `node lib/tax/taxcloud-connect-verify.ts` — `taxcloud connect gate passed: 346 checks`.
- `node --experimental-strip-types lib/tax/taxcloud-connect-verify.ts` — the same 346 checks.
- `npm run check:structure` — 17 directories, 14 root files, **588** source files.
- `npm run build` — clean, every route compiled.
- `npm run verify` — **exit 0**: audit **3295** checks, structure 588 source files, lint **77** checks.
- Gate mutation proof: **27 of 27** mutations were caught, each applied to a `/tmp` copy of the module, run against the honest gate and restored in the same command. The mutations were: the role list widened to include `super_admin`; the role check removed; the second factor check removed; the company taken from the actor without the guard; both credentials sharing one scope; a scope that forgets the company; a hint that shows more than four characters; an unmaskable key accepted; a new row written `active`; a second usable connection allowed; the view carrying a ciphertext; the `404` branch removed so a mistyped connection is not a rejection; an outage demoting the row; a rejection keeping the switch on; a rejection keeping the instant; the rejection audit renamed; a disconnect leaving the switch on; a disconnect keeping the instant; a write that does not move the version; the sentence not cut to the column; the transport accepting any host; the transport allowing the refused header; the row check dropping the `verified_at` rule; a credential swapped in place; two usable rows allowed; any word counting as a stored status; and a pending row allowed to collect.

## Not Run / Open

- **No route and no screen.** `app/` is not this STEP's, so sub-step 6's desktop and mobile widths were not exercised: there is no component. The connect form, the "test this connection" button and the masked panel belong to STEP 178, which owns the tax settings surfaces; this module is what that screen calls, and `getTaxCloudConnectRuntime()` is the wiring it uses.
- **The on and off switch is STEP 178's.** `collection_enabled` is written `false` on connect and cleared whenever verification is lost, but nothing here turns it on: section 7's switch, and the merchant's consent to collect, are the next STEP.
- **No mode column, by the schema rather than by choice.** STEP 176's record names `test` and `live` as a property of a connection. `public.taxcloud_connections` has no such column, this block has no migration exception, and TaxCloud documents one host where the connection ID decides the environment. So this STEP stores what the schema holds, reads the ping verdict as the only proof, and never infers an environment from anything. If the block later wants two connections per merchant, that is a migration with its own STEP, not a column written by inference.
- **A key whose last four characters are symbols cannot be connected.** The mask columns accept four letters and digits, so such a key is refused with a sentence instead of a database error. Whether the schema should keep a longer or looser mask is a question for a later migration STEP; this STEP has no permission to change it.
- **One attempt per verify, no retry.** The ping is a single call with a fifteen-second bound. A `429` or a `5xx` is recorded as unanswered and the merchant may press again; STEP 179, which sends calls on the invoice path, is where exponential backoff and `Retry-After` belong.
- **No re-seal on rotation.** A box names its key version in the row and the guard trigger allows new ciphertext only under a higher version; rotating the master key and re-sealing these rows is the secrets rotation procedure's job, not this STEP's.
- **Rate limits and filing state remain unknown.** STEP 176's eight open questions stand unchanged; nothing here reads an order from TaxCloud, so nothing here depends on them yet.
