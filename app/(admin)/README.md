// path: app/(admin)/README.md
# app/(admin)

Owner: STEP 068-078 (roles, permissions, office dashboards and announcements).

Reserved for the office roles super_admin, ceo, compliance_kyc, finance_ops, support and
blogger, each with its own dashboard and its own permission set, plus platform settings,
provider keys, plans, announcements and the compliance calendar.

Sensitive actions require step-up reauthentication and follow the approval chain:
requester, then CEO, then super_admin.

## The shell, since STEP 068

`layout.tsx` is the office shell and the one permission check every route in this group inherits.
It reads the account behind the request once (`office-actor.ts`), asks `decideOfficeAccess` in
`components/office/navigation.ts`, and then does one of four things:

| the account | what happens |
| --- | --- |
| no session | `307` to `/signin`, the form of STEP 045 |
| an account that cannot be read | the outage panel, because an outage is not a sign out |
| a session without an office role (`owner`) | the refusal panel, with no office navigation at all |
| an office role that still owes a second factor | `307` to `/2fa`, the enrolment of STEP 041 |
| an office role with its second factor | the shell: topbar, sidebar and content |

So a page in this group contains no role check of its own, and a later office STEP cannot forget
one: the gate is above it. The decision is a pure function of the account, which is how the gate
exercises all five outcomes without a browser.

## The address space

The group adds no segment of its own, so a page here is `/<name>`. The workspace index of STEP 068
is `/admin` (`app/(admin)/admin/page.tsx`); the office STEPs after it add their pages beside it and
their entry to `OFFICE_NAVIGATION`. The two office screens the authentication block built keep
their own addresses (`/office/sessions`, `/office/2fa-reset-requests`) and are offered from the
sidebar: they exist, so a link to them is not a promise.

Since STEP 069 the group also serves:

| page | who opens it | what it is |
| --- | --- | --- |
| `/dashboard` (`dashboard/page.tsx`) | super_admin | the office home: gateway readiness, the roles held, the freshness of the second factor, and the screens the roles open |
| `/gateways` (`gateways/page.tsx`) | super_admin | section 6's provider panel: store, test, enable and disable, with only the last four characters of a key ever read back |
| `/ceo` (`ceo/page.tsx`) | ceo and super_admin | section 2's approval queue at both desks, the two signatures that move a request through it, what was decided recently, the form that raises a request, and the country and KYC counts |
| `/delegations` (`delegations/page.tsx`) | super_admin | section 2's delegation lever: what is delegated and until when, the form that hands one permission to one colleague, and the history of what ran out and what was withdrawn |

Each reads through the service that owns the screen - `lib/gateways/service.ts`,
`lib/approvals/service.ts` and `lib/permissions/service.ts` - and the navigation imports those
services' role constants, so the sidebar and the service cannot disagree about who may enter.

## One rule per screen

`components/office/navigation.ts` imports the role list of the service behind each screen -
`SESSION_MANAGEMENT_OFFICE_ROLES`, `TWO_FACTOR_RESET_OFFICE_ROLES` - instead of restating it. The
sidebar can therefore never offer a screen whose service refuses the account, nor hide one it would
accept. `components/office/verify.ts` proves that, resolves every entry to a real `page.tsx`, and
decides all seven roles. Run it with `node components/office/verify.ts`; the package request for
`check:office` is in the STEP 068 handoff, because `package.json` is integrator-owned.

## Later STEPs

`073`-`078` build the remaining dashboards and the platform screens. Each one adds its page under this group,
its entry to `OFFICE_NAVIGATION` in the same commit, and - where it adds a mutation - its own audit
entry through `lib/security/audit.ts`. Step-up reauthentication for a sensitive action is STEP 053's
`lib/auth/step-up.ts`, and the approval chain of `070` - with the two signatures of `072` - sits between the requester and
the action.
