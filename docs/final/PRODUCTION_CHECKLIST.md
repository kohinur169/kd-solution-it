// path: docs/final/PRODUCTION_CHECKLIST.md
# KD SOLUTION IT - Production Readiness and Live Operation Checklist

This document lists everything outside the code that must be ready so the finished
project can go live and run as a business without errors. Coding agents read this file
together with FEATURE_LIST.md before the final STEPs.

## 1. Accounts and Services to Prepare
- Supabase projects: development, staging, production, each with backups enabled.
- Hosting projects on Vercel and Netlify connected to this repository.
- Object storage with tenant separated paths using one active built-in adapter selected by environment configuration: Supabase Storage or Amazon S3. The application may be hosted on Netlify, Vercel or Amazon. Server-local disk is never used for stored files.
- Cloudflare Turnstile keys for the production domain.
- Sentry project with alert rules to the office team.
- Email provider account (SMTP or API based) with a verified sending domain.
- Master platform accounts and live keys: NMI, Payoneer, Rainforest, Stripe Connect, Airwallex.
- Sandbox keys for the same five providers for the staging environment.
- TaxCloud availability for merchants who enable United States sales tax collection.
- KYC provider accounts for Jumio, Didit and Sumsub when automatic verification is activated.
- Shopify app listing approved, and the WooCommerce plugin package ready for merchants.
- Production domain with DNS records and HTTPS certificates.

## 2. Environment Variables (names only, values live in the hosting platform)
- NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
- DATABASE_URL for migrations and background jobs
- APP_ENCRYPTION_KEY (AES-256-GCM master key, held by the CEO as key custodian)
- AUDIT_SIGNING_KEY for audit log entry signing
- NEXT_PUBLIC_TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY
- SENTRY_DSN and Sentry release settings
- SESSION and token signing secrets for client portal links
- STORAGE_PROVIDER selection (supabase or s3) and the bucket, region and credential values required by the selected storage adapter
- Webhook base URL used when registering webhook endpoints with every provider
Provider keys, email secrets and TaxCloud credentials are not environment variables.
They are entered in the super admin screens, encrypted at rest and shown only masked.

## 3. Email Domain Readiness
- SPF record published for the sending domain.
- DKIM signing enabled with the email provider.
- DMARC record published and reports reviewed.
- Test messages verified in inbox (not spam) for lock alert, KYC and payment templates.
- Separate subdomain prepared for marketing sending when volume grows.

## 4. Payment Live Readiness
- Each provider passes the built-in connection test from the super admin gateway page
  with live keys before it is enabled.
- Webhook endpoints registered per provider and a live test event verified.
- One small real payment, one refund and one payout completed and matched in the
  double-entry ledger and in reconciliation before public launch.
- Statement descriptor verified on a real card statement: KD plus the sub-merchant
  business name.
- Chargeback thresholds and reserve settings reviewed by super_admin and compliance.
- Country switches reviewed: only countries with provider coverage are enabled, and
  sanctioned countries remain permanently disabled.

## 5. Business Operations Readiness
- Pricing page published with the full fee list and effective dates.
- Policy pages published and versioned, with signup acceptance recording active.
- Responsible compliance officer appointed and recorded in platform settings.
- Segregated client funds arrangement active with the banking partner.
- Cyber insurance bound and PCI attestation renewal dates entered in the compliance
  calendar.
- Support coverage hours published, with monetary urgent first response within one
  business day and stuck payment answers within 72 hours.
- Status page published and linked from the public website footer.

## 6. Go-Live Sequence (performed once, in this order)
1. Production environment variables set and the application boot check passes.
2. All migrations applied to production and verified.
3. First super_admin account created, 2FA enforced, platform logo and information set.
4. Email configuration saved, test email received, templates reviewed.
5. Each payment provider connected with live keys, connection test passed, then enabled.
6. One internal merchant completes signup, manual KYC, sub-merchant provisioning,
   invoice payment, settlement and payout end to end.
7. Backup restore rehearsed on staging and recorded.
8. Status page, pricing page and policy pages published.
9. Country switches set for launch countries.
10. Public launch announced through the announcement system.

## 7. Recurring Operations Calendar
- Daily: reconciliation review, failed payout review, job failure review.
- Weekly: chargeback rate review per merchant and platform wide.
- Monthly: processor bills matched, platform metrics reviewed, pricing version check.
- Quarterly: access review for all office roles, key rotation review, restore rehearsal.
- Yearly: PCI attestation renewal, cyber insurance renewal, policy version review.

## 8. Deployment Rollback Procedure
- Keep the previous production deployment available on the hosting platform at all times.
- On a failed release: first switch traffic back to the previous deployment on the
  hosting platform, then run the rollback of any migration applied by the failed release,
  then record the incident on the status page and in the launch record.
- A release that includes a migration is rehearsed on staging with its rollback before
  it is applied to production.

## 9. Environment Variable Reconciliation (checked at STEP 250)
- Every name in Section 2 of this checklist exists in .env.example and in the validated
  environment schema, and every variable in .env.example is listed in Section 2.
