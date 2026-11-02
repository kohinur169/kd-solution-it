// path: docs/final/STEP_PLAN_250.md
# KD SOLUTION IT - 250 STEP Chat Plan

## How this plan is used
- This plan, docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md stay inside the
  GitHub repository. The owner opens each new coding chat with this repository selected,
  so the agent can read and verify the full plan and the complete project scope by itself.
- The owner writes only one line in each new chat: Implement STEP NNN.
  Example: Implement STEP 001.
- The agent then reads FEATURE_LIST.md and MASTER_PROMPT.md in full, finds STEP NNN below,
  reads the previous handoff file, implements only that STEP, runs typecheck and lint,
  commits with the message "STEP NNN: title", pushes, and creates
  docs/handoffs/STEP_NNN_COMPLETED.md before the chat ends.
- One chat finishes exactly one STEP. STEP N+1 never starts before the handoff of STEP N exists.

## Production Gate for Every STEP
Every STEP follows the Production Readiness Rules in docs/final/MASTER_PROMPT.md:
typecheck, lint and build must pass; migrations must prove rollback; money flows must
prove balanced ledger entries; provider work must prove a sandbox cycle; new environment
variables must be added to .env.example. The handoff file of each STEP records these proofs.

## Coverage Map (feature list section to STEP range)
- Platform Foundations: STEP 001-011. Application Security Core: STEP 056-067.
- Database Schema and RLS foundation: STEP 012-036 (completed and immutable).
- Merchant risk-policy scope (FEATURE_LIST section 34): new forward-only schema parts in STEP 081, 084, 092 and 181, plus workflows in STEP 090-095, 136-144, 170-175, 249 and final review in STEP 250. Completed STEPs 001-080 are not modified.
- Roles, Permissions, Office Dashboards and Announcements: STEP 068-078.
- Authentication, 2FA, Login Lock and LR-022 Sessions: STEP 037-055.
- Merchant Onboarding, Processor KYB, optional IDV, Underwriting, Risk Tiers, Sanctions, Re-KYC and Sub-Merchant Provisioning: STEP 079-099.
- File Storage Layer: STEP 100-105.
- Clients, Products, Import, Invoices, Estimates, Recurring and Statements: STEP 106-126.
- Payment Core, Double-Entry Ledger, Risk Limits, Fulfilment-Gated Settlement, Reserve, Payout and Reconciliation: STEP 127-146.
- Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex): STEP 147-169.
- Optional supplementary identity verification adapters (Jumio, Didit, Sumsub): STEP 170-175.
- Sales Tax Collection with TaxCloud: STEP 176-180.
- Client Portal, Payment Pages and Payment Links: STEP 181-190.
- Refunds, Disputes and Evidence Packs: STEP 191-199.
- Public API, Test Mode and Store Plugins (Shopify, WooCommerce): STEP 200-211.
- Plans, Entitlements and Subscription Billing: STEP 212-220.
- Email System, Support and Status Page: STEP 221-230.
- Public Website, CMS and Blog: STEP 231-238.
- Company Accounting and Operations Metrics: STEP 239-243.
- Performance, Deployment and Launch Verification: STEP 244-250.
- Background Jobs: the queue, worker and scheduler foundation is STEP 011. Every feature
  STEP that needs a job registers it on that foundation. STEP 249 verifies all schedules,
  including daily screening, re-KYC, volume-spike, tier-limit and fulfilment-gated payout jobs.

## File Ownership Rules (applies to all 250 STEPs, no exceptions)
- Foundation STEPs 001-011 own root configuration, config/ and lib/ foundation files.
- Database STEPs 012-036 own only their numbered migration files in migrations/. New policy-related migrations are owned only by the explicitly named, still-uncompleted domain STEPs 081, 084, 092 and 181; each appends a new migration and rollback after inspecting the current migration inventory. No completed migration is edited.
- Auth STEPs 037-055 own app/(auth)/, app/api/auth/ and lib/auth/.
- Security STEPs 056-067 own lib/security/.
- Office STEPs 068-078 own app/(admin)/ and office components.
- Onboarding and KYC STEPs 079-099 own app/(dashboard)/onboarding/, services/kyc/ and services/submerchant/.
- Storage STEPs 100-105 own lib/storage/.
- Business STEPs 106-126 own services/clients/, services/products/, services/invoices/ and invoice components.
- Payment Core STEPs 127-146 own lib/payments/ core files (types, registry, routing, ledger, settlement), never adapter files.
- Adapter STEPs 147-169 own exactly one file each under lib/payments/adapters/ plus their provider components.
- Supplementary IDV Adapter STEPs 170-175 own lib/kyc/adapters/ and supplementary identity-provider settings.
- TaxCloud STEPs 176-180 own lib/tax/ and tax settings.
- Portal STEPs 181-190 own app/(client-portal)/ and payment components.
- Refund and Dispute STEPs 191-199 own services/refunds/ and services/disputes/.
- API and Plugin STEPs 200-211 own app/api/public/, lib/api/ and the plugin source folders.
- Plan and Billing STEPs 212-220 own services/billing/.
- Email, Support and Status STEPs 221-230 own lib/email/, services/support/ and app/(public)/status/.
- Public Website STEPs 231-238 own app/(public)/ and CMS components.
- Company Accounting STEPs 239-243 own services/company-accounting/ and finance operations screens.
- Performance and Deploy STEPs 244-250 own deployment configuration and docs/deploy/.
- Shared files (package.json, lib/payments/registry.ts after STEP 128, migrations index,
  docs/final/PROVIDER_DOCS.md) change only inside their owning STEP listed above.
  docs/final/PROVIDER_DOCS.md is created by STEP 147 and extended only by adapter STEPs.

## Foundation and Configuration

### STEP 001: Create repository folder structure for app, lib, services, components, config, migrations and docs
Chat line: Implement STEP 001 only: Create repository folder structure for app, lib, services, components, config, migrations and docs. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 001: Create repository folder structure for app, lib, services, components, config, migrations and docs", push, and create docs/handoffs/STEP_001_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Create repository folder structure for app, lib, services, components, config, migrations and docs.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 002: Add TypeScript strict configuration and path aliases
Chat line: Implement STEP 002 only: Add TypeScript strict configuration and path aliases. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 002: Add TypeScript strict configuration and path aliases", push, and create docs/handoffs/STEP_002_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add TypeScript strict configuration and path aliases.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 003: Add Tailwind configuration with central design tokens
Chat line: Implement STEP 003 only: Add Tailwind configuration with central design tokens. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 003: Add Tailwind configuration with central design tokens", push, and create docs/handoffs/STEP_003_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add Tailwind configuration with central design tokens.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 004: Add environment variable schema with boot-time validation
Chat line: Implement STEP 004 only: Add environment variable schema with boot-time validation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 004: Add environment variable schema with boot-time validation", push, and create docs/handoffs/STEP_004_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add environment variable schema with boot-time validation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 005: Add central application config file with typed exports
Chat line: Implement STEP 005 only: Add central application config file with typed exports. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 005: Add central application config file with typed exports", push, and create docs/handoffs/STEP_005_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add central application config file with typed exports.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 006: Add English string catalog structure lib/i18n/strings/en.ts
Chat line: Implement STEP 006 only: Add English string catalog structure lib/i18n/strings/en.ts. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 006: Add English string catalog structure lib/i18n/strings/en.ts", push, and create docs/handoffs/STEP_006_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add English string catalog structure lib/i18n/strings/en.ts.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 007: Add structured logger with request context and redaction
Chat line: Implement STEP 007 only: Add structured logger with request context and redaction. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 007: Add structured logger with request context and redaction", push, and create docs/handoffs/STEP_007_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add structured logger with request context and redaction.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 008: Add global error response format and error code catalog
Chat line: Implement STEP 008 only: Add global error response format and error code catalog. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 008: Add global error response format and error code catalog", push, and create docs/handoffs/STEP_008_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add global error response format and error code catalog.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 009: Add lint rules for strict typing and English-only source guard
Chat line: Implement STEP 009 only: Add lint rules for strict typing and English-only source guard. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 009: Add lint rules for strict typing and English-only source guard", push, and create docs/handoffs/STEP_009_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add lint rules for strict typing and English-only source guard.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 010: Add root layout shell with providers and theme tokens
Chat line: Implement STEP 010 only: Add root layout shell with providers and theme tokens. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 010: Add root layout shell with providers and theme tokens", push, and create docs/handoffs/STEP_010_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Add root layout shell with providers and theme tokens.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 011: Background job queue, worker and scheduler foundation with health check route
Chat line: Implement STEP 011 only: Background job queue, worker and scheduler foundation with health check route. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 011: Background job queue, worker and scheduler foundation with health check route", push, and create docs/handoffs/STEP_011_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Background job queue, worker and scheduler foundation with health check route.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Database Schema and Row Level Security

### STEP 012: Migration for companies and background jobs queue tables with tenant fields and version column
Chat line: Implement STEP 012 only: Migration for companies and background jobs queue tables with tenant fields and version column. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 012: Migration for companies and background jobs queue tables with tenant fields and version column", push, and create docs/handoffs/STEP_012_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for companies and background jobs queue tables with tenant fields and version column.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 013: Migration for users and role assignment tables
Chat line: Implement STEP 013 only: Migration for users and role assignment tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 013: Migration for users and role assignment tables", push, and create docs/handoffs/STEP_013_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for users and role assignment tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 014: Migration for office permissions, delegation, announcements and announcement dismissals tables
Chat line: Implement STEP 014 only: Migration for office permissions, delegation, announcements and announcement dismissals tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 014: Migration for office permissions, delegation, announcements and announcement dismissals tables", push, and create docs/handoffs/STEP_014_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for office permissions, delegation, announcements and announcement dismissals tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 015: Migration for sessions and device proof keys table
Chat line: Implement STEP 015 only: Migration for sessions and device proof keys table. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 015: Migration for sessions and device proof keys table", push, and create docs/handoffs/STEP_015_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for sessions and device proof keys table.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 016: Migration for login attempts and account locks table
Chat line: Implement STEP 016 only: Migration for login attempts and account locks table. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 016: Migration for login attempts and account locks table", push, and create docs/handoffs/STEP_016_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for login attempts and account locks table.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 017: Migration for audit logs append-only hash chain table
Chat line: Implement STEP 017 only: Migration for audit logs append-only hash chain table. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 017: Migration for audit logs append-only hash chain table", push, and create docs/handoffs/STEP_017_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for audit logs append-only hash chain table.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 018: Migration for plans, plan entitlements and pricing versions tables
Chat line: Implement STEP 018 only: Migration for plans, plan entitlements and pricing versions tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 018: Migration for plans, plan entitlements and pricing versions tables", push, and create docs/handoffs/STEP_018_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for plans, plan entitlements and pricing versions tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 019: Migration for subscriptions and subscription charges table
Chat line: Implement STEP 019 only: Migration for subscriptions and subscription charges table. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 019: Migration for subscriptions and subscription charges table", push, and create docs/handoffs/STEP_019_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for subscriptions and subscription charges table.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 020: Migration for clients, products and services tables
Chat line: Implement STEP 020 only: Migration for clients, products and services tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 020: Migration for clients, products and services tables", push, and create docs/handoffs/STEP_020_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for clients, products and services tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 021: Migration for invoices, invoice items and invoice events tables
Chat line: Implement STEP 021 only: Migration for invoices, invoice items and invoice events tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 021: Migration for invoices, invoice items and invoice events tables", push, and create docs/handoffs/STEP_021_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for invoices, invoice items and invoice events tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 022: Migration for estimates, estimate signatures and recurring schedules tables
Chat line: Implement STEP 022 only: Migration for estimates, estimate signatures and recurring schedules tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 022: Migration for estimates, estimate signatures and recurring schedules tables", push, and create docs/handoffs/STEP_022_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for estimates, estimate signatures and recurring schedules tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 023: Migration for payment providers, provider keys, routing rules, webhook events, idempotency keys, merchant API credentials, store connections and TaxCloud connections tables
Chat line: Implement STEP 023 only: Migration for payment providers, provider keys, routing rules, webhook events, idempotency keys, merchant API credentials, store connections and TaxCloud connections tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 023: Migration for payment providers, provider keys, routing rules, webhook events, idempotency keys, merchant API credentials, store connections and TaxCloud connections tables", push, and create docs/handoffs/STEP_023_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for payment providers, provider keys, routing rules, webhook events, idempotency keys, merchant API credentials, store connections and TaxCloud connections tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 024: Migration for payments, refunds and disputes tables
Chat line: Implement STEP 024 only: Migration for payments, refunds and disputes tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 024: Migration for payments, refunds and disputes tables", push, and create docs/handoffs/STEP_024_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for payments, refunds and disputes tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 025: Migration for double-entry ledger accounts and ledger entries tables
Chat line: Implement STEP 025 only: Migration for double-entry ledger accounts and ledger entries tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 025: Migration for double-entry ledger accounts and ledger entries tables", push, and create docs/handoffs/STEP_025_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for double-entry ledger accounts and ledger entries tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 026: Migration for settlements, holds, reserves and payouts tables
Chat line: Implement STEP 026 only: Migration for settlements, holds, reserves and payouts tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 026: Migration for settlements, holds, reserves and payouts tables", push, and create docs/handoffs/STEP_026_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for settlements, holds, reserves and payouts tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 027: Migration for payout bank accounts and bank change requests tables
Chat line: Implement STEP 027 only: Migration for payout bank accounts and bank change requests tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 027: Migration for payout bank accounts and bank change requests tables", push, and create docs/handoffs/STEP_027_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for payout bank accounts and bank change requests tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 028: Migration for KYC submissions, documents, UBO records, sanctions screening records, policy acceptances and review decisions tables
Chat line: Implement STEP 028 only: Migration for KYC submissions, documents, UBO records, sanctions screening records, policy acceptances and review decisions tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 028: Migration for KYC submissions, documents, UBO records, sanctions screening records, policy acceptances and review decisions tables", push, and create docs/handoffs/STEP_028_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for KYC submissions, documents, UBO records, sanctions screening records, policy acceptances and review decisions tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 029: Migration for sub-merchant provisioning records table
Chat line: Implement STEP 029 only: Migration for sub-merchant provisioning records table. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 029: Migration for sub-merchant provisioning records table", push, and create docs/handoffs/STEP_029_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for sub-merchant provisioning records table.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 030: Migration for card blacklist and velocity counters tables
Chat line: Implement STEP 030 only: Migration for card blacklist and velocity counters tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 030: Migration for card blacklist and velocity counters tables", push, and create docs/handoffs/STEP_030_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for card blacklist and velocity counters tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 031: Migration for files and storage records table
Chat line: Implement STEP 031 only: Migration for files and storage records table. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 031: Migration for files and storage records table", push, and create docs/handoffs/STEP_031_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for files and storage records table.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 032: Migration for email settings, templates, send logs, support tickets, CMS and blog pages, company accounting and compliance calendar tables
Chat line: Implement STEP 032 only: Migration for email settings, templates, send logs, support tickets, CMS and blog pages, company accounting and compliance calendar tables. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 032: Migration for email settings, templates, send logs, support tickets, CMS and blog pages, company accounting and compliance calendar tables", push, and create docs/handoffs/STEP_032_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Migration for email settings, templates, send logs, support tickets, CMS and blog pages, company accounting and compliance calendar tables.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 033: RLS default-deny policies for tenant tables batch one
Chat line: Implement STEP 033 only: RLS default-deny policies for tenant tables batch one. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 033: RLS default-deny policies for tenant tables batch one", push, and create docs/handoffs/STEP_033_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: RLS default-deny policies for tenant tables batch one.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 034: RLS default-deny policies for payment and ledger tables batch two
Chat line: Implement STEP 034 only: RLS default-deny policies for payment and ledger tables batch two. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 034: RLS default-deny policies for payment and ledger tables batch two", push, and create docs/handoffs/STEP_034_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: RLS default-deny policies for payment and ledger tables batch two.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 035: RLS policies for office roles and audit log immutability
Chat line: Implement STEP 035 only: RLS policies for office roles and audit log immutability. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 035: RLS policies for office roles and audit log immutability", push, and create docs/handoffs/STEP_035_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: RLS policies for office roles and audit log immutability.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 036: Audit hash chain function, initial reference seed for countries, MCC list and policy pages, and super_admin bootstrap
Chat line: Implement STEP 036 only: Audit hash chain function, initial reference seed for countries, MCC list and policy pages, and super_admin bootstrap. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 036: Audit hash chain function, initial reference seed for countries, MCC list and policy pages, and super_admin bootstrap", push, and create docs/handoffs/STEP_036_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Audit hash chain function, initial reference seed for countries, MCC list and policy pages, and super_admin bootstrap.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Authentication and Session Security

### STEP 037: Supabase Auth client and server helpers with typed session access
Chat line: Implement STEP 037 only: Supabase Auth client and server helpers with typed session access. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 037: Supabase Auth client and server helpers with typed session access", push, and create docs/handoffs/STEP_037_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Supabase Auth client and server helpers with typed session access.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 038: Signup flow with email verification, Turnstile and versioned policy acceptance recording
Chat line: Implement STEP 038 only: Signup flow with email verification, Turnstile and versioned policy acceptance recording. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 038: Signup flow with email verification, Turnstile and versioned policy acceptance recording", push, and create docs/handoffs/STEP_038_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Signup flow with email verification, Turnstile and versioned policy acceptance recording.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 039: Login flow with Turnstile and device registration
Chat line: Implement STEP 039 only: Login flow with Turnstile and device registration. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 039: Login flow with Turnstile and device registration", push, and create docs/handoffs/STEP_039_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Login flow with Turnstile and device registration.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 040: Password policy enforcement and breached password check
Chat line: Implement STEP 040 only: Password policy enforcement and breached password check. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 040: Password policy enforcement and breached password check", push, and create docs/handoffs/STEP_040_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Password policy enforcement and breached password check.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 041: 2FA TOTP enrollment with QR code and backup codes
Chat line: Implement STEP 041 only: 2FA TOTP enrollment with QR code and backup codes. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 041: 2FA TOTP enrollment with QR code and backup codes", push, and create docs/handoffs/STEP_041_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: 2FA TOTP enrollment with QR code and backup codes.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 042: 2FA verification step in login flow
Chat line: Implement STEP 042 only: 2FA verification step in login flow. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 042: 2FA verification step in login flow", push, and create docs/handoffs/STEP_042_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: 2FA verification step in login flow.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 043: Backup code regeneration for merchants inside settings
Chat line: Implement STEP 043 only: Backup code regeneration for merchants inside settings. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 043: Backup code regeneration for merchants inside settings", push, and create docs/handoffs/STEP_043_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Backup code regeneration for merchants inside settings.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 044: 2FA reset workflow after email contact and document verification
Chat line: Implement STEP 044 only: 2FA reset workflow after email contact and document verification. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 044: 2FA reset workflow after email contact and document verification", push, and create docs/handoffs/STEP_044_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: 2FA reset workflow after email contact and document verification.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 045: Login lock service: two failures trigger a two hour lock in database
Chat line: Implement STEP 045 only: Login lock service: two failures trigger a two hour lock in database. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 045: Login lock service: two failures trigger a two hour lock in database", push, and create docs/handoffs/STEP_045_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Login lock service: two failures trigger a two hour lock in database.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 046: Owner email alert when a login lock starts
Chat line: Implement STEP 046 only: Owner email alert when a login lock starts. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 046: Owner email alert when a login lock starts", push, and create docs/handoffs/STEP_046_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Owner email alert when a login lock starts.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 047: Admin unlock endpoint with permission check and audit entry
Chat line: Implement STEP 047 only: Admin unlock endpoint with permission check and audit entry. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 047: Admin unlock endpoint with permission check and audit entry", push, and create docs/handoffs/STEP_047_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Admin unlock endpoint with permission check and audit entry.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 048: Generic authentication error messages that reveal nothing about accounts
Chat line: Implement STEP 048 only: Generic authentication error messages that reveal nothing about accounts. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 048: Generic authentication error messages that reveal nothing about accounts", push, and create docs/handoffs/STEP_048_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Generic authentication error messages that reveal nothing about accounts.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 049: LR-022 device proof key generation and registration in browser
Chat line: Implement STEP 049 only: LR-022 device proof key generation and registration in browser. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 049: LR-022 device proof key generation and registration in browser", push, and create docs/handoffs/STEP_049_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: LR-022 device proof key generation and registration in browser.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 050: LR-022 request signature verification on sensitive endpoints
Chat line: Implement STEP 050 only: LR-022 request signature verification on sensitive endpoints. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 050: LR-022 request signature verification on sensitive endpoints", push, and create docs/handoffs/STEP_050_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: LR-022 request signature verification on sensitive endpoints.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 051: Rotating session token with replay detection and session family revocation
Chat line: Implement STEP 051 only: Rotating session token with replay detection and session family revocation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 051: Rotating session token with replay detection and session family revocation", push, and create docs/handoffs/STEP_051_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Rotating session token with replay detection and session family revocation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 052: New device detection with email confirmation and 2FA step
Chat line: Implement STEP 052 only: New device detection with email confirmation and 2FA step. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 052: New device detection with email confirmation and 2FA step", push, and create docs/handoffs/STEP_052_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: New device detection with email confirmation and 2FA step.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 053: Step-up reauthentication guard for sensitive actions
Chat line: Implement STEP 053 only: Step-up reauthentication guard for sensitive actions. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 053: Step-up reauthentication guard for sensitive actions", push, and create docs/handoffs/STEP_053_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Step-up reauthentication guard for sensitive actions.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 054: Session list and instant revoke for owners and office roles
Chat line: Implement STEP 054 only: Session list and instant revoke for owners and office roles. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 054: Session list and instant revoke for owners and office roles", push, and create docs/handoffs/STEP_054_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Session list and instant revoke for owners and office roles.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 055: IP based rate limiting on authentication endpoints
Chat line: Implement STEP 055 only: IP based rate limiting on authentication endpoints. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 055: IP based rate limiting on authentication endpoints", push, and create docs/handoffs/STEP_055_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: IP based rate limiting on authentication endpoints.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Application Security Core

### STEP 056: Input sanitizer library for text, rich text and URLs
Chat line: Implement STEP 056 only: Input sanitizer library for text, rich text and URLs. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 056: Input sanitizer library for text, rich text and URLs", push, and create docs/handoffs/STEP_056_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Input sanitizer library for text, rich text and URLs.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 057: CSRF double-submit protection for mutations
Chat line: Implement STEP 057 only: CSRF double-submit protection for mutations. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 057: CSRF double-submit protection for mutations", push, and create docs/handoffs/STEP_057_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CSRF double-submit protection for mutations.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 058: SSRF guard with URL allowlist and private range blocking
Chat line: Implement STEP 058 only: SSRF guard with URL allowlist and private range blocking. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 058: SSRF guard with URL allowlist and private range blocking", push, and create docs/handoffs/STEP_058_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: SSRF guard with URL allowlist and private range blocking.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 059: Nonce based Content Security Policy builder
Chat line: Implement STEP 059 only: Nonce based Content Security Policy builder. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 059: Nonce based Content Security Policy builder", push, and create docs/handoffs/STEP_059_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Nonce based Content Security Policy builder.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 060: Security headers middleware for every response
Chat line: Implement STEP 060 only: Security headers middleware for every response. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 060: Security headers middleware for every response", push, and create docs/handoffs/STEP_060_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Security headers middleware for every response.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 061: File upload validator with magic byte and size checks
Chat line: Implement STEP 061 only: File upload validator with magic byte and size checks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 061: File upload validator with magic byte and size checks", push, and create docs/handoffs/STEP_061_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: File upload validator with magic byte and size checks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 062: Rate limit service with per user, per IP and per endpoint buckets
Chat line: Implement STEP 062 only: Rate limit service with per user, per IP and per endpoint buckets. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 062: Rate limit service with per user, per IP and per endpoint buckets", push, and create docs/handoffs/STEP_062_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Rate limit service with per user, per IP and per endpoint buckets.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 063: Audit log writer service with hash chaining
Chat line: Implement STEP 063 only: Audit log writer service with hash chaining. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 063: Audit log writer service with hash chaining", push, and create docs/handoffs/STEP_063_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Audit log writer service with hash chaining.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 064: Encryption service AES-256-GCM for secrets and files
Chat line: Implement STEP 064 only: Encryption service AES-256-GCM for secrets and files. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 064: Encryption service AES-256-GCM for secrets and files", push, and create docs/handoffs/STEP_064_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Encryption service AES-256-GCM for secrets and files.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 065: Signed token service for client portal links with expiry and revocation
Chat line: Implement STEP 065 only: Signed token service for client portal links with expiry and revocation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 065: Signed token service for client portal links with expiry and revocation", push, and create docs/handoffs/STEP_065_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Signed token service for client portal links with expiry and revocation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 066: Fraud signal evaluation service for payment attempts
Chat line: Implement STEP 066 only: Fraud signal evaluation service for payment attempts. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 066: Fraud signal evaluation service for payment attempts", push, and create docs/handoffs/STEP_066_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Fraud signal evaluation service for payment attempts.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 067: Velocity counter service for card tokens and IP addresses
Chat line: Implement STEP 067 only: Velocity counter service for card tokens and IP addresses. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 067: Velocity counter service for card tokens and IP addresses", push, and create docs/handoffs/STEP_067_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Velocity counter service for card tokens and IP addresses.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Office Dashboards and Permissions

### STEP 068: Admin layout shell with sidebar, topbar and role based navigation
Chat line: Implement STEP 068 only: Admin layout shell with sidebar, topbar and role based navigation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 068: Admin layout shell with sidebar, topbar and role based navigation", push, and create docs/handoffs/STEP_068_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Admin layout shell with sidebar, topbar and role based navigation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 069: super_admin dashboard home and gateway management page with key test, enable and disable controls
Chat line: Implement STEP 069 only: super_admin dashboard home and gateway management page with key test, enable and disable controls. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 069: super_admin dashboard home and gateway management page with key test, enable and disable controls", push, and create docs/handoffs/STEP_069_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: super_admin dashboard home and gateway management page with key test, enable and disable controls.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 070: CEO dashboard home with approval queues
Chat line: Implement STEP 070 only: CEO dashboard home with approval queues. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 070: CEO dashboard home with approval queues", push, and create docs/handoffs/STEP_070_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CEO dashboard home with approval queues.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 071: Permission delegation screen for super_admin
Chat line: Implement STEP 071 only: Permission delegation screen for super_admin. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 071: Permission delegation screen for super_admin", push, and create docs/handoffs/STEP_071_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Permission delegation screen for super_admin.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 072: CEO confirmation step for large payout release, platform fee change, reserve release and country enable actions
Chat line: Implement STEP 072 only: CEO confirmation step for large payout release, platform fee change, reserve release and country enable actions. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 072: CEO confirmation step for large payout release, platform fee change, reserve release and country enable actions", push, and create docs/handoffs/STEP_072_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CEO confirmation step for large payout release, platform fee change, reserve release and country enable actions.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 073: Country enable and disable management screen
Chat line: Implement STEP 073 only: Country enable and disable management screen. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 073: Country enable and disable management screen", push, and create docs/handoffs/STEP_073_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Country enable and disable management screen.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 074: Platform general settings screen with compliance calendar for renewals and expiry alerts
Chat line: Implement STEP 074 only: Platform general settings screen with compliance calendar for renewals and expiry alerts. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 074: Platform general settings screen with compliance calendar for renewals and expiry alerts", push, and create docs/handoffs/STEP_074_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Platform general settings screen with compliance calendar for renewals and expiry alerts.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 075: Announcement composer, publish flow and popup component with per-user dismiss record
Chat line: Implement STEP 075 only: Announcement composer, publish flow and popup component with per-user dismiss record. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 075: Announcement composer, publish flow and popup component with per-user dismiss record", push, and create docs/handoffs/STEP_075_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Announcement composer, publish flow and popup component with per-user dismiss record.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 076: Audit log viewer with filters for office roles
Chat line: Implement STEP 076 only: Audit log viewer with filters for office roles. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 076: Audit log viewer with filters for office roles", push, and create docs/handoffs/STEP_076_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Audit log viewer with filters for office roles.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 077: Session management screen with revoke actions
Chat line: Implement STEP 077 only: Session management screen with revoke actions. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 077: Session management screen with revoke actions", push, and create docs/handoffs/STEP_077_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Session management screen with revoke actions.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 078: Account unlock management screen for permitted office roles
Chat line: Implement STEP 078 only: Account unlock management screen for permitted office roles. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 078: Account unlock management screen for permitted office roles", push, and create docs/handoffs/STEP_078_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Account unlock management screen for permitted office roles.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Merchant Onboarding, KYC and Sub-Merchant Provisioning

### STEP 079: Merchant onboarding wizard shell with saved progress
Chat line: Implement STEP 079 only: Merchant onboarding wizard shell with saved progress. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 079: Merchant onboarding wizard shell with saved progress", push, and create docs/handoffs/STEP_079_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant onboarding wizard shell with saved progress.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 080: Business information form driven by processor required fields
Chat line: Implement STEP 080 only: Business information form driven by processor required fields. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 080: Business information form driven by processor required fields", push, and create docs/handoffs/STEP_080_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Business information form driven by processor required fields.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 081: Merchant Category Code and additive versioned risk-policy/tier-history schema
Database ownership: because STEP 001-080 are already complete, add a new forward migration and rollback for versioned risk-policy proposals/approvals, merchant risk profile and tier history only if those structures are missing. Inspect all existing migrations and handoffs first; never alter or rerun an already committed migration.
Chat line: Implement STEP 081 only: Merchant Category Code and additive versioned risk-policy/tier-history schema. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 081: Merchant Category Code and additive versioned risk-policy/tier-history schema", push, and create docs/handoffs/STEP_081_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant Category Code and additive versioned risk-policy/tier-history schema.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 082: Business address and contact information section
Chat line: Implement STEP 082 only: Business address and contact information section. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 082: Business address and contact information section", push, and create docs/handoffs/STEP_082_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Business address and contact information section.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 083: One-time business profile that feeds every processor
Chat line: Implement STEP 083 only: One-time business profile that feeds every processor. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 083: One-time business profile that feeds every processor", push, and create docs/handoffs/STEP_083_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: One-time business profile that feeds every processor.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 084: Processor KYB document/status capture, UBO/director identity records and sanctions, PEP and adverse-media screening
Database ownership: append a separate migration/rollback only for missing screening-run/list-version, match-resolution or re-KYC case records; reuse existing UBO/KYC/sanctions tables when they already meet the feature requirements.
Chat line: Implement STEP 084 only: Processor KYB document/status capture, UBO/director identity records and sanctions, PEP and adverse-media screening. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 084: Processor KYB document/status capture, UBO/director identity records and sanctions, PEP and adverse-media screening", push, and create docs/handoffs/STEP_084_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Processor KYB document/status capture, UBO/director identity records and sanctions, PEP and adverse-media screening.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 085: Address proof upload: utility bill with 3 month issue rule
Chat line: Implement STEP 085 only: Address proof upload: utility bill with 3 month issue rule. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 085: Address proof upload: utility bill with 3 month issue rule", push, and create docs/handoffs/STEP_085_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Address proof upload: utility bill with 3 month issue rule.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 086: Bank statement and source of funds upload
Chat line: Implement STEP 086 only: Bank statement and source of funds upload. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 086: Bank statement and source of funds upload", push, and create docs/handoffs/STEP_086_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Bank statement and source of funds upload.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 087: KYC submission summary and status screen for merchant
Chat line: Implement STEP 087 only: KYC submission summary and status screen for merchant. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 087: KYC submission summary and status screen for merchant", push, and create docs/handoffs/STEP_087_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: KYC submission summary and status screen for merchant.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 088: Compliance KYC review queue with document viewer
Chat line: Implement STEP 088 only: Compliance KYC review queue with document viewer. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 088: Compliance KYC review queue with document viewer", push, and create docs/handoffs/STEP_088_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Compliance KYC review queue with document viewer.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 089: Four-eye review flow for high-risk merchants, screening matches and tier decisions
Chat line: Implement STEP 089 only: Four-eye review flow for high-risk merchants, screening matches and tier decisions. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 089: Four-eye review flow for high-risk merchants, screening matches and tier decisions", push, and create docs/handoffs/STEP_089_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Four-eye review flow for high-risk merchants, screening matches and tier decisions.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 090: CEO/super_admin versioned risk-policy settings, underwriting criteria, screening cadence and re-KYC rules
Policy change control: CEO and super_admin may propose permitted values. Activate only after approval by a distinct authorized actor under the requester → CEO → super_admin chain; super_admin retains full authority. Store each version with proposer, approver, effective date, reason and audit link; apply prospectively, never rewrite a policy snapshot already attached to a transaction.
Chat line: Implement STEP 090 only: CEO/super_admin versioned risk-policy settings, underwriting criteria, screening cadence and re-KYC rules. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 090: CEO/super_admin versioned risk-policy settings, underwriting criteria, screening cadence and re-KYC rules", push, and create docs/handoffs/STEP_090_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CEO/super_admin versioned risk-policy settings, underwriting criteria, screening cadence and re-KYC rules.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 091: Tier 1-3 eligibility, merchant risk-tier history and per-transaction/monthly limits with manual upgrade review
Chat line: Implement STEP 091 only: Tier 1-3 eligibility, merchant risk-tier history and per-transaction/monthly limits with manual upgrade review. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 091: Tier 1-3 eligibility, merchant risk-tier history and per-transaction/monthly limits with manual upgrade review", push, and create docs/handoffs/STEP_091_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Tier 1-3 eligibility, merchant risk-tier history and per-transaction/monthly limits with manual upgrade review.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 092: Pre-capture manual review for every transaction above USD 5,000 and risk-triggered transaction holds
Database ownership: append a separate migration/rollback for missing transaction-review cases, decision evidence and policy-version linkage only; no earlier migration may be edited. A provider that cannot separate authorization/capture must be reviewed before charge submission or the attempt must be rejected.
Chat line: Implement STEP 092 only: Pre-capture manual review for every transaction above USD 5,000 and risk-triggered transaction holds. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 092: Pre-capture manual review for every transaction above USD 5,000 and risk-triggered transaction holds", push, and create docs/handoffs/STEP_092_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Pre-capture manual review for every transaction above USD 5,000 and risk-triggered transaction holds.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 093: Separate processor KYB status from platform risk decision, with approval, restriction and reasoned review flow
Chat line: Implement STEP 093 only: Separate processor KYB status from platform risk decision, with approval, restriction and reasoned review flow. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 093: Separate processor KYB status from platform risk decision, with approval, restriction and reasoned review flow", push, and create docs/handoffs/STEP_093_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Separate processor KYB status from platform risk decision, with approval, restriction and reasoned review flow.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 094: Automatic sub-merchant provisioning job after final approval
Chat line: Implement STEP 094 only: Automatic sub-merchant provisioning job after final approval. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 094: Automatic sub-merchant provisioning job after final approval", push, and create docs/handoffs/STEP_094_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Automatic sub-merchant provisioning job after final approval.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 095: Per-processor KYB/capability status sync through signature-verified idempotent webhooks
Chat line: Implement STEP 095 only: Per-processor KYB/capability status sync through signature-verified idempotent webhooks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 095: Per-processor KYB/capability status sync through signature-verified idempotent webhooks", push, and create docs/handoffs/STEP_095_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Per-processor KYB/capability status sync through signature-verified idempotent webhooks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 096: Provisioning queue and office alert when no master account is connected
Chat line: Implement STEP 096 only: Provisioning queue and office alert when no master account is connected. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 096: Provisioning queue and office alert when no master account is connected", push, and create docs/handoffs/STEP_096_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Provisioning queue and office alert when no master account is connected.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 097: Extra document request flow from provider to merchant
Chat line: Implement STEP 097 only: Extra document request flow from provider to merchant. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 097: Extra document request flow from provider to merchant", push, and create docs/handoffs/STEP_097_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Extra document request flow from provider to merchant.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 098: Duplicate identity check at signup, KYC and provisioning stages
Chat line: Implement STEP 098 only: Duplicate identity check at signup, KYC and provisioning stages. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 098: Duplicate identity check at signup, KYC and provisioning stages", push, and create docs/handoffs/STEP_098_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Duplicate identity check at signup, KYC and provisioning stages.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 099: Merchant suspension, reactivation and account closure flow with saved card token deletion and chargeback-period fund hold
Chat line: Implement STEP 099 only: Merchant suspension, reactivation and account closure flow with saved card token deletion and chargeback-period fund hold. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 099: Merchant suspension, reactivation and account closure flow with saved card token deletion and chargeback-period fund hold", push, and create docs/handoffs/STEP_099_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant suspension, reactivation and account closure flow with saved card token deletion and chargeback-period fund hold.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## File Storage Layer

### STEP 100: Storage adapter interface with upload, download, delete, signed URL and file access audit logging
Chat line: Implement STEP 100 only: Storage adapter interface with upload, download, delete, signed URL and file access audit logging. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 100: Storage adapter interface with upload, download, delete, signed URL and file access audit logging", push, and create docs/handoffs/STEP_100_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Storage adapter interface with upload, download, delete, signed URL and file access audit logging.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 101: Supabase Storage and Amazon S3 storage adapters with adapter selection by environment configuration for Netlify, Vercel and Amazon hosting
Chat line: Implement STEP 101 only: Supabase Storage and Amazon S3 storage adapters with adapter selection by environment configuration for Netlify, Vercel and Amazon hosting. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 101: Supabase Storage and Amazon S3 storage adapters with adapter selection by environment configuration for Netlify, Vercel and Amazon hosting", push, and create docs/handoffs/STEP_101_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Supabase Storage and Amazon S3 storage adapters with adapter selection by environment configuration for Netlify, Vercel and Amazon hosting.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 102: AES-256-GCM file encryption before upload
Chat line: Implement STEP 102 only: AES-256-GCM file encryption before upload. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 102: AES-256-GCM file encryption before upload", push, and create docs/handoffs/STEP_102_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: AES-256-GCM file encryption before upload.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 103: File record service storing provider, hash, size and type
Chat line: Implement STEP 103 only: File record service storing provider, hash, size and type. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 103: File record service storing provider, hash, size and type", push, and create docs/handoffs/STEP_103_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: File record service storing provider, hash, size and type.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 104: KYC document storage category with tenant isolation paths
Chat line: Implement STEP 104 only: KYC document storage category with tenant isolation paths. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 104: KYC document storage category with tenant isolation paths", push, and create docs/handoffs/STEP_104_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: KYC document storage category with tenant isolation paths.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 105: Logo and branding asset storage category
Chat line: Implement STEP 105 only: Logo and branding asset storage category. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 105: Logo and branding asset storage category", push, and create docs/handoffs/STEP_105_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Logo and branding asset storage category.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Clients, Products, Invoices and Estimates

### STEP 106: Client create and edit forms with Zod validation
Chat line: Implement STEP 106 only: Client create and edit forms with Zod validation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 106: Client create and edit forms with Zod validation", push, and create docs/handoffs/STEP_106_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Client create and edit forms with Zod validation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 107: Client paginated list with search
Chat line: Implement STEP 107 only: Client paginated list with search. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 107: Client paginated list with search", push, and create docs/handoffs/STEP_107_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Client paginated list with search.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 108: Product and service create and edit forms
Chat line: Implement STEP 108 only: Product and service create and edit forms. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 108: Product and service create and edit forms", push, and create docs/handoffs/STEP_108_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Product and service create and edit forms.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 109: Product paginated list with search
Chat line: Implement STEP 109 only: Product paginated list with search. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 109: Product paginated list with search", push, and create docs/handoffs/STEP_109_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Product paginated list with search.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 110: CSV import for clients with per-row error reporting
Chat line: Implement STEP 110 only: CSV import for clients with per-row error reporting. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 110: CSV import for clients with per-row error reporting", push, and create docs/handoffs/STEP_110_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CSV import for clients with per-row error reporting.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 111: CSV import for products with per-row error reporting
Chat line: Implement STEP 111 only: CSV import for products with per-row error reporting. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 111: CSV import for products with per-row error reporting", push, and create docs/handoffs/STEP_111_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CSV import for products with per-row error reporting.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 112: Invoice create form with client and line items
Chat line: Implement STEP 112 only: Invoice create form with client and line items. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 112: Invoice create form with client and line items", push, and create docs/handoffs/STEP_112_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Invoice create form with client and line items.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 113: Line item editor with quantity, rate, discount and ordering
Chat line: Implement STEP 113 only: Line item editor with quantity, rate, discount and ordering. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 113: Line item editor with quantity, rate, discount and ordering", push, and create docs/handoffs/STEP_113_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Line item editor with quantity, rate, discount and ordering.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 114: Decimal invoice calculation engine with discount and totals
Chat line: Implement STEP 114 only: Decimal invoice calculation engine with discount and totals. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 114: Decimal invoice calculation engine with discount and totals", push, and create docs/handoffs/STEP_114_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Decimal invoice calculation engine with discount and totals.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 115: Invoice numbering service per merchant
Chat line: Implement STEP 115 only: Invoice numbering service per merchant. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 115: Invoice numbering service per merchant", push, and create docs/handoffs/STEP_115_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Invoice numbering service per merchant.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 116: Invoice status workflow transitions with paid invoice edit lock and audit entries
Chat line: Implement STEP 116 only: Invoice status workflow transitions with paid invoice edit lock and audit entries. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 116: Invoice status workflow transitions with paid invoice edit lock and audit entries", push, and create docs/handoffs/STEP_116_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Invoice status workflow transitions with paid invoice edit lock and audit entries.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 117: Invoice PDF generation as a background job
Chat line: Implement STEP 117 only: Invoice PDF generation as a background job. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 117: Invoice PDF generation as a background job", push, and create docs/handoffs/STEP_117_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Invoice PDF generation as a background job.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 118: Merchant logo and invoice branding settings applied to PDF
Chat line: Implement STEP 118 only: Merchant logo and invoice branding settings applied to PDF. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 118: Merchant logo and invoice branding settings applied to PDF", push, and create docs/handoffs/STEP_118_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant logo and invoice branding settings applied to PDF.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 119: Estimate create form and line items
Chat line: Implement STEP 119 only: Estimate create form and line items. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 119: Estimate create form and line items", push, and create docs/handoffs/STEP_119_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Estimate create form and line items.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 120: Estimate digital signature capture with evidence record
Chat line: Implement STEP 120 only: Estimate digital signature capture with evidence record. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 120: Estimate digital signature capture with evidence record", push, and create docs/handoffs/STEP_120_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Estimate digital signature capture with evidence record.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 121: Estimate accept conversion to invoice with payment link generation
Chat line: Implement STEP 121 only: Estimate accept conversion to invoice with payment link generation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 121: Estimate accept conversion to invoice with payment link generation", push, and create docs/handoffs/STEP_121_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Estimate accept conversion to invoice with payment link generation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 122: Recurring invoice schedule configuration
Chat line: Implement STEP 122 only: Recurring invoice schedule configuration. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 122: Recurring invoice schedule configuration", push, and create docs/handoffs/STEP_122_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Recurring invoice schedule configuration.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 123: Recurring generation job with due and overdue handling and client reminders
Chat line: Implement STEP 123 only: Recurring generation job with due and overdue handling and client reminders. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 123: Recurring generation job with due and overdue handling and client reminders", push, and create docs/handoffs/STEP_123_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Recurring generation job with due and overdue handling and client reminders.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 124: Partial payment recording with 20 USD minimum
Chat line: Implement STEP 124 only: Partial payment recording with 20 USD minimum. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 124: Partial payment recording with 20 USD minimum", push, and create docs/handoffs/STEP_124_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Partial payment recording with 20 USD minimum.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 125: Settlement statement export CSV generation
Chat line: Implement STEP 125 only: Settlement statement export CSV generation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 125: Settlement statement export CSV generation", push, and create docs/handoffs/STEP_125_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Settlement statement export CSV generation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 126: Settlement statement export PDF generation
Chat line: Implement STEP 126 only: Settlement statement export PDF generation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 126: Settlement statement export PDF generation", push, and create docs/handoffs/STEP_126_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Settlement statement export PDF generation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Payment Core, Ledger, Settlement and Payout

### STEP 127: Money value handling with decimal library and currency guard
Chat line: Implement STEP 127 only: Money value handling with decimal library and currency guard. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 127: Money value handling with decimal library and currency guard", push, and create docs/handoffs/STEP_127_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Money value handling with decimal library and currency guard.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 128: Provider registry with capability matrix for five providers
Chat line: Implement STEP 128 only: Provider registry with capability matrix for five providers. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 128: Provider registry with capability matrix for five providers", push, and create docs/handoffs/STEP_128_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Provider registry with capability matrix for five providers.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 129: Routing rule engine with reject on no match
Chat line: Implement STEP 129 only: Routing rule engine with reject on no match. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 129: Routing rule engine with reject on no match", push, and create docs/handoffs/STEP_129_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Routing rule engine with reject on no match.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 130: Payment creation service with idempotency key handling
Chat line: Implement STEP 130 only: Payment creation service with idempotency key handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 130: Payment creation service with idempotency key handling", push, and create docs/handoffs/STEP_130_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payment creation service with idempotency key handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 131: Double-entry ledger account setup per merchant
Chat line: Implement STEP 131 only: Double-entry ledger account setup per merchant. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 131: Double-entry ledger account setup per merchant", push, and create docs/handoffs/STEP_131_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Double-entry ledger account setup per merchant.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 132: Ledger posting service requiring balanced debit and credit pairs
Chat line: Implement STEP 132 only: Ledger posting service requiring balanced debit and credit pairs. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 132: Ledger posting service requiring balanced debit and credit pairs", push, and create docs/handoffs/STEP_132_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Ledger posting service requiring balanced debit and credit pairs.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 133: Ledger correction through reversing entries only
Chat line: Implement STEP 133 only: Ledger correction through reversing entries only. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 133: Ledger correction through reversing entries only", push, and create docs/handoffs/STEP_133_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Ledger correction through reversing entries only.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 134: Ledger balance integrity check job with office alerts
Chat line: Implement STEP 134 only: Ledger balance integrity check job with office alerts. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 134: Ledger balance integrity check job with office alerts", push, and create docs/handoffs/STEP_134_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Ledger balance integrity check job with office alerts.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 135: Platform fee calculation and posting per transaction
Chat line: Implement STEP 135 only: Platform fee calculation and posting per transaction. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 135: Platform fee calculation and posting per transaction", push, and create docs/handoffs/STEP_135_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Platform fee calculation and posting per transaction.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 136: Settlement hold and tier-specific post-fulfilment payout eligibility with scheduled release job
Chat line: Implement STEP 136 only: Settlement hold and tier-specific post-fulfilment payout eligibility with scheduled release job. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 136: Settlement hold and tier-specific post-fulfilment payout eligibility with scheduled release job", push, and create docs/handoffs/STEP_136_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Settlement hold and tier-specific post-fulfilment payout eligibility with scheduled release job.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 137: Versioned tier-based rolling reserve posting, tracking and authorized release
Chat line: Implement STEP 137 only: Versioned tier-based rolling reserve posting, tracking and authorized release. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 137: Versioned tier-based rolling reserve posting, tracking and authorized release", push, and create docs/handoffs/STEP_137_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Versioned tier-based rolling reserve posting, tracking and authorized release.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 138: Negative balance handling from reserve with contract collection record
Chat line: Implement STEP 138 only: Negative balance handling from reserve with contract collection record. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 138: Negative balance handling from reserve with contract collection record", push, and create docs/handoffs/STEP_138_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Negative balance handling from reserve with contract collection record.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 139: Payout bank account add flow with automatic provider bank linking
Chat line: Implement STEP 139 only: Payout bank account add flow with automatic provider bank linking. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 139: Payout bank account add flow with automatic provider bank linking", push, and create docs/handoffs/STEP_139_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payout bank account add flow with automatic provider bank linking.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 140: Bank change manual verification flow
Chat line: Implement STEP 140 only: Bank change manual verification flow. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 140: Bank change manual verification flow", push, and create docs/handoffs/STEP_140_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Bank change manual verification flow.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 141: Bank change 96 hour cooling period enforcement
Chat line: Implement STEP 141 only: Bank change 96 hour cooling period enforcement. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 141: Bank change 96 hour cooling period enforcement", push, and create docs/handoffs/STEP_141_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Bank change 96 hour cooling period enforcement.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 142: Minimum payout threshold of 100 USD with remainder rule
Chat line: Implement STEP 142 only: Minimum payout threshold of 100 USD with remainder rule. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 142: Minimum payout threshold of 100 USD with remainder rule", push, and create docs/handoffs/STEP_142_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Minimum payout threshold of 100 USD with remainder rule.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 143: Payout execution only after fulfilment, provider, tier, bank, hold and risk gates pass
Chat line: Implement STEP 143 only: Payout execution only after fulfilment, provider, tier, bank, hold and risk gates pass. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 143: Payout execution only after fulfilment, provider, tier, bank, hold and risk gates pass", push, and create docs/handoffs/STEP_143_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payout execution only after fulfilment, provider, tier, bank, hold and risk gates pass.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 144: Idempotent settlement release job enforcing fulfilment evidence, tier delay and all risk gates
Chat line: Implement STEP 144 only: Idempotent settlement release job enforcing fulfilment evidence, tier delay and all risk gates. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 144: Idempotent settlement release job enforcing fulfilment evidence, tier delay and all risk gates", push, and create docs/handoffs/STEP_144_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Idempotent settlement release job enforcing fulfilment evidence, tier delay and all risk gates.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 145: Reconciliation import of processor reports
Chat line: Implement STEP 145 only: Reconciliation import of processor reports. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 145: Reconciliation import of processor reports", push, and create docs/handoffs/STEP_145_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Reconciliation import of processor reports.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 146: Reconciliation mismatch queue with 3 day resolution tracking
Chat line: Implement STEP 146 only: Reconciliation mismatch queue with 3 day resolution tracking. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 146: Reconciliation mismatch queue with 3 day resolution tracking", push, and create docs/handoffs/STEP_146_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Reconciliation mismatch queue with 3 day resolution tracking.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Payment Provider Adapters

### STEP 147: NMI documentation verification and sandbox notes recording
Chat line: Implement STEP 147 only: NMI documentation verification and sandbox notes recording. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 147: NMI documentation verification and sandbox notes recording", push, and create docs/handoffs/STEP_147_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI documentation verification and sandbox notes recording.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 148: NMI encrypted key configuration and connection test
Chat line: Implement STEP 148 only: NMI encrypted key configuration and connection test. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 148: NMI encrypted key configuration and connection test", push, and create docs/handoffs/STEP_148_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI encrypted key configuration and connection test.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 149: NMI Collect.js token integration on payment pages
Chat line: Implement STEP 149 only: NMI Collect.js token integration on payment pages. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 149: NMI Collect.js token integration on payment pages", push, and create docs/handoffs/STEP_149_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI Collect.js token integration on payment pages.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 150: NMI API transaction types (sale, authorization, capture, refund, void) implemented exactly per official NMI API documentation
Chat line: Implement STEP 150 only: NMI API transaction types (sale, authorization, capture, refund, void) implemented exactly per official NMI API documentation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 150: NMI API transaction types (sale, authorization, capture, refund, void) implemented exactly per official NMI API documentation", push, and create docs/handoffs/STEP_150_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI API transaction types (sale, authorization, capture, refund, void) implemented exactly per official NMI API documentation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 151: NMI shared server payment module exchanging Collect.js tokens through the NMI API per official documentation
Chat line: Implement STEP 151 only: NMI shared server payment module exchanging Collect.js tokens through the NMI API per official documentation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 151: NMI shared server payment module exchanging Collect.js tokens through the NMI API per official documentation", push, and create docs/handoffs/STEP_151_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI shared server payment module exchanging Collect.js tokens through the NMI API per official documentation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 152: NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation
Chat line: Implement STEP 152 only: NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 152: NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation", push, and create docs/handoffs/STEP_152_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 153: NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks
Chat line: Implement STEP 153 only: NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 153: NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks", push, and create docs/handoffs/STEP_153_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 154: Payoneer documentation verification and sandbox notes recording
Chat line: Implement STEP 154 only: Payoneer documentation verification and sandbox notes recording. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 154: Payoneer documentation verification and sandbox notes recording", push, and create docs/handoffs/STEP_154_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payoneer documentation verification and sandbox notes recording.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 155: Payoneer encrypted key configuration and connection test
Chat line: Implement STEP 155 only: Payoneer encrypted key configuration and connection test. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 155: Payoneer encrypted key configuration and connection test", push, and create docs/handoffs/STEP_155_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payoneer encrypted key configuration and connection test.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 156: Payoneer automatic bank linking, payout execution and status handling
Chat line: Implement STEP 156 only: Payoneer automatic bank linking, payout execution and status handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 156: Payoneer automatic bank linking, payout execution and status handling", push, and create docs/handoffs/STEP_156_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payoneer automatic bank linking, payout execution and status handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 157: Rainforest documentation verification and sandbox notes recording
Chat line: Implement STEP 157 only: Rainforest documentation verification and sandbox notes recording. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 157: Rainforest documentation verification and sandbox notes recording", push, and create docs/handoffs/STEP_157_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Rainforest documentation verification and sandbox notes recording.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 158: Rainforest encrypted key configuration and connection test
Chat line: Implement STEP 158 only: Rainforest encrypted key configuration and connection test. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 158: Rainforest encrypted key configuration and connection test", push, and create docs/handoffs/STEP_158_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Rainforest encrypted key configuration and connection test.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 159: Rainforest payment acceptance integration
Chat line: Implement STEP 159 only: Rainforest payment acceptance integration. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 159: Rainforest payment acceptance integration", push, and create docs/handoffs/STEP_159_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Rainforest payment acceptance integration.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 160: Rainforest sub-merchant onboarding integration with signature verified idempotent webhooks
Chat line: Implement STEP 160 only: Rainforest sub-merchant onboarding integration with signature verified idempotent webhooks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 160: Rainforest sub-merchant onboarding integration with signature verified idempotent webhooks", push, and create docs/handoffs/STEP_160_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Rainforest sub-merchant onboarding integration with signature verified idempotent webhooks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 161: Stripe Connect documentation verification and sandbox notes recording
Chat line: Implement STEP 161 only: Stripe Connect documentation verification and sandbox notes recording. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 161: Stripe Connect documentation verification and sandbox notes recording", push, and create docs/handoffs/STEP_161_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Stripe Connect documentation verification and sandbox notes recording.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 162: Stripe Connect encrypted key configuration and connection test
Chat line: Implement STEP 162 only: Stripe Connect encrypted key configuration and connection test. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 162: Stripe Connect encrypted key configuration and connection test", push, and create docs/handoffs/STEP_162_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Stripe Connect encrypted key configuration and connection test.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 163: Stripe Connect connected account creation after KYC approval
Chat line: Implement STEP 163 only: Stripe Connect connected account creation after KYC approval. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 163: Stripe Connect connected account creation after KYC approval", push, and create docs/handoffs/STEP_163_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Stripe Connect connected account creation after KYC approval.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 164: Stripe Connect charges with platform fee split, payouts and signature verified idempotent webhooks
Chat line: Implement STEP 164 only: Stripe Connect charges with platform fee split, payouts and signature verified idempotent webhooks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 164: Stripe Connect charges with platform fee split, payouts and signature verified idempotent webhooks", push, and create docs/handoffs/STEP_164_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Stripe Connect charges with platform fee split, payouts and signature verified idempotent webhooks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 165: Airwallex documentation verification and sandbox notes recording
Chat line: Implement STEP 165 only: Airwallex documentation verification and sandbox notes recording. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 165: Airwallex documentation verification and sandbox notes recording", push, and create docs/handoffs/STEP_165_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Airwallex documentation verification and sandbox notes recording.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 166: Airwallex encrypted key configuration and connection test
Chat line: Implement STEP 166 only: Airwallex encrypted key configuration and connection test. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 166: Airwallex encrypted key configuration and connection test", push, and create docs/handoffs/STEP_166_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Airwallex encrypted key configuration and connection test.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 167: Airwallex connected account creation and verification sync
Chat line: Implement STEP 167 only: Airwallex connected account creation and verification sync. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 167: Airwallex connected account creation and verification sync", push, and create docs/handoffs/STEP_167_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Airwallex connected account creation and verification sync.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 168: Airwallex payment acceptance integration
Chat line: Implement STEP 168 only: Airwallex payment acceptance integration. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 168: Airwallex payment acceptance integration", push, and create docs/handoffs/STEP_168_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Airwallex payment acceptance integration.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 169: Airwallex payouts and webhook handling
Chat line: Implement STEP 169 only: Airwallex payouts and webhook handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 169: Airwallex payouts and webhook handling", push, and create docs/handoffs/STEP_169_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Airwallex payouts and webhook handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Optional Supplementary Identity Verification Adapters

### STEP 170: Optional supplementary identity-verification adapter interface kept separate from processor KYB status
Chat line: Implement STEP 170 only: Optional supplementary identity-verification adapter interface kept separate from processor KYB status. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 170: Optional supplementary identity-verification adapter interface kept separate from processor KYB status", push, and create docs/handoffs/STEP_170_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Optional supplementary identity-verification adapter interface kept separate from processor KYB status.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 171: Jumio supplementary identity/liveness adapter with encrypted configuration and verification session
Chat line: Implement STEP 171 only: Jumio supplementary identity/liveness adapter with encrypted configuration and verification session. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 171: Jumio supplementary identity/liveness adapter with encrypted configuration and verification session", push, and create docs/handoffs/STEP_171_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Jumio supplementary identity/liveness adapter with encrypted configuration and verification session.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 172: Didit supplementary identity/liveness adapter with encrypted configuration and verification session
Chat line: Implement STEP 172 only: Didit supplementary identity/liveness adapter with encrypted configuration and verification session. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 172: Didit supplementary identity/liveness adapter with encrypted configuration and verification session", push, and create docs/handoffs/STEP_172_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Didit supplementary identity/liveness adapter with encrypted configuration and verification session.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 173: Sumsub supplementary identity/liveness adapter with encrypted configuration and verification session
Chat line: Implement STEP 173 only: Sumsub supplementary identity/liveness adapter with encrypted configuration and verification session. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 173: Sumsub supplementary identity/liveness adapter with encrypted configuration and verification session", push, and create docs/handoffs/STEP_173_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Sumsub supplementary identity/liveness adapter with encrypted configuration and verification session.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 174: Supplementary IDV webhook verification and result handling without overriding processor KYB
Chat line: Implement STEP 174 only: Supplementary IDV webhook verification and result handling without overriding processor KYB. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 174: Supplementary IDV webhook verification and result handling without overriding processor KYB", push, and create docs/handoffs/STEP_174_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Supplementary IDV webhook verification and result handling without overriding processor KYB.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 175: super_admin selects at most one active supplementary IDV vendor with manual fallback and processor-KYB gate
Chat line: Implement STEP 175 only: super_admin selects at most one active supplementary IDV vendor with manual fallback and processor-KYB gate. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 175: super_admin selects at most one active supplementary IDV vendor with manual fallback and processor-KYB gate", push, and create docs/handoffs/STEP_175_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: super_admin selects at most one active supplementary IDV vendor with manual fallback and processor-KYB gate.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## TaxCloud Sales Tax

### STEP 176: TaxCloud documentation verification and connection design
Chat line: Implement STEP 176 only: TaxCloud documentation verification and connection design. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 176: TaxCloud documentation verification and connection design", push, and create docs/handoffs/STEP_176_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: TaxCloud documentation verification and connection design.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 177: Merchant TaxCloud account connect flow with masked credentials
Chat line: Implement STEP 177 only: Merchant TaxCloud account connect flow with masked credentials. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 177: Merchant TaxCloud account connect flow with masked credentials", push, and create docs/handoffs/STEP_177_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant TaxCloud account connect flow with masked credentials.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 178: Sales Tax Collection on and off setting per merchant
Chat line: Implement STEP 178 only: Sales Tax Collection on and off setting per merchant. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 178: Sales Tax Collection on and off setting per merchant", push, and create docs/handoffs/STEP_178_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Sales Tax Collection on and off setting per merchant.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 179: Automatic United States sales tax calculation on invoices
Chat line: Implement STEP 179 only: Automatic United States sales tax calculation on invoices. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 179: Automatic United States sales tax calculation on invoices", push, and create docs/handoffs/STEP_179_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Automatic United States sales tax calculation on invoices.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 180: Tax line storage on invoice and payment records and totals view
Chat line: Implement STEP 180 only: Tax line storage on invoice and payment records and totals view. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 180: Tax line storage on invoice and payment records and totals view", push, and create docs/handoffs/STEP_180_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Tax line storage on invoice and payment records and totals view.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Client Portal and Payment Pages

### STEP 181: Tokenized invoice page with paid state, receipt and buyer delivery/service-acceptance confirmation
Database ownership: append a separate migration/rollback for missing fulfilment evidence and buyer-acceptance records only; preserve existing invoice/payment rows and link them by immutable IDs. Payout remains blocked until valid evidence is recorded.
Chat line: Implement STEP 181 only: Tokenized invoice page with paid state, receipt and buyer delivery/service-acceptance confirmation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 181: Tokenized invoice page with paid state, receipt and buyer delivery/service-acceptance confirmation", push, and create docs/handoffs/STEP_181_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Tokenized invoice page with paid state, receipt and buyer delivery/service-acceptance confirmation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 182: Tokenized estimate page with signature approval, decline and expiry void handling
Chat line: Implement STEP 182 only: Tokenized estimate page with signature approval, decline and expiry void handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 182: Tokenized estimate page with signature approval, decline and expiry void handling", push, and create docs/handoffs/STEP_182_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Tokenized estimate page with signature approval, decline and expiry void handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 183: Payment page with provider hosted secure fields
Chat line: Implement STEP 183 only: Payment page with provider hosted secure fields. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 183: Payment page with provider hosted secure fields", push, and create docs/handoffs/STEP_183_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Payment page with provider hosted secure fields.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 184: 3D Secure request flow on card payments
Chat line: Implement STEP 184 only: 3D Secure request flow on card payments. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 184: 3D Secure request flow on card payments", push, and create docs/handoffs/STEP_184_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: 3D Secure request flow on card payments.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 185: Postal code and IP country match rule with manual review routing
Chat line: Implement STEP 185 only: Postal code and IP country match rule with manual review routing. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 185: Postal code and IP country match rule with manual review routing", push, and create docs/handoffs/STEP_185_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Postal code and IP country match rule with manual review routing.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 186: Provider fraud signal rejection handling
Chat line: Implement STEP 186 only: Provider fraud signal rejection handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 186: Provider fraud signal rejection handling", push, and create docs/handoffs/STEP_186_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Provider fraud signal rejection handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 187: Card blacklist check by token and fingerprint
Chat line: Implement STEP 187 only: Card blacklist check by token and fingerprint. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 187: Card blacklist check by token and fingerprint", push, and create docs/handoffs/STEP_187_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Card blacklist check by token and fingerprint.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 188: Card and IP velocity limit enforcement on payment page
Chat line: Implement STEP 188 only: Card and IP velocity limit enforcement on payment page. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 188: Card and IP velocity limit enforcement on payment page", push, and create docs/handoffs/STEP_188_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Card and IP velocity limit enforcement on payment page.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 189: Part payment on invoice link limited to remaining amount
Chat line: Implement STEP 189 only: Part payment on invoice link limited to remaining amount. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 189: Part payment on invoice link limited to remaining amount", push, and create docs/handoffs/STEP_189_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Part payment on invoice link limited to remaining amount.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 190: General payment link creation, hosted checkout page and merchant token revoke and reissue controls
Chat line: Implement STEP 190 only: General payment link creation, hosted checkout page and merchant token revoke and reissue controls. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 190: General payment link creation, hosted checkout page and merchant token revoke and reissue controls", push, and create docs/handoffs/STEP_190_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: General payment link creation, hosted checkout page and merchant token revoke and reissue controls.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Refunds, Disputes and Evidence

### STEP 191: Refund request and approval flow
Chat line: Implement STEP 191 only: Refund request and approval flow. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 191: Refund request and approval flow", push, and create docs/handoffs/STEP_191_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Refund request and approval flow.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 192: Refund execution through the originating provider
Chat line: Implement STEP 192 only: Refund execution through the originating provider. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 192: Refund execution through the originating provider", push, and create docs/handoffs/STEP_192_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Refund execution through the originating provider.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 193: Platform fee on refund rule applied from super admin setting
Chat line: Implement STEP 193 only: Platform fee on refund rule applied from super admin setting. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 193: Platform fee on refund rule applied from super admin setting", push, and create docs/handoffs/STEP_193_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Platform fee on refund rule applied from super admin setting.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 194: Dispute list and status tracking from provider webhooks
Chat line: Implement STEP 194 only: Dispute list and status tracking from provider webhooks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 194: Dispute list and status tracking from provider webhooks", push, and create docs/handoffs/STEP_194_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Dispute list and status tracking from provider webhooks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 195: Merchant dispute response form with 24 hour timezone aware deadline
Chat line: Implement STEP 195 only: Merchant dispute response form with 24 hour timezone aware deadline. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 195: Merchant dispute response form with 24 hour timezone aware deadline", push, and create docs/handoffs/STEP_195_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant dispute response form with 24 hour timezone aware deadline.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 196: Deadline warning emails at start and midpoint
Chat line: Implement STEP 196 only: Deadline warning emails at start and midpoint. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 196: Deadline warning emails at start and midpoint", push, and create docs/handoffs/STEP_196_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Deadline warning emails at start and midpoint.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 197: Structured evidence pack builder: invoice, delivery proof, communications
Chat line: Implement STEP 197 only: Structured evidence pack builder: invoice, delivery proof, communications. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 197: Structured evidence pack builder: invoice, delivery proof, communications", push, and create docs/handoffs/STEP_197_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Structured evidence pack builder: invoice, delivery proof, communications.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 198: Compliance review and evidence submission to processor
Chat line: Implement STEP 198 only: Compliance review and evidence submission to processor. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 198: Compliance review and evidence submission to processor", push, and create docs/handoffs/STEP_198_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Compliance review and evidence submission to processor.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 199: Chargeback rate monitoring with graduated actions and configurable thresholds
Chat line: Implement STEP 199 only: Chargeback rate monitoring with graduated actions and configurable thresholds. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 199: Chargeback rate monitoring with graduated actions and configurable thresholds", push, and create docs/handoffs/STEP_199_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Chargeback rate monitoring with graduated actions and configurable thresholds.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Public API and Store Plugins

### STEP 200: Merchant API credential creation with masked display
Chat line: Implement STEP 200 only: Merchant API credential creation with masked display. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 200: Merchant API credential creation with masked display", push, and create docs/handoffs/STEP_200_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant API credential creation with masked display.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 201: API credential revocation and regeneration
Chat line: Implement STEP 201 only: API credential revocation and regeneration. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 201: API credential revocation and regeneration", push, and create docs/handoffs/STEP_201_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: API credential revocation and regeneration.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 202: API authentication, rate limiting and audit logging
Chat line: Implement STEP 202 only: API authentication, rate limiting and audit logging. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 202: API authentication, rate limiting and audit logging", push, and create docs/handoffs/STEP_202_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: API authentication, rate limiting and audit logging.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 203: Store payment creation endpoint for online stores
Chat line: Implement STEP 203 only: Store payment creation endpoint for online stores. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 203: Store payment creation endpoint for online stores", push, and create docs/handoffs/STEP_203_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Store payment creation endpoint for online stores.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 204: Store payment status endpoint
Chat line: Implement STEP 204 only: Store payment status endpoint. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 204: Store payment status endpoint", push, and create docs/handoffs/STEP_204_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Store payment status endpoint.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 205: Store webhook delivery to merchant store with retries
Chat line: Implement STEP 205 only: Store webhook delivery to merchant store with retries. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 205: Store webhook delivery to merchant store with retries", push, and create docs/handoffs/STEP_205_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Store webhook delivery to merchant store with retries.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 206: Merchant test credentials and sandbox payment simulation
Chat line: Implement STEP 206 only: Merchant test credentials and sandbox payment simulation. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 206: Merchant test credentials and sandbox payment simulation", push, and create docs/handoffs/STEP_206_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant test credentials and sandbox payment simulation.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 207: Simulated webhook sender for merchant testing
Chat line: Implement STEP 207 only: Simulated webhook sender for merchant testing. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 207: Simulated webhook sender for merchant testing", push, and create docs/handoffs/STEP_207_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Simulated webhook sender for merchant testing.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 208: WooCommerce plugin connection with credential login
Chat line: Implement STEP 208 only: WooCommerce plugin connection with credential login. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 208: WooCommerce plugin connection with credential login", push, and create docs/handoffs/STEP_208_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: WooCommerce plugin connection with credential login.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 209: WooCommerce plugin payment and callback handling
Chat line: Implement STEP 209 only: WooCommerce plugin payment and callback handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 209: WooCommerce plugin payment and callback handling", push, and create docs/handoffs/STEP_209_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: WooCommerce plugin payment and callback handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 210: Shopify app connection with credential login after install
Chat line: Implement STEP 210 only: Shopify app connection with credential login after install. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 210: Shopify app connection with credential login after install", push, and create docs/handoffs/STEP_210_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Shopify app connection with credential login after install.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 211: Shopify app payment and callback handling
Chat line: Implement STEP 211 only: Shopify app payment and callback handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 211: Shopify app payment and callback handling", push, and create docs/handoffs/STEP_211_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Shopify app payment and callback handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Plans and Subscription Billing

### STEP 212: Plan creation by super_admin with price, period and services
Chat line: Implement STEP 212 only: Plan creation by super_admin with price, period and services. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 212: Plan creation by super_admin with price, period and services", push, and create docs/handoffs/STEP_212_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Plan creation by super_admin with price, period and services.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 213: Plan entitlement checks across merchant features
Chat line: Implement STEP 213 only: Plan entitlement checks across merchant features. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 213: Plan entitlement checks across merchant features", push, and create docs/handoffs/STEP_213_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Plan entitlement checks across merchant features.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 214: Subscription assignment and status tracking
Chat line: Implement STEP 214 only: Subscription assignment and status tracking. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 214: Subscription assignment and status tracking", push, and create docs/handoffs/STEP_214_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Subscription assignment and status tracking.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 215: Saved card mandate consent capture with versioned record
Chat line: Implement STEP 215 only: Saved card mandate consent capture with versioned record. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 215: Saved card mandate consent capture with versioned record", push, and create docs/handoffs/STEP_215_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Saved card mandate consent capture with versioned record.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 216: Subscription charge from balance service
Chat line: Implement STEP 216 only: Subscription charge from balance service. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 216: Subscription charge from balance service", push, and create docs/handoffs/STEP_216_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Subscription charge from balance service.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 217: Subscription charge from saved card through platform account
Chat line: Implement STEP 217 only: Subscription charge from saved card through platform account. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 217: Subscription charge from saved card through platform account", push, and create docs/handoffs/STEP_217_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Subscription charge from saved card through platform account.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 218: Seven day advance warning emails before due date
Chat line: Implement STEP 218 only: Seven day advance warning emails before due date. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 218: Seven day advance warning emails before due date", push, and create docs/handoffs/STEP_218_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Seven day advance warning emails before due date.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 219: Service stop on failed charge with login, billing and support kept open
Chat line: Implement STEP 219 only: Service stop on failed charge with login, billing and support kept open. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 219: Service stop on failed charge with login, billing and support kept open", push, and create docs/handoffs/STEP_219_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Service stop on failed charge with login, billing and support kept open.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 220: Automatic service restore on successful payment
Chat line: Implement STEP 220 only: Automatic service restore on successful payment. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 220: Automatic service restore on successful payment", push, and create docs/handoffs/STEP_220_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Automatic service restore on successful payment.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Email, Support and Status

### STEP 221: SMTP configuration screen with encrypted secrets and test email
Chat line: Implement STEP 221 only: SMTP configuration screen with encrypted secrets and test email. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 221: SMTP configuration screen with encrypted secrets and test email", push, and create docs/handoffs/STEP_221_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: SMTP configuration screen with encrypted secrets and test email.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 222: API email provider configuration with encrypted secrets and test email
Chat line: Implement STEP 222 only: API email provider configuration with encrypted secrets and test email. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 222: API email provider configuration with encrypted secrets and test email", push, and create docs/handoffs/STEP_222_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: API email provider configuration with encrypted secrets and test email.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 223: Active sending method selection with audit logging
Chat line: Implement STEP 223 only: Active sending method selection with audit logging. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 223: Active sending method selection with audit logging", push, and create docs/handoffs/STEP_223_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Active sending method selection with audit logging.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 224: Email template editor for super_admin
Chat line: Implement STEP 224 only: Email template editor for super_admin. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 224: Email template editor for super_admin", push, and create docs/handoffs/STEP_224_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Email template editor for super_admin.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 225: Activity email events wiring for account, KYC, invoice and payment events
Chat line: Implement STEP 225 only: Activity email events wiring for account, KYC, invoice and payment events. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 225: Activity email events wiring for account, KYC, invoice and payment events", push, and create docs/handoffs/STEP_225_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Activity email events wiring for account, KYC, invoice and payment events.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 226: Email send logging with provider message id
Chat line: Implement STEP 226 only: Email send logging with provider message id. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 226: Email send logging with provider message id", push, and create docs/handoffs/STEP_226_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Email send logging with provider message id.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 227: Failed email retry background job
Chat line: Implement STEP 227 only: Failed email retry background job. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 227: Failed email retry background job", push, and create docs/handoffs/STEP_227_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Failed email retry background job.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 228: Support ticket creation with file attachment
Chat line: Implement STEP 228 only: Support ticket creation with file attachment. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 228: Support ticket creation with file attachment", push, and create docs/handoffs/STEP_228_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Support ticket creation with file attachment.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 229: Support ticket assignment, reply by email and status flow
Chat line: Implement STEP 229 only: Support ticket assignment, reply by email and status flow. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 229: Support ticket assignment, reply by email and status flow", push, and create docs/handoffs/STEP_229_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Support ticket assignment, reply by email and status flow.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 230: Public status page with incident announcements
Chat line: Implement STEP 230 only: Public status page with incident announcements. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 230: Public status page with incident announcements", push, and create docs/handoffs/STEP_230_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Public status page with incident announcements.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Public Website, CMS and Blog

### STEP 231: Public layout with header, footer and SEO structure
Chat line: Implement STEP 231 only: Public layout with header, footer and SEO structure. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 231: Public layout with header, footer and SEO structure", push, and create docs/handoffs/STEP_231_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Public layout with header, footer and SEO structure.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 232: Home page built from CMS content
Chat line: Implement STEP 232 only: Home page built from CMS content. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 232: Home page built from CMS content", push, and create docs/handoffs/STEP_232_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Home page built from CMS content.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 233: Product and Pricing pages with detailed public price list
Chat line: Implement STEP 233 only: Product and Pricing pages with detailed public price list. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 233: Product and Pricing pages with detailed public price list", push, and create docs/handoffs/STEP_233_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Product and Pricing pages with detailed public price list.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 234: Company, Legal, Support and Contact pages with Turnstile form
Chat line: Implement STEP 234 only: Company, Legal, Support and Contact pages with Turnstile form. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 234: Company, Legal, Support and Contact pages with Turnstile form", push, and create docs/handoffs/STEP_234_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Company, Legal, Support and Contact pages with Turnstile form.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 235: Policy pages rendered from CMS with version display
Chat line: Implement STEP 235 only: Policy pages rendered from CMS with version display. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 235: Policy pages rendered from CMS with version display", push, and create docs/handoffs/STEP_235_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Policy pages rendered from CMS with version display.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 236: Blog post create, edit and publish flow for blogger
Chat line: Implement STEP 236 only: Blog post create, edit and publish flow for blogger. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 236: Blog post create, edit and publish flow for blogger", push, and create docs/handoffs/STEP_236_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Blog post create, edit and publish flow for blogger.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 237: Blog listing and article pages with SEO metadata
Chat line: Implement STEP 237 only: Blog listing and article pages with SEO metadata. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 237: Blog listing and article pages with SEO metadata", push, and create docs/handoffs/STEP_237_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Blog listing and article pages with SEO metadata.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 238: CMS page editor for every public page with publish control
Chat line: Implement STEP 238 only: CMS page editor for every public page with publish control. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 238: CMS page editor for every public page with publish control", push, and create docs/handoffs/STEP_238_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: CMS page editor for every public page with publish control.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Company Accounting and Metrics

### STEP 239: Company income and expense recording for platform operations
Chat line: Implement STEP 239 only: Company income and expense recording for platform operations. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 239: Company income and expense recording for platform operations", push, and create docs/handoffs/STEP_239_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Company income and expense recording for platform operations.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 240: Processor bill matching against platform records
Chat line: Implement STEP 240 only: Processor bill matching against platform records. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 240: Processor bill matching against platform records", push, and create docs/handoffs/STEP_240_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Processor bill matching against platform records.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 241: super_admin metrics: volume, active merchants, chargeback rate, average hold, platform revenue
Chat line: Implement STEP 241 only: super_admin metrics: volume, active merchants, chargeback rate, average hold, platform revenue. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 241: super_admin metrics: volume, active merchants, chargeback rate, average hold, platform revenue", push, and create docs/handoffs/STEP_241_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: super_admin metrics: volume, active merchants, chargeback rate, average hold, platform revenue.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 242: Merchant metrics: own volume, chargeback rate, holds, income and balance
Chat line: Implement STEP 242 only: Merchant metrics: own volume, chargeback rate, holds, income and balance. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 242: Merchant metrics: own volume, chargeback rate, holds, income and balance", push, and create docs/handoffs/STEP_242_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Merchant metrics: own volume, chargeback rate, holds, income and balance.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 243: Finance operations screens for reconciliation and payout handling
Chat line: Implement STEP 243 only: Finance operations screens for reconciliation and payout handling. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 243: Finance operations screens for reconciliation and payout handling", push, and create docs/handoffs/STEP_243_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Finance operations screens for reconciliation and payout handling.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

## Performance, Deployment and Launch Verification

### STEP 244: Pagination and column selection pass on every list endpoint
Chat line: Implement STEP 244 only: Pagination and column selection pass on every list endpoint. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 244: Pagination and column selection pass on every list endpoint", push, and create docs/handoffs/STEP_244_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Pagination and column selection pass on every list endpoint.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 245: Caching for public pages and dashboard summaries
Chat line: Implement STEP 245 only: Caching for public pages and dashboard summaries. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 245: Caching for public pages and dashboard summaries", push, and create docs/handoffs/STEP_245_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Caching for public pages and dashboard summaries.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 246: Image and font optimization and lazy loading pass
Chat line: Implement STEP 246 only: Image and font optimization and lazy loading pass. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 246: Image and font optimization and lazy loading pass", push, and create docs/handoffs/STEP_246_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Image and font optimization and lazy loading pass.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 247: Netlify deployment configuration, environment verification, backup and restore rehearsal record
Chat line: Implement STEP 247 only: Netlify deployment configuration, environment verification, backup and restore rehearsal record. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 247: Netlify deployment configuration, environment verification, backup and restore rehearsal record", push, and create docs/handoffs/STEP_247_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Netlify deployment configuration, environment verification, backup and restore rehearsal record.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 248: Vercel deployment configuration, monitoring and alerting wiring with Sentry and uptime checks
Chat line: Implement STEP 248 only: Vercel deployment configuration, monitoring and alerting wiring with Sentry and uptime checks. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 248: Vercel deployment configuration, monitoring and alerting wiring with Sentry and uptime checks", push, and create docs/handoffs/STEP_248_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Vercel deployment configuration, monitoring and alerting wiring with Sentry and uptime checks.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 249: Register and verify daily screening, re-KYC, volume-spike, tier-limit and fulfilment-gated payout schedules
Chat line: Implement STEP 249 only: Register and verify daily screening, re-KYC, volume-spike, tier-limit and fulfilment-gated payout schedules. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 249: Register and verify daily screening, re-KYC, volume-spike, tier-limit and fulfilment-gated payout schedules", push, and create docs/handoffs/STEP_249_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Register and verify daily screening, re-KYC, volume-spike, tier-limit and fulfilment-gated payout schedules.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.

### STEP 250: Final staging verification, independent security/compliance review evidence, production go-live gates and launch record
Chat line: Implement STEP 250 only: Final staging verification, independent security/compliance review evidence, production go-live gates and launch record. Follow docs/final/FEATURE_LIST.md and docs/final/MASTER_PROMPT.md. Work only on files owned by this STEP. At the end run typecheck and lint, commit with message "STEP 250: Final staging verification, independent security/compliance review evidence, production go-live gates and launch record", push, and create docs/handoffs/STEP_250_COMPLETED.md.
Sub-steps (same chat session, in order):
   1. Read the matching FEATURE_LIST section, MASTER_PROMPT rules and the previous handoff file.
   2. Confirm the owned paths for this STEP from the File Ownership Rules and list them in the working notes.
   3. Implement the database part of this STEP if any (migration plus rollback proof).
   4. Implement the core service and logic for: Final staging verification, independent security/compliance review evidence, production go-live gates and launch record.
   5. Connect the API routes or background jobs for this STEP.
   6. Build or update the UI for this STEP where applicable and check desktop and mobile widths.
   7. Verify security for this STEP: validation, RLS, audit log entries and permission checks.
   8. Run typecheck, lint and build for the touched area, exercise the behaviours named in the title, then finish with one commit, push and the completed handoff file.
