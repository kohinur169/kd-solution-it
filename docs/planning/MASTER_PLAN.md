// path: docs/planning/MASTER_PLAN.md
# KD SOLUTION IT - Master Execution Plan (Planning Only, No Code in This Chat)

> REVISION V2 (current authority): docs/planning/REVISED_FEATURE_LIST_V2.md supersedes every
> conflicting part of this plan. Removed: WhatsApp, payroll, HR, accounting, tax reports, tax
> filing, social automation, Google Drive, merchant staff accounts, and 11 of 16 providers.
> Providers are now only NMI, Payoneer, Rainforest, Stripe Connect, Airwallex. Tax module is
> removed, sales tax collection only is kept. Office roles are super_admin, ceo, compliance_kyc,
> support, blogger. Owner has no staff option. Performance and low database pressure rules apply.

## 1. Repository State Analyzed
- Repository contains only: README.md, MASTER_PROMPT .md (1621 lines), FEATURE_LIST.md (4911 lines).
- No application code exists yet. This is a greenfield build.
- FEATURE_LIST.md defines 11 PARTS, approx 3950+ features:
  PART 1 Core Foundation and Branding (375), PART 2 Auth Onboarding Settings (391),
  PART 3 Invoicing and Business Core (476), PART 4 Payment Gateway and MoR (423),
  PART 5 Client Experience (275), PART 6 WhatsApp Social API Integrations (413),
  PART 7 Super Admin SEO Analytics Marketing (445), PART 8 Payroll HR Accounting Reports (356),
  PART 9 Security Compliance Performance (296), PART 10 Deploy CI Final Polish (150),
  PART 11 Enhanced Security Roles Zero Trust (425).

## 2. Binding Rules (apply to every STEP, every chat)
English only in code/UI/comments/seeds. USD only, numeric(18,4), no JS Number for money (decimal library).
Text data in Supabase PostgreSQL. Files: company Google Drive if connected, else Supabase Storage;
AES-256-GCM encryption before upload; storage_provider recorded per file; runtime per-company routing;
automatic fallback to the other provider; file migration tool between providers.
No test files. No TODO/FIXME/placeholder. No any types, TypeScript strict. No console.log, structured logging.
Path comment on every file. Every table: id UUID v7, company_id, created_at, updated_at, deleted_at, version.
RLS enabled default-deny on every table. Audit log on every mutation. Zod validation client and server.
Sanitize every input. Idempotency key on every payment. Optimistic locking on editable records.
Roles: super_admin > ceo > admin_staff > owner > staff. Client is tokenized, no login.
Approval chain: staff -> CEO -> super_admin for all controlled actions.
Payment partner display names: only "Global Payout Partners" or "Local Payment Methods via Licensed Partners".
Zero Trust and Zero Tolerance security. VPN/Proxy/Tor detection and blocking on signup, payment, KYC, admin.
Stack: Next.js 14+ App Router, TypeScript strict, Tailwind, shadcn/ui, Supabase, Google Drive API,
Stripe/PayPal/Paddle/NMI/Rapyd/Adyen/Custom plus full 16-provider list in Section 4,
Universal SMTP, Meta WhatsApp Cloud API, Netlify primary deploy, Sentry, Cloudflare Turnstile, DOMPurify, CSP nonce.

## 3. New Requirements Merged Into This Plan
N1 Provider documentation rule: before coding any provider adapter, the coding chat MUST fetch and read that
   provider's latest official documentation and sandbox pages from the provider's own website in that same
   session. No adapter code from memory or assumption. Verified doc URL and sandbox URL must be recorded
   in the adapter file header comment and in docs/providers/PROVIDER_DOCS.md.
N2 Sixteen providers planned from the start, one adapter file per provider, one registry file listing all:
   Stripe, NMI, Adyen, Verifone (2Checkout), Braintree (PayPal), BlueSnap, Square, Payoneer, FastSpring,
   Paddle, PayPro Global, PayPal (standalone), Payarc/PaymentCloud, Rapyd, Authorize.Net, Custom. Total 16.
N3 NMI dual frontend modes, both kept: Collect.js (default, single-use token, 24h token expiry) and
   Payment Component (npm package, package added only via integrator-owned package.json change request).
   Both modes send payment server-side through one shared module using NMI REST API.
   Mode switchable per provider from super admin dashboard. Only one mode active per provider at a time.
   Successful test in new mode required before switch. Every switch written to audit log.
N4 Super admin API connection page: super_admin only, 2FA plus fresh reauthentication required.
   Set keys, test connection, enable/disable any provider without code change or redeploy.
   Keys encrypted with AES-256-GCM before storage, encryption key only in environment variable, never in DB.
   After save, key never shown again, only last characters and last-updated time.
   Provider cannot be enabled if test fails. Cannot add a provider that has no adapter in code.
   If no routing rule matches, payment is rejected, never silently sent to another provider.
N5 Login lock: 2 consecutive failed password or failed 2FA attempts lock the account for 2 hours.
   During lock: correct password does not log in, password reset disabled, password change does not clear lock.
   Owner alerted by email when lock starts. Unlock only by admin/admin_staff with unlock permission,
   only after confirming contact with owner by email, every unlock audit-logged.
   Failed-attempt counter and lock state stored in database (survives server restart).
   IP-based rate limiting also applies. Error messages never reveal whether an account exists.
N6 Card payment rules: card number, expiry, CVV entered only in provider-hosted secure fields.
   Our code and server never read, store, or keylog card data.
   After one successful card payment on an invoice, same card cannot pay same invoice again for 24 hours.
   Other invoices unaffected. Card or authentication failures (wrong number, wrong CVV, wrong OTP, 3DS failure)
   counted per card token: 2 failures within 24 hours means third attempt rejects that card.
   Insufficient-funds failures are NOT counted. Provider fraud signal or blacklisted card rejected immediately.
   Blacklist keyed by card token or provider card fingerprint, never by card number.
   Velocity limits for card and IP, default limits stored in config.
N7 Verification: request 3D Secure on every payment where possible. If 3DS not completed, capture only when
   billing postal code AND payer IP country both match invoice data. If either mismatches, do not capture,
   send to manual review queue. VPN/Proxy/Tor checks also apply on payment page.
   Provider webhooks accepted only after signature verification, processed idempotently.
N8 File storage routing as in Section 2 binding rules (Drive if connected per company, else Supabase Storage).

## 4. Sub-Merchant (PayFac / MoR) Module - Planned as SM Series
SM-1 Onboarding states: signup -> email verify -> company profile -> KYC documents submitted ->
     manual review by KYC Manager/CEO/super_admin -> approved or rejected with reason -> provider provisioning.
SM-2 Automatic sub-account creation: on KYC approval event, system calls the connected master provider
     (for example Stripe Connect type platform account, Adyen Marketplaces, Rapyd or equivalent abstraction
     lib/payments/submerchant/) and creates a sub-merchant account under the KD SOLUTION IT master account.
     Trigger is an idempotent, audited background job; provider_submerchant_id, provider name, status,
     charges_enabled, payouts_enabled stored on the company record. If master provider is not connected,
     provisioning stays in queued state and admin is alerted, no fake account is created.
SM-3 Provider verification sync: provider may request extra documents; status synced by webhook
     (verified, pending, restricted, rejected). Payouts stay disabled until provider status is verified.
SM-4 Split and settlement: platform fee percent per plan, split payment at charge time where provider
     supports it, otherwise ledger-based settlement. Settlement schedule, hold period, reserve percent
     configurable by super admin. All amounts USD numeric(18,4).
SM-5 Tax module TAX-1: US sales tax collection by state nexus, tax rate table, tax collected ledger per
     sub-merchant, monthly/quarterly tax summary, 1099-K data export for US sub-merchants above threshold,
     W-9 collection for US and W-8BEN/W-8BEN-E collection for non-US, VAT/GST collection fields for other
     countries (rate, registration number, reverse-charge flag), withholding tax records, tax remittance
     report per jurisdiction. Tax is calculated and reported, filing itself stays with the business and its
     accountant inside the system reports. Every tax record linked to invoice, payment, sub-merchant.
SM-6 Risk: rolling reserve, payout hold on fraud score, chargeback liability rule recorded in terms
     acceptance at signup (timestamp, IP, document version) for every sub-merchant.

## 5. LR-022 Session Security Module - Planned in STEP 3
Session cookie bound to one session only: HttpOnly, Secure, SameSite=Strict cookie plus server-side session row.
Device proof: per-device key pair generated in browser (WebCrypto, non-extractable private key), public key
registered at login, each sensitive request signed by device key, server verifies signature and nonce.
Cookie replay protection: rotating session token on every privileged request, old token reuse detected,
reuse immediately revokes whole session family and alerts owner and admin.
Reauthentication: password plus 2FA required for gateway keys, payouts, KYC decisions, unlock, role changes.
Revocation: user, owner and admin session revoke lists, revoke takes effect on next request, all revocations audited.
Audit protection: audit log hash chain, append-only table, no update/delete policy, periodic root hash export.

## 6. Sixteen STEPs, Each Split Into Sub-Steps (one sub-step = one chat)
STEP 1  Foundation: repo scaffold, config, env schema, lint guards, logging, error format. Sub-steps 1.1-1.3
STEP 2  Database: schema, migrations with rollback, RLS default-deny, audit, idempotency, locking. Sub-steps 2.1-2.4
STEP 3  Auth and Session: Supabase Auth, 2FA, login lock N5, LR-022 device-bound sessions, Turnstile, VPN block. Sub-steps 3.1-3.4
STEP 4  Tenant, Onboarding, KYC and File Storage routing N8: company, team invite, KYC upload/review. Sub-steps 4.1-4.4
STEP 5  Invoicing Core: clients, products, invoices, numbering, tax lines TAX-1 basics, PDF. Sub-steps 5.1-5.4
STEP 6  Payment Core: money library, provider registry, routing rules N4, super admin gateway page, webhook inbox. Sub-steps 6.1-6.4
STEP 7  Adapters Group A: Stripe, PayPal standalone, Braintree, Paddle. One provider per sub-step 7.1-7.4 (docs first per N1)
STEP 8  Adapters Group B: NMI dual mode N3, Adyen, Rapyd, Authorize.Net. Sub-steps 8.1-8.4
STEP 9  Adapters Group C and Sub-Merchant: Verifone, BlueSnap, Square, Payoneer, FastSpring, PayPro Global,
        Payarc, Custom, plus SM-1 to SM-6 and TAX-1 full. Sub-steps 9.1-9.6
STEP 10 Client Portal and Payment Page: tokenized invoice/estimate links, card rules N6, 3DS rules N7, receipts. Sub-steps 10.1-10.3
STEP 11 Payroll, HR, Accounting: employees, payroll runs, chart of accounts, journal, reports, tax filing reports. Sub-steps 11.1-11.4
STEP 12 Super Admin and Approval Chain: super_admin/CEO/admin_staff panels, approvals, gateway control N4 UI, unlock UI. Sub-steps 12.1-12.4
STEP 13 Communications and Integrations: universal SMTP, email templates, WhatsApp Meta Cloud API, public API keys. Sub-steps 13.1-13.3
STEP 14 Public Website and CMS: public pages, blog, legal pages, SEO, lead forms. Sub-steps 14.1-14.3
STEP 15 Security Hardening: fraud engine, card blacklist, velocity, VPN/Proxy/Tor, SIEM export, rate limits. Sub-steps 15.1-15.3
STEP 16 Deploy and Launch: Netlify config, env checklist, Sentry, cron jobs, backup, go-live checklist. Sub-steps 16.1-16.3
Total: 16 STEPs, 57 sub-step chats. No two chats own the same file. Ownership map is in CHAT_PROMPTS.md.

## 7. Branch and Conflict Rules
Single working branch for this session series. Every chat: pull latest, read MASTER_PLAN.md and
CHAT_PROMPTS.md and previous STEP_COMPLETED.md handoff, work only on its listed files, run typecheck and lint,
commit with message "STEP X.Y: title", push, write STEP_X_Y_COMPLETED.md handoff before ending.
package.json and lockfile are integrator-owned: any chat needing a package writes a package request in its
handoff file instead of editing package.json directly. One integrator chat applies package changes.
Database migrations are append-only, numbered sequentially, never edited after commit.

## 8. Accounts Needed Before Live (owner provides, never pasted in chat code)
Supabase project, Netlify site, Google Cloud service account for Drive, Cloudflare Turnstile keys,
SMTP provider credentials, Sentry DSN, master payment provider accounts for sub-merchant provisioning,
IP reputation provider key for VPN/Proxy/Tor detection. All values only in environment variables / Netlify env.
