// path: services/README.md
# services/

Owner: STEP 001 creates the folder; each feature STEP owns its service.

Domain services hold the business rules and are the only layer allowed to compose several
repositories or providers in one operation: clients, products, invoices, estimates,
recurring invoices, payments, ledger, settlement, payouts, refunds, disputes, billing,
support and company accounting.

Rules:
- A service receives an already authenticated actor and a company scope, never a raw
  request.
- Every mutation writes its audit log entry inside the same transaction as the change.
- Money movements write balanced double-entry ledger rows and carry an idempotency key.
- Heavy work is enqueued for the background worker instead of running inside the request.
