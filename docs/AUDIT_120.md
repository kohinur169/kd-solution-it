# Audit of STEPs 001–123 — inventory, security posture, and how each claim is verified

Date: 2026-11-05. Branch `arena/17762737-kd-solution-it`.
Companion gate: `npm run check:audit` (`scripts/verify-audit.mjs`, **2784 checks**).

This document answers three questions asked in one breath: which STEPs are done, what was missed, and
**how** the security and coding-vulnerability claims are actually verified rather than assumed.

---

## 1. Inventory: 121 of 123 STEPs have a handoff

| Measure | Result |
|---|---|
| STEP entries declared in `docs/final/STEP_PLAN_250.md` up to 123 | **123** |
| Handoffs in `docs/handoffs/` | **122** (121 at audit time) |
| Missing | **STEP 116** (STEP 096 completed in `df49387`, after this audit) |

The gaps were recorded as `knownGaps` in the gate. That means they cannot be quietly forgotten **and**
they cannot be used to excuse a third: any *other* missing handoff fails the build with its number. The
list now names only `116`.

**Addendum (post-audit).** STEP 096 was completed in `df49387` ("STEP 096: Provisioning queue and
office alert…"), which added the queue read and acknowledgement under `services/submerchant/`, the
`/provisioning-alerts` office screen and its route, and `docs/handoffs/STEP_096_COMPLETED.md`. The gate's
`knownGaps` dropped from `["096","116"]` to `["116"]` and `npm run verify` is green. STEP 116 remains the
single outstanding gap below. The STEP 096 subsection that follows is preserved as it was written at
audit time.

### STEP 096 — Provisioning queue and office alert when no master account is connected

**At audit time: partly built, and the missing part was the whole point of the STEP.** *(Now closed; see
the addendum above.)*

Present: `0054_submerchant_provisions.sql` carries `master_account_ref` (null while queued), the
"queue the office alert reads" index, and `services/submerchant/provision.ts` writes and reads the
queued state.

Missing: **nothing in the application ever reads that queue for a human.** The index exists, is
commented as the alert's source, and has no reader. FEATURE_LIST line 70 promises *"If no master
platform account is connected, provisioning stays queued and the office is alerted"* — the first half
is true, the second is not. No office screen lists stuck provisions, and no notification is sent.

Consequence: a sub-merchant whose provisioning is blocked by a missing platform master account waits
indefinitely with no signal. This is a **real operational gap**, not a cosmetic one.

### STEP 116 — Invoice status workflow with paid-invoice edit lock and audit entries

**Not built at all.** No handoff, no service function, no route, no UI. Confirmed by search: there is
no `updateInvoiceStatus`, no `transitionInvoice`, and `services/invoices/invoices.ts` exports only
`createInvoice`, `getInvoice` and two option lists.

What exists is the database half from `0022`:

- the seven-status vocabulary (`draft, sent, viewed, partially_paid, paid, overdue, void`);
- `invoices_issue_check` (non-draft needs a number and an `issued_at`);
- `invoices_guard_paid`, which locks a paid invoice against every change except `updated_at`/`version`;
- `invoices_voided_instant_check`, `invoices_paid_instant_check`.

So the *lock* that FEATURE_LIST line 181 promises is real and enforced in SQL. What is missing is the
*workflow* that moves a draft to `sent`, records who did it, and audits the transition.

**This is the single most consequential gap in the whole feature line**, and this audit found it rather
than assuming it:

1. FEATURE_LIST line 170 promises `draft, sent, viewed, partially_paid, paid, overdue, void` as a
   workflow. Today no invoice can leave `draft` through any code path.
2. Line 178 (recurring) says a generated invoice "shows as due or overdue" and "reminders go to the
   client". STEP 123 correctly generates drafts and correctly refuses to remind about them — but that
   means **the reminder half of STEP 123 is inert until STEP 116 exists**.
3. STEP 124 (partial payments, next) needs an issued invoice to partially pay.

STEP 116 is therefore a blocker for the invoice half of the product, and it should be implemented
before STEP 124 rather than after it.

---

## 2. How the security claims are verified — and what each method cannot see

Four independent layers, because no single one is honest on its own.

### Layer 1 — static gates (run on every `npm run verify`)

| Claim | Gate | Count |
|---|---|---|
| Every table enables RLS and carries a default-deny policy | `check:migrations` (per file) + `check:audit` (in total) | 3475 + included |
| Every mutating route calls the CSRF guard | `check:audit` | included in 2784 |
| No literal credential, shell import, `eval`, `new Function`, or body spliced into a query | `check:audit` | included in 2784 |
| No advisory in anything that ships | `check:audit` → `npm audit --omit=dev` | `0` |
| Injections of markup confined to one constant | `check:security` | 2378 |
| Text/host/URL/HTML/SSRF rules | `check:security` | 2378 |
| CSP and security headers wired on every response | `check:security` + `check:shell` | 2378 + 774 |
| Rate limiting on auth and payment surfaces | `check:security` | 2378 |
| Audit log written, redacted, chained and signed | `check:security` | 2378 |
| Money never a float; i18n keys complete; no `TODO` | `check:structure`, `check:i18n`, `check:config` | 458 / 2315 / 10 |

### Layer 2 — mutation testing (done by hand when a gate is written, recorded here)

A gate that has never failed is a gate nobody has tested. Each new claim was broken deliberately and
the gate was required to notice:

| Mutation | Expected | Observed |
|---|---|---|
| Remove `invoice_events_default_deny` from `0024` | fail | `every one carries a default-deny policy (missing: invoice_events)` |
| `requireCsrfToken(x)` → `void (x)` | fail | named the route as unexplained |
| Delete the `requireCsrfToken(...)` call outright | fail | named the route as unexplained |
| Move one handoff away | fail | `missing: 096, 100, 116` (at audit time; the same mutation now reports `missing: 100, 116`) |

The third of those exposed a **real defect in the first version of the audit gate**: it matched the
*name* `requireCsrfToken` anywhere in the file, so wrapping the call in `void (` disabled the guard
while the gate stayed green. The check now requires an actual call (`requireCsrfToken(`) on the line.

### Layer 3 — live adversarial probing (against the production build)

The built app was started and **70 mutating route/verb pairs** were attacked with no session cookie,
no CSRF token, a hostile `Origin`, and a body containing `amount_minor` and a `company_id`:

| Result | Count | Meaning |
|---|---|---|
| `422 VALIDATION_FAILED {field: "csrf"}` | 57 | refused at the CSRF guard — correct |
| `503 SERVICE_UNAVAILABLE` (auth routes, rate limiter) | 12 | refused before any work — correct |
| `2xx` | **0** | **no unauthenticated mutation succeeded** |

Spot checks confirm the reason rather than the status code:

```
POST /api/invoices            → {"details":[{"field":"csrf","rule":"csrf_token_invalid"}]}
POST /api/invoices/recurring  → same
POST /api/products|/api/services|/api/estimates|/api/clients → same
POST /api/auth/signin         → 503 from the rate limiter (config absent in this sandbox)
GET  /api/invoices/recurring  → 401 AUTHENTICATION_REQUIRED
```

### Layer 4 — the gaps, stated

- **No PostgreSQL and no Docker in this sandbox.** `migrations/verify.ts` and the audit gate read the
  SQL as *text*: they prove a policy is declared, not that it behaves. Actual RLS enforcement, the
  `invoices_guard_paid` trigger, the append-only trigger and every partial unique index need a scratch
  database to be proven. That is the highest-value remaining verification and it cannot be done here.
- **No browser.** XSS is proven by policy and by the single-`dangerouslySetInnerHTML` rule, not by
  executing a payload. The rich-text sanitiser is unit-gated (2378 checks) but not fuzzed in a DOM.
- **No network in some runs.** `npm audit` needs the registry. When it cannot reach one, the gate says
  so in one line rather than reporting green — a stated skip, never a silent pass.
- **No pen-test.** SSRF, header injection, session fixation and timing attacks are covered by unit
  gates over the rule modules, not by an external test.

---

## 3. Dependency posture

```
npm audit --omit=dev   →  found 0 vulnerabilities
npm audit              →  8 moderate
```

All eight are the `@typescript-eslint/*` → `minimatch` chain, which is **development tooling only** and
ships nowhere. No `npm audit fix --force` was run: it would downgrade or replace the lint toolchain to
close an advisory that cannot reach a user, and a broken lint chain would cost more than it buys. The
runtime tree is clean, and the gate enforces that it stays clean.

---

## 4. Coding-vulnerability scan results

| Vector | Method | Result |
|---|---|---|
| SQL injection | no raw SQL; PostgREST filters escaped by callers; gate rejects a body spliced into a query | **0 found** |
| XSS | one `dangerouslySetInnerHTML`, a static `THEME_SCRIPT` under a CSP nonce; sanitiser in `lib/security/html.ts` | **0 found** |
| RCE / shell | no `node:child_process`, no `eval`, no `new Function` in `app/ lib/ services/` | **0 found** |
| Hardcoded secrets | regex scan for provider key shapes and PEM headers | **0 found** |
| Tenant crossing | every read in the service gates carries `company_id`; three discovery reads are named and bounded | **0 found** |
| Open redirect / host trust | no `host` header read in application code | **0 found** |
| CSRF | 54 mutating routes, one explained exemption (`/api/jobs/health`) | **0 unexplained** |
| Auth bypass | 70 live probes, 0 accepted | **0 found** |
| Broken access control | `requireAnyRole` + `requireCompanyId` on every service entry point, tenant from the session | **0 found** |

---

## 5. What to do next, in order

1. **STEP 116** — the invoice status workflow. It unblocks FEATURE_LIST lines 170, 178 and 181, makes
   STEP 123's reminders reachable, and is a prerequisite for STEP 124. It is the only missing STEP.
2. **A scratch database** — apply `0001…0119` forward, run the rollback proofs, and `EXPLAIN` the
   overdue sweep against `invoices_due_idx`. This is the one verification this sandbox cannot give.
3. **A startup hook** — `registerRecurringGenerationJob` and the due-schedule enqueue have no caller at
   boot (`/api/jobs/health` reports `scheduler.registered: 0`). Deployment work.

STEP 124 was **not** started.
