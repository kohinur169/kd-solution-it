-- path: migrations/0078_policy_pages_seed.sql
-- STEP 036 - the twelve policy pages of section 3, seeded as CMS drafts.
--
-- Section 3 publishes twelve policies, and section 25 makes every one of them a CMS page, so the
-- text a merchant accepts at signup is the text an editor maintains. `cms_pages` already closes the
-- twelve `policy_key` values and allows one live page per key; what it does not have is the pages.
-- This file writes them.
--
-- Each row carries its slug, its title, its body and its SEO pair, and status `draft`. A page is
-- published only with the person and the instant of the publication, and on the day this migration
-- runs there is no person yet: the first account is created by the bootstrap of `0079`. Leaving the
-- pages as drafts is therefore the honest state, and the bootstrap publishes exactly these twelve
-- in the same transaction that creates the first super_admin, which is the moment the platform
-- becomes able to answer a merchant. Section 3 requires the acceptance record to name the version a
-- merchant accepted, so a page that exists but is not published cannot silently be accepted.
--
-- The bodies are the operative text of each policy, written in the English the rest of the platform
-- uses, and they state the controls that the rest of this build implements: manual verification
-- that moves to a connected provider when one is active, four eye review for large or high risk
-- merchants, screening against the OFAC, United Nations, European Union and United States lists,
-- evidence stored with a hash and an instant, no card data in platform systems, and human review of
-- an automated decision. They are edited from the CMS afterwards and every version a merchant
-- accepts is proved by the hash in `policy_acceptances`.
--
-- The slug of a page is frozen after this file, and so is its policy key, because an acceptance
-- points at the page a merchant read. The rollback removes the twelve rows and nothing else, so a
-- database that rolls this file back returns to having no policy pages rather than to having pages
-- whose text nobody wrote.

begin;

insert into public.cms_pages (slug, title, body, policy_key, status, seo_title, seo_description) values
  (
    $$kyc-and-kyb-policy$$,
    $$KYC and KYB Policy$$,
    $$# KYC and KYB Policy

## Purpose
KD Solution IT verifies every business and every person behind it before a merchant account can accept a payment. This policy explains what we collect, how we verify it, who decides, and how long we keep the record.

## What we collect
- Business identity: legal name, registration number, registered address, business category and Merchant Category Code.
- Owner and controller identity: full name, date of birth, residential address, identity document and proof of address.
- Contact details for the business and for each person who may act on the account.
- Address verification documents: a utility bill issued within three months, a bank statement, and any additional document a connected processor requires.

## How verification runs
Verification runs in Manual mode until a connected provider is active. When Jumio, Didit or Sumsub is connected and active, it becomes the default method. A verification that is incomplete or unsuccessful moves to manual review, and the merchant is told the status rather than the method used.

## Decisions
An analyst reviews the file and records an approval or a rejection with a reason. Large or high risk merchants require two reviewers. Every decision is written to the audit log. Final approval is given by the compliance officer or by the super administrator.

## Records
Documents are encrypted before storage, hashed, and retained for seven years after the relationship ends. A merchant may ask for a copy of the documents it submitted.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$kyc_kyb$$,
    $$draft$$,
    $$KYC and KYB Policy$$,
    $$How KD Solution IT verifies a business and the people behind it, who decides, and how long the record is kept.$$
  ),
  (
    $$ubo-policy$$,
    $$UBO Policy$$,
    $$# UBO Policy

## Purpose
This policy identifies every natural person who owns or controls a merchant business, so that the platform knows who it is really doing business with.

## Who is an ultimate beneficial owner
A person is treated as an ultimate beneficial owner when any of the following is true:
- The person holds twenty five percent or more of the shares or voting rights of the business.
- The person exercises control by other means, including a shareholders agreement, a trust or a nominee arrangement.
- No person reaches twenty five percent, in which case the senior managing official is recorded as the controller.

## What we record
- Full name, date of birth, nationality, country of residence and residential address.
- The ownership share in basis points, together with the flag that marks the twenty five percent threshold.
- The identity document reference and its hash, and whether the person is a politically exposed person.

## Rules we apply
- Every owner row must add up with the others to no more than one hundred percent of the business; the database refuses a set of owners that exceeds it.
- A person who reaches the threshold without the flag, or the flag without the threshold, is refused.
- Owner records are frozen once the file is approved, and a later change is a new submission that is reviewed again.

## Records
Owner records are kept for seven years after the relationship ends, together with the documents that prove them.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$ubo$$,
    $$draft$$,
    $$UBO Policy$$,
    $$How KD Solution IT identifies and records the ultimate beneficial owners of a merchant business.$$
  ),
  (
    $$aml-and-cft-policy$$,
    $$AML and CFT Policy$$,
    $$# AML and CFT Policy

## Purpose
KD Solution IT does not accept money it cannot explain. This policy sets out how the platform detects and reports activity that may be money laundering or the financing of terrorism.

## Our commitments
- A named responsible compliance officer is recorded in the platform settings and answers for this policy.
- Every merchant is verified before it can transact, and the file is re-reviewed when the business, the ownership or the bank account changes.
- Transactions are monitored: card and address velocity limits apply, unusually large transactions are held for review, and a payment flagged by a provider fraud signal is rejected.
- A sanctioned person or entity is never onboarded. Screening runs against the OFAC, United Nations, European Union and United States lists and every result is recorded.
- A suspicious activity case is prepared inside the platform and submitted through the proper external channel. Case material is visible only to the compliance team and the super administrator, and is never disclosed to the merchant concerned.
- No person may tell a merchant that a report has been filed.

## Records
Screening results, review decisions and case notes are retained for seven years. Every access to a case is written to the audit log.

## Training and review
This policy is reviewed at least once a year and whenever the platform enters a new country or adds a payment partner.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$aml_cft$$,
    $$draft$$,
    $$AML and CFT Policy$$,
    $$How KD Solution IT prevents, detects and reports money laundering and terrorist financing.$$
  ),
  (
    $$sanctions-and-pep-screening-policy$$,
    $$Sanctions and PEP Screening Policy$$,
    $$# Sanctions and PEP Screening Policy

## Purpose
KD Solution IT screens every merchant, every owner and every payout destination against sanctions lists and against politically exposed person lists before the first transaction and on an ongoing basis.

## The lists we screen
- The list of specially designated nationals of the United States Department of the Treasury, Office of Foreign Assets Control.
- The consolidated sanctions list of the United Nations Security Council.
- The consolidated list of the European Union.
- The list of the United States Department of State and the related United States lists.
- Politically exposed person and adverse media data supplied by the screening source.

## How a match is handled
A possible match is not a decision. The compliance team reviews it, records whether it is a false positive and why, and either clears the file or blocks it. A confirmed match is never cleared by the same person who proposed the decision, and the case note is required.

## Countries
The platform holds one country switch. A sanctioned country is disabled for ever and cannot be enabled from any screen; the database refuses it. Any other country can be disabled by the super administrator or the chief executive when a risk appears.

## Records
Every screening records which lists ran, what the result was, who reviewed it and when. A confirmed match that becomes a report keeps its flag for ever.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$sanctions_pep$$,
    $$draft$$,
    $$Sanctions and PEP Screening Policy$$,
    $$The lists KD Solution IT screens against and how a possible match is reviewed and recorded.$$
  ),
  (
    $$underwriting-and-risk-assessment-policy$$,
    $$Underwriting and Risk Assessment Policy$$,
    $$# Underwriting and Risk Assessment Policy

## Purpose
Underwriting decides how much risk the platform takes with a merchant, and on what terms. This policy explains the criteria the compliance team applies before a merchant is approved and while it transacts.

## Criteria set by the compliance team
- A starting monthly transaction limit for every new merchant.
- A risk tier for each Merchant Category Code, with an extra rolling reserve or a longer settlement hold where the tier requires it.
- The bank statement period a merchant must supply as part of its file.
- The transaction size above which a payment is held for manual review.

## What underwriting looks at
- The business model, the website or store, and whether the products are permitted under the merchant acceptance policy.
- The country of the business, of each owner and of the payout bank account.
- The history of the owners on the platform and any earlier terminated relationship.
- Card network rules that apply to the category and to the region.

## Decisions and their effect
A decision sets the limit, the reserve and the hold that apply to the merchant. The merchant sees its limit, its reserve terms and its hold days in its dashboard, and accepts them before its first transaction. A later change follows the approval chain: the requester, the chief executive, then the super administrator.

## Review
Limits and tiers are reviewed when the merchant changes business, when its volume changes materially, and at least once a year.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$underwriting$$,
    $$draft$$,
    $$Underwriting and Risk Assessment Policy$$,
    $$The criteria KD Solution IT uses to set a merchant limit, risk tier, reserve and settlement hold.$$
  ),
  (
    $$merchant-acceptance-and-prohibited-and-restricted-businesses-policy$$,
    $$Merchant Acceptance and Prohibited and Restricted Businesses Policy$$,
    $$# Merchant Acceptance and Prohibited and Restricted Businesses Policy

## Purpose
This policy states which businesses KD Solution IT can serve and which it cannot, so that a merchant knows before it applies and an analyst decides the same way every time.

## Prohibited businesses
We do not serve businesses whose products or services are illegal where the merchant or its customers are located, and in particular: unlicensed gambling and betting, unlicensed money transmission, counterfeit goods, narcotics, weapons and ammunition, sexual services, human trafficking, unlicensed pharmaceuticals, pyramid and Ponzi schemes, ransomware and malware, stolen data, and any business that misrepresents its identity or its products.

## Restricted businesses
The following categories may be accepted with extra underwriting: travel and events, digital goods and subscriptions, nutraceuticals, dating, prepaid and stored value, debt collection, legal and tax services, charities, precious metals, and businesses operating in a country the compliance team marks as higher risk. A restricted business carries a lower starting limit, a longer hold, or both.

## How we check
The business category, the website or store and the ownership file are reviewed together. A website is verified as part of onboarding. A mismatch between the declared business and the site, the category or the flow of funds is escalated to the compliance team and may end the relationship.

## Consequences
A merchant found to be selling a prohibited product has its services stopped and its funds handled under the refund and settlement policy. Every decision is recorded in the audit log.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$merchant_acceptance$$,
    $$draft$$,
    $$Merchant Acceptance and Prohibited and Restricted Businesses Policy$$,
    $$Which businesses KD Solution IT serves, which it refuses, and which need extra underwriting.$$
  ),
  (
    $$chargeback-and-dispute-management-policy$$,
    $$Chargeback and Dispute Management Policy$$,
    $$# Chargeback and Dispute Management Policy

## Purpose
A chargeback is a cardholder dispute raised with the issuing bank. This policy explains how KD Solution IT handles one, what the merchant must do, and what happens when the rate rises.

## The timeline
- A dispute reaches the platform from the processor and appears in the merchant dashboard with a response deadline.
- The response deadline is twenty four hours in the merchant time zone. The super administrator may extend a single case to forty eight hours.
- The merchant writes its response and uploads its evidence: the invoice, proof of delivery, the client communication and the terms the client accepted.
- The compliance team reviews the pack and submits it to the processor. A case that is not answered in time is lost by default.

## Evidence pack
The platform assembles the invoice, its line items and tax, the payment record, the delivery or service proof the merchant supplied, the client communication and the acceptance record of the terms. The pack is the merchant's evidence; the platform does not create it.

## Thresholds
The platform watches the chargeback rate and the transaction count together, because a percentage only means something above a minimum count. Action is graduated: a warning and closer monitoring, then an extra rolling reserve, then suspension. Every threshold is set by the super administrator.

## Money
A chargeback and its fee are taken from the merchant balance. A negative balance is covered first from the reserve. Every chargeback, response and decision is written to the audit log.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$chargeback$$,
    $$draft$$,
    $$Chargeback and Dispute Management Policy$$,
    $$How KD Solution IT handles a cardholder dispute, the evidence the merchant owes, and the rising rate rules.$$
  ),
  (
    $$refund-and-settlement-policy$$,
    $$Refund and Settlement Policy$$,
    $$# Refund and Settlement Policy

## Purpose
This policy explains when a merchant is paid, how a refund is handled, and how the reserve protects the platform and the merchant from a negative balance.

## Settlement
- A captured payment is settled after the hold days that apply to the merchant, which are set by the super administrator globally and per merchant.
- Settlement is released automatically when the hold period ends, and the merchant receives a statement for the period.
- The minimum payout is one hundred United States dollars. A smaller available balance is paid out as an accumulated remainder after the hold period.
- Payouts go to the verified bank account only. A new bank account is verified manually first, and a ninety six hour cooling period starts after that verification passes. During the cooling period every payout is paused, including to the previously verified account.
- A failed payout is reported to the merchant by email.

## Reserve
A rolling reserve may be held for risk and negative balance protection. The percentage and the release days are set by the super administrator and shown to the merchant at signup, where the merchant accepts them.

## Refunds
- A refund is requested by the merchant, approved by the platform, and processed through the processor that took the payment.
- A refund can never exceed the amount still refundable on the payment.
- Whether the platform fee is returned on a refund is set by the super administrator.

## Negative balance
A negative balance is covered first from the reserve. Any remaining amount is handled under the merchant contract, including legal collection where it is not paid.

## Statements
A merchant downloads a settlement statement for any period as a comma separated file or as a PDF document. It shows payments, fees, holds, reserve, refunds, chargebacks and payouts.

## Questions
Write to finance through the support desk in the merchant dashboard.$$,
    $$refund_settlement$$,
    $$draft$$,
    $$Refund and Settlement Policy$$,
    $$When a merchant is paid, how the reserve works, how a refund is processed and how a negative balance is covered.$$
  ),
  (
    $$fraud-and-risk-management-policy$$,
    $$Fraud and Risk Management Policy$$,
    $$# Fraud and Risk Management Policy

## Purpose
Fraud costs every merchant on the platform. This policy explains the controls KD Solution IT runs on every payment and what happens when one of them fires.

## Controls on every payment
- The card number, the expiry date and the security code are entered only inside the secure fields of the connected processor. They never reach a platform server and are never stored.
- Three dimensional secure authentication is requested on every payment where it is available.
- When three dimensional secure authentication is not completed, the payment is captured only if the billing postal code and the country of the payer address both match the invoice. When either does not match, nothing is captured and the payment goes to manual review.
- A fraud signal from the processor rejects the payment immediately.
- A blocked card is refused by a hash of its token or processor fingerprint, never by a stored card number.
- Card and address velocity limits apply in rolling windows, with defaults held in the platform configuration.
- Payout and bank account changes require fresh reauthentication and manual verification.

## When a control fires
A held payment is reviewed by the compliance team and released or rejected with a reason. A rejected payment is not represented to the merchant as a decline of its own customer; the merchant sees the outcome and the reason code.

## Monitoring
Payment success rate, webhook failures, payout failures and reconciliation mismatches are visible to the super administrator, and an unusual pattern raises an alert to the office team.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$fraud_risk$$,
    $$draft$$,
    $$Fraud and Risk Management Policy$$,
    $$The controls KD Solution IT applies to every payment and what happens when one of them fires.$$
  ),
  (
    $$data-privacy-and-security-policy$$,
    $$Data Privacy and Security Policy$$,
    $$# Data Privacy and Security Policy

## Purpose
KD Solution IT holds personal and business data for merchants, their owners and their clients. This policy explains what we hold, why, how we protect it and what rights a person has.

## Lawful basis and purpose
We process data to verify a merchant, to take and settle payments, to meet anti money laundering duties, to answer support requests and to meet tax and accounting duties. We do not sell personal data.

## What we hold
- Identity, contact and business data supplied during onboarding.
- Transaction records, including amounts, fees, ledger entries and settlement records.
- Documents supplied as evidence, encrypted before storage.
- Session and device records used to protect an account.

## How we protect it
- Row level security on every table, so one merchant can never read another merchant's row.
- Encryption in transit and encryption of stored files with AES 256 GCM before upload.
- Secrets and provider credentials encrypted at rest, shown masked after saving and never written to a log.
- Two factor authentication for every account that can sign in.
- An append only audit log that is hash chained and signed, so a change to a record is detectable.
- Access limited by role: support cannot reach gateway keys and cannot approve verification, and the blogger role reaches public content only.

## Retention
Records are kept for seven years after a relationship ends, as anti money laundering and tax rules require, and are then removed by the retention job.

## Rights under GDPR and CCPA
A person may ask for a copy of their data, ask for a correction, ask for deletion where no legal duty requires retention, object to a processing purpose, and complain to a supervisory authority. Requests are answered within thirty days.

## International transfers
Data is processed where the platform and its processors operate. Transfers rely on the safeguards in the merchant contract and in each processor agreement.

## Questions
Write to the data protection contact through the support desk in the merchant dashboard.$$,
    $$data_privacy$$,
    $$draft$$,
    $$Data Privacy and Security Policy$$,
    $$What personal data KD Solution IT holds, how it is protected, how long it is kept and what rights a person has.$$
  ),
  (
    $$pci-dss-compliance-policy$$,
    $$PCI DSS Compliance Policy$$,
    $$# PCI DSS Compliance Policy

## Purpose
KD Solution IT keeps card data out of its systems. This policy states how, and what that means for the merchant.

## Scope
Card numbers, expiry dates and security codes are entered only inside the secure fields of the connected payment processor, on pages the processor serves. Those values are exchanged for a token in the browser. Platform servers never receive, read, store, log or transmit a card number, expiry date or security code, and no platform code reads keystrokes on a payment page.

## Our controls
- Hosted secure fields for every card payment, on every page where a card is entered.
- Tokens and fingerprints only, encrypted at rest, and never the underlying card data.
- A card blacklist that stores a hash of a token or of a processor fingerprint.
- Network segmentation between the public site, the payment pages and the office surfaces.
- A nonce based content security policy, sanitised input, and protection against cross site request forgery on every form.
- Access to payment configuration restricted to the super administrator, with two factor authentication and fresh reauthentication.
- Key rotation for provider keys and email secrets: add the new key, test the connection, activate, then remove the old one, with every step in the audit log.
- A penetration test before real card volume begins and after any major payment change.

## Attestation
The platform completes the self assessment questionnaire that applies to a merchant that fully outsources card data handling, renews it every year, and records the renewal in the compliance calendar with an expiry alert.

## Merchant duties
A merchant must never ask its clients for card details by email, chat or telephone, must use the hosted payment page or the payment link the platform provides, and must report a suspected card data incident to the platform immediately.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$pci_dss$$,
    $$draft$$,
    $$PCI DSS Compliance Policy$$,
    $$How KD Solution IT keeps card data out of its systems and what a merchant must never do with card details.$$
  ),
  (
    $$automated-decision-review-policy$$,
    $$Automated Decision Review Policy$$,
    $$# Automated Decision Review Policy

## Purpose
Some decisions on this platform are made by software: a payment may be held, a velocity limit may block a card, a risk tier may add a reserve, and a verification may move from an automatic provider to a human queue. This policy explains those decisions, the human review behind them and the appeal path.

## Where an automated decision applies
- A payment is held when the postal code or the address country does not match the invoice after an incomplete authentication.
- A card or an address reaches a velocity limit inside a rolling window.
- A verification returns incomplete or unsuccessful, and the file moves to manual review.
- A merchant category carries a risk tier that adds a reserve or a longer hold.
- A rising chargeback rate triggers a monitoring, reserve or suspension step.

## Human review
Every decision that stops a payment, blocks a card, ends a service or changes a limit is reviewed by a person on the compliance or finance team. A large or high risk merchant requires two reviewers. The reviewer records the reason, and the record is written to the audit log.

## Transparency
The merchant sees the outcome and the reason code of a held payment, the limit and the reserve that apply to it, and the status of its verification. The merchant is not shown the internal rule weights or the screening source detail.

## Appeal
A merchant may contest any automated decision from the support desk. The appeal goes to a reviewer who did not make the original decision, is answered within five business days, and its outcome is recorded with its reason. An appeal never suspends the control while it is being considered.

## Records
Decisions, reasons, reviewers and appeal outcomes are retained for seven years so that the platform can explain any outcome to a merchant, a processor or a supervisor.

## Questions
Write to compliance through the support desk in the merchant dashboard.$$,
    $$automated_decision_review$$,
    $$draft$$,
    $$Automated Decision Review Policy$$,
    $$Where software makes a decision on this platform, who reviews it, and how a merchant appeals it.$$
  );

commit;
