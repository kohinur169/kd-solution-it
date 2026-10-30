// path: docs/planning/CHAT_PROMPTS.md
# Copy-Paste Prompt For Every New Chat (English, use exactly this structure)

## A. Master Block - paste this FIRST in every new STEP chat, change only STEP number and title

Read docs/planning/MASTER_PLAN.md, docs/planning/CHAT_PROMPTS.md, MASTER_PROMPT .md and FEATURE_LIST.md
from this repository, plus the previous STEP_COMPLETED handoff file. Follow every binding rule in
MASTER_PLAN.md Section 2 with zero exception. English only in all code, UI, comments and seeds.
USD only, numeric(18,4), never JavaScript Number for money. No test files, no TODO, no placeholder,
no any type, no console.log. Path comment on every file. Work only on the files owned by this STEP
listed below. Do not edit package.json; if a package is needed, write a package request in the handoff file.
Before coding any payment provider, fetch and read that provider's latest official documentation and
sandbox pages from the provider's own website in this session and record the verified URLs.
At the end: run typecheck and lint, commit with message "STEP X.Y: title", push this branch, and create
STEP_X_Y_COMPLETED.md listing files created, migrations added, env vars added, and next STEP dependency.

## B. One line to add per chat (STEP and owned scope)

STEP 1.1 Scaffold Next.js TypeScript strict, Tailwind, shadcn setup files, config folder, env schema. Owns: root config files, config/.
STEP 1.2 Security core library: sanitizer, CSP, rate limit helpers, structured logger. Owns: lib/security/, lib/logging/.
STEP 1.3 i18n English strings file, design tokens, layout shell. Owns: lib/i18n/, components/layout/.
STEP 2.1 Core migrations: companies, users, roles, audit_logs, sessions. Owns: migrations/0001-0005.
STEP 2.2 Billing catalog migrations: plans, subscriptions, coupons, entitlements. Owns: migrations/0006-0010.
STEP 2.3 Payment core migrations: providers, provider_keys, routing_rules, payments, idempotency_keys, card_blacklist. Owns: migrations/0011-0016.
STEP 2.4 RLS policies default-deny for all tables created so far plus audit hash chain function. Owns: migrations/0017-0020.
STEP 3.1 Supabase Auth integration, signup, login, email verify, Turnstile. Owns: app/(auth)/, app/api/auth/.
STEP 3.2 2FA TOTP, backup codes, step-up reauthentication. Owns: lib/auth/two-factor/, app/api/auth/2fa/.
STEP 3.3 Login lock rule (2 failures, 2 hour lock, email alert, admin unlock). Owns: lib/auth/login-lock/, app/api/admin/unlock/.
STEP 3.4 LR-022 device-bound sessions: device proof, cookie replay detection, revocation. Owns: lib/auth/session/, lib/security/device-proof/.
STEP 4.1 Company onboarding wizard and company settings. Owns: app/(dashboard)/onboarding/, services/company/.
STEP 4.2 Team invite, staff roles and permissions. Owns: services/team/, app/(dashboard)/team/.
STEP 4.3 File storage routing: Drive adapter, Supabase Storage adapter, AES-256-GCM, fallback, migration tool. Owns: lib/storage/.
STEP 4.4 KYC upload and manual review queue. Owns: app/(dashboard)/kyc/, app/(admin)/kyc/, services/kyc/.
STEP 5.1 Clients and products CRUD with optimistic locking. Owns: services/clients/, services/products/.
STEP 5.2 Invoice CRUD, line items, decimal calculation engine. Owns: services/invoices/, lib/money/.
STEP 5.3 Invoice numbering, status workflow, recurring invoices. Owns: services/invoices/workflow/.
STEP 5.4 Invoice PDF generation and file storage link. Owns: services/pdf/, components/invoices/.
STEP 6.1 Provider registry and adapter interface for all 16 providers. Owns: lib/payments/registry.ts, lib/payments/types.ts.
STEP 6.2 Routing rules engine, reject when no rule matches. Owns: lib/payments/routing/.
STEP 6.3 Super admin gateway connection page backend: encrypted key storage, test, enable disable. Owns: app/api/admin/gateways/, lib/payments/key-vault/.
STEP 6.4 Webhook inbox: signature verify, idempotent processing, replay guard. Owns: app/api/webhooks/, services/webhooks/.
STEP 7.1 Stripe adapter after reading official Stripe docs and testing page in this session. Owns: lib/payments/adapters/stripe.ts.
STEP 7.2 PayPal standalone adapter after reading official PayPal REST docs in this session. Owns: lib/payments/adapters/paypal.ts.
STEP 7.3 Braintree adapter after reading official Braintree docs in this session. Owns: lib/payments/adapters/braintree.ts.
STEP 7.4 Paddle adapter after reading official Paddle docs in this session. Owns: lib/payments/adapters/paddle.ts.
STEP 8.1 NMI adapter dual mode Collect.js default plus Payment Component, shared REST module, after reading NMI docs. Owns: lib/payments/adapters/nmi/, components/payments/nmi/.
STEP 8.2 Adyen adapter after reading official Adyen docs in this session. Owns: lib/payments/adapters/adyen.ts.
STEP 8.3 Rapyd adapter after reading official Rapyd docs in this session. Owns: lib/payments/adapters/rapyd.ts.
STEP 8.4 Authorize.Net adapter after reading official Authorize.Net docs in this session. Owns: lib/payments/adapters/authorize-net.ts.
STEP 9.1 Verifone 2Checkout adapter after reading official Verifone docs. Owns: lib/payments/adapters/verifone.ts.
STEP 9.2 BlueSnap adapter after reading official BlueSnap docs and llms index, find correct test-mode page. Owns: lib/payments/adapters/bluesnap.ts.
STEP 9.3 Square and Payoneer adapters after reading official docs for each. Owns: lib/payments/adapters/square.ts, lib/payments/adapters/payoneer.ts.
STEP 9.4 FastSpring and PayPro Global adapters, find and record sandbox pages from official docs. Owns: lib/payments/adapters/fastspring.ts, lib/payments/adapters/paypro-global.ts.
STEP 9.5 Payarc and Custom adapters, find and record Payarc sandbox from official docs. Owns: lib/payments/adapters/payarc.ts, lib/payments/adapters/custom.ts.
STEP 9.6 Sub-merchant provisioning SM-1 to SM-6 plus tax module TAX-1. Owns: lib/payments/submerchant/, services/tax/, migrations for submerchant and tax tables.
STEP 10.1 Tokenized client portal invoice and estimate pages. Owns: app/(client-portal)/.
STEP 10.2 Payment page: provider hosted fields only, card rules, 24h same-card same-invoice block, failure counter. Owns: components/payments/, lib/payments/card-rules/.
STEP 10.3 3D Secure flow, postal and IP country match rule, manual review queue. Owns: lib/payments/verification/, app/(admin)/reviews/.
STEP 11.1 Employees and departments. Owns: services/hr/, app/(dashboard)/employees/.
STEP 11.2 Payroll runs, payslips, payroll files. Owns: services/payroll/.
STEP 11.3 Chart of accounts, journal entries, double-entry ledger. Owns: services/accounting/.
STEP 11.4 Financial and tax reports. Owns: services/reports/, app/(dashboard)/reports/.
STEP 12.1 Super admin dashboard shell and user management. Owns: app/(admin)/.
STEP 12.2 CEO and admin_staff panels, approval chain engine. Owns: services/approvals/, app/(admin)/approvals/.
STEP 12.3 Gateway control UI including NMI mode switch with pre-switch test and audit. Owns: app/(admin)/gateways/.
STEP 12.4 Audit log viewer, session revoke UI, account unlock UI. Owns: app/(admin)/audit/, app/(admin)/sessions/.
STEP 13.1 Universal SMTP adapter and platform plus tenant SMTP settings. Owns: lib/email/.
STEP 13.2 Email templates English only and notification events. Owns: lib/email/templates/, services/notifications/.
STEP 13.3 WhatsApp Meta Cloud API and public API keys with rate limits. Owns: lib/whatsapp/, app/api/public/.
STEP 14.1 Public website pages CMS editable. Owns: app/(public)/.
STEP 14.2 Blog, legal pages, support pages. Owns: app/(public)/blog/, app/(public)/legal/.
STEP 14.3 SEO metadata, sitemap, lead capture forms. Owns: lib/seo/, app/(public)/contact/.
STEP 15.1 Fraud engine, velocity limits, card blacklist management. Owns: lib/security/fraud-engine/, lib/payments/blacklist/.
STEP 15.2 VPN Proxy Tor detection and blocking on signup, payment, KYC, admin. Owns: lib/security/network-trust/.
STEP 15.3 Rate limiting completion, SIEM export, security headers final pass. Owns: lib/security/rate-limit/, lib/security/siem/.
STEP 16.1 Netlify deployment config, environment checklist, cron jobs. Owns: netlify.toml, docs/deploy/.
STEP 16.2 Sentry, monitoring, backup and restore runbook. Owns: lib/monitoring/, docs/runbook/.
STEP 16.3 Final go-live verification: build, typecheck, lint, RLS check, env check, GO_LIVE_CHECKLIST.md. Owns: docs/deploy/GO_LIVE_CHECKLIST.md.

## C. Rules so chats never conflict
One chat owns only its listed files. Shared files (package.json, registry, migrations index) change only in
their owner chat. Each chat starts by pulling the latest branch and reading the previous handoff file.
Each chat ends with one commit and one handoff file. Never start STEP N+1 before STEP N handoff exists.
