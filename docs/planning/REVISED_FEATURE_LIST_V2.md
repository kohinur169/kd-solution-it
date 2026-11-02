// path: docs/planning/REVISED_FEATURE_LIST_V2.md
# KD SOLUTION IT - Revised Feature List V2 (Supersedes Conflicting Parts of Earlier Plans)

This document is the current scope authority. Where MASTER_PROMPT .md, FEATURE_LIST.md,
docs/planning/MASTER_PLAN.md or docs/planning/CHAT_PROMPTS.md conflict with this document,
this document wins. Decision date: this revision removes the modules listed in Section 1.

## 1. Removed Completely (no code, no tables, no UI for these)
- WhatsApp automation and Meta WhatsApp Cloud API module.
- Payroll module.
- HR and employee management module.
- Accounting module (chart of accounts, journal, ledger, bookkeeping).
- Tax report module and tax filing module.
- Social automation module.
- Google Drive storage (no Drive adapter, no Drive connection, no Drive migration tool).
- Staff accounts for owners and sub-merchants: an owner or sub-merchant cannot add staff.
  There is no staff role under a merchant.
- Eleven payment processors removed. Only the five providers in Section 5 remain.
- Full tax module TAX-1 (nexus engine, W-9/W-8 collection workflow, 1099-K export,
  VAT/GST module, withholding module, tax filing reports). Sales tax collection in
  Section 7 is kept and is not a tax module.

## 2. Role Model (final)
Platform office roles only for internal team:
- super_admin: full control, gateway keys, platform fee and settlement hold settings.
- ceo: office management and approvals below super_admin.
- compliance_kyc: KYC review, compliance checks, blacklist review, manual payment review.
- support: support tickets and merchant help, no gateway key access, no KYC approval.
- blogger: blog posts and public content only, no merchant data access.
Merchant side:
- owner: one account per business (sub-merchant). No staff add option, no sub-user invite.
Client side:
- client: tokenized link access only, no login, no account.
Approval chain for controlled actions: requester -> ceo -> super_admin.
Compliance decisions: compliance_kyc reviews, ceo or super_admin gives final approval where required.

## 3. Core Platform (kept)
- Multi-tenant SaaS, company isolation, RLS default-deny on every table.
- English only everywhere in code, UI, comments, seeds and templates.
- USD only, numeric(18,4), decimal library for money, never JavaScript Number for money.
- Every table: id UUID v7, company_id, created_at, updated_at, deleted_at, version.
- Audit log (hash chained, append only) on every mutation.
- Zod validation client and server, input sanitization, CSRF, XSS and SQL injection prevention.
- Idempotency key on every payment. Optimistic locking on editable records.
- Path comment on every file, TypeScript strict, no any, no test files, no TODO or placeholder.
- Structured logging, no console.log. Sentry monitoring.

## 4. Auth and Session Security (kept)
- Supabase Auth, email verification, password policy, breach password check.
- 2FA TOTP mandatory for all account holding roles, backup codes, step-up reauthentication
  for gateway keys, payouts, KYC decisions, account unlock and role changes.
- Login lock: 2 consecutive failed password or 2FA attempts lock account for 2 hours.
  During lock correct password does not log in, password reset disabled, password change
  does not clear lock. Owner gets alert email when lock starts. Unlock only by permitted
  office role after email confirmation with owner. Counter and lock state stored in database.
  IP rate limiting also applies. Errors never reveal whether an account exists.
- LR-022 session protection: session-bound cookie (HttpOnly, Secure, SameSite=Strict),
  device proof key per device, rotating token, cookie replay detection with full session
  family revocation, new device confirmation, instant session revoke, all events audited.
- Cloudflare Turnstile on signup, login and password reset forms.
- VPN, Proxy and Tor detection and blocking on signup, payment, KYC and admin access.

## 5. Payment Providers (final, only five)
One adapter file per provider, one registry file, provider docs must be read from the
provider official website in the coding session before writing that adapter (no memory coding).
1. NMI (nmi.com): dual frontend modes, Collect.js default (single-use token, 24 hour expiry)
   and Payment Component (npm package via integrator request only). Both modes use one
   shared server module on NMI REST API. Mode switch from super admin dashboard, one active
   mode at a time, successful test required before switch, every switch audited.
2. Payoneer: adapter for Payoneer platform payments and payouts per official Payoneer docs.
3. Rainforest (rainforestpay.com): adapter for embedded platform payments and sub-merchant
   onboarding per official Rainforest docs.
4. Stripe Connect: adapter for connected account (sub-merchant) creation, charges and
   payouts per official Stripe Connect docs. This replaces standalone Stripe.
5. Airwallex (airwallex.com): adapter for global payments and payouts per official Airwallex docs.
Super admin gateway page: super_admin only with 2FA and fresh reauthentication. Add keys,
test connection, enable or disable each provider without code change or redeploy. Keys are
AES-256-GCM encrypted, encryption key only in environment variable, key never shown after
save (last characters and last update time only). Provider cannot be enabled if test fails.
No provider can be added from dashboard if its adapter is not in code. Routing rule with no
match rejects the payment, never falls back silently to another provider.
Platform fee percent and settlement hold days are configurable by super_admin (global default
and per sub-merchant override), applied and recorded on every transaction.

## 6. Sub-Merchant Flow (kept, simplified roles)
- Merchant signs up, verifies email, completes company profile, uploads KYC documents.
- compliance_kyc team reviews manually. ceo or super_admin final approval where required.
- On final approval, an audited background job creates the sub-merchant account automatically
  under the connected master platform account (Stripe Connect or Rainforest as primary
  provisioning providers; other providers provision only where their platform supports it
  and the registry marks that capability).
- Provider sub-merchant id, status (pending, action required, verified, restricted, rejected),
  charges enabled and payouts enabled are stored and synced by verified webhooks.
- Charges and payouts stay disabled until provider verification is complete.
- If no master platform account is connected, provisioning stays queued and office is alerted.
- Platform fee and settlement hold from super admin settings are applied per transaction.
- Sales tax collected (Section 7) is recorded per sub-merchant transaction.

## 7. Sales Tax Collection Only (kept, no tax module)
- Sales tax rate can be set on invoice and at payment (percent set by owner within options
  allowed by super admin, or a fixed rate set by super_admin).
- Tax amount is calculated with decimal library, stored as numeric(18,4) on invoice and
  payment records, shown separately on invoice, receipt and transaction detail.
- Collected sales tax total is visible per sub-merchant and platform wide as a simple
  collected amount list. No tax filing, no tax return, no jurisdiction tax report module,
  no W-9, W-8 or 1099 features.

## 8. Invoicing and Client Payment (kept)
- Clients, products and services, invoice create edit duplicate, line items, discounts,
  sales tax line (Section 7), invoice numbering, statuses, recurring invoices, PDF invoice.
- Tokenized client portal: invoice link and estimate link, no client login, token expiry,
  revoke and reissue, optional email OTP gate, noindex on token pages.
- Payment page: card data only inside provider hosted secure fields. Our code and server
  never read, store or track card number, expiry or CVV.
- Same card cannot pay the same invoice again within 24 hours after a successful payment.
  Card or authentication failures count per card token: 2 failures in 24 hours means the
  card is rejected on the next attempt. Insufficient funds failures are not counted.
  Blacklist is by card token or provider card fingerprint, never by card number.
  Provider fraud signal or blacklisted card is rejected immediately. Card and IP velocity
  limits with defaults in config.
- 3D Secure requested where possible. If 3DS is not completed, capture only when billing
  postal code and payer IP country both match invoice data, otherwise no capture and the
  payment goes to manual review for compliance_kyc.
- Webhooks accepted only after signature verification and processed idempotently.

## 9. File Storage (Supabase only)
- All text and accounting data in Supabase PostgreSQL.
- All files (PDF, images, KYC documents, logos) in Supabase Storage only.
- Every file AES-256-GCM encrypted before upload, file record stores storage_provider
  value supabase, file hash, size, type and company_id.
- Signed short lived download URLs, file type and magic byte validation, size limits,
  malware scan hook, file access audit log.

## 10. Email System (kept and expanded)
- Super admin can configure email sending by SMTP (host, port, user, password encrypted,
  from name, from email, TLS) and by API provider (Resend, SendGrid, SES, Mailgun style
  API key configuration). One active sending method at a time, test email required before
  activating a new configuration, configuration change audited, secrets never shown after save.
- Email templates in English only, editable by super_admin: welcome, email verification,
  password reset, login lock alert, new device alert, KYC submitted, KYC approved,
  KYC rejected, sub-merchant provisioned, invoice sent, payment received, payment failed,
  payout sent, settlement released, support reply, account unlock confirmation.
- Activity emails are sent automatically for the events above, each send logged with
  template name, recipient, status and provider message id. Failed sends are retried by
  background job with a retry limit, failures visible to super_admin.

## 11. Office Admin, Blog and Support (kept)
- super_admin dashboard: merchants, sub-merchant provisioning status, gateways, platform
  fee and settlement settings, email configuration, templates, audit log, sessions, unlock.
- ceo dashboard: approvals queue, merchant overview, office activity.
- compliance_kyc dashboard: KYC queue, manual payment review queue, blacklist management.
- support dashboard: support tickets from merchants and token-page contact requests,
  reply by email using templates, ticket status and assignment.
- blogger dashboard: blog post create edit publish, public pages content, SEO fields.
  Blogger has no access to merchant, payment or KYC data.
- Public website: home, product, pricing, company, legal, support and blog pages, CMS
  editable by blogger and super_admin, SEO metadata, lead contact form with Turnstile.

## 12. Performance Rules (new, binding for every coding chat)
- Website must load fast: Server Components by default, client JavaScript only where
  interactive, lazy loading for heavy components, image optimization, font optimization.
- Database pressure must stay low: indexed foreign keys and lookup columns, pagination on
  every list (no full table loads), select only needed columns, joined single queries
  instead of repeated per-row queries (no N+1), no query inside loops.
- Server caching for public pages and plan data, short lived cache for dashboard summaries,
  Supabase connection pooling, no realtime subscription where a simple fetch is enough.
- Deploy targets Vercel and Netlify must stay light: no heavy work in request handlers,
  PDF and email and provisioning run as background jobs, request handlers only validate,
  write minimal rows and enqueue.
- Bundle budget and Core Web Vitals budget recorded in the performance step, every list
  API must return paginated results with a maximum page size in config.

## 13. Background Jobs (kept, reduced list)
- Sub-merchant provisioning after KYC approval.
- Email send retry.
- Recurring invoice generation.
- Webhook processing.
- Settlement release after hold days.
- Expired token and session cleanup.
- Audit log root hash export.

## 14. Remaining Open Discussion Points (not decided yet)
- Whether estimates and quotes stay in scope or are cut.
- Whether recurring invoices stay in scope or are cut.
- Whether refund and dispute handling UI stays in scope or is cut to provider side only.
- Whether multi-currency display for clients stays (USD base always) or is cut.
- Whether custom domain for merchants stays or is cut.
- Whether public API for merchants stays or is cut.
- Whether coupons and discount plans for platform subscription stay or are cut.
- Which single provisioning provider is primary at launch: Stripe Connect or Rainforest.
