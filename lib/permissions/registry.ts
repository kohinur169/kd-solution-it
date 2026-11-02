// path: lib/permissions/registry.ts
import type { PlatformRole } from "../auth/types.ts";
import type { MessagePath } from "../i18n/messages.ts";
import { deepFreeze } from "../utils/freeze.ts";

/**
 * The permission catalog: every named authority an office account can hold, and the three it cannot be
 * handed.
 *
 * ## A permission is not a role
 *
 * `role_assignments` says what kind of office user somebody is; `office_permissions` says which
 * specific action they may take. `0005_office_permissions.sql` was written for exactly this split, and
 * its own comment gives the example: a support agent who is temporarily allowed to release a small
 * payout gets one row, not a new role and not a change to their role history. This catalog is the
 * code side of that column - the keys, what each one means, and which desk it belongs to.
 *
 * ## Why a key is a dotted string
 *
 * The column stores a string and only checks its shape (`^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$`, at most 64
 * characters), which is what lets a new permission arrive without a migration. The price is that the
 * database cannot tell a real permission from a typo, so the catalog does: every write goes through
 * `isPermissionKey`, and a key that is not here is refused rather than stored.
 *
 * ## The three that are never delegated
 *
 * Section 6 keeps gateway keys in the super administrator's hands, section 2 keeps the platform's own
 * settings there, and the lever that hands permissions out cannot be handed out by the same lever - a
 * delegation that can delegate itself is a grant nobody can track. Section 2 also keeps the CEO's final
 * signature with the CEO, so `kyc.final_approval` is deliberately absent from this catalog: the CEO
 * hands work over through `delegations` (0006), which records a delegator and a delegate, not through a
 * super administrator's grant. The screen names all four in words instead of offering them.
 *
 * ## Expiry is a requirement, not an option
 *
 * `office_permissions.expires_at` may be null, and this catalog still refuses a grant without an end.
 * `0006_delegations.sql` states the reason better than this file can: an approval authority that never
 * expires is indistinguishable from a permanent role change. A permanent authority is a role; a
 * delegation is a window.
 */

/** The desks a delegated permission belongs to. Descriptive: it says where the work lives. */
export type PermissionGroup = "kyc" | "money" | "support" | "content" | "platform";

/** One named authority, as the catalog keeps it. */
export interface PermissionDefinition {
  /** The dotted key stored in `office_permissions.permission`. */
  readonly key: string;
  readonly group: PermissionGroup;
  /** The catalog message that names it in a sentence a person reads. */
  readonly labelKey: MessagePath;
  /** The desks that hold it by charter. Informational: section 2's charters, not a grant rule. */
  readonly charterRoles: readonly PlatformRole[];
  /** False for the three the super administrator never hands out. */
  readonly delegable: boolean;
}

/** The four desks, in the order the screen lists them. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = deepFreeze([
  "kyc",
  "money",
  "support",
  "content",
  "platform",
] as const satisfies readonly PermissionGroup[]);

const groupLabelKeys: Readonly<Record<PermissionGroup, MessagePath>> = deepFreeze({
  kyc: "officeDelegations.groupKyc",
  money: "officeDelegations.groupMoney",
  support: "officeDelegations.groupSupport",
  content: "officeDelegations.groupContent",
  platform: "officeDelegations.groupPlatform",
});

const groupDescriptionKeys: Readonly<Record<PermissionGroup, MessagePath>> = deepFreeze({
  kyc: "officeDelegations.groupKycDescription",
  money: "officeDelegations.groupMoneyDescription",
  support: "officeDelegations.groupSupportDescription",
  content: "officeDelegations.groupContentDescription",
  platform: "officeDelegations.groupPlatformDescription",
});

/**
 * Every permission this platform knows, in the order the screen lists it.
 *
 * The three non-delegable rows are last and in their own group, because a screen that mixed them into
 * the offer would be promising something the next check refuses.
 */
export const PERMISSIONS: readonly PermissionDefinition[] = deepFreeze([
  {
    key: "kyc.review",
    group: "kyc",
    labelKey: "officeDelegations.permissionKycReview",
    charterRoles: ["compliance_kyc"],
    delegable: true,
  },
  {
    key: "kyc.document_request",
    group: "kyc",
    labelKey: "officeDelegations.permissionKycDocumentRequest",
    charterRoles: ["compliance_kyc"],
    delegable: true,
  },
  {
    key: "underwriting.criteria",
    group: "kyc",
    labelKey: "officeDelegations.permissionUnderwritingCriteria",
    charterRoles: ["compliance_kyc"],
    delegable: true,
  },
  {
    key: "sanctions.screen",
    group: "kyc",
    labelKey: "officeDelegations.permissionSanctionsScreen",
    charterRoles: ["compliance_kyc"],
    delegable: true,
  },
  {
    key: "dispute.review",
    group: "kyc",
    labelKey: "officeDelegations.permissionDisputeReview",
    charterRoles: ["compliance_kyc"],
    delegable: true,
  },
  {
    key: "sar.prepare",
    group: "kyc",
    labelKey: "officeDelegations.permissionSarPrepare",
    charterRoles: ["compliance_kyc"],
    delegable: true,
  },
  {
    key: "payout.release",
    group: "money",
    labelKey: "officeDelegations.permissionPayoutRelease",
    charterRoles: ["finance_ops"],
    delegable: true,
  },
  {
    key: "payout.failed_retry",
    group: "money",
    labelKey: "officeDelegations.permissionPayoutFailedRetry",
    charterRoles: ["finance_ops"],
    delegable: true,
  },
  {
    key: "reconciliation.resolve",
    group: "money",
    labelKey: "officeDelegations.permissionReconciliationResolve",
    charterRoles: ["finance_ops"],
    delegable: true,
  },
  {
    key: "settlement.release",
    group: "money",
    labelKey: "officeDelegations.permissionSettlementRelease",
    charterRoles: ["finance_ops"],
    delegable: true,
  },
  {
    key: "support.ticket",
    group: "support",
    labelKey: "officeDelegations.permissionSupportTicket",
    charterRoles: ["support"],
    delegable: true,
  },
  {
    key: "account.unlock",
    group: "support",
    labelKey: "officeDelegations.permissionAccountUnlock",
    charterRoles: ["support"],
    delegable: true,
  },
  {
    key: "blog.publish",
    group: "content",
    labelKey: "officeDelegations.permissionBlogPublish",
    charterRoles: ["blogger"],
    delegable: true,
  },
  {
    key: "gateway.keys",
    group: "platform",
    labelKey: "officeDelegations.permissionGatewayKeys",
    charterRoles: ["super_admin"],
    delegable: false,
  },
  {
    key: "platform.settings",
    group: "platform",
    labelKey: "officeDelegations.permissionPlatformSettings",
    charterRoles: ["super_admin"],
    delegable: false,
  },
  {
    key: "delegation.grant",
    group: "platform",
    labelKey: "officeDelegations.permissionDelegationGrant",
    charterRoles: ["super_admin"],
    delegable: false,
  },
] as const satisfies readonly PermissionDefinition[]);

const definitionsByKey: ReadonlyMap<string, PermissionDefinition> = new Map(
  PERMISSIONS.map((definition) => [definition.key, definition]),
);

/** Every key the platform knows, in catalog order. */
export const PERMISSION_KEYS: readonly string[] = deepFreeze(
  PERMISSIONS.map((definition) => definition.key),
);

/** The keys this screen may hand out. */
export const DELEGABLE_PERMISSION_KEYS: readonly string[] = deepFreeze(
  PERMISSIONS.filter((definition) => definition.delegable).map((definition) => definition.key),
);

/** The three the super administrator keeps, in catalog order. */
export const RESERVED_PERMISSION_KEYS: readonly string[] = deepFreeze(
  PERMISSIONS.filter((definition) => !definition.delegable).map((definition) => definition.key),
);

/** True when the value is a key this platform knows. */
export function isPermissionKey(value: unknown): value is string {
  return typeof value === "string" && definitionsByKey.has(value);
}

/** True when this screen may hand the key out. An unknown key is not delegable either. */
export function isDelegablePermission(value: unknown): value is string {
  return isPermissionKey(value) && definitionsByKey.get(value)?.delegable === true;
}

/** The definition of a known key, or null. */
export function permissionDefinitionOf(key: string): PermissionDefinition | null {
  return definitionsByKey.get(key) ?? null;
}

/** The catalog message that names a key, so a screen never builds a label from the key itself. */
export function permissionLabelKey(key: string): MessagePath {
  const definition = definitionsByKey.get(key);

  if (definition === undefined) {
    throw new Error(`Unknown permission key: ${key}`);
  }

  return definition.labelKey;
}

/** The desks that hold a key by charter. Informational; an empty list for an unknown key. */
export function charterRolesOf(key: string): readonly PlatformRole[] {
  return definitionsByKey.get(key)?.charterRoles ?? [];
}

/** The group a key belongs to, or null. */
export function permissionGroupOf(key: string): PermissionGroup | null {
  return definitionsByKey.get(key)?.group ?? null;
}

/** The keys of one group, in catalog order. */
export function permissionKeysInGroup(group: PermissionGroup): readonly string[] {
  return PERMISSIONS.filter((definition) => definition.group === group).map(
    (definition) => definition.key,
  );
}

/** The keys of one group that this screen may hand out. */
export function delegablePermissionKeysInGroup(group: PermissionGroup): readonly string[] {
  return PERMISSIONS.filter((definition) => definition.group === group && definition.delegable).map(
    (definition) => definition.key,
  );
}

/** The catalog message that names a group. */
export function permissionGroupLabelKey(group: PermissionGroup): MessagePath {
  return groupLabelKeys[group];
}

/** The catalog message that says what a group is for. */
export function permissionGroupDescriptionKey(group: PermissionGroup): MessagePath {
  return groupDescriptionKeys[group];
}

/**
 * Who may open the delegation screen, grant, and withdraw.
 *
 * One role, taken from section 2: "super_admin ... delegates permissions to office roles". The CEO
 * confirms platform decisions, but handing a colleague an authority is the super administrator's act,
 * and the two roles' lists are deliberately not merged here - a screen that two roles share is a screen
 * whose audit trail cannot say who is accountable for a grant.
 */
export const PERMISSION_DELEGATION_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The column check of `0005`: a dotted key, at most 64 characters. */
export const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u;

/** The column's ceiling on a key. */
export const PERMISSION_KEY_MAXIMUM_LENGTH = 64;

/** `office_permissions_reason_check` allows 1 to 280; a delegation asks for a reason worth reading. */
export const PERMISSION_REASON_MINIMUM_LENGTH = 10;
export const PERMISSION_REASON_MAXIMUM_LENGTH = 280;

/** The longest window this screen grants: half a year. */
export const PERMISSION_MAXIMUM_DAYS = 180;

/** A grant that lapses inside this window is called out on the screen. */
export const PERMISSION_EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1_000;

/** A day, in milliseconds, for turning a chosen window into an instant. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/** How many live grants one read returns. More than a platform this size delegates at once. */
export const PERMISSION_ACTIVE_LIMIT = 200;

/** How many withdrawals the history shows. */
export const PERMISSION_HISTORY_LIMIT = 20;

/** One window the form offers, and the copy that names it. */
export interface GrantDuration {
  readonly days: number;
  readonly labelKey: MessagePath;
}

/** The four windows the screen offers. A value outside them is refused by the service as well. */
export const GRANT_DURATIONS: readonly GrantDuration[] = deepFreeze([
  { days: 7, labelKey: "officeDelegations.durationWeek" },
  { days: 30, labelKey: "officeDelegations.durationMonth" },
  { days: 90, labelKey: "officeDelegations.durationQuarter" },
  { days: 180, labelKey: "officeDelegations.durationHalfYear" },
] as const satisfies readonly GrantDuration[]);

/** True when the number of days is one of the four the screen offers, or any integer in the window. */
export function isGrantDurationDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PERMISSION_MAXIMUM_DAYS
  );
}

/** The instant a window ends, from the instant it starts. */
export function expiryInstantOf(startEpochMs: number, days: number): number {
  return startEpochMs + days * DAY_MS;
}

/** The email shape `users_email_format_check` accepts, applied before a lookup spends a query. */
const emailPattern = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;

/** The address as the table stores it: trimmed, lowercased, and shaped like an address. */
export function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();

  if (normalized.length < 5 || normalized.length > 254 || !emailPattern.test(normalized)) {
    return null;
  }

  return normalized;
}
