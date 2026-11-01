// path: docs/handoffs/STEP_023_COMPLETED.md
# STEP 023 Completed - Handoff

## STEP
- Number and title: STEP 023 - Migration for payment providers, provider keys, routing rules,
  webhook events, idempotency keys, merchant API credentials, store connections and TaxCloud
  connections tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 022 (the quotes and the
  recurring schedules that point at an invoice), STEP 021 (the invoices a payment settles) and STEP
  014 (`plans`, which set the precedent of a platform row with a null `company_id`). STEP 024 adds
  the payments, refunds and disputes that reference the provider, the routing rule and the
  idempotency key this STEP stores, STEP 025 the ledger those payments post to, and STEP 035 the
  permissive policies. The owner asked for three sub-steps with one approval between each rather
  than the usual five, and the plan is `docs/planning/STEP_023_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0029_payment_providers.sql and 0029_payment_providers.down.sql - the platform
    catalogue of the five section 6 adapters, with the closed `provider_key` vocabulary, the three
    capability booleans, the connection test and the condition that a provider is only enabled after
    a passing test.
  - migrations/0030_provider_keys.sql and 0030_provider_keys.down.sql - the AES-256-GCM ciphertext
    of a provider key with its vector, tag and key version, the four visible characters, the SHA-256
    fingerprint, one active key per provider and mode, the rotation link and the identity guard.
  - migrations/0031_routing_rules.sql and 0031_routing_rules.down.sql - the routing decision with
    one provider per rule, a priority unique per mode, the country, method and amount criteria, no
    fallback column, and the guard that refuses a provider that is disabled or cannot accept.
  - migrations/0032_webhook_events.sql and 0032_webhook_events.down.sql - the delivery keyed by the
    provider's own event identifier, the payload hash, the signature result, the forward only status
    and the evidence guard.
  - migrations/0033_idempotency_keys.sql and 0033_idempotency_keys.down.sql - the caller key as a
    hash, unique per tenant and scope, with the request hash, the three states, the replayed answer,
    the expiry window and the state guard.
  - migrations/0034_merchant_api_credentials.sql and 0034_merchant_api_credentials.down.sql - the
    merchant API key as a SHA-256 with its visible prefix and tail, the encrypted webhook signing
    secret beside its own tail, the rotation link, the revocation and the identity guard.
  - migrations/0035_store_connections.sql and 0035_store_connections.down.sql - the Shopify and
    WooCommerce store with its bare lower case domain, its encrypted access token, its install
    states and the identity guard.
  - migrations/0036_taxcloud_connections.sql and 0036_taxcloud_connections.down.sql - the merchant
    TaxCloud account with both credentials encrypted, one usable connection per merchant and the
    collection switch.
  - docs/planning/STEP_023_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_023_COMPLETED.md.
- Modified:
  - migrations/README.md - eight inventory rows and two new rules: a provider is a catalogue row and
    a key is ciphertext, and a credential is a hash while a secret is ciphertext. The numbering rule
    moved from 30 to 33.
  - README.md - the database section describes the provider catalogue, the encrypted keys, the
    routing rules, the webhook events, the idempotency keys, the merchant credentials, the store
    connections and the TaxCloud connections, directly above the `uuid_generate_v7()` bullet.
- Corrected, because reading these documents exposed defects in them:
  - migrations/README.md - the rules were numbered 1 to 25 then 27, 28, 30, 31 and 32, missing 26
    and 29 from the renumbering of STEP 021 and STEP 022. They are now contiguous from 1 to 33.
  - docs/handoffs/STEP_021_COMPLETED.md - the sentence about the numbering rule now says 26 to 28,
    which is what that STEP actually did.
  - docs/handoffs/STEP_022_COMPLETED.md - the sentence about the numbering rule now says 26 to 30,
    the next STEP is named as the providers and not as expenses that do not exist in the plan, the
    reminder job is attributed to the job STEPs of section 27, and the next chat note names this
    STEP correctly.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0028`, every
  `lib/` module, `config/`, the environment contract, payments, refunds and disputes (024), the
  ledger (025), settlements and payouts (026), the five adapters and their registry, the webhook
  job, the store plugins, the TaxCloud client, the super admin gateway screens, the merchant API
  endpoints, the file storage adapter (100-105), the permissive RLS policies (035) and every code
  STEP. `package.json` is untouched because the migrations gate already covers new files.

## Database
- Migrations added (file names): `0029_payment_providers`, `0030_provider_keys`,
  `0031_routing_rules`, `0032_webhook_events`, `0033_idempotency_keys`,
  `0034_merchant_api_credentials`, `0035_store_connections` and `0036_taxcloud_connections`, each
  with its `.down.sql`. Together they create eight tables, 146 columns, 135 constraints, thirty
  indexes, 154 comments, seven functions and fifteen triggers. The schema now holds thirty six
  tables, thirty six policies, fifty four triggers and twenty two functions in `public`.
- Shape per table: `payment_providers` 17 columns, 14 constraints, three indexes, 18 comments, one
  trigger; `provider_keys` 23 columns, 21 constraints, five indexes, 24 comments, two triggers;
  `routing_rules` 16 columns, 16 constraints, four indexes, 17 comments, two triggers;
  `webhook_events` 16 columns, 15 constraints, four indexes, 17 comments, two triggers;
  `idempotency_keys` 15 columns, 14 constraints, four indexes, 16 comments, two triggers;
  `merchant_api_credentials` 21 columns, 19 constraints, five indexes, 22 comments, two triggers;
  `store_connections` 19 columns, 18 constraints, three indexes, 20 comments, two triggers;
  `taxcloud_connections` 19 columns, 18 constraints, two indexes, 20 comments, two triggers.
- Money: no table of this STEP stores an amount, so no money rule is restated here. A routing rule
  bounds its band in minor units with `min_amount_minor` and `max_amount_minor`, and the amounts
  themselves arrive with STEP 024.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All thirty six
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the thirty six forward
  files applied again to a second empty database, recreating exactly thirty six tables, thirty six
  policies, fifty four triggers and twenty two functions with no rows left behind.

## Environment
- Environment variables added to .env.example: none. The rows of this STEP store ciphertext; the
  encryption key itself is the environment variable the settings STEP already declares, and no new
  variable is needed to hold a secret in a column.
- Secrets handled (names only, never values): none. The proofs wrote synthetic ciphertext, synthetic
  fingerprints and synthetic store domains in throwaway local databases, and no real provider key,
  TaxCloud account, store token or Shopify credential was written anywhere.
- The working tree survived from STEP 022 at commit `6d6023a`; Node.js 26.13.0, the installed
  dependencies and PostgreSQL 16.2 from the `pgserver` wheel were reused, and `npm run verify` was
  exit 0 at that commit before any file of this STEP was written.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Two scripts ran against the local PostgreSQL 16.2 with 61 and 65 checks; all passed and each ended
with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0036` applied in order and produced thirty six tables, thirty six
   policies, fifty four triggers and twenty two functions. 2. **Every table shape holds.** The eight
   tables reported the column, constraint, index, trigger and comment counts listed above, with RLS
   on and one policy each, so every column is documented. 3. **The provider vocabulary is closed.**
   `adyen` was refused by `payment_providers_key_check`, so a provider without an adapter cannot be
   added from the dashboard, and adding a sixth one is a migration. 4. **The capability matrix is
   three booleans and at least one is true.** A provider with all three false was refused, and the
   five section 6 rows were stored with the matrix the feature list describes: NMI acceptance and
   sub-merchant, Payoneer payouts, Rainforest acceptance and sub-merchant, Stripe Connect and
   Airwallex all three. 5. **A provider is platform owned.** A row carrying a merchant was refused
   by `payment_providers_platform_check`, and all five rows carry a null `company_id`. 6. **A
   provider is enabled only by a passing test.** An enabled row without a test, and an enabled row
   whose test failed, were both refused, by insert and by update; enabling a tested row succeeded,
   set the instant and bumped the version to 2. 7. **The panel order and the adapter are unique.** A
   second row for `nmi` was refused by `payment_providers_key_key`, and a display order already
   taken was refused by `payment_providers_order_key`, which stopped counting a soft deleted row. 8.
   **A key is ciphertext with four visible characters.** A five character tail, an upper case
   fingerprint, the same secret entered twice and an active key that was never tested were each
   refused by name. 9. **One active key per provider and mode.** A second active key was refused by
   `provider_keys_active_key`, and the rotation is the section 29 procedure: disable the old key,
   add the new one with `rotated_from_id`, and the pair reads active and disabled. A second key
   rotating the same predecessor was refused by `provider_keys_rotation_key`.
10. **A key is never rewritten.** A changed tail was refused with "a provider key keeps its
   identity", and new ciphertext under an unchanged key version was refused, while the same row
   accepted new ciphertext under version 2.
11. **A routing rule names one provider that works.** A rule pointing at a payout only provider was
   refused with "a routing rule needs a provider that accepts payments", and one pointing at a
   disabled provider with "a routing rule needs an enabled provider".
12. **The routing criteria and order are closed.** A lower case country, a three letter country, a
   method outside the vocabulary, a ceiling below the floor and a disabled rule with no instant were
   each refused by name, and the same priority and the same name were refused inside one mode while
   being accepted in the other.
13. **There is no fallback anywhere.** A query over `information_schema.columns` for a fallback,
   default or next column on `routing_rules` returned no row, so an unmatched payment has no route
   to fall into.
14. **The routing index answers the decision.** With sequential scans disabled the planner used
   `routing_rules_match_idx` for the country and method lookup, and `routing_rules_priority_key` for
   a bare priority sweep.
15. **A delivery is one row.** The same provider event delivered twice was refused by
   `webhook_events_delivery_key`, while the same identifier in live mode was a row of its own, and
   the payload is kept only as a SHA-256, never as the body.
16. **An unverified event is never processed.** An unverified event marked `processed` or
   `processing` was refused, a verified event marked `rejected` was refused, a `failed` event with
   no detail was refused, and a `processed` event with no instant was refused.
17. **An event moves forward only.** Rewriting the payload hash was refused with "a webhook event
   keeps its identity", a terminal event that changed its outcome with "a finished webhook event
   keeps its outcome", a decided event that returned to `pending` with "a webhook event only moves
   forward", and a merchant that was renamed with "a webhook event names its merchant once".
18. **The webhook queue index is used.** With sequential scans disabled the planner used
   `webhook_events_queue_idx` for the pending and processing sweep of section 27.
19. **An idempotency key is one row per tenant and scope.** The same key replayed inside one
   merchant was refused, while the same key in a second merchant and in the refund scope were rows
   of their own. An upper case hash, a short hash, a scope outside the vocabulary, a completed key
   with no instant or no body, a failed key with no detail and a window that ends before the key
   exists were each refused by name.
20. **A decided key is never reopened.** A completed key rewrote its answer was refused with "a
   completed idempotency key keeps its answer", the same key returning to flight was refused, a
   failed key returning to flight was refused with "an idempotency key is decided once", and a
   changed request hash or a longer window was refused with its own message.
21. **The cleanup index is used.** With sequential scans disabled the planner used
   `idempotency_keys_expiry_idx` for the expired window sweep.
22. **An API key exists only as a hash.** The same hash in a second merchant was refused by
   `merchant_api_credentials_hash_key`, so two merchants can never hold the same secret; an active
   credential authenticates a lookup by its hash, and the revoked one authenticates nothing.
23. **A credential shape is closed.** An upper case prefix, a one character prefix, a truncated
   signing secret, a revoked credential with no reason and an active one carrying a reason were each
   refused by name.
24. **A credential rotates and a revocation is final.** A replacement carrying `rotated_from_id`
   reads active while its predecessor reads revoked with the reason, a second replacement of the
   same predecessor was refused, a revoked credential brought back was refused with "a revoked
   credential stays revoked", and a rewritten hash or new ciphertext under an unchanged key version
   was refused.
25. **A store is one row per merchant and platform.** The same store twice was refused by
   `store_connections_domain_key`, while a second merchant and a second platform held the same
   domain as their own rows; a trailing slash, an upper case domain and a domain without a dot were
   refused by name.
26. **A store connection follows the install.** An active connection without its instant and an
   error connection without its detail were refused; the handshake set `active` with `connected_at`
   and bumped the version, a move to another domain was refused with "a store connection keeps its
   store", new ciphertext under an unchanged key version was refused, a revoked connection that came
   back was refused with "a revoked store connection stays revoked", and a reinstall after removing
   the revoked row produced a new row.
27. **A tax connection is verified before it collects.** Collection on an unverified connection was
   refused by `taxcloud_connections_collection_check`, an active connection without verification by
   `taxcloud_connections_verified_check`, a second usable connection by
   `taxcloud_connections_company_key`, and an empty failure detail by
   `taxcloud_connections_error_check`.
28. **Tax credentials belong to their merchant.** Moving a connection to another merchant was
   refused with "a tax connection keeps its merchant", new ciphertext under an unchanged key version
   was refused with "tax credentials are re-encrypted only under a new key version", and the
   verified connection then read active, collecting tax and holding version 2 of the encryption key.
29. **A merchant can change its tax account.** Disabling the first connection freed the slot, so a
   second connection was accepted, which is the reason the unique index excludes the disabled rows.
30. **Row level security.** A plain role saw zero providers, zero keys, zero rules, zero events,
   zero idempotency keys, zero credentials, zero stores and zero tax connections, and could not add
   a provider or connect a store, while the owner saw six provider rows, two keys, two rules, three
   events, four keys, two credentials, four stores and two tax connections.
31. **Rollback and re-apply.** The thirty six rollbacks emptied the `public` schema completely,
   removed every function of this STEP, and the thirty six forward files rebuilt it on a second
   database with no rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1083 checks, 36 migrations, 36 tables, every
  forward file transactional and default-deny` (963 after the four provider tables, 843 before this
  STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from `0029`
  ("table payment_providers must enable row level security in this file"), removing `company_id`
  from `0033` ("table idempotency_keys is missing the required column company_id"), inserting a
  `truncate` into `0034` ("a forward migration never drops or deletes rows") and moving
  `0036_taxcloud_connections.down.sql` away ("has no rollback file").
- Behaviour mutation probes, each run against the proof that exercises the rule and each restored
  afterwards: relaxing the enable check made the provider proof report "an enabled provider without
  a passing test :: the write succeeded"; detaching `webhook_events_guard_evidence` made it report
  "an event that rewrites its payload hash :: the write succeeded"; detaching
  `idempotency_keys_guard_state` made the credential proof report both "a completed key rewritten ::
  the write succeeded" and "a completed key that returns to flight :: the write succeeded";
  detaching `store_connections_guard_identity` made it report "a connection that moves to another
  domain :: the write succeeded"; and detaching `taxcloud_connections_guard_credentials` made it
  report "credentials moved to another merchant :: the write succeeded".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 1083 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII, checked with a byte grep for
  characters outside the printable range.

## Errors Found And Corrected In This STEP
1. **A check that a null slipped through.** `webhook_events_failure_check` wrote the failed branch
   as `status = 'failed' and char_length(failure_detail) between 1 and 280`, which is null for a
   missing detail, and a check that evaluates to null passes; a `failed` event with no detail was
   therefore accepted. The branch now states `failure_detail is not null` explicitly.
2. **A proof that expected the wrong index.** The routing proof first asked for the whole active
   list ordered by priority and expected `routing_rules_match_idx`, but the planner correctly chose
   `routing_rules_priority_key` for that shape. The proof now measures the real decision query -
   mode, country, method, active - which does use the match index, and the gate list records both.
3. **A store constraint that forbid history.** `store_connections_active_check` required
   `connected_at` to be set exactly when the status was active, so revoking a connected store was
   refused as an active row without its instant. The instant is history, so the constraint is now an
   implication - active requires it, pending forbids it - and the table gained one constraint, which
   is why the count is eighteen and not seventeen.
4. **A unique index that blocked a legitimate second account.** `taxcloud_connections_company_key`
   covered every live row, so disabling the first TaxCloud account did not free the slot for the
   merchant that moved to another one. The index is now partial on `status <> 'disabled'`, which
   keeps one usable connection and lets disabled rows stand as history.
5. **A probe that tested the wrong thing.** The "upper case key hash" probe used `"2" * 64`, which
   is a valid lower case hex string, so the insert correctly succeeded. It now uses letters.
6. **Counts written before they were measured.** The owner counts were predicted as three keys and
   three stores and measured as four each, because the failed key and the reinstalled store also
   belong to the merchant; the labels were corrected with the numbers, as in every earlier STEP.
7. **A numbering defect inherited from two earlier STEPs.** The rules of `migrations/README.md` were
   numbered 1 to 25 then 27, 28, 30, 31 and 32, so 26 and 29 were missing and two handoff sentences
   described the wrong rule numbers. The rules are contiguous now and both sentences are corrected,
   as is the STEP 022 sentence that named expenses as the next STEP when the plan names the
   providers.

## Decisions And Limits Left For Later STEPs
- The five provider rows are not seeded here. A migration that inserted rows would be the only file
  in the folder that writes data, and the adapter registry that decides which five names are real
  arrives with the adapters themselves; the panel creates the rows and the closed vocabulary already
  refuses anything the registry could not call.
- No column holds a card number, an expiry, a CVV or a full token. Section 18 is therefore a
  property of the schema and not only of the adapter code that will call Collect.js.
- The encryption key is not in the database. Every encrypted column carries
  `encryption_key_version`, and a re-encryption under a higher version is the only rewrite the
  guards allow, which is what the environment key rotation of section 29 needs.
- `webhook_events` stores the payload hash and not the body, so a replay for debugging needs the
  provider's own portal. That is deliberate: a stored body is the easiest way for card data to reach
  the platform database by accident.
- A routing rule is platform data with no merchant. If a later STEP lets a merchant prefer a method,
  it adds a merchant scoped rule and a second index, it does not put a fallback here.
- `idempotency_keys` keeps a window and not an answer forever. The cleanup job of section 27 removes
  the expired rows; this schema only records when that is allowed.
- Store connections and the merchant API credentials are the data half of section 20. The Shopify
  app, the WooCommerce plugin, the rate limiting of the public API and the audit rows of every call
  are code STEPs.
- The TaxCloud client and the tax line on the invoice are section 7 code. This STEP only records a
  verified account and the merchant's on and off switch.
- RLS stays default-deny until STEP 035 grants the merchant its own rows and the office the platform
  catalogue.

## Next Chat Notes
- Next in this category is STEP 024, the payments, refunds and disputes tables. A payment will point
  at `provider_keys.id` and at the routing rule that chose it, will carry the idempotency key it was
  written under, and will be the first table that names an amount.
- A provider is enabled by a passing test, not by an update alone: the settings screen must record
  `last_tested_at` and `last_test_ok` in the same statement that sets `status = 'enabled'`, or the
  check refuses the row.
- A key rotates; it never changes. Any screen that "edits" a provider key must create a replacement
  with `rotated_from_id` and disable the old row, which is the procedure section 29 describes.
- A webhook handler must verify the signature before it writes `status` beyond `pending`, and it
  must treat a unique violation on `webhook_events_delivery_key` as "already received" rather than
  an error: the providers retry, and that index is what makes the retry harmless.
- An API request must hash the caller key with SHA-256 and look it up with `status = 'active' and
  deleted_at is null`; the plaintext key exists only in the response that created it.
- The store and tax guards freeze ciphertext under an unchanged `encryption_key_version`, so a
  re-encryption job must raise the version in the same statement that rewrites the value.
