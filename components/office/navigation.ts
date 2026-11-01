// path: components/office/navigation.ts
import { SESSION_MANAGEMENT_OFFICE_ROLES } from "../../lib/auth/session-list.ts";
import { TWO_FACTOR_RESET_OFFICE_ROLES } from "../../lib/auth/two-factor-reset.ts";
import { PLATFORM_ROLES, type PlatformRole, type RequestActor } from "../../lib/auth/types.ts";
import { APPROVAL_QUEUE_ROLES } from "../../lib/approvals/registry.ts";
import { GATEWAY_MANAGEMENT_ROLES, OFFICE_DASHBOARD_ROLES } from "../../lib/gateways/registry.ts";
import type { MessagePath } from "../../lib/i18n/messages.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The office workspace: which roles exist, which screens each one opens, and who may enter.
 *
 * ## One rule, one owner
 *
 * Every office screen already has a permission rule inside the service behind it:
 * `SESSION_MANAGEMENT_OFFICE_ROLES` for another account's sessions, `TWO_FACTOR_RESET_OFFICE_ROLES`
 * for the reset queue, `ACCOUNT_UNLOCK_OFFICE_ROLES` for a lock. The navigation imports those
 * constants instead of restating the list, so the sidebar can never offer a screen whose service
 * refuses the same account, and can never hide one it would accept. The gate proves the import and
 * the equality, because a copy is the one thing that would drift.
 *
 * ## The office roles are the seven minus the merchant
 *
 * `role_assignments` holds seven roles (FEATURE_LIST section 2). Six of them are the platform
 * office; `owner` is a merchant, and a merchant has its own area. So the office roles are derived
 * here from `PLATFORM_ROLES` rather than written out again, and the order they keep is the order
 * the migration lists.
 *
 * ## Which pages the sidebar may link to
 *
 * Only pages that exist. A navigation entry is a promise that something is behind it, and the gate
 * resolves every entry to a `page.tsx` in the tree, so an entry for a screen that is not built yet
 * fails the gate rather than shipping a 404. The office STEPs that follow add their own entry to
 * `OFFICE_NAVIGATION` in the same commit that adds their page.
 *
 * ## Why the imports carry their `.ts` extension
 *
 * `components/office/verify.ts` runs this module under plain Node, which resolves a relative
 * specifier that names the file exactly; the `.tsx` components beside it are compiled by Next and
 * use the `@/` alias like every other screen. The model is the part a gate can execute, so it is
 * the part that keeps the extension.
 */

/** The six platform office roles, in the order `0004_role_assignments.sql` lists them. */
export type OfficeRole = Exclude<PlatformRole, "owner">;

export const OFFICE_ROLES: readonly OfficeRole[] = deepFreeze(
  PLATFORM_ROLES.filter((role): role is OfficeRole => role !== "owner"),
);

const officeRoleSet: ReadonlySet<string> = new Set<string>(OFFICE_ROLES);

/** True when a value is one of the six office roles. `owner` is a merchant, not an officer. */
export function isOfficeRole(value: unknown): value is OfficeRole {
  return typeof value === "string" && officeRoleSet.has(value);
}

/** The office workspace index: the page this shell was built around. */
export const OFFICE_HOME_PATH = "/admin";

/** Where an anonymous request is sent. The sign in form is STEP 045's screen. */
export const OFFICE_SIGN_IN_PATH = "/signin";

/** Where a role holding account that still owes a second factor is sent (STEP 041's screen). */
export const OFFICE_TWO_FACTOR_PATH = "/2fa";

/**
 * One screen of the office, and the roles that may open it.
 *
 * `roles` is exactly the constant the service behind the screen enforces, never a copy of it.
 */
export interface OfficeSection {
  readonly key: OfficeSectionKey;
  readonly href: string;
  readonly labelKey: MessagePath;
  readonly descriptionKey: MessagePath;
  readonly roles: readonly PlatformRole[];
}

export type OfficeSectionKey =
  | "workspace"
  | "dashboard"
  | "ceo"
  | "gateways"
  | "sessions"
  | "twoFactorResets";

/**
 * Every office screen that exists today, in the order the sidebar shows them.
 *
 * The first entry is the workspace index of STEP 068; the dashboard and the gateway page are STEP
 * 069's two screens and the CEO's home is STEP 070's, all inside the admin group like the workspace;
 * the last two are the office screens the authentication block built (`app/office/`), which is why
 * their hrefs sit outside the group. A link to a page that exists is the only kind this shell offers,
 * which is why an entry arrives in the same commit as its `page.tsx`.
 */
export const OFFICE_NAVIGATION: readonly OfficeSection[] = deepFreeze([
  {
    key: "workspace",
    href: OFFICE_HOME_PATH,
    labelKey: "office.sectionWorkspace",
    descriptionKey: "office.sectionWorkspaceDescription",
    roles: OFFICE_ROLES,
  },
  {
    key: "dashboard",
    href: "/dashboard",
    labelKey: "office.sectionDashboard",
    descriptionKey: "office.sectionDashboardDescription",
    roles: OFFICE_DASHBOARD_ROLES,
  },
  {
    key: "ceo",
    href: "/ceo",
    labelKey: "office.sectionCeo",
    descriptionKey: "office.sectionCeoDescription",
    roles: APPROVAL_QUEUE_ROLES,
  },
  {
    key: "gateways",
    href: "/gateways",
    labelKey: "office.sectionGateways",
    descriptionKey: "office.sectionGatewaysDescription",
    roles: GATEWAY_MANAGEMENT_ROLES,
  },
  {
    key: "sessions",
    href: "/office/sessions",
    labelKey: "office.sectionSessions",
    descriptionKey: "office.sectionSessionsDescription",
    roles: SESSION_MANAGEMENT_OFFICE_ROLES,
  },
  {
    key: "twoFactorResets",
    href: "/office/2fa-reset-requests",
    labelKey: "office.sectionTwoFactorResets",
    descriptionKey: "office.sectionTwoFactorResetsDescription",
    roles: TWO_FACTOR_RESET_OFFICE_ROLES,
  },
]);

const roleLabelKeys: Readonly<Record<OfficeRole, MessagePath>> = deepFreeze({
  super_admin: "office.roleSuperAdmin",
  ceo: "office.roleCeo",
  compliance_kyc: "office.roleComplianceKyc",
  finance_ops: "office.roleFinanceOps",
  support: "office.roleSupport",
  blogger: "office.roleBlogger",
});

const roleCharterKeys: Readonly<Record<OfficeRole, MessagePath>> = deepFreeze({
  super_admin: "office.charterSuperAdmin",
  ceo: "office.charterCeo",
  compliance_kyc: "office.charterComplianceKyc",
  finance_ops: "office.charterFinanceOps",
  support: "office.charterSupport",
  blogger: "office.charterBlogger",
});

/** The catalog key of a role's name. */
export function officeRoleLabelKey(role: OfficeRole): MessagePath {
  return roleLabelKeys[role];
}

/** The catalog key of the one sentence that says what a role may do. */
export function officeRoleCharterKey(role: OfficeRole): MessagePath {
  return roleCharterKeys[role];
}

/**
 * The office roles an account holds, deduplicated and in the migration's order.
 *
 * An account may hold more than one role (section 2 says a grant is a row, not a column), and the
 * actor record already sorts and deduplicates its list; this narrows that list and keeps the order
 * stable so two renders of one account compare equal.
 */
export function officeRolesOf(roles: readonly PlatformRole[]): readonly OfficeRole[] {
  return OFFICE_ROLES.filter((role) => roles.includes(role));
}

/** True when the account holds at least one office role. */
export function hasOfficeRole(roles: readonly PlatformRole[]): boolean {
  return officeRolesOf(roles).length > 0;
}

/** The screens these roles may open, in catalog order, each one once. */
export function officeSectionsFor(roles: readonly PlatformRole[]): readonly OfficeSection[] {
  return OFFICE_NAVIGATION.filter((section) => section.roles.some((role) => roles.includes(role)));
}

/** One screen by key, or null. */
export function officeSectionByKey(key: OfficeSectionKey): OfficeSection | null {
  return OFFICE_NAVIGATION.find((section) => section.key === key) ?? null;
}

/** One screen by the path it is served at, or null. */
export function officeSectionByHref(href: string): OfficeSection | null {
  return OFFICE_NAVIGATION.find((section) => section.href === href) ?? null;
}

/**
 * What the shell knows before it decides anything.
 *
 * The three states are kept apart because they answer differently: no session is a redirect to the
 * form, a session is a decision, and an account that could not be read must not be treated as
 * anonymous - "the directory is down" and "nobody is signed in" are opposite facts, and only one of
 * them belongs in front of an officer.
 */
export type OfficeActorState =
  | { readonly kind: "anonymous" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "actor"; readonly actor: RequestActor };

export type OfficeAccessDecision =
  | { readonly kind: "sign-in" }
  | { readonly kind: "two-factor" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "denied" }
  | {
      readonly kind: "allowed";
      readonly roles: readonly OfficeRole[];
      readonly sections: readonly OfficeSection[];
    };

/**
 * The one decision the shell makes about the account in front of it.
 *
 * In this order:
 *
 *   1. no session is the sign in form;
 *   2. an account that could not be read is an outage, not an anonymous visitor;
 *   3. an account without an office role is refused here, before the second factor question,
 *      because the office is not a place a merchant may enrol into;
 *   4. an office account that still owes a second factor is STEP 041's enrolment screen. Section 22
 *      makes TOTP mandatory for every account that holds a role, so a dashboard reached without one
 *      would be the rule bypassed;
 *   5. otherwise the account enters, with the roles it holds and the screens those roles open.
 */
export function decideOfficeAccess(state: OfficeActorState): OfficeAccessDecision {
  if (state.kind === "anonymous") {
    return { kind: "sign-in" };
  }

  if (state.kind === "unavailable") {
    return { kind: "unavailable" };
  }

  const roles = officeRolesOf(state.actor.roles);

  if (roles.length === 0) {
    return { kind: "denied" };
  }

  if (state.actor.twoFactorEnrolmentRequired) {
    return { kind: "two-factor" };
  }

  return { kind: "allowed", roles, sections: officeSectionsFor(state.actor.roles) };
}

/**
 * The path a decision sends the browser to, or null when the shell renders instead.
 *
 * A page and the layout that owns it both ask this, so the two cannot disagree about where an
 * account without access goes.
 */
export function officeAccessRedirect(decision: OfficeAccessDecision): string | null {
  switch (decision.kind) {
    case "sign-in":
      return OFFICE_SIGN_IN_PATH;
    case "two-factor":
      return OFFICE_TWO_FACTOR_PATH;
    default:
      return null;
  }
}

/** One role as the workspace page shows it: its name and its charter. */
export interface OfficeRoleView {
  readonly role: OfficeRole;
  readonly labelKey: MessagePath;
  readonly charterKey: MessagePath;
}

/** Everything the workspace index renders for one account. */
export interface OfficeWorkspaceView {
  readonly roles: readonly OfficeRoleView[];
  readonly sections: readonly OfficeSection[];
}

/**
 * The workspace index of one account, or null when the account holds no office role.
 *
 * The page renders this and nothing else it did not read here, so what a screen shows about a role
 * is decided in one place - and the gate can check all six roles without a browser.
 */
export function officeWorkspaceOf(roles: readonly PlatformRole[]): OfficeWorkspaceView | null {
  const officeRoles = officeRolesOf(roles);

  if (officeRoles.length === 0) {
    return null;
  }

  return {
    roles: officeRoles.map((role) => ({
      role,
      labelKey: officeRoleLabelKey(role),
      charterKey: officeRoleCharterKey(role),
    })),
    sections: officeSectionsFor(roles),
  };
}
