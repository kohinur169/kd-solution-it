-- path: migrations/0078_policy_pages_seed.down.sql
-- STEP 036 rollback of 0078: removes the twelve seeded policy pages and nothing else.
--
-- The rows are selected by their policy key, which is the closed list of section 3, and by the
-- slugs this file wrote. A page an editor added later has no row here and is not touched. Deleting
-- a published page is a real deletion rather than a soft delete, because the forward file wrote
-- real rows and a rollback returns the schema to the state before it: no policy pages at all.

begin;

delete from public.cms_pages
 where policy_key in (
   'kyc_kyb', 'ubo', 'aml_cft', 'sanctions_pep', 'underwriting', 'merchant_acceptance',
   'chargeback', 'refund_settlement', 'fraud_risk', 'data_privacy', 'pci_dss',
   'automated_decision_review'
 )
   and slug in (
     'kyc-and-kyb-policy',
     'ubo-policy',
     'aml-and-cft-policy',
     'sanctions-and-pep-screening-policy',
     'underwriting-and-risk-assessment-policy',
     'merchant-acceptance-and-prohibited-and-restricted-businesses-policy',
     'chargeback-and-dispute-management-policy',
     'refund-and-settlement-policy',
     'fraud-and-risk-management-policy',
     'data-privacy-and-security-policy',
     'pci-dss-compliance-policy',
     'automated-decision-review-policy'
   );

commit;
