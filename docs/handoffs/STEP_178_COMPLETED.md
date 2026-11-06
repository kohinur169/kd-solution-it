// path: docs/handoffs/STEP_178_COMPLETED.md
# STEP 178 — Sales Tax Collection on and off setting per merchant

**Status: COMPLETED**

## STEP

- Number and title: STEP 178 — Sales Tax Collection on and off setting per merchant.
- Category: Sales Tax Collection With TaxCloud, STEPs 176-180. STEP 176 recorded TaxCloud's pages, STEP 177 built the connect flow and the ping, this STEP is the merchant's switch and the decision a later STEP must consult before an invoice carries tax, and STEP 179 is the invoice calculation itself.
- Depends on: `docs/final/FEATURE_LIST.md` section 7 ("Sales Tax Collection is an on and off option. When enabled, sales tax is collected automatically on invoices", "Collection applies to United States transactions", "TaxCloud credentials are encrypted and only shown masked"); STEP 023's `migrations/0036_taxcloud_connections.sql` for the `collection_enabled` column and its check (`collection_enabled = false or status = 'active'`); STEP 0073's merchant policies for who may write that column; STEP 037's `requireCompanyId`, STEP 008's `AppError`; STEP 177's `lib/tax/taxcloud-connect.ts` for the row, the store, the version guarded write, the masked view, the audit vocabulary and the permission (`requireTaxCloudConnectActor`); `lib/countries/registry.ts` for `COUNTRY_CODE_PATTERN`, which is how the platform already spells a country code.

## Owned paths, and the ones that stay shut

Owned and used: `lib/tax/` only, per `docs/final/STEP_PLAN_250.md:119` ("TaxCloud STEPs 176-180 own `lib/tax/` and tax settings").

- `lib/tax/taxcloud-collection.ts` — new, 428 lines. The country scope, the readiness vocabulary, the panel state, the decision function, and `setSalesTaxCollection` with its refusals, its version guarded write and its two audit entries.
- `lib/tax/taxcloud-collection-verify.ts` — new, 795 lines, the gate, **215 checks**.
- `docs/handoffs/STEP_178_COMPLETED.md` — this file.

Untouched, deliberately: `package.json` (the gate runs by path, as every STEP since 170 does), `config/structure.json`, `migrations/` (the column exists and this block has no migration exception), `app/` (see "Not Run" below: the screen is not this block's), `lib/countries/` (read for its pattern, not changed), `lib/tax/taxcloud.ts` and `lib/tax/taxcloud-connect.ts` (STEP 176's and STEP 177's behaviour is consumed, not edited).

## Database

**No migration.** `public.taxcloud_connections.collection_enabled` was created by STEP 023, and the two constraints that make this STEP's rules true are already in that file:

| Rule | Where it is enforced | What this STEP adds |
|---|---|---|
| Collection cannot be on unless the connection is `active` | `taxcloud_connections_collection_check`: `collection_enabled = false or status = 'active'` | A refusal with a sentence before the write, so the merchant never sees a constraint violation. |
| `active` means a verification instant | `taxcloud_connections_verified_check`: `(status = 'active') = (verified_at is not null)` | The switch never touches `status` or `verified_at`, and the gate proves it. |
| One usable connection per merchant | `taxcloud_connections_company_key`, partial on `deleted_at is null and status <> 'disabled'` | The switch reads the rows that index describes: not deleted, not disabled. |
| A credential is re-encrypted only under a new key version | `taxcloud_connections_guard_credentials` | The switch writes no credential column at all; the gate proves the stored row is byte for byte unchanged apart from the bit, the version and the update instant. |

**A finding worth recording**: STEP 0073's merchant update policy checks `verified_at is null` in its `WITH CHECK`, so a merchant's own session can update only a row that has never been verified. Flipping the switch on a *verified* connection is therefore a server-side write, which is what `getTaxCloudConnectRuntime()`'s store is. That is the right split - the switch belongs beside the proof - and it is why this module takes the same store the connect flow takes rather than a merchant-scoped client.

## Environment

No variable is added or read. The module imports no sealer and no transport, which the gate proves by scanning its own source for both words: the switch cannot open a credential or make a call, so it needs neither.

## Packages

None. `package.json` is unchanged.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| A merchant can switch collection on | `setSalesTaxCollection({ enabled: true })` writes the bit on the merchant's verified connection and answers `enabled` with the panel. The gate proves the column, the version bump, the status and instant left alone, the clock used, and the audit entry. |
| A merchant can switch it off | The same function with `enabled: false`, which needs no proof: an unverified, verified or failing connection can always be switched off. The gate proves the write, the audit entry and that the panel returns to "the connection is verified, turn collection on". |
| It cannot be switched on through an unverified connection | A `pending` connection (no ping has answered, or a ping said no) is refused with "the connection has not answered a verification ping, so collection cannot be turned on", nothing is written and nothing is audited. The gate also proves the store refuses the same write if a caller tries it directly, which is the table's constraint in code. |
| It cannot be switched on with no connection at all | A merchant with no row is refused with "no TaxCloud account is connected for this merchant..."; a merchant whose only row is `disabled` reads `disconnected` and is refused the same way, because history is not a connection. |
| The setting is per merchant | The company is `requireCompanyId(actor)`, never the body. The gate proves one merchant's flip leaves another merchant's row untouched (same version, bit still off) and that two merchants can each collect with their own entries. |
| A repeated click is not a decision | Enabling an enabled switch and disabling a switched-off switch both answer `unchanged`, write no row and write no audit entry. The gate proves the version does not move and the trail does not grow. |
| Nobody but the merchant's owner, and only with a second factor | The check is STEP 177's `requireTaxCloudConnectActor`, called rather than copied: the gate proves an `aal1` session and each of the six office roles are refused with `PERMISSION_DENIED`, that the refusal names the second factor, and that a platform account with no company has no switch. |
| One mutation, one audit entry | `taxcloud.collection_enabled` and `taxcloud.collection_disabled`. The gate proves each payload's provider key, both four-character masks, the status before and after, the bit, the key version, and that no key, connection ID or ciphertext is in it. |
| A race cannot overwrite a decision | The write filters on the version read and the store answers whether it matched. The gate proves a stale read ends as `CONFLICT` with no audit entry. |
| Collection applies to United States transactions | `TAXCLOUD_COLLECTION_COUNTRIES = ["US"]` and `isTaxCloudCollectableCountry` read through the platform's own `COUNTRY_CODE_PATTERN`. The gate proves `US`, `us`, `Us` and padded forms are covered, and that `USA`, `CA`, `GB`, `BD`, `U1`, `U`, the empty string and a non-string are not. |
| One decision a later STEP must use | `taxCloudCollectionGateOf(rows, countryCode)` answers `collect` only when the switch is on, the connection is `active` and the country is covered, and answers `not_connected`, `unverified`, `disconnected`, `switched_off` or `outside_united_states` otherwise, each with its own sentence. The gate proves every reason, that the boolean and the reason always agree, and that the missing proof is named before the country when both are wrong. |
| The panel a screen renders | `taxCloudCollectionStateOf(rows)` carries the bit, the readiness (`ready`, `unverified`, `disconnected`, `not_connected`), the masked connection, the row the bit belongs to, `canEnable`, `canDisable`, one sentence per state, and the outage warning. The gate proves the four readiness states, the button matrix in each, that a deleted row collects nothing even if its column was left on, that the masked view holds neither the key nor the connection ID, and that an outage is shown beside a switch that is still on. |

## Security review for this STEP

- **Validation**: the only input from a caller is the boolean. The company is the session's; the row is resolved from the merchant's own rows; the country is validated through the platform's pattern before it can influence a decision.
- **RLS**: the read is the merchant's own rows; the write is the server's, because STEP 0073's merchant policy forbids a merchant session from updating a verified row. Both facts are recorded above and neither is undone here.
- **Audit log entries**: one per flip, with a dotted action name, the actor, the session, the entity and the company, and a payload of two masks and two status words.
- **Permission checks**: `owner` plus a satisfied second factor, through STEP 177's guard so the two settings surfaces cannot drift.
- **Secrets**: the module never imports the sealer or the transport (proven by the gate's source scan), never reads a box and never makes a call; there is no credential in its inputs, its outputs, its audit payload or its panel.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/tax/` — clean, no warnings.
- `node lib/tax/taxcloud-collection-verify.ts` — `taxcloud collection gate passed: 215 checks`.
- `node --experimental-strip-types lib/tax/taxcloud-collection-verify.ts` — the same 215 checks.
- `npm run check:structure` — 17 directories, 14 root files, **590** source files.
- `npm run build` — clean, every route compiled.
- `npm run verify` — **exit 0**: audit **3302** checks, structure 590 source files, lint **77** checks.
- Gate mutation proof: **25 of 25** mutations were caught, each applied to a `/tmp` copy of the module, run against the honest gate and restored in the same command. The mutations were: an active connection reading unverified; history reading as no account; a disabled row treated as usable; a deleted row treated as usable; Canada added to the covered countries; any country code collecting; lower case refused; the two ready sentences merged; an unverified connection allowed to switch on; nothing allowed to switch off; the panel forgetting the bit; the outage warning dropped; the active check skipped in the enable path; the no-connection refusal removed; an enabled switch written again; an off switch written again; a write that keeps the version; enabling audited as disabling; the audit payload carrying ciphertext beside the mask; a switched-off connection collecting; the country never checked; the country checked before the proof; every invoice collecting; a platform account given a company; and the second factor requirement dropped.

## Not Run / Open

- **No route and no screen.** `app/` is not this block's, so sub-step 6's desktop and mobile widths were not exercised: there is no component. `TaxCloudCollectionState` is the view model a screen renders (the bit, the four readiness states, the two button flags, one sentence, the masked connection and the outage warning), and the screen itself belongs to STEP 180's totals view and the settings surface it carries, which is where the panel and the totals can be one page. STEP 177's handoff expected that screen in this STEP; this STEP records instead that the ownership rule gives this block `lib/tax/` and "tax settings" but not `components/` or `app/`, and that the block's precedent (STEPs 170 to 177) is a library module with a gate.
- **STEP 179 must consult `taxCloudCollectionGateOf`.** The invoice calculation may not read `collection_enabled` itself: the four conditions (a connection, `active`, switched on, a covered country) are one function, and the sentence a merchant sees for a missing tax line comes from the same vocabulary.
- **The switch resets when the account changes.** A merchant who disconnects and connects another TaxCloud account starts switched off. That is deliberate: the stored bit belongs to the connection row, and carrying "this merchant once wanted tax collected" across a change of account would collect through credentials no merchant consented to after the change.
- **No dependency on the platform country switch.** Section 6's "country level availability follows the platform country switch" governs which payment providers serve a country; section 7's scope is the tax rule and is decided per transaction by `taxCloudCollectionGateOf`. If the platform's country switch is ever meant to stop tax collection too, that is a product decision to take in a STEP that owns both switches, not something to infer here.
- **No retry and no backoff.** The switch makes no call. STEP 179's calls are where `429`, `Retry-After` and exponential backoff belong, and STEP 176's failure table already classifies them.
- **A collecting connection can be in an outage.** STEP 177's rule keeps an `active` row active through a `429`, `500`, `503` or an unreachable server, and this STEP shows that as a warning beside the switch rather than turning collection off. An outage is not evidence about a credential; a `401` or `404`, which is evidence, still demotes the row and clears the bit in STEP 177's write.
