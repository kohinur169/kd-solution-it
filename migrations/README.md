// path: migrations/README.md
# migrations/

Owner: STEP 012-036 and every later STEP that adds a table.

Append-only numbered SQL migrations applied with the Supabase CLI against the project of the
current environment. STEP 012 to STEP 030 created the first fifty six files; `npm run
check:migrations` keeps them honest.

Each row names the objects its file creates. The index count is the number of indexes the
table has once the file has run, the primary key included, so it is what `\d` prints.

| File | What it creates |
| --- | --- |
| 0001_companies.sql | `public.uuid_generate_v7()`, `public.set_row_metadata()`, the `companies` tenant table, its slug index, row level security and the default-deny policy |
| 0002_job_queue.sql | The `job_queue` background work table, its seven indexes, its trigger, row level security and the default-deny policy |
| 0003_users.sql | The `users` sign-in accounts table, its email and company indexes, the TOTP and backup code columns, its trigger, row level security and the default-deny policy |
| 0004_role_assignments.sql | The `role_assignments` grant history table for the seven roles, its two live indexes, its trigger, row level security and the default-deny policy |
| 0005_office_permissions.sql | The `office_permissions` delegated permission table, its three live indexes, its trigger, row level security and the default-deny policy |
| 0006_delegations.sql | The `delegations` approval handover table with its window and scope, two live indexes, its trigger, row level security and the default-deny policy |
| 0007_announcements.sql | The `announcements` table with its draft and publish instants, the published index, its trigger, row level security and the default-deny policy |
| 0008_announcement_dismissals.sql | The `announcement_dismissals` table, its unique pair index, its trigger, row level security and the default-deny policy |
| 0009_device_proof_keys.sql | The `device_proof_keys` enrolled device table with its trust and revoke instants, four indexes including the `(user_id, id)` target of the session key, its trigger, row level security and the default-deny policy |
| 0010_sessions.sql | The `sessions` table with its token hash, family, rotation parent, step-up instants and closed revocation vocabulary, seven indexes, its trigger, row level security and the default-deny policy |
| 0011_login_attempts.sql | The `login_attempts` event record with its factor and outcome vocabularies, the rate limit and counter indexes, its trigger, row level security and the default-deny policy |
| 0012_account_locks.sql | The `account_locks` table with its two hour window, the owner alert and contact instants, the two mutually exclusive closures, the open lock unique index, its trigger, row level security and the default-deny policy |
| 0013_audit_logs.sql | The `audit_logs` append-only hash chain with its per tenant chain, its Ed25519 signature and signing key columns, the seven query indexes, both guard functions and triggers, row level security and the default-deny policy |
| 0014_plans.sql | The `plans` catalogue with its code, price, period and status, its four indexes, its trigger, row level security and the default-deny policy |
| 0015_plan_entitlements.sql | The `plan_entitlements` table, one row per service a plan includes, with its live pair index, its service index, its trigger, row level security and the default-deny policy |
| 0016_pricing_versions.sql | The `pricing_versions` price list with the five fees of section 14 and their payers, its scope, its thirty day announcement check, four indexes, its trigger, row level security and the default-deny policy |
| 0017_subscriptions.sql | The `subscriptions` agreement with its cycle, its five status instants, the seven day warning window, the card mandate consent quartet with its text, version, time and address, four indexes including the one live agreement per merchant, its trigger, row level security and the default-deny policy |
| 0018_subscription_charges.sql | The `subscription_charges` attempt record with its balance and card split, its closed failure vocabulary, the retry key of subscription, period and attempt, four indexes, its trigger, row level security and the default-deny policy |
| 0019_clients.sql | The `clients` table a merchant invoices, with its checked address, its optional tax identifier, four indexes including the email unique per merchant, its trigger, row level security and the default-deny policy |
| 0020_products.sql | The `products` catalogue of goods with its optional SKU, its price in minor units, its currency and unit, four indexes, its trigger, row level security and the default-deny policy |
| 0021_services.sql | The `services` catalogue of work with its optional code, the same money rules as products, the `hour` default unit, four indexes, its trigger, row level security and the default-deny policy |
| 0022_invoices.sql | The `invoices` document with its client snapshot, its seven status values and their instants, its five money columns, the unique number per merchant, the derived total trigger and the paid lock, six indexes, row level security and the default-deny policy |
| 0023_invoice_items.sql | The `invoice_items` lines with their generated line total, their position uniqueness, their optional catalogue references, the tenant pair foreign key, the catalogue guard and the totals sync trigger, four indexes, RLS and the policy |
| 0024_invoice_events.sql | The `invoice_events` append only timeline with its closed event and actor vocabularies, the guard trigger that refuses every update and removal, three indexes, RLS and the default-deny policy |
| 0025_estimates.sql | The `estimates` quote with its client snapshot, its five statuses and the void reason, its derived total, its expiry, the unique number per merchant, the terminal lock, the one conversion link, seven indexes, RLS and the default-deny policy |
| 0026_estimate_items.sql | The `estimate_items` quote lines with their generated line total, their position uniqueness, their catalogue guard and their totals sync trigger, four indexes, RLS and the policy |
| 0027_estimate_signatures.sql | The `estimate_signatures` evidence row with its consent pair, the IP, geo, fingerprint and SHA-256 document hash, one signature per quote, the append only guard and the open-quote guard, three indexes, RLS and the policy |
| 0028_recurring_schedules.sql | The `recurring_schedules` repeating invoice with its draft template, its interval, run dates, terms and reminder policy, the template guard, four indexes, RLS and the default-deny policy |
| 0029_payment_providers.sql | The `payment_providers` platform catalogue: a closed adapter vocabulary, a capability matrix of three booleans, the display order, the connection test and the enable condition, three indexes, RLS and the default-deny policy |
| 0030_provider_keys.sql | The `provider_keys` AES-256-GCM ciphertext with its initialisation vector, tag and key version, the four visible characters, the fingerprint, one active key per provider and mode, the rotation link, the identity guard, five indexes and the policy |
| 0031_routing_rules.sql | The `routing_rules` decision with one provider per rule, a unique priority per mode, the country, method and amount criteria, no fallback column, the enabled provider guard, four indexes, RLS and the default-deny policy |
| 0032_webhook_events.sql | The `webhook_events` delivery keyed by the provider identifier, with the payload hash, the signature result, the forward only status, the evidence guard, four indexes, RLS and the policy |
| 0033_idempotency_keys.sql | The `idempotency_keys` caller key as a hash, unique per tenant and scope, with the request hash, the three states, the replayed answer, the expiry window, the state guard, four indexes and the policy |
| 0034_merchant_api_credentials.sql | The `merchant_api_credentials` key as a hash plus prefix and tail, the encrypted signing secret beside its own tail, the rotation link, the revocation, the identity guard, five indexes and the policy |
| 0035_store_connections.sql | The `store_connections` Shopify and WooCommerce row with its bare lower case domain, its encrypted access token, its install states, the identity guard, three indexes and the policy |
| 0036_taxcloud_connections.sql | The `taxcloud_connections` merchant account with both credentials encrypted, one usable connection per merchant, the on and off collection switch, the credential guard, two indexes and the policy |
| 0037_payments.sql | The `payments` processor transaction with its provider, key, routing rule and unique idempotency key, its amount, fee and generated net, the four card characters, the 3DS capture rule, the risk rule, the status instants, the refund state guard, seven indexes and the policy |
| 0038_refunds.sql | The `refunds` document with its request, approval and processing states, the cap guard against its payment, the sync that writes the payment refunded total and status, four indexes and the policy |
| 0039_disputes.sql | The `disputes` chargeback with its 24 or 48 hour deadline, the evidence flag, the response and its submission, the resolved outcome, the deadline guard, four indexes and the policy |
| 0040_ledger_accounts.sql | The `ledger_accounts` chart with its eight closed codes, the kind and side pairing, the platform and merchant scopes of two partial unique keys, the close instant, the identity guard, three indexes and the policy |
| 0041_ledger_entries.sql | The `ledger_entries` double-entry rows with their balanced group, the deferred balance trigger, the append only guard, the reversal mirror and its one-reversal key, the three source pairs, the invoice sync, six indexes and the policy |
| 0042_settlements.sql | The `settlements` processor batch with its window, its six money parts, the generated net that may be negative, the hold days copied onto the row, the release instant, the four statuses and their instants, the identity guard, five indexes and the policy |
| 0043_holds.sql | The `holds` money the platform keeps back, with its five reasons, its payment and batch links, the cap guard against its payment, the owner guard, the released and collected pairs, the closed hold guard, four indexes and the policy |
| 0044_reserves.sql | The `reserves` rolling reserve with its basis point percent, its release days, the held and released totals bounded by one check, one active reserve per merchant, the release instant, the terms guard, three indexes and the policy |
| 0045_payouts.sql | The `payouts` request with its requester and approver, the generated net, the 100 USD minimum with its remainder exception, the destination snapshot, the failure pair, the unique provider identifier, the closed payout guard, five indexes and the policy |
| 0046_payout_bank_accounts.sql | The `payout_bank_accounts` row with its number as AES-256-GCM ciphertext, its four visible characters and its fingerprint, its five statuses and their instants, one active account per merchant, the identity guard, five indexes, the policy and the `payouts.bank_account_id` column with its composite foreign key |
| 0047_bank_change_requests.sql | The `bank_change_requests` row with its current and requested accounts, its six statuses, the 96 hour cooling check, one open request per merchant, the identity guard, four indexes and the policy |
| 0048_kyc_submissions.sql | The `kyc_submissions` cycle with its method and provider reference, its five statuses, the one open cycle per merchant, the four-eye reviewer pair with its two-people check, the decision instants and reason, the identity guard, five indexes and the policy |
| 0049_kyc_documents.sql | The `kyc_documents` evidence row with its storage key, byte hash, mime type and size, its six document types, the issue instant of the three month rule, the review pair and its rejection reason, the evidence guard, four indexes and the policy |
| 0050_ubo_records.sql | The `ubo_records` owner with its share in basis points, the 25 percent flag tied to the number, the identity document hash, the PEP flag, the sum guard, the identity guard, three indexes and the policy |
| 0051_sanctions_screenings.sql | The `sanctions_screenings` row with its three subject kinds, the four lists, the three results, the case note of a confirmed match, the SAR flag that is never cleared, the identity guard, six indexes and the policy |
| 0052_policy_acceptances.sql | The `policy_acceptances` evidence row with its twelve policy keys, its dotted version, its text hash and its person, one acceptance per merchant, policy and version, the identity guard, three indexes and the policy |
| 0053_review_decisions.sql | The `review_decisions` audit row with its four subject kinds, its six decisions, its reason, its appeal through the tenant key, one appeal per decision, the append only guard that moves the appeal state forward only, five indexes and the policy |
| 0054_submerchant_provisions.sql | The `submerchant_provisions` row that carries the KYC approval, the provider and its key, the mode, the master account, the provider sub-merchant id, the five statuses with their instants, the two flags that wait for verification, the attempt and queue columns, the webhook evidence, four guards that freeze the identity, check the provider and the approval, walk the status forward and verify the sync, five indexes and the policy |
| 0055_card_blacklist.sql | The `card_blacklist` row that blocks a card by the SHA-256 of its token or provider fingerprint, never by a card number, with its source, its provider, its six reasons and the note an other reason needs, its active and released life with the person and the note of a release, the optional payment behind it and the optional expiry, the one active block per fingerprint, the state guard that freezes the block and refuses a soft delete, four indexes and the policy |
| 0056_velocity_counters.sql | The `velocity_counters` row that counts one card or one address in one window, with the address as a real `inet`, exactly one subject, the window start and length with a unique key per subject, the count, the configured limit it applied and the instant it was first breached, the guard that counts up only, never clears a breach and refuses a soft delete, four indexes and the policy |

Every file is paired with `<name>.down.sql`, which undoes exactly what its forward file created and
nothing else.

## Naming
- Forward: 0001_short_description.sql, 0002_short_description.sql, ...
- Rollback: 0001_short_description.down.sql next to its forward file.
- Description: lowercase snake case, ASCII, no spaces.

## Rules

1. A committed migration is never edited; a correction is a new migration.
2. Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with
   row level security enabled and a default-deny policy named `<table>_default_deny`.
3. Every migration is applied and rolled back on a clean database and the result is recorded in
   the handoff file of the STEP that added it.
4. One file is one transaction: the first statement is `begin;`, the last is `commit;`. The
   Supabase CLI runs each file in a transaction of its own, and the explicit pair makes a manual
   `psql -f` atomic too.
5. A forward migration never drops a table, truncates, or deletes rows. Removal of data is an
   operational decision, not a schema change.
6. `id` defaults to `public.uuid_generate_v7()`. PostgreSQL before 18 has no native UUID v7, so
   `0001` defines one; it is `volatile`, it reads `clock_timestamp()`, and it takes its random
   tail from `gen_random_uuid()`.
7. `updated_at` and `version` are maintained by `public.set_row_metadata()`, a before-update
   trigger installed per table. The application still writes `where id = $1 and version = $2`, so
   a stale writer loses; the trigger makes the counter monotonic for anything else that writes.
8. Row level security is enabled and explicitly denied. A STEP that grants access adds a
   permissive policy beside `<table>_default_deny`; it does not remove the deny.
9. No migration creates extensions, roles or schemas. `gen_random_uuid()` is core since
   PostgreSQL 13, and the functions in this folder are schema qualified with an empty
   `search_path` precisely so no extension and no role is needed.
10. The queue table's shape is fixed by the `JobQueue` port in `lib/jobs/queue.ts`, not the other
    way round. Changing a column to suit a store implementation is a design change that starts in
    that port and in a new migration.
11. A role is a row in `role_assignments`, never a column on `users`. A grant is recorded with
    `granted_by`, `granted_at` and `revoked_at`; revoking sets `revoked_at`, it does not delete the
    row, and a later grant of the same role is a new row. The role vocabulary is the seven names in
    FEATURE_LIST.md section 2, and `client` is never one of them because a client cannot sign in.
12. A permission and a delegation scope are dotted keys such as `payout.release`, stored as text
    and checked for shape, not as a new enum per feature. The catalog of what a key means lives in
    the STEP that performs the action; this folder only guarantees the key is well formed.
13. An announcement is a draft until `published_at` is set, and a dismissal is one row per person
    per announcement. The unique index is the rule "a dismissed announcement does not appear again
    for that user", not a cleaner in application code.
14. A session token is stored as a hash, never as the token itself, and one row is one rotation.
    Every rotation of one login shares `family_id`, so ending a family is one statement on that
    column, and a parent may be rotated once: a fork is refused by `sessions_rotation_key` rather
    than by convention. A replay is a revocation with `replay_detected_at` set, never a quiet
    expiry, and the check constraint keeps the two together.
15. A session names a device of its own account. The composite key
    `(user_id, device_proof_key_id)` against `(user_id, id)` on `device_proof_keys` is what makes
    "a cookie works only inside its own session" true in the database and not only in the code that
    writes it.
16. A failed attempt counter is a query, not a column: `login_attempts` records every attempt with
    its factor and outcome, and "two consecutive failures" is counted since the last success. A
    stored counter is a second truth that drifts. An attempt against an address with no account
    stores a hash of the address and never the address, and the two identity columns are mutually
    exclusive.
17. A lock closes one way: an office unlock sets `unlocked_at`, `unlocked_by` and `unlock_note` and
    requires the owner contact to be confirmed first; expiry sets `expired_at` and never before
    `expires_at`. The two are mutually exclusive, the window may not exceed two hours from
    `locked_at`, and one account has at most one open lock.
18. The audit log is append-only and hash chained. A row names its chain through a generated
    `chain_id`, its position through a gapless `sequence` and its predecessor through `prev_hash`;
    the insert guard refuses anything that does not extend the current head, and the second guard
    refuses every update and every removal whatever role asks. The canonical hash string is defined
    once, in `0013_audit_logs.sql`, and a second definition would invalidate every later check.
19. Every audit row is signed. `signature` is the base64url Ed25519 signature over the 32 byte
    hash and `signing_key_id` names the key, so rotating the signing key leaves history verifiable.
    Merkle roots are derived from `chain_id`, `sequence` and `hash` by the export job; no roots are
    stored in the migrations.
20. A plan is the platform catalogue entry: a unique code, a price in minor units with a currency,
    a billing period, and a status that moves from draft to active to retired. The services a plan
    includes are rows in `plan_entitlements`, not columns, so adding a service to a plan is data; the
    catalogue of service keys lives in code and the table only checks their shape.
21. A price list is versioned, not edited. `revision` counts up inside a scope, and `scope_id` is
    generated from `company_id` so the platform list and a merchant override are separate lines. A
    price list announced for a later date must be effective at least thirty days after the
    announcement, every fee names its payer, and percentages are basis points.
22. A subscription is the agreement, not the money. The plan price is never copied onto it: the
    cycle is `current_period_start`, `current_period_end` and `next_due_at`, and every amount lives
    on the charge row that took it. One merchant has one live agreement; the partial unique index
    on `company_id` is what makes a second one impossible, and cancelling sets `cancelled_at` so
    the old agreement stays as history. Saving a card is an explicit consent: the text, its
    version, the instant and the address are recorded together or not at all, and warnings are
    refused earlier than seven days before the due date.
23. A charge attempt is a row, so a retry is a new row keyed by subscription, period and attempt
    number rather than an edit. Section 12 charges the merchant balance first and the saved card
    second, and the split column keeps that visible: a succeeded charge adds up to the amount, a
    failed or pending one took nothing. A failure names its cause from a closed vocabulary and its
    detail is at most 280 characters, so no card number can be written there.
24. A catalogue row is soft deleted, never removed. Clients, products and services all point at
    history: an invoice written last year must still explain the client it was sent to and the item
    it sold, so `deleted_at` marks the row and the partial unique index stops counting it, which is
    what lets a mistyped address, SKU or service code be entered again. Uniqueness is per merchant
    and on `lower(...)`, never platform wide and never case sensitive.
25. A product and a service are separate tables with one money rule. Both store `unit_price_minor`
    in minor units beside a three letter currency, both refuse a negative price and accept zero, and
    both draw `unit` from the same closed list because the invoice prints the quantity and the word
    together. A product identifies itself by a SKU and defaults to `item`; a service identifies
    itself by a code and defaults to `hour`.
26. An invoice is a document, not a view of other tables. It snapshots the client name, email and
    address when it is issued, its lines snapshot the description, unit and price, and its number is
    assigned at issue rather than at creation, so a draft never burns one. `total = subtotal -
    discount + tax` is derived by a trigger and stated again by a check, and the status carries its
    own facts: paid exactly when the paid instant is set, void exactly when the voided instant is
    set, and a paid invoice that the guard trigger holds shut against every change.
27. A line is arithmetic defined once and a timeline is evidence. `line_total_minor` is a generated
    column, an item trigger keeps the parent subtotal equal to the sum of the live lines and refuses
    any line change on an invoice that has left draft, and `invoice_events` refuses every update and
    every removal, so what a dispute pack reads months later is what happened. Both child tables
    point at their invoice through `(invoice_id, company_id)`, so no row can join another merchant's
    document.
28. A quote is a document that ends in a decision. It snapshots its client and its lines like an
    invoice, derives its total the same way, and states its own expiry; `accepted` and `void` are
    terminal and a guard trigger holds them shut. Section 16 folds a decline and an expiry into
    `void`, so `void_reason` carries which one happened, and acceptance is written once together
    with the invoice it becomes, because the same statement that decides a quote freezes it.
29. A signature is evidence and a schedule is a promise. Every element section 16 names sits on the
    signature row, the consent pair cannot be false, the document hash is 64 lower case hex
    characters, one quote takes one signature, and nothing may update or remove the row. A recurring
    schedule points at a draft invoice as its template rather than a second catalogue of lines,
    states its interval and run dates in columns, and has no retry or attempt column at all, because
    section 16 says a failed recurring payment is not retried automatically.
30. A provider is a catalogue row and a key is ciphertext. `payment_providers` holds the closed
    vocabulary of the five section 6 adapters, a capability matrix of three booleans, and an
    `enabled` state that a passing connection test alone permits. `provider_keys` holds the
    AES-256-GCM ciphertext of a key with its vector, its tag and its key version, and nothing but
    four visible characters, so one active key per provider and mode is what makes rotation the
    section 29 procedure of add, test, activate, disable. A routing rule names exactly one provider,
    its priority is unique per mode, and there is no fallback column anywhere, because section 6
    rejects a payment no rule matches instead of sending it somewhere else.
31. A credential is a hash and a secret is ciphertext. `merchant_api_credentials` keeps the API key
    only as a SHA-256 with its visible prefix and tail, and encrypts the webhook signing secret
    because it must be read back; `store_connections` and `taxcloud_connections` encrypt their
    tokens the same way, all three refuse new ciphertext under an unchanged key version, and a
    revoked row stays revoked. `idempotency_keys` keeps the caller key as a hash, unique per tenant
    and scope, with the answer a retry replays and a guard that never reopens a decided key.
    `webhook_events` is keyed by the provider own identifier, keeps only the payload hash, and lets
    an unverified delivery live as `rejected` but never as `processed`.
32. A payment is one processor transaction with a route. It names the provider, the key, the routing
    rule and the idempotency key, and the key is unique, so the second delivery of a request cannot
    write a second payment. `net_minor` is generated from the amount and the fee, the only card
    columns are the brand and four digits, and section 18's two operational rules are checks: a
    capture without 3DS needs the postal code and the IP country to match, and a fraud rejection can
    only sit on a failed payment.
33. A refund is capped by its payment and a dispute is a deadline. The refund guard sums the live
    refunds and refuses one that would take the total above what was charged, its sync writes the
    payment refunded total and status so nobody types them, and a refund is cancelled or failed
    rather than removed. A dispute states its opening instant, its 24 or 48 hour window and its due
    date, cannot be submitted without its evidence pack, and cannot reopen once resolved.
34. A chart of accounts is eight closed codes, not free text. `ledger_accounts` accepts only the
    codes section 11 names, pairs each kind with its normal side, and scopes them with two partial
    unique keys so the platform chart holds one row per code while a merchant may repeat a code
    inside its own chart. A closed account carries its instant and cannot reopen, its code, kind,
    side and owner never change, and a soft deleted row frees its code for a fresh one.
35. A money movement is a balanced group and a posted entry never changes. `ledger_entries` names
    its movement through `entry_group_id`, and a deferred constraint trigger sums that group at
    commit and refuses anything but equal debits and credits in one currency for one merchant, so a
    half posted movement cannot commit. Every update and every removal is refused by the append only
    guard, so a correction is a reversal: the mirror guard requires the opposite side, the same
    amount, the same currency and merchant, in a group of its own, and the unique index allows one
    reversal per entry. The payment, refund and dispute links are pairs of a source type and a
    foreign key, and the payment post writes the invoice paid total and state that STEP 024 left to
    this STEP.
36. A settlement is a batch and a hold is money kept back. `settlements` carries the window, the
    gross and the five deductions, and its net is generated so the batch cannot disagree with its
    parts; the net may be negative because section 10 covers a negative balance from the reserve
    first. The hold days are copied onto the row with the release instant, so a setting changed
    tomorrow cannot move a batch already in flight, one processor batch is booked once per merchant,
    and a settled or failed batch is history. `holds` names its payment and its batch, takes a
    reason from the five causes the statement groups by, never takes more than its payment through a
    guard that sums the live holds, and closes one way: released with its instant and its person, or
    collected with its instant, its person and the note section 10 needs.
37. A reserve is one account and a payout is a request with a decision. `reserves` stores the
    percent in basis points beside the release days, keeps one active row per merchant, bounds the
    released total by the held total, and freezes its terms for the life of the row. `payouts` names
    who asked and who approved with their instants, refuses processing or payment without an
    approval, refuses an amount under the 100 USD minimum unless it is the accumulated remainder,
    requires the destination snapshot on a paid payout, requires a code and a detail on a failed
    one, and freezes the row once it is paid, failed or cancelled.
38. A bank account is ciphertext and a life. `payout_bank_accounts` stores the account number as
    AES-256-GCM ciphertext with its vector, its tag and its key version, four visible characters and
    a SHA-256 fingerprint, and never a plain number in any column. The row walks pending, verified,
    active and then rejected or retired, one account is active per merchant through a partial unique
    index, the same fingerprint cannot be live twice, and a guard freezes its identity. The payouts
    table gains `bank_account_id` through the composite key, so a payout cannot name another
    merchant's account.
39. A bank change is 96 hours or it is not a change. `bank_change_requests` names the account in use
    and the account asked for, who asked and who verified, and it refuses a cooling instant that is
    not exactly the verification instant plus 96 hours. A rejected request carries no cooling
    instant at all, an activation cannot precede the end of the cooling, one request is open per
    merchant, and the closed row is history.
40. A KYC submission is a cycle and its evidence is a row. `kyc_submissions` keeps one open cycle
    per merchant through a partial unique index, records the method that ran with the provider
    reference of that method, and refuses a decision without its instant, a rejection without its
    reason and a four-eye decision without a second, different reviewer. `kyc_documents` keeps the
    storage key, the SHA-256 of the bytes, the mime type and the size rather than a file, requires
    the issue instant the three month rule of a utility bill needs, and freezes the key and the
    bytes after upload. `ubo_records` keeps the share in basis points, ties the 25 percent flag to
    the number, and a trigger refuses owners that add up to more than 10000 basis points.
41. A screening is four lists and a result, and a decision is history. `sanctions_screenings` records
    which of the OFAC, United Nations, European Union and United States lists ran, requires at least
    one of them, requires the case note of a confirmed match and never clears the SAR flag once it
    is raised. `policy_acceptances` keeps one row per merchant, policy and version with the hash of
    the accepted text, so a consent is provable and a new version is a new row. `review_decisions`
    is append only, names its subject, its person, its instant and its reason, and points at the
    decision it appeals through the tenant key; an overturn or an uphold is legal only on an appeal,
    one appeal per decision, and the appeal state moves none, open, upheld or overturned and no
    further.
42. A sub-merchant is provisioned once per merchant and provider, and its row is a life. The KYC
    approval is a composite foreign key, so only an approved submission of the same merchant can
    provision, and the provider is checked as platform level, able to create sub-merchants and
    enabled before an attempt. A pending row with no master account is the queued case of section
    5; the reference may be filled once and never changed, charges and payouts are legal only on a
    verified row, the five statuses walk forward to a closed row, and a sync must name a processed
    webhook event with a good signature of its own provider.
43. A card is blocked by a hash and counted in a window. `card_blacklist` keeps the SHA-256 of
    the token or the provider fingerprint with the source that says which, never a card number,
    expiry, CVV or clear token; the block is the platform's, it carries a closed reason, it is
    released once with its person, its instant and its note, a released row is history, and no
    row is soft deleted, because a delete would drop a block off the list without a release and
    would free a counter's window for a fresh count of zero.
    `velocity_counters` counts one card or one address in one window, the subject is exactly one
    of the two columns and the address is a real `inet`, the window is unique per subject, the
    configured limit that applied is stored beside the count and the breach, and the guard counts
    up only, never clears a breach and refuses a soft delete. Old windows leave by the physical
    delete of STEP 067's sweep. The defaults live in `config/`, not in a migration.
44. Numbering is contiguous from 0001. A migration is never renumbered after it has been applied
    anywhere.

## Commands

```bash
npm run check:migrations                      # the static gate, also part of npm run verify
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_companies.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_companies.down.sql
```

Apply forward in ascending order and roll back in descending order. `ON_ERROR_STOP=1` matters:
without it `psql` keeps going after a failed statement and reports success for the file.

## What the gate checks

`migrations/verify.ts` reads every file and refuses: a name outside `NNNN_lower_snake.sql`, a gap
or a duplicate in the numbering, a forward file without its rollback (and the reverse), a missing
path comment, a body without the `begin;`/`commit;` pair, non ASCII text, a forward file that
drops or deletes, a created table that misses one of the six required columns, an `id` default
that is not the shared UUID v7 function, a table without `enable row level security` and its
`<table>_default_deny` policy, a default-deny policy that does not refuse reads and writes alike,
a required column that is missing (the parser reads a column only where a name is followed by a
type, so the wrapped body of a constraint is never mistaken for one), and a rollback that does not
drop the tables its forward creates.

It is static, so it needs no database. Whether the SQL actually applies is proven by running it:
STEP 012 recorded a forward apply, a data level proof of every constraint and both rollbacks on
PostgreSQL 16.2 in `docs/handoffs/STEP_012_COMPLETED.md`.
