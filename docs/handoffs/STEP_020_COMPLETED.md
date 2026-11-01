// path: docs/handoffs/STEP_020_COMPLETED.md
# STEP 020 Completed - Handoff

## STEP
- Number and title: STEP 020 - Migration for clients, products and services tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger and the gate conventions) and STEP 019 (the migrations
  index, the rule that a price list is versioned rather than copied, and the proof harness this STEP
  reuses). STEP 021 creates `invoices`, `invoice_items` and `invoice_events` and points at the client
  and the catalogue rows this STEP adds; STEP 022 will point estimates at the same clients. The owner
  asked for five sub-steps with one approval between each, and the plan is
  `docs/planning/STEP_020_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0019_clients.sql and 0019_clients.down.sql - the clients a merchant invoices, with a
    checked postal address, an optional tax identifier, three indexes including the email unique per
    merchant, trigger, RLS and default-deny policy.
  - migrations/0020_products.sql and 0020_products.down.sql - the goods catalogue with an optional
    SKU, a price in minor units, a currency and a unit, three indexes, trigger, RLS and policy.
  - migrations/0021_services.sql and 0021_services.down.sql - the work catalogue, the same money
    rules with a `code` instead of a SKU and `hour` as the default unit.
  - docs/planning/STEP_020_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_020_COMPLETED.md.
- Modified:
  - migrations/README.md - three inventory rows and two new rules: a catalogue row is soft deleted
    and unique per merchant on `lower(...)`, and a product and a service are two tables with one
    money rule and one closed unit vocabulary. The numbering rule moved from 24 to 26.
  - README.md - the database section describes the client table, its all-or-nothing address, and the
    two catalogues with their shared money rule, directly above the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0018`, every
  `lib/` module, `config/`, the environment contract, invoices (021), estimates (022), the CSV import
  job and its row-by-row report, the client and product screens, the permissive RLS policies (035),
  the tax engine and every code STEP. `package.json` is untouched because the migrations gate already
  covers new files.

## Database
- Migrations added (file names): `0019_clients`, `0020_products` and `0021_services`, each with its
  `.down.sql`. Together they create three tables, 42 columns, 40 constraints, twelve indexes and 45
  comments. The schema now holds twenty one tables, twenty one policies, twenty two triggers and four
  functions in `public`.
- Shape per table: `clients` 18 columns, 18 constraints, four indexes, nineteen comments;
  `products` 12 columns, 11 constraints, four indexes, thirteen comments; `services` 12 columns, 11
  constraints, four indexes, thirteen comments.
- Money is `bigint` minor units with the three letter currency on the row; both catalogue tables
  default the currency to `USD` because section 16 fixes the display currency, and both accept a zero
  price because a complimentary line is still an invoice line.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All twenty one
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog reported 0
  public tables, 0 policies, 0 triggers and 0 functions in `public`, and the twenty one forward files
  applied again to a second empty database, recreating exactly twenty one tables, twenty one policies
  and twenty two triggers with no rows left behind. The environment has no Docker and no Supabase
  CLI, so the server was a real PostgreSQL 16.2 started locally from the `pgserver` wheel with
  `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs seeded synthetic client names, street
  addresses, SKUs, service codes and prices in throwaway local databases, and no real person, card,
  token or provider value was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three scripts ran against the local PostgreSQL 16.2 with 40, 37 and 29 checks; all passed and each
ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0021` applied in order and produced twenty one tables, twenty one
   policies and twenty two triggers.
2. **Every table shape holds.** `clients` reported 18 columns and 18 constraints, `products` and
   `services` 12 and 11 each, every table four indexes, RLS on, one policy and one trigger, and the
   comments were counted as nineteen and thirteen and thirteen, so every column is documented.
3. **A client opens with its address and its identifier.** A full row stored with version 1, no
   delete marker, the street, the city, the country and the tax identifier read back exactly as
   typed, and a client with no contact and no address is allowed.
4. **One address per merchant, case insensitively.** `DANA@Example.com` for the merchant that already
   held `dana@example.com` was refused by `clients_email_key`, while the second merchant stored the
   same person independently.
5. **The address is all or nothing.** A city with no street line and a country with no street line
   were both refused by `clients_address_complete_check`.
6. **Every client field is bounded.** A blank name, a padded name, a name of 121 characters, a padded
   business name, an address without an at sign, a padded address, an address of 255 characters, a
   phone with letters, a country in lower case, a country of three letters, a postal code of two
   characters, a padded city, notes of 2001 characters and a tax identifier of 33 characters were
   each refused by name.
7. **Editing and listing.** An edit moved the version to 2 through the trigger, the paginated list
   returned the newest row first, and the planner answered the page from `clients_page_idx` with
   sequential scans disabled.
8. **A deleted client is history.** The soft deleted row stayed readable, and the same address became
   available for a new client.
9. **A product carries its money.** A product stored its price, defaulted to `USD` and to the unit
   `item`, and a row with only a name and a price took both defaults.
10. **One SKU per merchant, case insensitively.** `desk-oak-01` against `DESK-OAK-01` was refused by
    `products_sku_key`, the second merchant reused the same SKU, and two products were allowed to
    have no SKU at all.
11. **Every product field is bounded.** A blank, padded or 161 character name, a SKU with a space, a
    SKU starting with a dot, a SKU of 49 characters, a negative price, a lower case currency, a two
    letter currency, a unit outside the vocabulary, a padded unit word, a description of 2001
    characters and a padded description were each refused by name.
12. **All seven unit words are accepted**, and a price edit moved the version to 2.
13. **Products page and delete.** The planner answered the list from `products_page_idx`, a deleted
    product stayed readable, and its SKU became available again.
14. **A service carries its money and its own default.** A service stored its price, its currency and
    the unit the merchant chose, a row with only a name and a price defaulted to `USD` and `hour`, and
    the seven unit words were accepted.
15. **One service code per merchant.** A repeated code in another case was refused by
    `services_code_key`, the second merchant reused it, and a soft delete released it for a new
    service while the deleted row stayed readable and left the list.
16. **Every service field is bounded.** A blank and a padded name, a code with a slash, a negative
    price, a lower case currency, a unit outside the vocabulary and a description of 2001 characters
    were each refused by name.
17. **Each merchant sees only its own world.** One query returned one client, the products and the
    services of the first merchant and one client and the services of the second, and the second
    merchant's client was not reachable from the first.
18. **One query prices a line from each catalogue in minor units.** Two oak desks at 249.00 and three
    design days at 120.00 summed to `2 * 24900 + 3 * 12000` with no float anywhere.
19. **Row level security.** A plain role saw zero clients, zero products and zero services and could
    not insert a service, while the owner saw its own rows on all three tables.
20. **Rollback and re-apply.** The twenty one rollbacks emptied the `public` schema completely and the
    twenty one forward files rebuilt it on a second database with no rows.

## Verification
- `npm run check:migrations`: `migrations gate passed: 633 checks, 21 migrations, 21 tables, every
  forward file transactional and default-deny` (573 after the client table, 603 after products; 543
  before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from `0019`
  ("table clients must enable row level security in this file"), removing `company_id` from `0020`
  ("table products is missing the required column company_id"), inserting a `truncate` into `0021`
  ("a forward migration never drops or deletes rows") and moving `0020_products.down.sql` away ("has
  no rollback file").
- Behaviour mutation probes, each restored afterwards and each run against the proof that exercises
  the rule: weakening `clients_address_complete_check` to `true` made the client proof report
  "a city with no street line :: the write succeeded"; replacing the product unit vocabulary with a
  length check made the product proof report "a unit outside the vocabulary :: the write succeeded";
  and dropping `unique` from `services_code_key` made the cross-table proof report the index
  definition and "the same service code twice in one merchant, in another case :: the write
  succeeded".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 633 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII (checked with
  `grep -c '[^ -~]'`).

## Errors Found And Corrected In This STEP
1. **A constraint count written before it was measured.** The client table was expected to carry
   three indexes and carries four, because the primary key is an index too; the expectation was
   corrected rather than the schema. The same mistake appeared once on products and once on services
   and was corrected the same way.
2. **A case sensitive search for a catalogue definition.** The unique index assertion looked for
   lowercase `unique` inside `indexdef`, which returns `CREATE UNIQUE INDEX` in upper case; the
   assertion now matches the real catalog text.
3. **A multi statement call through the extended protocol.** A planner probe sent `begin`, `set
   local` and `explain` as one statement and psycopg refused it ("cannot insert multiple commands into
   a prepared statement"); the probe now sets the GUC on the session, runs one `explain` and restores
   the setting.
4. **Rows counted across tenants.** Two owner counts forgot that the proof inserts rows for a second
   merchant; the expectations were corrected to twelve products and four services for the first
   merchant and the reasons were written into the labels.
5. **A mutation probe that proved nothing at first.** The first two behaviour mutations were run
   against the cross-table proof, which does not exercise the address rule or the product unit
   vocabulary, so both passed unchanged; each mutation is now run against the proof that covers it,
   and all three fail as they should.

## Decisions And Limits Left For Later STEPs
- A product and a service are separate tables. STEP 021 stores a snapshot of the name, the unit and
  the price on every invoice line, so a line points at either table through one nullable foreign key
  per kind rather than through a shared polymorphic id.
- `unit` is a closed list of seven words. A merchant that needs another word gets a migration; that is
  deliberate, because the invoice prints the word beside the quantity and a free text unit would drift.
- Clients are not users. A client has no login of its own, only the tokenized links of sections 16 and
  25, so this table holds contact data and never a credential.
- Deletion is soft everywhere in this STEP. The STEP that builds the delete flows must set
  `deleted_at` and must not remove a row that an invoice points at.
- The CSV import of section 15 is row by row behaviour, not a table: it reads and writes these three
  tables and reports its own failures. No import batch table is created here.
- `tax_id` is a stored identifier, not a tax decision. The TaxCloud STEP of section 7 reads it and
  writes the tax line on the invoice and the payment.
- RLS stays default-deny until STEP 035 grants the merchant its own clients and catalogue and the
  office the whole list.

## Next Chat Notes
- Next in this category is STEP 021 (invoices, invoice items and invoice events). It references
  `clients(id)` and must carry its own snapshot of the client name and address on the invoice, because
  a client may be edited after an invoice is sent and the sent document must not change.
- The unique indexes are partial and use `lower(...)`. A query that filters `company_id` and `email`
  without `deleted_at is null` will not use `clients_email_key`, and an upsert written against it must
  repeat the predicate.
- The list indexes end with `id desc` on purpose: without the tie breaker two rows created in the
  same millisecond can swap places between pages.
- `unit_price_minor` is a minor unit `bigint` on both catalogue tables and zero is legal. An invoice
  line must multiply a quantity by it in `numeric` or with an explicit rule, never in a float, and the
  rounding decision belongs to STEP 021.
- `currency` defaults to `USD` but is stored per row. A cross currency invoice is a decision for a
  later STEP; nothing here assumes two rows share a currency.
