// path: docs/planning/GAP_AND_DECISIONS.md
# Gap Analysis After Live, and Decisions Needed Before Coding Starts (Discussion Document)

## A. How Automatic Sub-Merchant Creation Works (summary)
1. New merchant signs up on KD SOLUTION IT and verifies email.
2. Merchant completes company profile and uploads KYC documents (identity, business registration, address proof, tax form W-9 or W-8).
3. KYC Manager or CEO or super_admin reviews manually in admin queue. Decision approved or rejected with reason. Every decision audit-logged.
4. Approval fires an audited background job. If a master provider account is connected in the super admin gateway page,
   the system creates a sub-merchant account under the KD SOLUTION IT master account through that provider
   (connected-account / marketplace model), stores provider_submerchant_id and syncs status by webhook.
5. Provider may ask for more documents. Merchant sees pending, action-required, verified or restricted status in dashboard.
6. Charges and payouts stay disabled until provider status is verified. Platform fee and settlement are applied per plan.
7. If no master provider is connected, the job stays queued and admin gets an alert. Nothing is faked.

## B. What the Owner Must Arrange Outside Code
1. Master merchant account approved as platform/PayFac or MoR model with the chosen provider, with connected-account permission.
2. Business registration, tax ID, bank account, and compliance approval of KD SOLUTION IT itself with that provider.
3. Agreement on who is merchant of record, who carries chargeback liability, reserve and payout hold policy.
4. Tax registration where required (US states nexus, VAT/GST where selling), and an accountant for filing.
   The system collects, calculates, records and reports tax; legal filing responsibility stays with the business.
5. Legal pages: terms for sub-merchants, privacy, refund and chargeback policy, accepted by merchant at signup with version record.
6. Live API keys for each provider to enable, sandbox keys for testing, webhook secrets per provider.
7. Accounts: Supabase, Netlify, Google Cloud (Drive), Cloudflare Turnstile, SMTP provider, Sentry, IP reputation provider.

## C. Tax System Included In Plan (TAX-1, STEP 9.6 and STEP 11.4)
US sales tax by state with nexus flag and rate table. Tax collected ledger per sub-merchant and per jurisdiction.
W-9 collection for US persons, W-8BEN and W-8BEN-E for non-US, stored as encrypted files with storage_provider recorded.
1099-K data export for qualifying US sub-merchants. VAT/GST fields: rate, registration number, reverse charge flag.
Withholding tax record on payouts where configured. Monthly and quarterly tax summary reports per sub-merchant
and platform-wide. No tax amount is ever computed with JavaScript Number; decimal library and numeric(18,4) only.

## D. LR-022 Session Theft Protection Included In Plan (STEP 3.4 and STEP 15)
Cookie works only with its own session: server-side session row, HttpOnly Secure SameSite=Strict cookie,
rotating token per privileged request. Stolen cookie replayed from another device fails device-proof signature
check and triggers full session family revocation plus alerts. Device proof uses a non-extractable browser
device key registered at login. New device requires email confirmation plus 2FA. Sensitive actions require fresh
reauthentication. Admin and owner can revoke any session instantly. Every bind, rotation, replay detection,
reauthentication and revocation event is written to the hash-chained audit log.

## E. Security Gaps That Remain After Go-Live (must be operated, not just coded)
1. PCI scope: using provider hosted fields keeps card data out of our servers, but annual SAQ attestation is still required.
2. Independent penetration test before taking real card volume, and after every major payment change.
3. Webhook endpoints depend on provider signature schemes; key rotation procedure must be rehearsed.
4. Encryption master key loss means encrypted files and keys are unrecoverable; offline key backup procedure required.
5. Google Drive quota and API limits under heavy KYC volume; storage fallback and alerting must be monitored.
6. VPN detection quality depends on the IP reputation provider data; false positives need an admin whitelist process.
7. Provider outage: routing rejects instead of silently switching, so a manual admin routing change procedure is needed.
8. Admin account compromise impact is high; hardware key 2FA for super_admin is recommended as a later upgrade.
9. Backup restore must be tested on a schedule, not only configured.
10. Chargeback and fraud rules need tuning with real transaction data after launch.

## F. Feature Gaps To Decide Before Coding (owner chooses keep or cut per line in discussion)
1. Display currency conversion for clients (USD stays base) - currently planned as read-only display.
2. Offline mode and mobile applications - not in current plan, web responsive only.
3. Multi-language UI - excluded by English-only rule.
4. Automated tax filing submission to authorities - plan covers calculation, records and reports, not direct filing.
5. Providers beyond the 16 listed - excluded, registry supports adding later through a new adapter chat.
6. Payout to sub-merchants in local currencies - plan settles in USD through licensed partners display naming only.
7. Hardware security key login (WebAuthn) - planned as later upgrade, TOTP 2FA is in scope.
8. Real-time chat support inside dashboard - not in current feature list.

## G. Decision Checklist For Owner Before STEP 1.1 Starts
Decide keep or cut for each line in Section F. Confirm first master provider for sub-merchant provisioning.
Confirm platform fee percent and settlement hold days. Confirm which of the 16 providers are enabled at launch
(adapters for all 16 are planned, enabling depends on live keys). Confirm tax registrations held by the business.
