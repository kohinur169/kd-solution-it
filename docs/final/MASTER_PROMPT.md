// path: docs/final/MASTER_PROMPT.md
# KD SOLUTION IT - Master Prompt for Every Coding Chat

You are building KD SOLUTION IT, an enterprise multi-tenant SaaS payment facilitator
platform. Read docs/final/FEATURE_LIST.md in full before writing anything. That feature
list is the single source of truth for scope. Implement exactly the features in it,
completely, with production quality.

## Absolute Rules
1. English only in code, UI, comments, seeds, templates, file names and content strings.
   All user facing strings live in lib/i18n/strings/en.ts.
2. USD only. Money is numeric(18,4) in the database. Money math uses a decimal library only.
3. Text and structured data live in Supabase PostgreSQL. Files live in the storage of the
   hosting environment through the storage adapter layer. Every file is AES-256-GCM
   encrypted before upload and every file record stores storage_provider.
4. No test files of any kind. No TODO, FIXME or placeholder text anywhere.
5. TypeScript strict mode everywhere. No any types. No console.log; use structured logging.
6. Every file starts with a path comment: // path: followed by the file path.
7. Every table has id UUID v7, company_id, created_at, updated_at, deleted_at and version.
8. RLS is enabled with a default-deny policy on every table.
9. Every mutation writes an audit log entry.
10. Every form and API input is validated with Zod on client and server.
11. Every input is sanitized against XSS, SQL injection, CSRF, SSRF and header injection.
12. Every payment carries an idempotency key.
13. Every editable record uses optimistic locking through the version column.
14. Roles: super_admin, ceo, compliance_kyc, finance_ops, support, blogger, owner.
    Clients use tokenized links only. Approval chain: requester, CEO, super_admin.
15. Partner display naming uses Global Payout Partners and Local Payment Methods via Licensed Partners.
16. Zero Trust and Zero Tolerance security on every layer.
17. Performance: paginated lists, selected columns only, joined queries, no query in a loop,
    indexes on lookup columns, caching for public and summary data, heavy work in background jobs.

## Stack
Next.js 14+ App Router with Server Components, TypeScript strict, Tailwind CSS, shadcn/ui,
Supabase PostgreSQL with Auth and RLS, Supabase Storage and Amazon S3 object storage through the storage adapter layer selected by environment configuration,
payment adapters for NMI, Payoneer, Rainforest, Stripe Connect and Airwallex,
TaxCloud for United States sales tax calculation, optional supplementary identity-verification adapters for Jumio, Didit and Sumsub, with at most one active; the contracted payment processor remains authoritative for its own KYB/KYC and verification status,
universal email through SMTP or API provider, Cloudflare Turnstile, DOMPurify,
nonce-based CSP, Sentry, deployable on Vercel and Netlify.

## Provider Documentation Rule
Before coding a payment or verification adapter, fetch and read the provider's latest
official documentation and sandbox or testing pages from the provider's own website in the
same coding session. Record the verified documentation and sandbox URLs in the adapter file
header and in docs/final/PROVIDER_DOCS.md. Code from the documentation, never from memory.

## Working Method for Each Chat
- These documents live inside the project repository: docs/final/FEATURE_LIST.md,
  docs/final/MASTER_PROMPT.md and docs/final/STEP_PLAN_250.md. The owner selects this
  repository when opening a coding chat, so the agent reads everything from the repository
  itself. The owner does not paste any instruction block.
- In each new chat the owner writes only one line: Implement STEP NNN.
  Example: Implement STEP 001.
- On receiving that line, the agent must, before writing any code:
  1. Read docs/final/FEATURE_LIST.md in full.
  2. Read this MASTER_PROMPT.md in full.
  3. Find STEP NNN in docs/final/STEP_PLAN_250.md and identify its exact scope and the
     feature list sections it belongs to.
  4. Read the previous handoff file docs/handoffs/STEP_(NNN-1)_COMPLETED.md when it exists.
  5. Pull the latest state of the working branch.
- One chat implements exactly one STEP. Work only on the files owned by that STEP.
  Never edit files owned by another STEP.
- Migrations are append-only, numbered in order, never edited after commit, each with a rollback.
- package.json is integrator-owned. When a package is needed, write a package request into
  the handoff file instead of editing package.json.
- STEP 001 creates the docs/handoffs/ folder. Every chat copies
  docs/final/HANDOFF_TEMPLATE.md to docs/handoffs/STEP_NNN_COMPLETED.md and fills every
  field, including the acceptance checklist for that STEP, files created, migrations added,
  environment variables added, packages requested, proof results and the next STEP dependency.
- Steps run strictly in numeric order. A STEP depends on every earlier STEP in its own
  category and on the handoff files of those STEPs. A later category may start only when
  the previous category handoff files all exist.
- At the end of the chat: run typecheck and lint, commit with the message format
  "STEP NNN: title", push the branch, and leave the completed handoff file in the same commit.
- Never start STEP N+1 before the handoff of STEP N exists.
- Completed STEP commits, handoffs and migrations are immutable. The owner reports STEPs
  001-080 complete; do not reopen, renumber or rewrite any completed work. Before resuming,
  verify the selected branch has a contiguous handoff sequence through STEP 080. If it does,
  the next STEP is 081; if not, stop and reconcile the branch/progress with the owner rather
  than skipping missing STEPs. Implement this policy only in still-uncompleted STEPs, using
  append-only migrations owned by the designated future STEPs. Inspect the actual migration
  inventory before assigning a migration number; never edit a committed migration or claim
  an unverified step is complete.
- If anything in the STEP conflicts with FEATURE_LIST.md, FEATURE_LIST.md wins and the
  conflict must be written into the handoff file. For approved scope amendments, the current
  FEATURE_LIST.md and STEP_PLAN_250.md supersede only the advisory “Next STEP” title in an
  older completed handoff; never edit that completed handoff or its underlying completed work.
- Before coding, verify that all six authoritative files are accessible under docs/final/ and
  the root README identifies them as the only active instructions. This repository may retain
  docs/planning/ for historical handoff evidence; treat every file there, including old
  CHAT_PROMPTS.md, MASTER_PLAN.md and REVISED_FEATURE_LIST_V2.md, as historical only. Never
  follow their instructions or use them to expand scope. Update the README and add a historical-
  only notice in docs/planning/README.md. Preserve completed handoff references; do not delete
  or move the historical files. If any active README/prompt still directs the agent to use
  those old plans, or any required docs/final file is missing, stop before coding.

## Production Readiness Rules (apply to every STEP)
- Definition of done for every STEP: the implemented scope works end to end, typecheck
  passes, lint passes, and the production build passes for the touched area. A STEP that
  fails any of these is not complete and its handoff must say so.
- Every STEP that adds a database migration must run the migration and its rollback on a
  clean database and record the result in the handoff file.
- Every STEP that touches money must prove balanced double-entry ledger postings for its
  flows and record the proof in the handoff file.
- Every STEP that touches a provider must complete a sandbox cycle (payment, refund where
  supported, and webhook delivery) and record the provider documentation URLs, the sandbox
  URLs and the sandbox result in the handoff file.
- For merchant onboarding, keep processor KYB/KYC status separate from optional Jumio/Didit/Sumsub IDV. Never let platform IDV override a processor restriction or rejection, and never treat an unavailable or unresolved check as a pass.
- Risk-tier, sanctions, re-KYC, transaction review and payout code must fail closed on unknown/stale status. Payout requires persisted fulfilment proof, applicable post-fulfilment delay, provider eligibility, verified bank and all risk/hold/dispute gates. Manual review above USD 5,000 must block capture until approved.
- CEO and super_admin risk-policy edits must be versioned, effective-dated, audited and approved by distinct authorized actors; policy changes are prospective and cannot silently weaken a transaction's captured policy version. Support cannot perform KYC approval, tier policy changes or payout release.
- Risk policy values and their definitions (monthly period, chargeback denominator/window/sample minimum, completed order and fulfilment evidence) must be explicit. An unset value or unresolved case fails closed; stricter overlapping limits win.
- Every STEP that adds an environment variable must add it to .env.example with a
  description and must read it through the validated environment schema only.
- No secret, key, token or credential may appear in code, commits, logs, error messages
  or handoff files.
- Every STEP must keep the performance rules: paginated lists, selected columns, joined
  queries, no queries in loops, background jobs for heavy work.
- The final STEP verifies the full go-live gate lists in FEATURE_LIST.md sections 33 and 34 on
  staging before any production switch is recommended.

## Acceptance Checklist Required in Every Handoff
- The exact behaviours named in the STEP title were exercised manually on staging or in
  sandbox and the observed result is written in the handoff.
- For UI STEPs: desktop and mobile widths were checked, keyboard navigation works, and
  text is readable in light and dark themes.
- For API STEPs: success, validation failure, unauthorized and cross-tenant requests were
  exercised and the results are written in the handoff.
- For money STEPs: the ledger entries created by the flow are shown balanced in the handoff.
- A STEP is not complete while any item of this checklist is unproven.
