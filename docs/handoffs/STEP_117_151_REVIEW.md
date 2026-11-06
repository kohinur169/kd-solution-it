# STEP 117-151 review

## Scope and verification

The review ran the full `npm run verify` chain, the invoice and estimate core gates (previously absent from that chain), and inspected the NMI protocol and selected payment, ledger, settlement and reconciliation paths. The invoice and estimate core gates are now included in `npm run verify`. These automated checks and this targeted review are not an exhaustive line-by-line security or financial audit of every STEP. No live NMI sandbox, PostgreSQL concurrency, browser, or deployed-environment test was performed.

## Corrections

- NMI Classic API: correct sandbox and production URLs, private `security_key`, Collect.js `payment_token`, `auth`, `transactionid`, form-encoded response fields, and approval mapping. The HTTP transport is asynchronous and refuses redirects. Unknown outcomes must be reconciled before a retry. Credential roles and official reference links are in `docs/final/PROVIDER_DOCS.md`. The prior STEP 149-151 handoffs describe the earlier implementation and are superseded by this review. Local customer IDs are rejected rather than mistaken for NMI vault IDs. This change breaks the old synchronous transport interface; consumers must await the result, provide an async transport if overriding it, and verify existing key configurations.
- Correct 100 USD payout minimum to the shared four-decimal money scale and add a cross-module assertion.
- Include method and country in payment idempotency comparison, reject empty keys, and avoid compound-key collisions in the in-memory store.
- Reject repeat ledger group IDs and invalid posting sides in the service; do not treat a rejected reserve draw as covered.
- Require maturity for direct settlement and reserve releases, validate hold durations and basis-point inputs, and honor rejected ledger postings.
- Reconciliation now rejects duplicate processor IDs and reports a type mismatch instead of a false match.

## Important unresolved risks: not production-ready

1. Several payment-core implementations are in-memory reference stores, not persistent transactional services. Ledger group insertion, reversal, payment idempotency, hold/release, reserve draw, and payout execution lack a demonstrated atomic database transaction / concurrency guarantee. A lookup followed by individual inserts cannot provide exactly-once behavior under competing requests or failures. Payout execution lacks a demonstrated provider idempotency contract. Do not execute real payments or payouts until these are designed and tested against the database and providers.
2. Settlement and reserve accounting currently pass account-code strings as account IDs; settlement hold and release debit and credit the same `merchant_payable` account. These placeholders do not establish a separate held balance, do not implement production account-ID resolution, and cannot guarantee funds are unavailable for payout. A correct chart, atomic accounting and payout eligibility integration are required.
3. NMI HTTP integration has only mocked tests, not a real sandbox transaction or end-to-end hosted-field page. Verify public/private key provisioning, approved/declined/capture/refund/void responses and reconciliation with NMI before production use. Unknown transport outcomes must never be blindly retried. API routes, persistence, and payment idempotency are not wired to this transport.
4. Reconciliation lookup is supplied by the caller and has no explicit provider parameter; the caller must scope it to the report's provider and period. Cross-provider uniqueness and duplicate system records need a durable design.
5. The STEP 124 handoff records a database minimum-partial-payment constraint weaker than the application rule. Database enforcement, a real migration test, and integration with the payment flow remain necessary.
6. Earlier handoffs note missing scheduler/email integrations and live infrastructure checks. Those omissions have not been independently closed by this review. Historical claims of completion and green gates are not evidence of production readiness.

## Ledger atomic-batch follow-up

Preflight found the existing STEP 132/133/134 ledger gates passing, but `postLedgerEntries` and `reverseLedgerGroup` still wrote rows one at a time. They now use a single `LedgerEntryStore.insertGroup` operation, which must either store the entire group or return false without writing. The in-memory store materializes the batch before changing its indexes, rejects duplicate groups/entries/reversals and unbalanced or cross-tenant groups, and stores immutable copies. The balance gate uses a read-only corruption fixture rather than bypassing the writer. Existing fee, hold, reserve and negative-balance gate behavior remains intact.

The ledger posting and reversal gates now exercise store-level conflicts, failure before insertion, duplicate IDs, duplicate reversals, and unchanged originals. The full verify chain was run, and the updated targeted gates, typecheck and lint passed. This changes the `LedgerEntryStore` interface: any other implementation must provide an atomic `insertGroup` instead of individual `insert` calls.

**Still incomplete:** this synchronous in-memory implementation is not a PostgreSQL transaction, durable storage, or a multi-process concurrency proof. A real database adapter needs an asynchronous atomic transaction or single secured database operation, with simultaneous duplicate-group and reversal tests, rollback tests, tenant authorization, and audit integration. No PostgreSQL server or isolated database was available here; no migration was added or applied. The other unresolved risks above remain unchanged. Do not use this as evidence that payments, settlements, or payouts are production-ready.
