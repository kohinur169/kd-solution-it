// path: docs/planning/STEP_023_SUBSTEP_BREAKDOWN.md
# STEP 023 - Sub-Step Breakdown

The owner asked for this STEP in three sub-steps rather than the usual five, with an approval
between each, so this document is sub-step 023.1 and it stops for permission before any SQL is
written. The proof belongs in `docs/handoffs/STEP_023_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 023 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for payment providers, provider keys, routing rules, webhook events, idempotency
  keys, merchant API credentials, store connections and TaxCloud connections tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 022 created `estimates`, `estimate_items`, `estimate_signatures` and
  `recurring_schedules`; STEP 024 adds payments, refunds and disputes, which point at the providers,
  the routing rule and the idempotency key this STEP stores. The adapter files of section 6, the
  webhook job of section 27 and the store integrations are code STEPs, not this one.

### Feature list lines that fix the shape
- Section 6:
  - "One adapter file per provider and one registry file listing all five with a capability matrix."
  - Five providers: NMI, Payoneer, Rainforest, Stripe Connect and Airwallex. NMI accepts cards
    through Collect.js hosted fields and creates sub-merchants; Rainforest accepts and creates
    sub-merchants; Stripe Connect and Airwallex accept, create connected accounts and pay out;
    Payoneer pays out.
  - "Super admin gateway page: super_admin only, with 2FA and fresh reauthentication. API keys can
    be added, tested, enabled and disabled without code change or redeploy."
  - "Keys are AES-256-GCM encrypted before storage. The encryption key exists only in environment
    variables."
  - "After saving, a full key is never shown again. Only the last characters and last updated time
    are shown."
  - "A provider cannot be enabled when its connection test fails."
  - "A provider without an adapter in code cannot be added from the dashboard."
  - "Routing rules decide the provider. When no routing rule matches, the payment is rejected and is
    never silently sent to another provider."
- Section 7: one merchant may connect a personal TaxCloud account, its credentials are encrypted and
  shown masked, and United States sales tax collection is an on and off option per merchant.
- Section 8: every merchant has a test and a sandbox mode with separate test credentials, and test
  and live data are fully separated.
- Section 20: merchants create, revoke and regenerate API credentials for store payments only; full
  keys and secrets are never displayed and never appear in UI, logs or error messages; Shopify and
  WooCommerce connections are installed with credentials and become active automatically.
- Section 29: every secret lives in environment variables or is AES-256-GCM encrypted at rest and
  shown masked, and key rotation is add, test, activate, then remove the old key.
- Section 27: webhook processing is a background job, which is why an event is a row.
- MASTER_PROMPT rule 12: "Every payment carries an idempotency key."
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy.

### What exists today (measured before coding)
- Twenty eight proven migrations (`0001`-`0028`), 843 gate checks over twenty eight tables, `npm run
  verify` exit 0 at commit `6d6023a`.
- `0003_users.sql` already sets the encryption precedent this STEP follows: a secret is stored as
  `text` AES-256-GCM ciphertext beside its metadata, and the key lives only in the environment,
  never in the database.
- `0014_plans.sql` sets the platform-object precedent: a platform wide row keeps `company_id` null
  with a foreign key to `companies`, and the column is documented as null for the platform.
- `0002_job_queue.sql` already carries the job rows that process webhooks, so no retry counter is
  added here; retries belong to the queue.

## 2. Design Decisions Taken Before Coding

1. **Eight tables in eight migrations, `0029`-`0036`.** Eight tables in one file would be a 1500
line
file whose rollback could not be reasoned about; one table per file matches every earlier STEP. 2.
**Platform objects keep `company_id` null.** The provider catalogue, its keys and the routing rules
are the platform's, made by super_admin in the gateway page of section 6, so those three tables
store null exactly as `plans` does. Webhook events, idempotency keys, merchant API credentials,
store connections and TaxCloud connections are tenant rows and carry the merchant. 3. **The provider
catalogue is a closed vocabulary.** `provider_key` is one of the five adapter names,
so a provider without an adapter cannot be added from the dashboard: the database refuses the row
the registry would not know how to call. Adding a sixth provider is a new migration, deliberately.
4. **Capabilities are three booleans, not a text array.** `supports_acceptance`, `supports_payouts`
and `supports_submerchant` state the section 6 matrix in a way a check can refuse (`at least one
true`) and a proof can read. A comma separated string would be an unqueryable vocabulary. 5. **A key
is ciphertext plus the four visible characters.** `key_ciphertext`, `key_iv`, `key_tag` and
`encryption_key_version` are the encrypted secret; `key_last_four` and `updated_at` are the only
things a screen may show, which is section 6 exactly. `key_fingerprint` is the SHA-256 of the
plaintext key, so a duplicate key is refused without ever storing it. 6. **A provider is enabled
only by a passing test.** `status = 'enabled'` requires
`last_test_ok = true` and an `enabled_at` instant in the same row, so "a provider cannot be enabled
when its connection test fails" is a check rather than a habit of the settings screen. 7. **One
active key per provider per mode.** `provider_keys_active_key` is unique on
`(provider_id, mode) where status = 'active' and deleted_at is null`, which is the rotation
procedure of section 29: add the new key, test it, activate it, and the old one must be disabled
first. `rotated_from_id` records what a key replaced. 8. **A routing rule names exactly one provider
and there is no fallback column.** The criteria are
country, payment method and an amount band, all optional, and `priority` is unique per mode so the
order is total. Section 6 says an unmatched payment is rejected and never sent somewhere else, so
the schema has no `default_provider`, no `fallback` and no "try next" column to set by accident. 9.
**The rule is checked against the provider row.** `routing_rules_guard_provider` refuses a rule
pointing at a provider that is disabled or that does not accept payments, because a rule that
cannot work is a silent rejection at the till. 10. **A webhook event is a row, keyed by the
provider's own id.** `(provider_id, mode,
external_event_id)` is unique, so a provider that delivers the same event three times is stored
once, and the payload is kept as a SHA-256 hash rather than a body that may hold card data.
`webhook_events_guard_evidence` freezes the identity columns and only lets the status move
forward. 11. **An unverified event never reaches `processed`.** A check ties `signature_ok` to the
states that
mean the platform acted on the event, so a forged delivery can be stored as `rejected` and can
never be processed. 12. **An idempotency key is stored as a hash and scoped to its tenant.** The
unique index is on
`(company_id, scope, key_hash)`, so the same client key in two merchants is two rows while a
replay inside one merchant is one row. `request_hash` records what the first attempt asked for, so
a key reused with a different body is refused by the service instead of paying twice. 13. **A
merchant API credential is hash only, and its signing secret is encrypted.** The API key is
verified by comparing hashes, so `key_hash` and `key_last_four` are all that exist of it; the
webhook signing secret must be used later, so it is stored as AES-256-GCM ciphertext beside its
`last_four`. Two different secrets, two different storages, one rule: nothing is shown in full. 14.
**Rotation is a link, not an overwrite.** `rotated_from_id` is unique, so a credential rotates
once, and revoking sets `revoked_at` and a reason while the row stays readable for the audit log.
15. **A store connection is one row per store.** `(company_id, platform, store_domain)` is unique
while the row is live, the platform is `shopify` or `woocommerce`, and `active` requires
`connected_at`, because section 20 says the connection becomes active automatically after login. 16.
**One TaxCloud connection per merchant.** The unique index on `company_id` where `deleted_at` is
null makes a second connection impossible, both credentials are encrypted with their own masked
tail, and `collection_enabled` requires `status = 'active'`, so tax cannot be collected on
credentials that were never verified. 17. **No token, no card, no plaintext column anywhere.** There
is no column named `key`, `secret`,
`token`, `password` without a hash or ciphertext suffix, no PAN column and no CVV column, which
is section 18 and section 29 in one sentence: the platform never holds card data. 18. **RLS on,
default deny, nothing forced.** STEP 035 grants the merchant its own rows and the office
the platform catalogue.

Out of scope: payments, refunds and disputes (024), the ledger (025), the five adapters, the
registry file, the webhook job, the store plugins, the TaxCloud client, the super admin gateway
screens, the merchant API endpoints, the environment schema, the permissive RLS policies (035),
migrations `0001` to `0028`, every `lib/` and `config/` file.

## 3. The Schema This Produces

### `0029_payment_providers.sql`
- `id`, `company_id` (null: platform catalogue), `provider_key` (`nmi`, `payoneer`, `rainforest`,
  `stripe_connect`, `airwallex`), `display_name`, `supports_acceptance`, `supports_payouts`,
  `supports_submerchant`, `status` (`disabled`, `enabled`), `enabled_at`, `last_tested_at`,
  `last_test_ok`, `last_test_detail` (280 characters), `display_order`, plus the five platform
  columns.
- Unique `provider_key` platform wide; unique `display_order` where `deleted_at` is null.
- Checks: the key vocabulary, a trimmed display name of 1 to 80 characters, at least one capability,
  `(status = 'enabled') = (enabled_at is not null)`, enabled requires `last_test_ok`, and the
  standard version and timestamp checks.

### `0030_provider_keys.sql`
- `provider_id`, `label`, `mode` (`test`, `live`), `key_last_four`, `key_fingerprint`,
  `key_ciphertext`, `key_iv`, `key_tag`, `encryption_key_version`, `status` (`active`, `disabled`),
  `activated_at`, `disabled_at`, `last_tested_at`, `last_test_ok`, `last_test_detail`,
  `last_used_at`, `rotated_from_id`.
- Unique `(provider_id, key_fingerprint)`; unique `(provider_id, mode) where status = 'active' and
  deleted_at is null`; unique `rotated_from_id`.
- Checks: mode vocabulary, four visible characters, 64 lower case hex fingerprint, non-empty
  ciphertext, iv and tag with length bounds, positive key version, active requires a passing test
  and an activation instant, disabled requires its instant, and the standard checks.

### `0031_routing_rules.sql`
- `company_id` (null: platform rule), `rule_name`, `mode`, `priority`, `provider_id`,
  `country_code`, `payment_method` (`card`, `bank_transfer`, `e_wallet`), `min_amount_minor`,
  `max_amount_minor`, `status` (`active`, `disabled`), `disabled_at`.
- Unique `(mode, priority)` and `(mode, lower(rule_name))` where `deleted_at` is null.
- Checks: priority 1 to 999, upper case two letter country, the method vocabulary, a non-negative
  minimum and a maximum at least the minimum, `(status = 'disabled') = (disabled_at is not null)`,
  and no fallback column exists at all.
- Trigger `routing_rules_guard_provider`: the provider must exist (the foreign key), be enabled and
  support acceptance.

### `0032_webhook_events.sql`
- `company_id` (null until the event names its merchant), `provider_id`, `mode`,
  `external_event_id`, `event_type`, `payload_hash`, `signature_ok`, `received_at`, `status`
  (`pending`, `processing`, `processed`, `failed`, `ignored`, `rejected`), `processed_at`,
  `failure_detail`.
- Unique `(provider_id, mode, external_event_id)`, so duplicate deliveries collapse into one row.
- Index on `(status, received_at)` where the status is pending or processing, the job of section 27.
- Checks: the status vocabulary, an unverified event is never `processing` or `processed`, `(status
  = 'processed') = (processed_at is not null)`, `rejected` requires `signature_ok = false`, `failed`
  requires a detail, and the standard checks.
- Trigger `webhook_events_guard_evidence`: the provider, the mode, the external id, the type, the
  payload hash, the received instant and the flag are frozen after insert, and the status may only
  move forward.

### `0033_idempotency_keys.sql`
- `company_id`, `scope` (`payment`, `refund`, `payout`), `key_hash`, `request_hash`, `state`
  (`in_flight`, `completed`, `failed`), `response_status`, `response_body`, `error_detail`,
  `completed_at`, `expires_at`.
- Unique `(company_id, scope, key_hash)`; index on `expires_at` for the cleanup job of section 27.
- Checks: 64 hex hashes, the state and scope vocabularies, completed exactly when `completed_at` is
  set, completed needs a response status in 100 to 599, in flight carries no response, failed
  carries a detail of at most 280 characters, a response body of at most 20000 characters,
  `expires_at` after `created_at`.
- Trigger `idempotency_keys_guard_state`: the tenant, scope and both hashes are frozen, and a state
  never returns to `in_flight`.

### `0034_merchant_api_credentials.sql`
- `company_id`, `label`, `mode`, `key_prefix`, `key_last_four`, `key_hash`,
  `signing_secret_last_four`, `signing_secret_ciphertext`, `signing_secret_iv`,
  `signing_secret_tag`, `encryption_key_version`, `status` (`active`, `revoked`), `revoked_at`,
  `revoke_reason`, `last_used_at`, `rotated_from_id`.
- Unique `key_hash`; unique `(company_id, label)` where `deleted_at` is null; unique
  `rotated_from_id`.
- Checks: the mode and status vocabularies, a lower case key prefix of 2 to 16 characters, four
  visible characters on both secrets, 64 hex hash, non-empty ciphertext, iv and tag, revoked exactly
  when `revoked_at` is set and needs a reason, and the standard checks.
- Trigger `merchant_api_credentials_guard_secret`: the hash, the prefix and the encrypted signing
  secret are frozen after insert, so a credential rotates instead of being rewritten.

### `0035_store_connections.sql`
- `company_id`, `platform` (`shopify`, `woocommerce`), `store_domain`, `external_store_id`,
  `access_token_last_four`, `access_token_ciphertext`, `access_token_iv`, `access_token_tag`,
  `encryption_key_version`, `status` (`pending`, `active`, `revoked`, `error`), `connected_at`,
  `revoked_at`, `last_error`, `last_synced_at`.
- Unique `(company_id, platform, store_domain)` where `deleted_at` is null; index on `(company_id,
  platform)`.
- Checks: the platform and status vocabularies, a lower case domain of 3 to 253 characters with a
  dot and no scheme or slash, non-empty ciphertext, iv and tag, active exactly when `connected_at`
  is set, revoked exactly when `revoked_at` is set, `error` requires `last_error`, and the standard
  checks.

### `0036_taxcloud_connections.sql`
- `company_id`, `api_id_last_four`, `api_id_ciphertext`, `api_id_iv`, `api_id_tag`,
  `api_key_last_four`, `api_key_ciphertext`, `api_key_iv`, `api_key_tag`, `encryption_key_version`,
  `status` (`pending`, `active`, `disabled`), `collection_enabled`, `verified_at`, `last_error`.
- Unique `company_id` where `deleted_at` is null, so one merchant cannot hold two connections.
- Checks: the status vocabulary, non-empty encrypted fields with length bounds, active exactly when
  `verified_at` is set, a disabled connection never collects tax, and the standard checks.

## 4. The Three Sub-Steps

### 023.1 - Inventory, decisions and ownership (this document)
Read sections 6, 7, 8, 20, 27 and 29 and the STEP 022 handoff, measure the twenty eight existing
migrations, fix the schema above, repair the numbering gaps this reading exposed in
`migrations/README.md`, correct the two sentences of the STEP 022 handoff that named the wrong next
STEP, and stop for permission.

### 023.2 - `0029` to `0032`: the provider side
Create `payment_providers`, `provider_keys`, `routing_rules` and `webhook_events` with their
rollbacks, indexes, guards, comments, RLS and policies. Prove the five key vocabulary, the
capability matrix, the refusal of a provider enabled without a passing test, the ciphertext beside
the four visible characters, one active key per mode, the key rotation link, the routing criteria
and priority uniqueness, the guard that refuses a disabled provider, the frozen webhook identity,
the forward only status, the unverified event that can never be processed, the duplicate delivery
that collapses into one row, all thirty-two rollbacks, and the forward files applying again on a
clean database.

### 023.3 - `0033` to `0036`, documentation, verification, commit and handoff
Create `idempotency_keys`, `merchant_api_credentials`, `store_connections` and
`taxcloud_connections` with their rollbacks; then prove section 20 and section 29 end to end: a
merchant credential created, used, rotated and revoked, a store connected and disconnected, a
TaxCloud connection verified and enabled, a key replayed inside one merchant refused while the same
key in a second merchant is accepted, a completed key that cannot return to flight, all thirty-six
rollbacks emptying `public`, and the thirty-six forward files rebuilding it. Patch
`migrations/README.md` and the root README, run `npm run verify`, prove the gate catches a removed
RLS line, a removed `company_id`, an inserted `truncate` and a missing rollback file, mutate each
guard to watch the proof fail, write `docs/handoffs/STEP_023_COMPLETED.md`, commit as "STEP 023:
Migration for payment providers, provider keys, routing rules, webhook events, idempotency keys,
merchant API credentials, store connections and TaxCloud connections tables", push, and stop.

## 5. Files This STEP Owns

| Path | Action | Sub-step |
| --- | --- | --- |
| migrations/0029_payment_providers.sql, .down.sql | created | 023.2 |
| migrations/0030_provider_keys.sql, .down.sql | created | 023.2 |
| migrations/0031_routing_rules.sql, .down.sql | created | 023.2 |
| migrations/0032_webhook_events.sql, .down.sql | created | 023.2 |
| migrations/0033_idempotency_keys.sql, .down.sql | created | 023.3 |
| migrations/0034_merchant_api_credentials.sql, .down.sql | created | 023.3 |
| migrations/0035_store_connections.sql, .down.sql | created | 023.3 |
| migrations/0036_taxcloud_connections.sql, .down.sql | created | 023.3 |
| migrations/README.md (the migrations index) | modified | 023.1, 023.3 |
| README.md (the database section) | modified | 023.3 |
| docs/handoffs/STEP_022_COMPLETED.md (two wrong next-STEP sentences) | corrected | 023.1 |
| docs/planning/STEP_023_SUBSTEP_BREAKDOWN.md | this document | 023.1 |
| docs/handoffs/STEP_023_COMPLETED.md | created | 023.3 |

Not owned here: payments, refunds and disputes (024), the ledger (025), the settlements and payouts
(026), the five adapters and their registry, the payment page, the webhook job and the store
plugins, the TaxCloud client, the super admin gateway screens, the merchant API endpoints, the
environment schema, the permissive RLS policies (035), the file storage adapter (100-105) and every
code STEP.
