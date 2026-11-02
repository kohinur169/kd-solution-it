// path: docs/final/FEATURE_LIST.md
# KD SOLUTION IT - Final Feature List

## 1. Platform Foundations
- Multi-tenant SaaS payment facilitator platform for Asian market with worldwide merchant country control.
- English only in UI, code, comments, seeds, templates and content. All strings in lib/i18n/strings/en.ts.
- USD only for all amounts. Money stored as numeric(18,4). Money math only with a decimal library.
- Every table has id UUID v7, company_id, created_at, updated_at, deleted_at and version.
- RLS enabled with default-deny policy on every table.
- Audit log entry on every mutation. Hash-chained append-only audit log with Ed25519 signing and Merkle root export.
- Zod validation on client and server for every form and API.
- Sanitization for every input: XSS, SQL injection, CSRF, SSRF, header injection, null byte, path traversal, Unicode normalization.
- Idempotency key on every payment. Optimistic locking on every editable record.
- TypeScript strict mode. Structured logging only.
- Path comment on the first line of every file.
- Deployable on Vercel and Netlify with light runtime load. Sentry monitoring.

## 2. Roles and Permissions
- super_admin: full control of everything. Sets platform logo, name, contact details and all general settings. Delegates permissions to office roles. Large actions such as large payout release and platform fee change require CEO confirmation step.
- ceo: separate dashboard, approvals, KYC final approval, confirmation of large super_admin actions, country enable and disable decisions with super_admin, pricing decisions with super_admin.
- compliance_kyc: separate dashboard, KYC review, underwriting criteria, manual payment review, dispute document review, SAR case preparation, sanctions and PEP screening work.
- finance_ops: reconciliation mismatch resolution within 3 days, failed payout handling, settlement release work, processor monthly bill matching.
- support: separate dashboard, support tickets, merchant help. No gateway key access and no KYC approval.
- blogger: separate dashboard, blog posts and public content only. No merchant, payment or KYC data.
- owner (sub-merchant): one account per person and per business. Manages own business, clients, products, invoices, payments, payout bank and branding.
- client: tokenized link access only under i/[token] and e/[token], no login.
- Approval chain: requester, then CEO, then super_admin.
- Every permission grant, change and use is audit logged.

## 3. Business, Legal and Compliance Operations
- Platform legal structure for payment facilitation with versioned terms acceptance records (version, time, IP).
- Client and merchant funds held segregated from platform funds.
- Appointed responsible compliance officer recorded in platform settings.
- Cyber insurance record and PCI attestation renewal tracking in a compliance calendar with expiry alerts.
- Liquidity is covered from company funds when processor settlement is delayed or a large chargeback arrives.
- Country enable and disable switch at platform level, controlled by super_admin and CEO. Sanctioned countries stay permanently disabled.
- Staff offboarding checklist: all access closed on the same day a staff member leaves.
- Encryption master key custodian is the CEO. Key material lives only in environment variables.
- Policies, each as a CMS editable page with versioned merchant acceptance at signup:
  KYC and KYB Policy. UBO Policy for owners of 25 percent or more. AML and CFT Policy.
  Sanctions and PEP Screening Policy following OFAC, UN, EU and United States policy lists.
  Underwriting and Risk Assessment Policy. Merchant Acceptance and Prohibited and Restricted Businesses Policy.
  Chargeback and Dispute Management Policy. Refund and Settlement Policy. Fraud and Risk Management Policy.
  Data Privacy and Security Policy for GDPR, CCPA and local law. PCI-DSS Compliance Policy.
  Automated Decision Review Policy with human review and appeal path.
- SAR workflow: system prepares an internal case file and document pack, compliance submits through the proper channel. SAR information is visible only to compliance_kyc and super_admin and is never disclosed to the related merchant.

## 4. One Person, One Account
- One person holds exactly one account. One owner holds exactly one business and one sub-merchant account.
- Duplicate checks run at signup, at KYC submission and before sub-merchant creation.
- Signals: email, phone, identity document number hash, tax id, bank account fingerprint, legal name with date of birth.
- A match blocks the new account and sends the case to compliance_kyc review. The applicant is informed that an account already exists.

## 5. Signup, Business Profile, Underwriting and KYC
- Merchant signup with email verification, Turnstile and breach password check.
- Business information form follows the connected processor requirements and changes per processor.
- Fields include business name, business address, person name, contact information and every other business detail the processor requires.
- Merchant Category Code (MCC) dropdown or input in merchant onboarding and profile settings.
- Merchant website verification step: website or store link review for business authenticity.
- Merchant sets business information once on the platform. The same information is sent to every connected processor.
- Address verification uploads: utility bill issued within 3 months, bank statement, source of funds document, and any extra document a processor requests.
- Underwriting criteria are set by the compliance team: starting monthly transaction limit for new merchants, MCC based risk tiers with extra reserve or longer hold, required bank statement period, and holding unusually large transactions for review.
- KYC runs in Manual mode while none of Jumio, Didit or Sumsub is connected.
- Automatic KYC adapters for Jumio, Didit and Sumsub are part of the platform. super_admin selects one active KYC provider in settings. When one is connected and active it becomes the default verification method. When none is active, Manual KYC runs.
- Automatic verification that is incomplete or unsuccessful moves to Manual review without telling the merchant which method was used. The merchant only sees verification status.
- Large or high-risk merchants require two reviewers (four-eye review).
- Final approval by CEO or super_admin triggers automatic sub-merchant account creation under the connected master platform account.
- Sub-merchant provisioning stores provider name, provider submerchant id, status (pending, action required, verified, restricted, rejected), charges enabled and payouts enabled, synced by verified webhooks.
- Charges and payouts stay disabled until provider verification completes.
- If no master platform account is connected, provisioning stays queued and the office is alerted.
- Every KYC decision is audit logged.

## 6. Payment Processors (Five)
- One adapter file per provider and one registry file listing all five with a capability matrix.
- Before coding any adapter, the coding session must read that provider's latest official documentation and sandbox or testing pages on the provider's own website in that session and record the verified URLs.
- NMI: integration follows the official NMI API documentation and Collect.js rules from
  nmi.com and docs.nmi.com. Card data is collected only through Collect.js hosted fields
  (https://secure.nmi.com/token/Collect.js), which returns a payment token to the browser.
  Our code never reads or stores card number, expiry or CVV. The server exchanges that
  token for payment through the NMI API exactly as the official NMI documentation
  specifies (request format, transaction types, response codes and error handling all
  follow the documentation read in the coding session). Sub-merchant creation runs
  through the NMI gateway as documented by NMI.
- Payoneer: payouts. A bank account added in the merchant profile is also added to Payoneer automatically.
- Rainforest (rainforestpay.com): payment acceptance and sub-merchant creation.
- Stripe Connect: connected sub-merchant account creation, charges and payouts.
- Airwallex (airwallex.com): connected account creation, payment acceptance and payouts.
- Payment methods: every method supported by the connected processor or gateway can be accepted, including cards and e-wallets.
- The platform keeps an extension point for future providers: a new adapter added to the registry becomes available in the super admin panel.
- Super admin gateway page: super_admin only, with 2FA and fresh reauthentication. API keys can be added, tested, enabled and disabled without code change or redeploy.
- Keys are AES-256-GCM encrypted before storage. The encryption key exists only in environment variables.
- After saving, a full key is never shown again. Only the last characters and last updated time are shown.
- A provider cannot be enabled when its connection test fails.
- A provider without an adapter in code cannot be added from the dashboard.
- Routing rules decide the provider. When no routing rule matches, the payment is rejected and is never silently sent to another provider.
- Country level availability follows the platform country switch.

## 7. Sales Tax Collection With TaxCloud
- One tax calculation provider at launch: TaxCloud.
- Every merchant can connect a personal TaxCloud account. The platform builds no large tax engine of its own.
- Collection applies to United States transactions.
- Sales Tax Collection is an on and off option. When enabled, sales tax is collected automatically on invoices.
- TaxCloud credentials are encrypted and only shown masked.
- The tax amount appears as its own line on the invoice and is stored on invoice and payment records.
- Collected sales tax totals are visible per sub-merchant and platform wide.

## 8. Merchant Test Mode
- Every merchant has a Test and Sandbox mode with separate test credentials.
- Test payments move no real money.
- Invoices, payment links, recurring invoices and store connections can all be exercised in test mode.
- Test and live data are fully separated.
- Simulated webhooks let the merchant verify an integration.

## 9. Plans and Entitlements
- super_admin creates plans: name, price, period and which services each plan includes.
- Sub-merchants use the services included in their plan, such as invoicing, payment links, recurring invoices, public API and store connections, and test mode.
- Services outside the plan are not usable by that merchant.

## 10. Platform Fee, Settlement, Reserve and Payout
- Platform fee percent is set by super_admin, globally and per sub-merchant when needed.
- Settlement hold days are set by super_admin, globally and per sub-merchant when needed.
- Rolling reserve exists for risk and negative balance protection. Reserve percent and release days are set by super_admin. Reserve terms are shown to the merchant at signup and accepted there.
- A negative balance is covered first from reserve. Any remaining amount is collected through the contract process including legal collection.
- Merchants add a payout bank account in profile payout settings. The bank is added automatically to Payoneer or Airwallex.
- Changing a bank account requires manual verification first. The 96 hour cooling period starts only after manual verification passes.
- During the cooling period all payouts are fully paused, including to the previous verified bank.
- When manual verification fails, the cooling period never starts and the previous bank stays active.
- Minimum payout amount is 100 USD. Below that amount, funds are paid out as the accumulated remainder after the holding period.
- Failed payouts are reported to the merchant by email.
- Settlement is released automatically after the hold period.

## 11. Double-Entry Payment Ledger and Reconciliation
- Every merchant has a full payment ledger.
- Double-entry method: every money movement writes a debit entry and a credit entry and the pair always balances to zero.
- Ledger entries are never edited or deleted. Corrections are written as reversing entries.
- Ledger covers payment received, platform fee, hold, reserve, settlement, payout, refund, chargeback, chargeback fee and subscription charge.
- Merchants see their balance and every entry detail.
- The system continuously checks that the ledger is balanced and alerts the office on any mismatch.
- Reconciliation matches system records with processor reports. A mismatch must be resolved by the responsible team within 3 days. Every mismatch and resolution step is audit logged.

## 12. Platform Subscription Billing
- Subscription is charged first from the merchant balance.
- When the balance is empty, the saved card is charged.
- The saved card is stored and charged through the super admin platform sub-merchant account.
- Saving a card requires an explicit future-charge consent (mandate). Consent text, version, time and IP are recorded.
- Warnings start 7 days before the due date.
- When balance and card charges both fail on the due date, all services stop at once.
- Login, the billing payment page and support stay open while services are stopped.
- As soon as payment succeeds, all services are enabled again automatically.

## 13. Suspension, Reactivation and Account Closure
- A suspended merchant submits the required documents and returns to active status after compliance review.
- A merchant stopped for unpaid billing can log in and pay, and all services are enabled as soon as payment succeeds.
- When a merchant closes the account, remaining money is sent to the bank after the hold period, and funds for possible chargeback liability stay held until the chargeback period ends.
- When a merchant leaves the platform, saved card tokens are deleted at once.
- Closed and suspended account data and sub-merchant records are retained for 7 years for regulatory observation.

## 14. Public Pricing
- The public Pricing page shows the full detailed price list: platform fee, processor fees, payout fees, chargeback fees and refund fees, and who pays each.
- Pricing is decided by super_admin and CEO and is visible to everyone.
- A new price is announced 30 days before it becomes effective. Every pricing version is kept with its effective date.

## 15. Clients, Products and Data Import
- Client create, edit, delete and paginated list.
- Product and service create, edit, delete and paginated list.
- CSV data import for client and product lists. Invalid rows are reported row by row while valid rows are imported.

## 16. Invoices, Estimates, Recurring Invoices and Payment Links
- Invoices follow a professional format accepted in the United States and globally.
- Invoice create, edit, duplicate, void, numbering, and status workflow: draft, sent, viewed, partially paid, paid, overdue, void.
- Line items can be added, edited and ordered correctly. Full discount support.
- Partial payments are accepted with a minimum of 20 USD.
- PDF invoice generation.
- Estimates and quotes exist. Client approval of an estimate requires a digital signature.
- Signature evidence is stored: signer name, email, consent checkbox record, time, IP address, geo location, device fingerprint and document hash.
- A client can decline an estimate, and an estimate expires at its expiry time. Both paths set the estimate to void.
- When an estimate is accepted it converts automatically into an invoice and a payment link is generated.
- Recurring invoices exist. When a recurring payment fails there is no automatic retry. The invoice shows as due or overdue, reminders go to the client at set intervals, and the merchant can take the needed action.
- Tokenized links open invoices and estimates for clients.
- Once an invoice is fully paid through its tokenized link, that link no longer accepts payment. Opening it shows the paid state and the receipt. A partly paid invoice link accepts only the remaining amount.
- A paid invoice is locked and cannot be edited.
- Payment links and hosted checkout: a merchant can create a general payment link and share it anywhere, when the service is in the merchant plan.
- Statement descriptor shows the two letters KD together with the sub-merchant business name.
- Merchants can set their own logo and invoice branding.
- All prices are displayed in USD.

## 17. Settlement Statements
- Merchants download settlement statements as CSV and PDF for any selected period.
- A statement shows payments, fees, holds, reserve, refunds, chargebacks and payouts.

## 18. Payment Page and Card Security
- Card number, expiry and CVV are entered only inside the provider hosted secure fields. Platform code and servers never read, store or track card data or keystrokes.
- 3D Secure is requested on every payment where possible.
- When 3DS is not completed, capture happens only when billing postal code and payer IP country both match the invoice data. When either does not match, nothing is captured and the payment goes to manual review by compliance_kyc.
- A provider fraud signal rejects the payment at once.
- Card blacklist entries use card token or provider card fingerprint.
- Card and IP velocity limits exist with defaults in config.
- Chargeback handling follows international card network rules: rate and transaction count are both considered, a minimum transaction count must be reached before a percentage threshold applies, and action is graduated: warning and monitoring, then extra reserve, then suspension. Every threshold value is configurable by super_admin.
- The chargeback fee amount is set by super_admin and chargeback losses are taken from the sub-merchant balance.
- Whether the platform fee is returned on a refund is set by super_admin.
- Webhooks are accepted only after signature verification and are processed idempotently.

## 19. Refunds and Disputes
- Refund interface: request, approval and status tracking.
- Dispute interface: list, status and document upload.
- The merchant writes the dispute response and supplies the required documents.
- The response deadline is 24 hours in the merchant own time zone. super_admin can set the deadline to 48 hours when needed.
- The merchant receives email warnings at the start and in the middle of the deadline window.
- A structured chargeback evidence pack is assembled: invoice, delivery proof, client communication record and terms acceptance record.
- compliance_kyc reviews the evidence pack and sends it to the processor.
- Every refund and dispute action is audit logged.

## 20. Merchant Public API and Store Connections
- A public API exists for online store payments only.
- Merchants create, revoke and regenerate API credentials.
- Full API keys and secrets are never displayed. After creation they are shown masked only and never appear in UI, logs or error messages.
- Shopify: the platform has its own Shopify app with approval. A merchant installs the app and logs in with credentials, and the connection becomes active and fully functional automatically.
- WooCommerce: the platform has its own plugin. A merchant logs in with credentials in the plugin and the connection becomes active automatically.
- Both Shopify and WooCommerce are available at launch.
- Every API call requires authentication and is rate limited and audit logged.

## 21. File Storage
- Text and structured data live in the platform database.
- Files live in object storage through the storage adapter layer. Two adapters are built in: Supabase Storage and Amazon S3. The active adapter is selected by environment configuration, so the same build runs with the application hosted on Netlify, Vercel or Amazon without rewriting the core. Server-local disk is never used for stored files.
- Every file is AES-256-GCM encrypted before upload.
- Every file record stores storage_provider, hash, size, type and company.
- File type and magic byte verification and file size limits apply.
- Downloads use short-lived signed URLs. Every file access is audit logged.
- KYC documents, logos, invoice PDFs, dispute documents and support attachments can be uploaded.

## 22. Authentication and Session Security (LR-022)
- Email verification, strong password policy and breached password check.
- 2FA TOTP is mandatory for every account holding role, with backup codes.
- Merchants can generate fresh backup codes in advance.
- When backup codes are finished or lost, the merchant contacts the platform by email, supplies additional documents for verification, the office resets 2FA, and the merchant sets up 2FA again after login.
- Step-up reauthentication is required for gateway keys, payouts, KYC decisions and account unlocks.
- Login lock: 2 consecutive failed password or failed 2FA attempts lock the account for 2 hours.
- During the lock, a correct password does not log in, password reset is disabled, and changing the password does not clear the lock.
- The owner receives an email alert when the lock starts.
- Unlock is done only by an office role with unlock permission and only after contact with the owner is confirmed by email. Every unlock is audit logged.
- Failed attempt counters and lock state are stored in the database and survive server restarts.
- IP based rate limiting applies on authentication endpoints.
- Error messages never reveal whether an account exists.
- LR-022 session protection: session-bound cookie (HttpOnly, Secure, SameSite Strict), per-device proof key, rotating session token, cookie replay detection with revocation of the whole session family, extra verification on a new device, reauthentication for sensitive actions, instant session revocation, and audit logging of every session event. A cookie works only inside its own session.
- Cloudflare Turnstile runs on signup, login and password reset.

## 23. Email System
- super_admin configures email sending by SMTP and by API provider. One sending method is active at a time.
- Activating a new configuration requires a successful test email first.
- Email secrets are encrypted and never shown in full after saving.
- Email templates are editable by super_admin.
- Activity emails are sent automatically for welcome and verification, password reset, login lock alert, new device alert, KYC submitted, approved and rejected, invoice sent, payment received and failed, refund and dispute updates, payout sent, settlement released, subscription warnings and service stop and restore notices, support replies and account unlock confirmation.
- Every send is logged with template, recipient, status and provider message id. Failed sends are retried by background job with a retry limit.
- Domain authentication SPF, DKIM and DMARC is configured and verified before launch.
- Transactional and marketing sending use separate domains or subdomains as volume grows.

## 24. Platform Setup, Announcements, Support and Status
- super_admin sets the platform logo and all platform information from settings.
- Announcements: super_admin publishes announcements that appear as popups everywhere. A user can dismiss an announcement, and a dismissed announcement does not appear again for that user.
- Support tickets: merchants create tickets, attach files, and receive replies by email. Support assigns tickets and changes status.
- Support service level: monetary urgent matters receive a first response within one business day. A merchant with a stuck payment receives an answer within 72 hours. Service level compliance is recorded.
- A public status page shows service state, and incidents are announced on the status page and by email.

## 25. Blog, CMS, Public Website and SEO
- The blogger role and the full CMS are available from the first day of launch.
- Blog posts can be created, edited and published.
- Every public page is editable through the CMS.
- Public pages: Home, Product, Pricing, Company, Legal, Support, Blog, Contact and the policy pages.
- SEO metadata and sitemap are generated for public pages.
- Contact and lead forms run with Turnstile.
- Partner display naming on public and merchant surfaces uses Global Payout Partners and Local Payment Methods via Licensed Partners.

## 26. Company Accounting and Operations Metrics
- The platform company has its own accounting area covering company income and expenses, processor bill matching, tax calculation and reports.
- This accounting area is accessible only to super_admin, CEO and finance_ops. Merchants have no access to it.
- super_admin dashboard shows operations numbers in one place: total transaction volume, active merchant count, overall chargeback rate, average hold and platform revenue.
- Every sub-merchant sees the same kinds of numbers for itself: own volume, own chargeback rate, own holds and own income and balance.

## 27. Background Jobs
- Sub-merchant provisioning after KYC approval.
- Email sending and retry.
- Recurring invoice generation and client reminders.
- Webhook processing.
- Settlement release after hold days.
- Subscription charge attempts and the 7 day advance warnings.
- Reconciliation checks and mismatch alerts.
- Expired token and session cleanup.
- Audit log integrity hash generation.
- Compliance calendar expiry alerts for annual renewals.

## 28. Performance and Low Load Rules
- Fast loading: Server Components by default, client JavaScript only where interactive, lazy loading of heavy parts, image and font optimization.
- Low database pressure: pagination on every list, only required columns selected, joined single queries, no per-row repeated queries, no queries inside loops, indexes on lookup columns, connection pooling.
- Public pages and rarely changing data are cached. Dashboard summaries use short-lived cache.
- Light runtime on Vercel and Netlify: PDF generation, email, webhook processing and sub-merchant provisioning run as background jobs. Request handlers validate, write minimal rows and enqueue.
- Maximum page size for list APIs is set in config. Bundle and Core Web Vitals budgets are recorded.

## 29. Production Environments and Secrets
- Three separated environments: development, staging and production. Each environment has its own database, storage, provider keys and email settings. Test mode data never mixes with production data.
- Every secret lives only in environment variables of the hosting platform. No secret is stored in the repository, in the database in plain form, or in any log.
- An .env.example file lists every required environment variable by name with a short description and no real values. The application refuses to start when a required variable is missing.
- Provider keys, email secrets and TaxCloud credentials entered in admin screens are AES-256-GCM encrypted at rest and shown only masked.
- Key rotation procedure exists for provider keys and email secrets: add new key, run connection test, activate, then remove the old key. Every rotation is audit logged.

## 30. External Services Setup Required for Live Operation
- Supabase project for each environment with daily backups enabled.
- Hosting project on Vercel and on Netlify, both connected to the same repository with environment variables set per environment.
- Object storage configured by environment variables with two built-in adapters, Supabase Storage and Amazon S3, for encrypted file storage with tenant separated paths, while the application itself is hosted on Netlify, Vercel or Amazon.
- Cloudflare Turnstile site and secret keys for the production domain.
- Sentry project with server and client error reporting and release tracking.
- Email sending domain with SPF, DKIM and DMARC records published and verified, plus a separate subdomain for marketing sending when volume grows.
- Master platform accounts with the five payment providers, with sandbox keys for staging and live keys for production, and webhook endpoints registered per provider.
- TaxCloud account connection available for merchants who enable United States sales tax collection.
- Automatic KYC provider accounts (Jumio, Didit, Sumsub) connectable from super admin settings when the business decides to activate one.
- Shopify app created and approved so merchants can install it and connect with credentials. WooCommerce plugin package published for merchant stores.
- Production domain with DNS, TLS certificates and HTTPS enforced on every page.

## 31. Backup, Recovery and Retention Operations
- Database backups run daily with point-in-time recovery where the platform supports it.
- File storage is versioned or backed up so an accidentally deleted file can be recovered.
- A restore rehearsal is performed on staging before launch and on a recurring schedule, and the result is recorded.
- Retention jobs enforce the 7 year record retention rule and then remove expired operational data according to the retention settings.
- Audit log integrity roots are exported on schedule so tampering can be detected.

## 32. Monitoring, Alerting and Incident Operations
- Error monitoring through Sentry with alert rules to the office team.
- Uptime monitoring of the public site, the payment pages and the webhook endpoints.
- Background job monitoring: a failed or stalled job raises an office alert.
- Payment success rate, webhook failure count, payout failure count and reconciliation mismatch count are visible to super_admin.
- The public status page reflects real service state and incidents are announced there and by email.
- Structured logs carry request identifiers so any payment can be traced from request to ledger entry.

## 33. Release and Go-Live Gates
- A STEP is complete only when typecheck, lint and production build pass for the touched area.
- Provider integrations are complete only after a successful sandbox payment, refund and webhook cycle is recorded in the handoff file.
- Database changes are complete only after the migration and its rollback both run cleanly on staging.
- Security sensitive features are complete only after the audit log entries for their actions are verified in staging.
- Go-live requires: production environment variables verified, provider live keys tested with the built-in connection test, email test received, Turnstile verified on the production domain, backup restore rehearsed, status page published and the first super_admin account created with 2FA enforced.
